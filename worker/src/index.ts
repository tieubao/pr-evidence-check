import { check } from "./check";
import { renderBypassComment, renderComment } from "./comment";
import { parseRepos, type RepoConfig } from "./config";
import { convertToDraft, fetchChangedFiles, fetchTemplate, setStatus, upsertComment } from "./github";

export interface Env {
  GITHUB_WEBHOOK_SECRET: string; // wrangler secret, HMAC key for X-Hub-Signature-256
  GITHUB_TOKEN: string; // wrangler secret, fine-grained user PAT
  REPOS: string; // wrangler secret, per-installation config (see config.ts)
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

// The reusable workflow's `types:` list, unchanged. `edited` matters most: an
// author fixing only the PR body pushes no commit, and the check still has to
// re-run.
const HANDLED_ACTIONS = new Set([
  "opened",
  "edited",
  "synchronize",
  "ready_for_review",
  "labeled",
  "unlabeled",
]);

export interface PullRequestEvent {
  action?: string;
  sender?: { login?: string };
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    node_id?: string;
    body?: string | null;
    draft?: boolean;
    labels?: Array<{ name?: string }>;
    html_url?: string;
    base?: { sha?: string };
    head?: { sha?: string; repo?: { full_name?: string } | null };
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      // Names what is wired without naming a repo, a token, or a secret value:
      // enough to tell a half-configured deploy from a working one.
      return Response.json({
        ok: true,
        service: "pr-evidence",
        repos_configured: parseRepos(env.REPOS).size,
        webhook_secret: Boolean(env.GITHUB_WEBHOOK_SECRET),
        github_token: Boolean(env.GITHUB_TOKEN),
      });
    }
    if (url.pathname === "/github/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }
    return new Response("not found", { status: 404 });
  },
};

// Order, each step before the next: body cap, signature, repo allowlist, then
// the event/action filter. 401 (rejected), 204 (accepted, ignored) and 202
// (accepted, processing) stay distinguishable from outside.
async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    console.error("[webhook] GITHUB_WEBHOOK_SECRET unset");
    return new Response("service unavailable", { status: 503 });
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) return new Response("missing signature", { status: 401 });

  const contentLength = request.headers.get("content-length");
  if (!contentLength || Number(contentLength) > MAX_BODY_BYTES) {
    return new Response("payload too large", { status: 413 });
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return new Response("payload too large", { status: 413 });
  }

  let signatureOk = false;
  try {
    signatureOk = await verifySignature(rawBody, signature, env.GITHUB_WEBHOOK_SECRET);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    console.warn(`[webhook] bad signature event=${request.headers.get("x-github-event") ?? "unknown"}`);
    return new Response("bad signature", { status: 401 });
  }

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(rawBody) as PullRequestEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (request.headers.get("x-github-event") !== "pull_request") return new Response(null, { status: 204 });
  if (!payload.action || !HANDLED_ACTIONS.has(payload.action)) return new Response(null, { status: 204 });

  const repo = payload.repository?.full_name;
  const config = repo ? parseRepos(env.REPOS).get(repo) : undefined;
  if (!repo || !config) {
    console.warn(`[webhook] repo not configured repo=${repo ?? "unknown"}`);
    return new Response(null, { status: 204 });
  }

  // The caller workflow's `if:` guard, kept: a fork PR's head sha is not in
  // this repo, so neither the status nor the compare would land anywhere
  // useful, and the token must not act on a fork's behalf.
  if (payload.pull_request?.head?.repo?.full_name !== repo) {
    console.log(`[webhook] fork PR ignored repo=${repo}`);
    return new Response(null, { status: 204 });
  }

  if (!env.GITHUB_TOKEN) {
    console.error("[webhook] GITHUB_TOKEN unset; cannot comment or set a status");
    return new Response("service unavailable", { status: 503 });
  }

  ctx.waitUntil(judge(env, repo, config, payload));
  return new Response(null, { status: 202 });
}

export async function judge(
  env: Env,
  repo: string,
  config: RepoConfig,
  payload: PullRequestEvent,
): Promise<void> {
  const pr = payload.pull_request;
  const number = pr?.number;
  const headSha = pr?.head?.sha;
  const baseSha = pr?.base?.sha;
  if (!number || !headSha || !baseSha) {
    console.error(`[judge] incomplete payload repo=${repo}`);
    return;
  }

  const token = env.GITHUB_TOKEN;
  const labels = (pr?.labels ?? []).map((l) => l.name ?? "");

  // Bypass is checked before anything else touches the API, same as the
  // workflow: a bypassed run does none of the diff or check work below.
  if (labels.includes(config.bypass_label)) {
    const by = payload.sender?.login ?? "unknown";
    await upsertComment(token, repo, number, renderBypassComment(config.bypass_label, by));
    await setStatus(token, repo, headSha, "success", `bypassed by the ${config.bypass_label} label`);
    return;
  }

  const [template, changedFiles] = await Promise.all([
    fetchTemplate(token, repo, headSha, config.template_path),
    fetchChangedFiles(token, repo, baseSha, headSha),
  ]);

  const result = check({
    body: pr?.body ?? "",
    template,
    changedFiles,
    uiPaths: config.ui_paths,
    previewHosts: config.preview_hosts,
  });

  let body = renderComment(result, config.bypass_label);
  if (!result.overall_pass && config.convert_to_draft && pr?.draft !== true) {
    body = `${body}\n\n${await convertToDraft(token, pr?.node_id ?? "")}`;
  }

  await upsertComment(token, repo, number, body);
  const failed = result.checks.filter((c) => !c.pass).map((c) => c.name);
  await setStatus(
    token,
    repo,
    headSha,
    result.overall_pass ? "success" : "failure",
    result.overall_pass ? "every check passed" : `failed: ${failed.join(", ")}`,
    pr?.html_url,
  );
}

// GitHub signs the raw body with HMAC-SHA256 under the shared secret and sends
// it as `sha256=<hex>`. WebCrypto's verify does the comparison in constant
// time, so there is no manual digest compare to get wrong.
export async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const clean = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return false;
  const sigBytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < sigBytes.length; i++) sigBytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}

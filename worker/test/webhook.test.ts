import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, type PullRequestEvent, verifySignature } from "../src/index";
import { parseRepos } from "../src/config";

const SECRET = "test-webhook-secret";
const REPO = "owner/site";

const ENV: Env = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  GITHUB_TOKEN: "test-token",
  REPOS: JSON.stringify({ [REPO]: { ui_paths: ["src/**"], preview_hosts: ["pages.dev"] } }),
};

async function sign(body: string, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

const event = (over: Partial<PullRequestEvent> = {}): PullRequestEvent => ({
  action: "opened",
  sender: { login: "someone" },
  repository: { full_name: REPO },
  pull_request: {
    number: 7,
    node_id: "PR_node",
    body: "## How I verified it\n\n```\nok\n```\n",
    draft: false,
    labels: [],
    html_url: `https://github.com/${REPO}/pull/7`,
    base: { sha: "b".repeat(40) },
    head: { sha: "h".repeat(40), repo: { full_name: REPO } },
  },
  ...over,
});

// A minimal ExecutionContext: waitUntil has to actually await, or an assertion
// on the GitHub calls would race the handler's background work.
function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}

async function post(payload: PullRequestEvent, opts: { signature?: string; event?: string; env?: Env } = {}) {
  const body = JSON.stringify(payload);
  const signature = opts.signature ?? (await sign(body));
  const request = new Request("https://pr-evidence.example/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      "x-github-event": opts.event ?? "pull_request",
      ...(signature ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
  const { ctx, settle } = makeCtx();
  const resp = await worker.fetch(request, opts.env ?? ENV, ctx);
  await settle();
  return resp;
}

let calls: Array<{ method: string; url: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/contents/")) {
      return Response.json({ encoding: "base64", content: btoa("## How I verified it\n") });
    }
    if (url.includes("/compare/")) return Response.json({ files: [{ filename: "src/page.astro" }] });
    if (url.includes("/issues/") && url.includes("/comments")) return Response.json([]);
    if (url.includes("/graphql")) {
      return Response.json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } });
    }
    return Response.json({});
  });
});

afterEach(() => vi.unstubAllGlobals());

const statusCall = () => calls.find((c) => c.url.includes("/statuses/"));
const commentCall = () => calls.find((c) => c.method !== "GET" && c.url.includes("/comments"));

describe("signature gate", () => {
  it("401s with no signature header", async () => {
    expect((await post(event(), { signature: "" })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("401s on a signature made with the wrong secret", async () => {
    const body = JSON.stringify(event());
    const bad = await sign(body, "not-the-secret");
    expect((await post(event(), { signature: bad })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("401s on a malformed signature", async () => {
    expect((await post(event(), { signature: "sha256=zzzz" })).status).toBe(401);
  });

  it("accepts a correctly signed payload", async () => {
    expect((await post(event())).status).toBe(202);
  });

  it("503s when no webhook secret is configured", async () => {
    const resp = await post(event(), { env: { ...ENV, GITHUB_WEBHOOK_SECRET: "" } });
    expect(resp.status).toBe(503);
  });

  it("verifySignature tolerates a bare hex digest with no sha256= prefix", async () => {
    const body = "x";
    const prefixed = await sign(body);
    expect(await verifySignature(body, prefixed.slice(7), SECRET)).toBe(true);
  });
});

describe("routing", () => {
  it("ignores a non-pull_request event", async () => {
    expect((await post(event(), { event: "push" })).status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("ignores an action outside the handled set", async () => {
    expect((await post(event({ action: "closed" }))).status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("ignores a repo that is not configured", async () => {
    const resp = await post(event({ repository: { full_name: "someone/else" } }));
    expect(resp.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("ignores a fork PR", async () => {
    const e = event();
    e.pull_request!.head!.repo = { full_name: "fork/site" };
    expect((await post(e)).status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("404s an unknown path", async () => {
    const { ctx } = makeCtx();
    const resp = await worker.fetch(new Request("https://pr-evidence.example/nope"), ENV, ctx);
    expect(resp.status).toBe(404);
  });

  it("healthz reports what is wired without naming it", async () => {
    const { ctx } = makeCtx();
    const resp = await worker.fetch(new Request("https://pr-evidence.example/healthz"), ENV, ctx);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json).toEqual({
      ok: true,
      service: "pr-evidence",
      repos_configured: 1,
      webhook_secret: true,
      github_token: true,
    });
  });
});

describe("bypass label", () => {
  it("comments, sets a green status, and touches no diff endpoint", async () => {
    const e = event();
    e.pull_request!.labels = [{ name: "skip-evidence-check" }];
    expect((await post(e)).status).toBe(202);

    expect(calls.some((c) => c.url.includes("/compare/"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
    expect(statusCall()!.body).toMatchObject({ state: "success", context: "pr-evidence" });
    expect(String((commentCall()!.body as { body: string }).body)).toContain(
      "bypassed by the `skip-evidence-check` label, added by @someone",
    );
  });

  it("a different label does not bypass", async () => {
    const e = event();
    e.pull_request!.labels = [{ name: "documentation" }];
    e.pull_request!.body = "## How I verified it\n\nnothing here";
    await post(e);
    expect(statusCall()!.body).toMatchObject({ state: "failure" });
  });
});

describe("verdict", () => {
  it("goes red and converts to draft when a UI change carries no evidence", async () => {
    expect((await post(event())).status).toBe(202);
    expect(statusCall()!.body).toMatchObject({ state: "failure", context: "pr-evidence" });
    expect(String((statusCall()!.body as { description: string }).description)).toContain("EVIDENCE");
    expect(calls.some((c) => c.url.includes("/graphql"))).toBe(true);
    const body = String((commentCall()!.body as { body: string }).body);
    expect(body).toContain("### PR evidence check");
    expect(body).toContain("Moved to draft");
  });

  it("goes green once the body carries a preview link", async () => {
    const e = event();
    e.pull_request!.body = "## How I verified it\n\n```\npnpm check\n```\n\nhttps://abc.pages.dev/";
    await post(e);
    expect(statusCall()!.body).toMatchObject({ state: "success" });
    expect(calls.some((c) => c.url.includes("/graphql"))).toBe(false);
  });

  it("does not try to draft a PR that is already a draft", async () => {
    const e = event();
    e.pull_request!.draft = true;
    await post(e);
    expect(statusCall()!.body).toMatchObject({ state: "failure" });
    expect(calls.some((c) => c.url.includes("/graphql"))).toBe(false);
  });
});

describe("config", () => {
  it("drops a repo entry with no ui_paths rather than waiving EVIDENCE", () => {
    const parsed = parseRepos(JSON.stringify({ "a/b": { preview_hosts: ["x"] }, "c/d": { ui_paths: ["src/*"] } }));
    expect([...parsed.keys()]).toEqual(["c/d"]);
  });

  it("returns an empty map on malformed JSON", () => {
    expect(parseRepos("{not json").size).toBe(0);
    expect(parseRepos(undefined).size).toBe(0);
  });

  it("fills the optional fields with the workflow's defaults", () => {
    const cfg = parseRepos(JSON.stringify({ "a/b": { ui_paths: ["src/*"] } })).get("a/b")!;
    expect(cfg).toMatchObject({
      preview_hosts: ["pages.dev", "workers.dev"],
      template_path: ".github/PULL_REQUEST_TEMPLATE.md",
      bypass_label: "skip-evidence-check",
      convert_to_draft: true,
    });
  });
});

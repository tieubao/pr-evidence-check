import { COMMENT_MARKER } from "./comment";

const API = "https://api.github.com";

export class GithubError extends Error {
  status: number;
  path: string;
  constructor(status: number, path: string) {
    super(`github ${status}: ${path}`);
    this.status = status;
    this.path = path;
  }
}

// Every path this Worker builds is a fixed API segment plus interpolated
// identifiers (repo names, shas, PR numbers). Any character outside this set
// means one of those identifiers arrived unvalidated. Reject before the URL is
// built. "..." is GitHub's own compare separator, so a bare ".." check would
// reject a legitimate path; only a ".." SEGMENT is traversal.
const PATH_SHAPE = /^\/[A-Za-z0-9/_.\-?=&%:]*$/;

function hasTraversalSegment(path: string): boolean {
  return path.split(/[/?]/).includes("..");
}

export async function gh(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  if (hasTraversalSegment(path) || !PATH_SHAPE.test(path)) {
    throw new GithubError(0, "rejected: path outside the expected github API shape");
  }
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pr-evidence",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new GithubError(resp.status, path);
  return resp;
}

// The workflow got the template from its checkout of the caller repo. The
// Worker has no checkout, so it reads the same file from the head sha. A
// missing template is not an error: the bash original wrote an empty
// template.txt in that case, and UNEDITED then trivially passes.
export async function fetchTemplate(
  token: string,
  repo: string,
  ref: string,
  templatePath: string,
): Promise<string> {
  try {
    const resp = await gh(token, "GET", `/repos/${repo}/contents/${templatePath}?ref=${ref}`);
    const json = (await resp.json()) as { content?: string; encoding?: string };
    if (json.encoding !== "base64" || typeof json.content !== "string") return "";
    return atob(json.content.replace(/\n/g, ""));
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return "";
    throw err;
  }
}

// The workflow ran `git diff --name-only base...head`. The compare endpoint is
// the same three-dot comparison (merge-base to head), so the file list matches.
// GitHub caps `files` at 300 entries per response; a diff that large already
// touches a UI path many times over, so the cap cannot flip EVIDENCE off.
export async function fetchChangedFiles(
  token: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const resp = await gh(token, "GET", `/repos/${repo}/compare/${baseSha}...${headSha}`);
  const json = (await resp.json()) as { files?: Array<{ filename?: string }> };
  return (json.files ?? []).map((f) => f.filename ?? "").filter(Boolean);
}

// One comment per PR, edited in place, found by its marker line. Same
// last-match-wins rule as the workflow's jq expression.
export async function upsertComment(token: string, repo: string, pr: number, body: string): Promise<void> {
  const resp = await gh(token, "GET", `/repos/${repo}/issues/${pr}/comments?per_page=100`);
  const comments = (await resp.json()) as Array<{ id: number; body?: string }>;
  const mine = comments.filter((c) => (c.body ?? "").startsWith(COMMENT_MARKER));
  const existing = mine.length > 0 ? mine[mine.length - 1]! : undefined;
  if (existing) {
    await gh(token, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  } else {
    await gh(token, "POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  }
}

// The Worker has no job whose exit code can go red, so the verdict is a commit
// status instead. A branch rule can require the `pr-evidence` context.
export async function setStatus(
  token: string,
  repo: string,
  sha: string,
  state: "success" | "failure",
  description: string,
  targetUrl?: string,
): Promise<void> {
  await gh(token, "POST", `/repos/${repo}/statuses/${sha}`, {
    state,
    context: "pr-evidence",
    description: description.slice(0, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

// GITHUB_TOKEN (an Actions job token or a GitHub App install token) cannot run
// this mutation: GraphQL answers FORBIDDEN "Resource not accessible by
// integration". Only a user PAT can. Returns the line to append to the
// comment, so a failed conversion is visible on the PR rather than only in
// the Worker log.
export async function convertToDraft(token: string, nodeId: string): Promise<string> {
  const query =
    "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }";
  const resp = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pr-evidence",
    },
    body: JSON.stringify({ query, variables: { id: nodeId } }),
  });
  const json = (await resp.json().catch(() => ({}))) as {
    data?: { convertPullRequestToDraft?: { pullRequest?: { isDraft?: boolean } } };
    errors?: Array<{ message?: string }>;
  };
  if (json.data?.convertPullRequestToDraft?.pullRequest?.isDraft === true) {
    return "Moved to draft because a check failed. Mark it ready for review again after fixing the body above.";
  }
  const msg = json.errors?.[0]?.message ?? "conversion did not report isDraft=true";
  return `Draft conversion failed: ${msg}`;
}

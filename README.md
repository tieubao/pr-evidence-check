# pr-evidence-check

A reusable GitHub Actions workflow that enforces one rule: a PR touching UI
paths must carry evidence it works, a screenshot, a video, or a preview
link, plus a filled-in "how I verified it" section. No leftover template
placeholder text either.

## Why

GitHub Free (private repos) has no branch protection and no required
reviewers/CODEOWNERS gate. There is no merge button to block. The one lever
that still works on Free is that a **draft PR has no merge button** either,
so this workflow's enforcement mechanism is: fail the checks, convert the PR
to draft, post a comment explaining why. The author un-drafts it once the
body actually says what they did.

## What it checks

| Check | What it means |
|---|---|
| UNEDITED | No line from the PR template survives verbatim in the body. Author wrote something. |
| VERIFIED | The `## How I verified it` section has real content (not template placeholder) and looks like a command or output: a fenced code block, a `$` line, a line starting with a known tool (`pnpm`, `npm`, `bash`, `node`, `go`, `cargo`, `make`, `curl`, `wrangler`), or containing `exit 0` / `passed` / `ok`. |
| EVIDENCE | Only required when the diff touches `ui_paths`. The body must link an image, video, GitHub attachment, or a preview host (`pages.dev`, `workers.dev` by default). |

Any failure: the check fails, the PR is converted to draft (unless
`convert_to_draft: false`), and a comment lists what to fix. The check never
marks a PR ready again automatically, only the author does that.

## Caller usage

```yaml
name: PR evidence
on:
  pull_request:
    types: [opened, edited, synchronize, ready_for_review, labeled, unlabeled]
jobs:
  evidence:
    if: github.event.pull_request.head.repo.full_name == github.repository
    uses: tieubao/pr-evidence-check/.github/workflows/evidence-check.yml@main
    with:
      runs_on: '["self-hosted","pr-shared"]'
      ui_paths: |
        apps/memo/**
        apps/home/**
    secrets:
      draft_token: ${{ secrets.PR_EVIDENCE_DRAFT_TOKEN }}
    permissions:
      contents: read
      pull-requests: write
```

The `if:` guard on the caller job matters: it keeps this workflow off fork
PRs, where the job token cannot comment or convert drafts anyway. Every
event type in `types:` matters too, especially `edited`, an author fixing
only the PR body (no new commit) still needs the check to re-run.

## Draft conversion needs a user PAT

`GITHUB_TOKEN` (the default Actions token, and a GitHub App install token
the same way) cannot convert a PR to draft. The `convertPullRequestToDraft`
GraphQL mutation returns:

```json
{"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}
```

GitHub does not allow a job token or App token to draft-convert a PR;
only a user token works. To get real draft conversion, create a
fine-grained personal access token and pass it through as the
`draft_token` secret:

1. GitHub -> Settings -> Developer settings -> Fine-grained tokens -> new
   token.
2. Repository access: only the repos that call this workflow (never "all
   repos").
3. Permissions: **Pull requests: Read and write**. Nothing else, this
   token does no other API call in this workflow.
4. Store it as a repo or org secret (e.g. `PR_EVIDENCE_DRAFT_TOKEN`) and
   pass it via `secrets: { draft_token: ... }` in the caller, as shown
   above.

Without this secret, the workflow still runs and still fails the check on
a bad PR body: it just cannot flip the PR to draft. The comment says
"Draft conversion unavailable: no draft_token secret configured" and the
check stays red, advisory-only, a reviewer has to notice and not merge.
With the secret, a failing check also moves the PR to draft so there is no
merge button at all.

## Inputs

| Input | Type | Default | Meaning |
|---|---|---|---|
| `runs_on` | string (JSON array) | required | Runner labels, e.g. `'["self-hosted","pr-shared"]'` |
| `ui_paths` | string (newline globs) | required | Glob patterns; a diff touching any of them requires EVIDENCE |
| `template_path` | string | `.github/PULL_REQUEST_TEMPLATE.md` | Where to read the PR template from, for the UNEDITED check |
| `bypass_label` | string | `skip-evidence-check` | Label that skips the whole check |
| `preview_hosts` | string (newline substrings) | `pages.dev\nworkers.dev` | Extra hostnames that count as EVIDENCE when linked in the body |
| `convert_to_draft` | boolean | `true` | Convert the PR to draft on any failure |

## Bypass

Add the `skip-evidence-check` label (or whatever `bypass_label` is set to)
to any PR to skip the check entirely. The comment records who added the
label. Use this for docs-only PRs mislabeled as UI-touching, or genuine
exceptions, not as a habit.

## Glob matching

`ui_paths` globs are matched with bash's `[[ "$file" == $pattern ]]`, not
real filesystem globbing. `**` is not special here: fnmatch collapses
repeated `*` into one, and a single `*` already matches any run of
characters including `/`, so `src/**` and `src/*` behave identically and
both correctly match `src/a/b/c.ts`. See the comment in
`scripts/check-body.sh` above the `ui_touched` block.

## Test locally

The actual checking logic lives in `scripts/check-body.sh`, a pure function:
body file + template file + changed-files file + UI-path globs in, a
single-line JSON verdict out. No git, no GitHub API, so it runs anywhere:

```bash
bash scripts/check-body.sh \
  --body path/to/pr-body.md \
  --template .github/PULL_REQUEST_TEMPLATE.md \
  --changed-files path/to/changed-files.txt \
  --ui-paths path/to/ui-paths.txt \
  --preview-hosts path/to/preview-hosts.txt
```

`changed-files.txt` is one path per line (what `git diff --name-only` would
print). `ui-paths.txt` and `preview-hosts.txt` are newline-separated, same
shape as the workflow inputs.

Run the test suite:

```bash
bash tests/run.sh
```

Fixtures live in `tests/fixtures/`: a raw (unedited) template body, a filled
body with real evidence, and a filled body with no evidence, run against
both UI-touched and UI-not-touched changed-file lists. `tests/run.sh` also
runs a negative control: it strips the preview link out of the passing
fixture on a temp copy and confirms EVIDENCE now fails, proving the check
actually depends on that link rather than always passing.

The workflow itself (`.github/workflows/evidence-check.yml`) is plumbing
only: checkout, `git diff`, write inputs to files, call
`scripts/check-body.sh`, then curl the GitHub API to comment and, on
failure, convert the PR to draft via the `convertPullRequestToDraft`
GraphQL mutation. All the actual judgment calls live in the tested script.

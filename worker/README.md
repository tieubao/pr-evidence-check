# The `pr-evidence` Worker

The same check as `.github/workflows/evidence-check.yml`, run by a Cloudflare
Worker off a GitHub `pull_request` webhook instead of by a GitHub Actions job.
Reach for it when a repo should not pay for Actions minutes and should not
need a self-hosted runner: the Worker needs neither.

The workflow stays in this repo. Both paths call the same rules, and
`worker/test/parity.test.ts` runs the shell original and the TypeScript port
over every fixture combination and fails if their verdicts differ.

## What runs where

```
  GitHub                         Cloudflare
  ------                         ----------
  pull_request event
    opened / edited / synchronize
    ready_for_review
    labeled / unlabeled
        |
        |  POST /github/webhook
        |  X-Hub-Signature-256: sha256=<hmac of the raw body>
        v
                              +--------------------------+
                              |  Worker  pr-evidence     |
                              |                          |
                              |  1 body cap (1 MiB)      |
                              |  2 HMAC verify           |
                              |  3 repo in REPOS?        |
                              |  4 action handled?       |
                              |  5 fork? -> ignore       |
                              |  6 bypass label? -> green|
                              |  7 check.ts verdict      |
                              +-----------+--------------+
                                          |
        +---------------------------------+
        |            |              |            |
        v            v              v            v
   GET template  GET compare   POST/PATCH    POST status
   (head sha)    base...head   PR comment    context=pr-evidence
                                    |
                                    +-- on failure, GraphQL
                                        convertPullRequestToDraft
```

## Deliberate differences from the workflow

| Workflow | Worker | Why |
|---|---|---|
| Red = the job's exit code | Red = a commit status, context `pr-evidence` | A Worker has no job to fail. A branch rule can require the context. |
| `runs_on` input | gone | No runner. |
| `git diff --name-only base...head` from a checkout | `GET /repos/:repo/compare/:base...:head` | Same three-dot comparison, no checkout. GitHub caps the file list at 300 entries. |
| Template read from the checkout | `GET /contents/<template_path>?ref=<head sha>` | Same file, same commit. A 404 is treated as an empty template, exactly as the shell wrote an empty `template.txt`. |
| Bypass comment credits `github.actor` | credits `sender.login` | The webhook's equivalent field. |
| Inputs live in the caller's YAML | Config lives in the `REPOS` secret | This repo is public. No installation's repo names or path globs are committed. |
| One workflow run per event, visible in the Actions tab | One Worker invocation, visible in Workers Logs | `observability` is on; `wrangler tail` follows live. |

Everything else is unchanged: the same bypass label, the same path filter, the
same UNEDITED / VERIFIED / EVIDENCE rules, the same comment text, the same
single comment edited in place, the same draft conversion.

## Configuration

Three wrangler secrets. Nothing is a `var`: `wrangler deploy` replaces the
config's whole `vars` block on every deploy, and this Worker deploys from a
public repo, so a var set out of band would not survive.

| Secret | What |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | The webhook's shared secret. Generate with `openssl rand -hex 32`, store it, then set it on both sides. |
| `GITHUB_TOKEN` | A fine-grained user PAT. Needs, on each configured repo: Pull requests read+write (comment, draft-convert), Commit statuses read+write, Contents read (template + compare). Draft conversion needs a *user* token; an Actions job token or App token gets `FORBIDDEN "Resource not accessible by integration"`. |
| `REPOS` | The per-installation table, JSON. |

`REPOS` shape, one entry per repo:

```json
{
  "owner/repo": {
    "ui_paths": ["src/**", "public/**"],
    "preview_hosts": ["pages.dev", "workers.dev"],
    "template_path": ".github/PULL_REQUEST_TEMPLATE.md",
    "bypass_label": "skip-evidence-check",
    "convert_to_draft": true
  }
}
```

Only `ui_paths` is required, and an entry without it is dropped with a log
line rather than defaulted: an empty `ui_paths` would waive EVIDENCE on every
PR, and a check that silently stops checking is worse than a missing one. The
other four fall back to the workflow's own defaults, shown above.

## Routes

| Path | Method | Answer |
|---|---|---|
| `/healthz` | GET | `{ok, service, repos_configured, webhook_secret, github_token}`. Counts and booleans only, never a name or a value. |
| `/github/webhook` | POST | 401 unsigned or badly signed, 413 over 1 MiB, 400 malformed JSON, 204 accepted and ignored, 202 accepted and judging. |
| anything else | any | 404 |

## Install on a repo

1. Deploy the Worker and set the three secrets (`deploy/workers-builds/README.md`).
2. Add the repo to `REPOS` and re-set that secret.
3. Register the webhook on the repo:

   ```bash
   secret=$(openssl rand -hex 32)   # store it, then: wrangler secret put GITHUB_WEBHOOK_SECRET
   gh api -X POST /repos/OWNER/REPO/hooks -f name=web -F active=true \
     -f 'events[]=pull_request' \
     -f config[url]='https://pr-evidence.<subdomain>.workers.dev/github/webhook' \
     -f config[content_type]=json -f config[secret]="$secret"
   ```

4. Optional: require the `pr-evidence` status in a branch rule.

Run the two side by side for one PR before making the workflow dormant. Both
should reach the same verdict; that is what parity means.

## Test

```bash
npm install
npm test          # check parity, webhook gate, config parsing
npx tsc --noEmit
bash tests/run.sh # the shell implementation on its own
```

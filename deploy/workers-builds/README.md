# Deploying the `pr-evidence` Worker

CI and deploy for the Worker run on Cloudflare Workers Builds. A push to `main`
installs, runs the test suite, typechecks, and deploys. The repo's own GitHub
Actions CI (`.github/workflows/ci.yml`) still runs on pull requests, because
this repo is public and hosted minutes are free there.

## Topology

| Piece | Where |
|---|---|
| Worker | `pr-evidence`, the operator's Cloudflare account (id read from 1Password, never committed) |
| Repo | `tieubao/pr-evidence-check`, connected through the Cloudflare GitHub App |
| Production trigger | builds `main`, runs `npm test` and `tsc`, deploys |
| Runtime config | three wrangler secrets, set once, outside this repo (see below) |
| Webhook | a `pull_request` hook on each watched repo, pointing at `/github/webhook` |

## First deploy

A Builds trigger attaches to an existing script; it does not create one. So
the Worker is deployed once by hand, then handed to Builds.

```bash
npm ci
CLOUDFLARE_ACCOUNT_ID="$(op read op://Toolkit/cf-account-id/credential)" \
  npx wrangler deploy                     # creates the script
OPS_TOOLKIT_ROOT=<ops-toolkit checkout> bash deploy/workers-builds/apply.sh       # dry run, prints the plan
OPS_TOOLKIT_ROOT=<ops-toolkit checkout> bash deploy/workers-builds/apply.sh --apply

# or point WORKERS_BUILDS_APPLY straight at the canonical apply.sh
```

`apply.sh` is a thin shim that delegates to the canonical implementation
(`tools/workers-builds/apply.sh` in the operator's ops-toolkit). It reads the
account id and both Cloudflare tokens from 1Password at
run time. Override the references with `OP_ACCOUNT_REF`, `OP_ADMIN_TOKEN_REF`,
and `OP_DEPLOY_TOKEN_REF` if your vault is laid out differently.

## Secrets

Set once with `wrangler secret put`. Secrets survive a deploy; `vars` do not,
which is why none of the three is a var.

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET   # openssl rand -hex 32, same value as the GitHub hook
wrangler secret put GITHUB_TOKEN            # fine-grained user PAT, permissions in worker/README.md
wrangler secret put REPOS                   # the per-installation JSON table
```

Verify without printing any of them:

```bash
curl -s https://pr-evidence.<subdomain>.workers.dev/healthz
# {"ok":true,"service":"pr-evidence","repos_configured":1,"webhook_secret":true,"github_token":true}
```

## Anti-drift

`trigger-production.json` is the source of truth. Edit the JSON, run
`apply.sh --apply`, commit. Never edit a trigger in the Cloudflare dashboard:
the next `apply.sh` run reverts it without warning. `apply.sh` is idempotent,
matching triggers by `trigger_name`.

## No preview trigger

PR branches get no Cloudflare build. Pull requests are gated by
`.github/workflows/ci.yml` on hosted runners, which is free on a public repo.
Add a `trigger-preview.json` if that changes; `apply.sh` picks up any
`trigger-*.json` in this directory with no code change.

## Rebuild from zero

1. `npm ci && CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy` to recreate the script.
2. Install the Cloudflare GitHub App for the owner and grant it this repo.
3. `bash deploy/workers-builds/apply.sh --apply`.
4. Re-set the three wrangler secrets.
5. Re-point each watched repo's webhook at the new `workers.dev` URL if the
   subdomain changed (`gh api /repos/OWNER/REPO/hooks`).

## Reverting to GitHub Actions

`.github/workflows/evidence-check.yml` is still here and still supported. A
repo moves back by restoring its caller workflow's `pull_request` trigger and
deleting its `pull_request` webhook, in that order. Nothing about the Worker
needs to change; dropping the repo from `REPOS` is the tidy second step.

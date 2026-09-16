#!/usr/bin/env bash
# Apply this repo's Cloudflare Workers Builds configuration from the JSON payloads next to this script.
# The repo is the source of truth; never hand-edit a trigger in the Cloudflare dashboard, or the next run
# of this script silently reverts the edit.
#
# Idempotent: creates what is missing, patches what exists, matching triggers by trigger_name.
#
#   bash deploy/workers-builds/apply.sh          # dry run, prints the plan
#   bash deploy/workers-builds/apply.sh --apply  # write
#
# Runbook: deploy/workers-builds/README.md
set -uo pipefail
set +x   # an operator debugging a failed apply reaches for `bash -x`, which would print both tokens

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API=https://api.cloudflare.com/client/v4
WORKER=pr-evidence
GH_OWNER=tieubao
GH_REPO=pr-evidence-check
BUILD_TOKEN_NAME="pr-evidence builds"

# Operator-overridable so this public repo names no vault layout as a hard requirement.
OP_ACCOUNT_REF="${OP_ACCOUNT_REF:-op://Toolkit/cf-account-id/credential}"
OP_ADMIN_TOKEN_REF="${OP_ADMIN_TOKEN_REF:-op://Toolkit/cf-api-token/credential}"
OP_DEPLOY_TOKEN_REF="${OP_DEPLOY_TOKEN_REF:-op://Toolkit/cf-api-token/credential}"

say() { printf '%s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

op_read() { env -u OP_CONNECT_HOST -u OP_CONNECT_TOKEN op read "$1"; }

# No account id is committed (this repo is public), so it is resolved at run time.
ACC=$(op_read "$OP_ACCOUNT_REF")
[ -z "$ACC" ] && die "account id read empty; refusing to continue"

# Config-plane token: Workers Builds Configuration Edit + Workers Scripts Read.
ADMIN=$(op_read "$OP_ADMIN_TOKEN_REF")
[ -z "$ADMIN" ] && die "admin token read empty; refusing to continue"

# Deploy-plane token: what the BUILD uses for `wrangler deploy`. An empty read here would store a blank
# build secret that still reports success, so it is checked before any write.
DEPLOY_TOKEN=$(op_read "$OP_DEPLOY_TOKEN_REF")
[ -z "$DEPLOY_TOKEN" ] && die "deploy token read empty; refusing to store a blank build secret"

# Non-empty is not live. A revoked value passes the emptiness check, lands in the trigger secret, and
# surfaces only as a red build, which notifies nobody. The same call yields the token id that the
# build-token create needs as cloudflare_token_id.
tok_verify=$(curl -s -H "Authorization: Bearer $DEPLOY_TOKEN" "$API/user/tokens/verify")
tok_status=$(printf '%s' "$tok_verify" | jq -r '.result.status // "unverifiable"')
DEPLOY_TOKEN_ID=$(printf '%s' "$tok_verify" | jq -r '.result.id // empty')
[ "$tok_status" != "active" ] && die "deploy token does not verify (status=$tok_status); refusing to store a dead build secret"
[ -z "$DEPLOY_TOKEN_ID" ] && die "token verify returned no id; cannot create a build token without cloudflare_token_id"

cf() {
  local method="$1" path="$2" body="${3:-}"
  # The env-var call's body carries the deploy token, so it goes in on stdin rather than argv.
  if [ -n "$body" ]; then
    printf '%s' "$body" | curl -s -X "$method" \
      -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$API$path" --data @-
  else
    curl -s -X "$method" -H "Authorization: Bearer $ADMIN" "$API$path"
  fi
}

ok() { printf '%s' "$1" | jq -e '.success == true' >/dev/null 2>&1; }
errs() { printf '%s' "$1" | jq -c '(.errors // []) | map(.message)'; }

say "### worker tag"
# The Worker must already exist: a Builds trigger attaches to a script, it does not create one.
# First deploy is `CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy` from the repo root.
tag=$(cf GET "/accounts/$ACC/workers/scripts" | jq -r --arg w "$WORKER" '.result[]? | select(.id==$w) | .tag')
[ -z "$tag" ] || [ "$tag" = "null" ] && die "worker '$WORKER' not found on this account; deploy it once by hand first"
say "  $WORKER -> $tag"

say "### github ids"
# Authenticated on both calls. Unauthenticated api.github.com is 60 req/hour per IP, and a rate-limited
# response yields the string "null", which would flow into provider_account_id.
gh_user_id=$(gh api "users/$GH_OWNER" --jq '.id' 2>/dev/null)
gh_repo_id=$(gh api "repos/$GH_OWNER/$GH_REPO" --jq '.id' 2>/dev/null)
for v in "$gh_user_id" "$gh_repo_id"; do
  [ -z "$v" ] || [ "$v" = "null" ] && die "cannot resolve GitHub ids for $GH_OWNER/$GH_REPO"
done
say "  $GH_OWNER=$gh_user_id  $GH_REPO=$gh_repo_id"

if [ "$APPLY" -eq 0 ]; then
  say
  say "dry run. Would upsert the repo connection, ensure a build token, and create or patch:"
  for f in "$HERE"/trigger-*.json; do
    say "  $(basename "$f"): $(jq -r '.trigger_name' "$f")  branches=$(jq -c '.branch_includes' "$f")"
  done
  say
  say "re-run with --apply to write."
  exit 0
fi

say "### repo connection"
conn=$(cf PUT "/accounts/$ACC/builds/repos/connections" "$(jq -n \
  --arg pa "$gh_user_id" --arg pn "$GH_OWNER" --arg ri "$gh_repo_id" --arg rn "$GH_REPO" \
  '{provider_type:"github", provider_account_id:$pa, provider_account_name:$pn, repo_id:$ri, repo_name:$rn}')")
ok "$conn" || die "repo connection failed: $(errs "$conn"). If this says the repo is not accessible, grant the Cloudflare GitHub App access to $GH_OWNER/$GH_REPO once, in GitHub app settings."
conn_uuid=$(printf '%s' "$conn" | jq -r '.result.repo_connection_uuid')
[ -z "$conn_uuid" ] || [ "$conn_uuid" = "null" ] && die "repo connection returned no uuid"
say "  connection $conn_uuid"

say "### build token"
tokens=$(cf GET "/accounts/$ACC/builds/tokens")
ok "$tokens" || die "build token list failed: $(errs "$tokens")"
# Match by the name this script creates. Selecting .result[0] would bind the trigger to whichever project
# the API happened to return first, and that choice could change between runs.
btok=$(printf '%s' "$tokens" | jq -r --arg n "$BUILD_TOKEN_NAME" \
  '.result[]? | select(.build_token_name==$n) | .build_token_uuid' | head -1)
if [ -z "$btok" ]; then
  created=$(cf POST "/accounts/$ACC/builds/tokens" \
    "$(jq -n --arg n "$BUILD_TOKEN_NAME" --arg s "$DEPLOY_TOKEN" --arg i "$DEPLOY_TOKEN_ID" \
      '{build_token_name:$n, build_token_secret:$s, cloudflare_token_id:$i}')")
  ok "$created" || die "build token create failed: $(errs "$created")"
  btok=$(printf '%s' "$created" | jq -r '.result.build_token_uuid')
  say "  created $btok"
else
  say "  reusing $btok"
fi
[ -z "$btok" ] || [ "$btok" = "null" ] && die "no build token uuid"

existing=$(cf GET "/accounts/$ACC/builds/workers/$tag/triggers")
# Unchecked, any transient failure reads as "no triggers exist" and the loop CREATES a duplicate instead
# of patching. Cloudflare does not dedupe by name, so a duplicate production trigger means two concurrent
# deploys on every push.
ok "$existing" || die "trigger list failed: $(errs "$existing")"

for f in "$HERE"/trigger-*.json; do
  name=$(jq -r '.trigger_name' "$f")
  payload=$(cat "$f")
  uuid=$(printf '%s' "$existing" | jq -r --arg n "$name" '.result[]? | select(.trigger_name==$n) | .trigger_uuid' | head -1)

  if [ -z "$uuid" ]; then
    body=$(printf '%s' "$payload" | jq --arg s "$tag" --arg c "$conn_uuid" --arg b "$btok" \
      '. + {external_script_id:$s, repo_connection_uuid:$c, build_token_uuid:$b}')
    res=$(cf POST "/accounts/$ACC/builds/triggers" "$body")
    ok "$res" || die "create '$name' failed: $(errs "$res")"
    uuid=$(printf '%s' "$res" | jq -r '.result.trigger_uuid')
    say "### created '$name' -> $uuid"
  else
    res=$(cf PATCH "/accounts/$ACC/builds/triggers/$uuid" "$payload")
    ok "$res" || die "patch '$name' failed: $(errs "$res")"
    say "### patched '$name' -> $uuid"
  fi

  envbody=$(jq -n --arg t "$DEPLOY_TOKEN" --arg a "$ACC" \
    '{CLOUDFLARE_API_TOKEN:{value:$t, is_secret:true}, CLOUDFLARE_ACCOUNT_ID:{value:$a, is_secret:true}}')
  res=$(cf PATCH "/accounts/$ACC/builds/triggers/$uuid/environment_variables" "$envbody")
  ok "$res" || die "env vars for '$name' failed: $(errs "$res"). Trigger $uuid EXISTS but has no credentials; re-run --apply, or delete it."
  say "  env set: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID"
done

say
say "done. The production trigger fires on $(jq -c '.branch_includes' "$HERE/trigger-production.json")."
say "The three wrangler secrets are NOT set here: GITHUB_WEBHOOK_SECRET, GITHUB_TOKEN, REPOS survive"
say "deploys and are set once with 'wrangler secret put'. See deploy/workers-builds/README.md."

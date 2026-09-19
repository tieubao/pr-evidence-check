# workers-builds shim: proof of done

Change: `deploy/workers-builds/apply.sh` delegates to the canonical
`tools/workers-builds/apply.sh` (the operator's ops-toolkit). The upstream
location comes from `WORKERS_BUILDS_APPLY` or `OPS_TOOLKIT_ROOT` because this
repo is public and names no local layout.

## Green run (real primary flow, dry-run mode)

Command: `OPS_TOOLKIT_ROOT=<checkout> bash deploy/workers-builds/apply.sh`
Exit: 0

```
### worker tag
  pr-evidence -> 78d4408aa38f4cbb9ef5db1b5a9967b7
### github ids
  tieubao=1749624  pr-evidence-check=1369423632
dry run. Would upsert the repo connection, ensure a build token, and create or patch:
  trigger-production.json: Deploy production  branches=["main"]  token=yes
re-run with --apply to write.
```

Worker tag and GitHub IDs resolved live, the trigger named, zero write calls.

## Negative control

Command: `bash deploy/workers-builds/apply.sh` (no env set)
Exit: 1, `!! set WORKERS_BUILDS_APPLY or OPS_TOOLKIT_ROOT ...`. The shim fails
closed instead of guessing a path.

## Rollback

`git revert` restores the standalone script; the trigger JSON is unchanged
either way. No `--apply` run was made, so no Cloudflare state moved.

## Not attempted

No `--apply` run: the live trigger config is already correct and a write is
only needed when the JSON payload changes.

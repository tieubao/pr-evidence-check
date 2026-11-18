# judge error status: proof of done

Change: `judge()` runs inside `waitUntil` after the webhook already answered 202. A GitHub non-2xx threw out of it, no commit status was set, and a required `pr-evidence` check stayed pending forever (GitHub does not redeliver a 202). `judgeOrReportError` now catches, logs, and best-effort sets an `error` status whose description carries only the HTTP status.

## Green run

Command: `npm test && npm run typecheck`
Exit: 0
Output:

```
 Test Files  3 passed (3)
      Tests  106 passed (106)
> tsc --noEmit
```

Verdict: PASS

## Red before the fix

Command: `npx vitest run worker/test/webhook.test.ts` (new tests added, fix absent)
Exit: 1
Output:

```
Error: github 502: /repos/owner/site/contents/.github/PULL_REQUEST_TEMPLATE.md?ref=hhhh...
 Tests  2 failed | 20 passed (22)
```

## Negative control

Command: revert only `waitUntil(judgeOrReportError(...))` to `waitUntil(judge(...))`, then `npx vitest run worker/test/webhook.test.ts`
Exit: 1
Output:

```
 FAIL  GitHub failure while judging > sets an error status when a GitHub read fails, and does not reject waitUntil
 FAIL  GitHub failure while judging > survives the error status call failing too
 Tests  2 failed | 20 passed (22)
```

Restored afterwards (`git checkout worker/src/index.ts`).

## Rollback

`git revert`. No Cloudflare state touched, no deploy.

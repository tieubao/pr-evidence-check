## What changed

Tightened the retry loop.

## How I verified it

rg -c 'retryLegacy' src/
returned 0 hits, the old path is gone.

## Screenshots / evidence

N/A, backend-only change.

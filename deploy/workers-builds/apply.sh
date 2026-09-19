#!/usr/bin/env bash
# Thin shim: delegates to the canonical Workers Builds apply implementation
# (ops-toolkit `tools/workers-builds/apply.sh`). The trigger-*.json payloads
# next to this script stay this repo's source of truth; the page logic lives
# upstream. This repo is public, so the upstream location comes from the
# environment, never a hardcoded path:
#
#   WORKERS_BUILDS_APPLY=<path-to-canonical-apply.sh> bash deploy/workers-builds/apply.sh
#   OPS_TOOLKIT_ROOT=<ops-toolkit checkout>           bash deploy/workers-builds/apply.sh
#
# add --apply to write; without it the run is a dry run that prints the plan.
set -uo pipefail

CANONICAL="${WORKERS_BUILDS_APPLY:-${OPS_TOOLKIT_ROOT:+$OPS_TOOLKIT_ROOT/tools/workers-builds/apply.sh}}"
if [ -z "$CANONICAL" ] || [ ! -f "$CANONICAL" ]; then
    printf '!! set WORKERS_BUILDS_APPLY or OPS_TOOLKIT_ROOT to the canonical workers-builds apply.sh\n' >&2
    exit 1
fi

exec bash "$CANONICAL" \
    --worker pr-evidence --repo tieubao/pr-evidence-check \
    --dir "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" "$@"

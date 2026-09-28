#!/usr/bin/env bash
# Start a Workers Builds build for pr-evidence on demand. Deploys are
# manual-only: the production trigger's path_includes is pinned to a path no
# commit touches, so pushes never build. This is the build trigger.
exec bash "${OPS_TOOLKIT_ROOT:-$HOME/workspace/tieubao/ops-toolkit}/tools/workers-builds/run.sh" \
    --worker pr-evidence "$@"

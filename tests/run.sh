#!/usr/bin/env bash
# Unit tests for scripts/check-body.sh, offline (no git, no GitHub API).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FX="$ROOT/tests/fixtures"
CHECK="$ROOT/scripts/check-body.sh"

fail_count=0

# check_result NAME BODY_FILE CHANGED_FILES_FILE EXPECT_JQ
# EXPECT_JQ is a jq boolean expression evaluated against the check's JSON
# output; the test passes if it evaluates to true.
check_result() {
  local name="$1" body="$2" changed="$3" expect="$4"
  local json
  json=$(bash "$CHECK" \
    --body "$body" --template "$FX/template.md" \
    --changed-files "$changed" \
    --ui-paths "$FX/ui-paths.txt" --preview-hosts "$FX/preview-hosts.txt")
  if jq -e "$expect" <<< "$json" > /dev/null 2>&1; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    echo "  expect: $expect"
    echo "  got:    $json"
    fail_count=$((fail_count + 1))
  fi
}

# check_result_tpl: like check_result but with an explicit template path,
# for fixtures that use a different template than $FX/template.md.
check_result_tpl() {
  local name="$1" template="$2" body="$3" changed="$4" expect="$5"
  local json
  json=$(bash "$CHECK" \
    --body "$body" --template "$template" \
    --changed-files "$changed" \
    --ui-paths "$FX/ui-paths.txt" --preview-hosts "$FX/preview-hosts.txt")
  if jq -e "$expect" <<< "$json" > /dev/null 2>&1; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    echo "  expect: $expect"
    echo "  got:    $json"
    fail_count=$((fail_count + 1))
  fi
}

# (a) raw template body, UI touched: fails VERIFIED, EVIDENCE.
# UNEDITED now passes: template.md's placeholders are pure single-line HTML
# comments, so once comments are stripped there is no visible placeholder
# text left to compare -- see fixture (f) for a template with a mix of
# comments and visible leftover lines, where UNEDITED does still fail.
check_result "a: raw template + UI touched -> UNEDITED passes (comment-only template, nothing visible to compare)" \
  "$FX/raw-template-body.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "UNEDITED") | .pass) == true'
check_result "a: raw template + UI touched -> VERIFIED fails" \
  "$FX/raw-template-body.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "VERIFIED") | .pass) == false'
check_result "a: raw template + UI touched -> EVIDENCE fails" \
  "$FX/raw-template-body.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "EVIDENCE") | .pass) == false'
check_result "a: raw template + UI touched -> overall fails" \
  "$FX/raw-template-body.md" "$FX/changed-files-ui.txt" \
  '.overall_pass == false'

# (b) filled body with pnpm output + pages.dev link, UI touched: passes
check_result "b: filled + evidence + UI touched -> overall passes" \
  "$FX/filled-with-evidence.md" "$FX/changed-files-ui.txt" \
  '.overall_pass == true'

# (c) filled body, no evidence, UI not touched: passes, EVIDENCE not required
check_result "c: filled + no evidence + UI not touched -> overall passes" \
  "$FX/filled-no-evidence.md" "$FX/changed-files-no-ui.txt" \
  '.overall_pass == true'
check_result "c: filled + no evidence + UI not touched -> EVIDENCE not required" \
  "$FX/filled-no-evidence.md" "$FX/changed-files-no-ui.txt" \
  '(.checks[] | select(.name == "EVIDENCE") | .required) == false'

# (d) filled body, no evidence, UI touched: fails EVIDENCE only
check_result "d: filled + no evidence + UI touched -> UNEDITED passes" \
  "$FX/filled-no-evidence.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "UNEDITED") | .pass) == true'
check_result "d: filled + no evidence + UI touched -> VERIFIED passes" \
  "$FX/filled-no-evidence.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "VERIFIED") | .pass) == true'
check_result "d: filled + no evidence + UI touched -> EVIDENCE fails" \
  "$FX/filled-no-evidence.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "EVIDENCE") | .pass) == false'
check_result "d: filled + no evidence + UI touched -> overall fails" \
  "$FX/filled-no-evidence.md" "$FX/changed-files-ui.txt" \
  '.overall_pass == false'

# (e) real foundation-apps template, filled with real content but the
# author left every HTML comment in place (GitHub barely renders them, so
# people rarely notice and delete them): must PASS UNEDITED and VERIFIED.
check_result_tpl "e: real template, filled body keeps HTML comments -> UNEDITED passes" \
  "$FX/template-real.md" "$FX/filled-keeps-comments.md" "$FX/changed-files-no-ui.txt" \
  '(.checks[] | select(.name == "UNEDITED") | .pass) == true'
check_result_tpl "e: real template, filled body keeps HTML comments -> VERIFIED passes" \
  "$FX/template-real.md" "$FX/filled-keeps-comments.md" "$FX/changed-files-no-ui.txt" \
  '(.checks[] | select(.name == "VERIFIED") | .pass) == true'
check_result_tpl "e: real template, filled body keeps HTML comments -> overall passes" \
  "$FX/template-real.md" "$FX/filled-keeps-comments.md" "$FX/changed-files-no-ui.txt" \
  '.overall_pass == true'

# (f) real foundation-apps template used verbatim as the body (raw,
# unedited), UI touched. Unlike (a), this template has visible non-comment
# lines outside the comments (the checklist items), so UNEDITED does fail
# here; VERIFIED and EVIDENCE fail regardless of that.
check_result_tpl "f: raw real template + UI touched -> UNEDITED fails" \
  "$FX/template-real.md" "$FX/raw-template-real-body.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "UNEDITED") | .pass) == false'
check_result_tpl "f: raw real template + UI touched -> VERIFIED fails" \
  "$FX/template-real.md" "$FX/raw-template-real-body.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "VERIFIED") | .pass) == false'
check_result_tpl "f: raw real template + UI touched -> EVIDENCE fails" \
  "$FX/template-real.md" "$FX/raw-template-real-body.md" "$FX/changed-files-ui.txt" \
  '(.checks[] | select(.name == "EVIDENCE") | .pass) == false'
check_result_tpl "f: raw real template + UI touched -> overall fails" \
  "$FX/template-real.md" "$FX/raw-template-real-body.md" "$FX/changed-files-ui.txt" \
  '.overall_pass == false'

# --- negative control ---
# Confirm fixture (b) actually depends on the pages.dev link: strip it on a
# TEMP COPY (never mutate the tracked fixture -- no restore step needed,
# and a mid-run crash can't leave the repo dirty), rerun, and expect
# EVIDENCE to now fail.
echo
echo "--- negative control: drop the pages.dev link from fixture (b) ---"
tmp_body="$(mktemp)"
grep -v 'pages.dev' "$FX/filled-with-evidence.md" > "$tmp_body"
neg_json=$(bash "$CHECK" \
  --body "$tmp_body" --template "$FX/template.md" \
  --changed-files "$FX/changed-files-ui.txt" \
  --ui-paths "$FX/ui-paths.txt" --preview-hosts "$FX/preview-hosts.txt")
rm -f "$tmp_body"
if jq -e '(.checks[] | select(.name == "EVIDENCE") | .pass) == false' <<< "$neg_json" > /dev/null 2>&1; then
  echo "PASS: negative control -- EVIDENCE fails once the link is gone"
else
  echo "FAIL: negative control -- EVIDENCE should fail without the link"
  echo "  got: $neg_json"
  fail_count=$((fail_count + 1))
fi
if jq -e '(.checks[] | select(.name == "UNEDITED") | .pass) == true and (.checks[] | select(.name == "VERIFIED") | .pass) == true' <<< "$neg_json" > /dev/null 2>&1; then
  echo "PASS: negative control -- UNEDITED and VERIFIED unaffected"
else
  echo "FAIL: negative control -- UNEDITED/VERIFIED should still pass"
  echo "  got: $neg_json"
  fail_count=$((fail_count + 1))
fi

echo
if [ "$fail_count" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "$fail_count test(s) failed."
  exit 1
fi

#!/usr/bin/env bash
# Pure PR-evidence checking logic: no GitHub API calls, no git, no network.
# Reads a PR body, an optional PR template, a list of changed files, and a
# list of UI-path globs, and prints a single-line JSON verdict on stdout.
#
# Kept separate from the workflow so it is unit-testable offline
# (tests/run.sh drives it directly against tests/fixtures/).
set -euo pipefail

usage() {
  echo "usage: $0 --body FILE --template FILE --changed-files FILE --ui-paths FILE --preview-hosts FILE" >&2
  exit 2
}

body_file="" template_file="" changed_files_file="" ui_paths_file="" preview_hosts_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --body) body_file="$2"; shift 2 ;;
    --template) template_file="$2"; shift 2 ;;
    --changed-files) changed_files_file="$2"; shift 2 ;;
    --ui-paths) ui_paths_file="$2"; shift 2 ;;
    --preview-hosts) preview_hosts_file="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$body_file" ] && [ -n "$changed_files_file" ] && [ -n "$ui_paths_file" ] || usage

read_or_empty() { [ -n "${1:-}" ] && [ -f "$1" ] && cat "$1" || true; }

BODY="$(read_or_empty "$body_file")"
TEMPLATE="$(read_or_empty "$template_file")"
CHANGED="$(read_or_empty "$changed_files_file")"
UI_PATTERNS="$(read_or_empty "$ui_paths_file")"
PREVIEW_HOSTS="$(read_or_empty "$preview_hosts_file")"

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

# --- strip HTML comments ------------------------------------------------
# GitHub's PR-body editor renders <!-- ... --> template guidance as
# barely-visible text that authors routinely leave in place (they never
# typed it, so they never think to delete it), and a comment can span
# many lines. An awk state machine strips every <!-- ... --> block,
# multi-line aware, before either UNEDITED or VERIFIED looks at the text,
# so leftover guidance never counts as either real content or a leftover
# placeholder line.
strip_html_comments() {
  awk '
    BEGIN { incomment = 0 }
    {
      line = $0
      out = ""
      while (length(line) > 0) {
        if (incomment) {
          e = index(line, "-->")
          if (e == 0) { line = "" }
          else { line = substr(line, e + 3); incomment = 0 }
        } else {
          s = index(line, "<!--")
          if (s == 0) { out = out line; line = "" }
          else { out = out substr(line, 1, s - 1); line = substr(line, s + 4); incomment = 1 }
        }
      }
      print out
    }
  ' <<< "$1"
}

BODY="$(strip_html_comments "$BODY")"
TEMPLATE="$(strip_html_comments "$TEMPLATE")"

# --- ui_touched -------------------------------------------------------
# Glob matching via bash's `[[ str == pattern ]]`. This is pattern
# matching, not filesystem globbing, so "**" is not special: fnmatch
# collapses repeated "*" into one, and a single "*" already matches any
# run of characters including "/". So "src/**" and "src/*" behave
# identically here, and both correctly match "src/a/b/c.ts". Simpler and
# just as correct as a real ** implementation for this use case.
ui_touched=false
if [ -n "$UI_PATTERNS" ] && [ -n "$CHANGED" ]; then
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    while IFS= read -r pattern; do
      [ -z "$pattern" ] && continue
      # shellcheck disable=SC2053
      if [[ "$file" == $pattern ]]; then
        ui_touched=true
      fi
    done <<< "$UI_PATTERNS"
  done <<< "$CHANGED"
fi

# --- UNEDITED -----------------------------------------------------------
# Any non-empty, non-heading template line that still appears verbatim
# (line-for-line, trimmed) in the body means the author left the
# placeholder text in place.
norm_body_lines="$(while IFS= read -r l; do trim "$l"; printf '\n'; done <<< "$BODY")"

unedited_offenders=()
if [ -n "$TEMPLATE" ]; then
  while IFS= read -r tline; do
    t="$(trim "$tline")"
    [ -z "$t" ] && continue
    case "$t" in \#*) continue ;; esac
    if grep -qxF -- "$t" <<< "$norm_body_lines"; then
      unedited_offenders+=("$t")
    fi
  done <<< "$TEMPLATE"
fi
if [ "${#unedited_offenders[@]}" -eq 0 ]; then
  unedited_pass=true
  unedited_reason="no leftover template placeholder lines"
else
  unedited_pass=false
  unedited_reason="leftover template placeholder line(s): $(printf '%s; ' "${unedited_offenders[@]}")"
  unedited_reason="${unedited_reason%; }"
fi

# --- VERIFIED -------------------------------------------------------
# Section body: everything between the "## How I verified it" heading
# and the next "## " heading (or EOF). "### " sub-headings do not end
# the section, only a heading at the same "## " level does.
extract_section() {
  awk '
    BEGIN{capture=0}
    /^## How I verified it[[:space:]]*$/{capture=1; next}
    /^## / && capture{capture=0}
    capture{print}
  ' <<< "$1"
}

verified_section="$(extract_section "$BODY")"
template_verified_section="$(extract_section "$TEMPLATE")"
norm_template_verified_lines="$(while IFS= read -r l; do trim "$l"; printf '\n'; done <<< "$template_verified_section")"

if ! grep -qE '^## How I verified it[[:space:]]*$' <<< "$BODY"; then
  verified_pass=false
  verified_reason="no '## How I verified it' section found in the PR body"
else
  has_content=false
  while IFS= read -r vline; do
    v="$(trim "$vline")"
    [ -z "$v" ] && continue
    if ! grep -qxF -- "$v" <<< "$norm_template_verified_lines"; then
      has_content=true
    fi
  done <<< "$verified_section"

  has_signal=false
  if grep -qE '^[[:space:]]*```' <<< "$verified_section"; then has_signal=true; fi
  if grep -qE '^[[:space:]]*\$' <<< "$verified_section"; then has_signal=true; fi
  if grep -qE '^[[:space:]]*(pnpm|npm|bash|node|go|cargo|make|curl|wrangler)\b' <<< "$verified_section"; then has_signal=true; fi
  if grep -qiE '(exit 0|passed|\bok\b)' <<< "$verified_section"; then has_signal=true; fi

  if [ "$has_content" = true ] && [ "$has_signal" = true ]; then
    verified_pass=true
    verified_reason="verification section has real content and a command/output signal"
  elif [ "$has_content" = false ]; then
    verified_pass=false
    verified_reason="'## How I verified it' is empty or only contains placeholder text"
  else
    verified_pass=false
    verified_reason="'## How I verified it' has content but no command/output signal (fenced code block, a \$ line, or a known tool name)"
  fi
fi

# --- EVIDENCE -------------------------------------------------------
evidence_required="$ui_touched"
evidence_found=false
grep -qE '!\[' <<< "$BODY" && evidence_found=true
grep -qiE '\.(png|jpe?g|gif|webp|mp4|mov|webm)(\?|$|\))' <<< "$BODY" && evidence_found=true
grep -qE 'github\.com/user-attachments/' <<< "$BODY" && evidence_found=true
grep -qiE 'loom\.com' <<< "$BODY" && evidence_found=true
grep -qiE 'youtu' <<< "$BODY" && evidence_found=true
if [ -n "$PREVIEW_HOSTS" ]; then
  while IFS= read -r host; do
    [ -z "$host" ] && continue
    grep -qiF -- "$host" <<< "$BODY" && evidence_found=true
  done <<< "$PREVIEW_HOSTS"
fi
# the `&&` chains above are fine under `set -e`: a bare command in an
# `&&` list only trips errexit if it is the LAST command executed, and
# each of these is immediately followed by more script.

if [ "$evidence_required" = true ]; then
  if [ "$evidence_found" = true ]; then
    evidence_pass=true
    evidence_reason="image/video/attachment/preview link found in the body"
  else
    evidence_pass=false
    evidence_reason="no image, video, GitHub attachment, or preview link found in the body"
  fi
else
  evidence_pass=true
  evidence_reason="not required (no UI paths in diff)"
fi

jq -n -c \
  --argjson ui_touched "$ui_touched" \
  --argjson unedited_pass "$unedited_pass" \
  --arg unedited_reason "$unedited_reason" \
  --argjson verified_pass "$verified_pass" \
  --arg verified_reason "$verified_reason" \
  --argjson evidence_required "$evidence_required" \
  --argjson evidence_pass "$evidence_pass" \
  --arg evidence_reason "$evidence_reason" \
  '{
    ui_touched: $ui_touched,
    checks: [
      {name: "UNEDITED", pass: $unedited_pass, reason: $unedited_reason},
      {name: "VERIFIED", pass: $verified_pass, reason: $verified_reason},
      {name: "EVIDENCE", required: $evidence_required, pass: $evidence_pass, reason: $evidence_reason}
    ],
    overall_pass: ($unedited_pass and $verified_pass and (if $evidence_required then $evidence_pass else true end))
  }'

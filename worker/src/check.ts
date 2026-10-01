// Port of scripts/check-body.sh to TypeScript, byte-for-byte on the verdicts.
// Pure: no network, no env, no GitHub. The Worker calls this; tests call it
// directly, and tests/run.sh still drives the bash original so the two
// implementations can be diffed against the same fixtures.

export interface CheckResult {
  ui_touched: boolean;
  checks: Array<{ name: string; required?: boolean; pass: boolean; reason: string }>;
  overall_pass: boolean;
}

export interface CheckInput {
  body: string;
  template: string;
  changedFiles: string[];
  uiPaths: string[];
  previewHosts: string[];
}

// GitHub's PR-body editor renders <!-- ... --> template guidance as
// barely-visible text that authors routinely leave in place, and a comment can
// span many lines. Strip every block, comment state carried across lines,
// before UNEDITED or VERIFIED looks at the text.
export function stripComments(input: string): string {
  let state = false;
  const lines = input.split("\n").map((line) => {
    let rest = line;
    let out = "";
    while (rest.length > 0) {
      if (state) {
        const end = rest.indexOf("-->");
        if (end === -1) {
          rest = "";
        } else {
          rest = rest.slice(end + 3);
          state = false;
        }
      } else {
        const start = rest.indexOf("<!--");
        if (start === -1) {
          out += rest;
          rest = "";
        } else {
          out += rest.slice(0, start);
          rest = rest.slice(start + 4);
          state = true;
        }
      }
    }
    return out;
  });
  return lines.join("\n");
}

const trim = (s: string) => s.replace(/^\s+|\s+$/g, "");

// bash's `[[ "$file" == $pattern ]]` is fnmatch-style pattern matching, not
// filesystem globbing: `*` matches any run of characters INCLUDING `/`, and
// repeated `*` collapses. So "src/**" and "src/*" behave identically and both
// match "src/a/b/c.ts". This translation keeps that behaviour exactly.
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      while (pattern[i + 1] === "*") i++;
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const TOOLS =
  "pnpm|npm|npx|yarn|bun|bunx|deno|bash|sh|node|tsc|go|cargo|make|curl|wrangler|python|python3|uv|uvx|pip|pytest|vitest|jest|ruff|eslint|grep|rg|jq|gh|git|docker|shellcheck|sqlite3|duckdb";

function extractVerifiedSection(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let capture = false;
  for (const line of lines) {
    if (/^## How I verified it[ \t]*$/.test(line)) {
      capture = true;
      continue;
    }
    // A "### " sub-heading does not end the section; only "## " at the same level does.
    if (capture && line.startsWith("## ")) capture = false;
    if (capture) out.push(line);
  }
  return out.join("\n");
}

export function check(input: CheckInput): CheckResult {
  const body = stripComments(input.body);
  const template = stripComments(input.template);

  // --- ui_touched ---
  const patterns = input.uiPaths.map(trim).filter(Boolean).map(globToRegExp);
  const files = input.changedFiles.map(trim).filter(Boolean);
  const uiTouched = files.some((f) => patterns.some((p) => p.test(f)));

  // --- UNEDITED ---
  // Any non-empty, non-heading template line that still appears verbatim
  // (line-for-line, trimmed) in the body means the author left the placeholder.
  const bodyLines = new Set(body.split("\n").map(trim));
  const offenders = template
    .split("\n")
    .map(trim)
    .filter((t) => t.length > 0 && !t.startsWith("#"))
    .filter((t) => bodyLines.has(t));
  const uneditedPass = offenders.length === 0;
  const uneditedReason = uneditedPass
    ? "no leftover template placeholder lines"
    : `leftover template placeholder line(s): ${offenders.join("; ")}`;

  // --- VERIFIED ---
  let verifiedPass: boolean;
  let verifiedReason: string;
  if (!/^## How I verified it[ \t]*$/m.test(body)) {
    verifiedPass = false;
    verifiedReason = "no '## How I verified it' section found in the PR body";
  } else {
    const section = extractVerifiedSection(body);
    const templateSectionLines = new Set(extractVerifiedSection(template).split("\n").map(trim));
    const hasContent = section
      .split("\n")
      .map(trim)
      .filter(Boolean)
      .some((v) => !templateSectionLines.has(v));
    // Heuristic, kept identical to scripts/check-body.sh (parity.test.ts diffs them).
    const sectionLines = section.split("\n");
    const listMarker = /^([-*+]|[0-9]+[.)])([ \t]|$)/;
    const hasSignal =
      /^[ \t]*```/m.test(section) ||
      // indented (4+ spaces or tab) code block; a nested list item does not count
      sectionLines.some((l) => /^( {4}|\t)[ \t]*\S/.test(l) && !listMarker.test(l.trimStart())) ||
      // `$ cmd` or a known tool at line start, behind an optional bullet, checkbox, backtick
      new RegExp(`^[ \\t]*(([-*+]|[0-9]+[.)])[ \\t]+)?(\\[[ xX]\\][ \\t]+)?\`?(\\$|(${TOOLS})\\b)`, "m").test(section) ||
      // output: "exit 0", "passed", "ok", "127 pass", "0 failed"
      /(exit 0|passed|\bok\b|[0-9]+[ \t]+(tests?[ \t]+)?(pass|fail)(ed|es|s|ing)?\b)/i.test(section);

    if (hasContent && hasSignal) {
      verifiedPass = true;
      verifiedReason = "verification section has real content and a command/output signal";
    } else if (!hasContent) {
      verifiedPass = false;
      verifiedReason = "'## How I verified it' is empty or only contains placeholder text";
    } else {
      verifiedPass = false;
      verifiedReason =
        "'## How I verified it' has content but no command/output signal (fenced or indented code block, a $ line, a known tool name, or output like 127 passed)";
    }
  }

  // --- EVIDENCE ---
  const evidenceFound =
    /!\[/.test(body) ||
    /\.(png|jpe?g|gif|webp|mp4|mov|webm)(\?|$|\))/im.test(body) ||
    /github\.com\/user-attachments\//.test(body) ||
    /loom\.com/i.test(body) ||
    /youtu/i.test(body) ||
    input.previewHosts
      .map(trim)
      .filter(Boolean)
      .some((h) => body.toLowerCase().includes(h.toLowerCase()));

  const evidencePass = uiTouched ? evidenceFound : true;
  const evidenceReason = !uiTouched
    ? "not required (no UI paths in diff)"
    : evidenceFound
      ? "image/video/attachment/preview link found in the body"
      : "no image, video, GitHub attachment, or preview link found in the body";

  return {
    ui_touched: uiTouched,
    checks: [
      { name: "UNEDITED", pass: uneditedPass, reason: uneditedReason },
      { name: "VERIFIED", pass: verifiedPass, reason: verifiedReason },
      { name: "EVIDENCE", required: uiTouched, pass: evidencePass, reason: evidenceReason },
    ],
    overall_pass: uneditedPass && verifiedPass && (uiTouched ? evidencePass : true),
  };
}

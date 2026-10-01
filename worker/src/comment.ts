import type { CheckResult } from "./check";

export const COMMENT_MARKER = "### PR evidence check";

const FIXES: Record<string, string> = {
  UNEDITED: "- Replace the leftover template placeholder text noted above with real content.",
  VERIFIED:
    '- Fill in "## How I verified it" with what you actually ran and what it showed: a command, a fenced code block, or output like "tests passed".',
  EVIDENCE:
    "- Add a screenshot, video, GitHub attachment, or preview link (pages.dev / workers.dev) showing the UI change.",
};

// Same table, same wording, same "How to fix" list as the reusable workflow's
// final step. Changing either side without the other splits the two
// implementations' output, which is the whole point of keeping the text here.
export function renderComment(result: CheckResult, bypassLabel: string): string {
  const rows = result.checks
    .map((c) => {
      const verdict =
        c.name === "EVIDENCE" && c.required === false ? "not required" : c.pass ? "pass" : "fail";
      return `| ${c.name} | ${verdict} | ${c.reason} |`;
    })
    .join("\n");

  const fixes = result.checks
    .filter((c) => !c.pass)
    .map((c) => FIXES[c.name])
    .filter(Boolean);

  return [
    COMMENT_MARKER,
    "",
    "| Check | Result | Reason |",
    "|---|---|---|",
    rows,
    "",
    "**How to fix:**",
    fixes.length > 0 ? fixes.join("\n") : "- (none)",
    "",
    `Bypass: add the \`${bypassLabel}\` label to skip this check.`,
  ].join("\n");
}

export function renderBypassComment(bypassLabel: string, by: string): string {
  return `${COMMENT_MARKER}\n\nThis check was bypassed by the \`${bypassLabel}\` label, added by @${by}.`;
}

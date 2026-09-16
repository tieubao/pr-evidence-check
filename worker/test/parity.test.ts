import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/check";

// The Worker and the reusable workflow must reach the same verdict on the same
// PR, so this runs BOTH implementations over every fixture combination and
// compares the JSON. Without it, a fix applied to one side drifts silently and
// a repo's verdict depends on which path happens to be wired.
const ROOT = join(import.meta.dirname, "../..");
const FX = join(ROOT, "tests/fixtures");
const read = (name: string) => readFileSync(join(FX, name), "utf8");
const lines = (name: string) =>
  read(name)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const cases: Array<[string, string, string]> = [];
for (const template of ["template.md", "template-real.md"]) {
  for (const body of [
    "raw-template-body.md",
    "raw-template-real-body.md",
    "filled-with-evidence.md",
    "filled-no-evidence.md",
    "filled-keeps-comments.md",
  ]) {
    for (const changed of ["changed-files-ui.txt", "changed-files-no-ui.txt"]) {
      cases.push([template, body, changed]);
    }
  }
}

describe("check.ts matches scripts/check-body.sh", () => {
  it.each(cases)("%s + %s + %s", (template, body, changed) => {
    const shell = JSON.parse(
      execFileSync(
        "bash",
        [
          join(ROOT, "scripts/check-body.sh"),
          "--body",
          join(FX, body),
          "--template",
          join(FX, template),
          "--changed-files",
          join(FX, changed),
          "--ui-paths",
          join(FX, "ui-paths.txt"),
          "--preview-hosts",
          join(FX, "preview-hosts.txt"),
        ],
        { encoding: "utf8" },
      ),
    );
    const ts = check({
      body: read(body),
      template: read(template),
      changedFiles: lines(changed),
      uiPaths: lines("ui-paths.txt"),
      previewHosts: lines("preview-hosts.txt"),
    });
    expect(ts).toEqual(shell);
  });
});

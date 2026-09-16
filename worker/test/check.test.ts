import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, globToRegExp, stripComments } from "../src/check";

// The same fixtures tests/run.sh drives the bash original with. Each case here
// mirrors one of its assertions, so a divergence between check-body.sh and
// check.ts fails one suite and not the other.
const FX = join(import.meta.dirname, "../../tests/fixtures");
const read = (name: string) => readFileSync(join(FX, name), "utf8");
const lines = (name: string) =>
  read(name)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const UI_PATHS = lines("ui-paths.txt");
const PREVIEW_HOSTS = lines("preview-hosts.txt");
const CHANGED_UI = lines("changed-files-ui.txt");
const CHANGED_NO_UI = lines("changed-files-no-ui.txt");

function run(bodyFile: string, changedFiles: string[], templateFile = "template.md") {
  return check({
    body: read(bodyFile),
    template: read(templateFile),
    changedFiles,
    uiPaths: UI_PATHS,
    previewHosts: PREVIEW_HOSTS,
  });
}

const verdict = (r: ReturnType<typeof check>, name: string) => r.checks.find((c) => c.name === name)!;

describe("parity with tests/run.sh", () => {
  it("a: raw template body + UI touched", () => {
    const r = run("raw-template-body.md", CHANGED_UI);
    // The comment-only template leaves nothing visible to compare once
    // comments are stripped, so UNEDITED passes here (fixture f is the case
    // where visible leftover lines do fail it).
    expect(verdict(r, "UNEDITED").pass).toBe(true);
    expect(verdict(r, "VERIFIED").pass).toBe(false);
    expect(verdict(r, "EVIDENCE").pass).toBe(false);
    expect(r.overall_pass).toBe(false);
  });

  it("b: filled + evidence + UI touched passes", () => {
    expect(run("filled-with-evidence.md", CHANGED_UI).overall_pass).toBe(true);
  });

  it("c: filled + no evidence + UI not touched passes, EVIDENCE not required", () => {
    const r = run("filled-no-evidence.md", CHANGED_NO_UI);
    expect(r.overall_pass).toBe(true);
    expect(verdict(r, "EVIDENCE").required).toBe(false);
  });

  it("d: filled + no evidence + UI touched fails EVIDENCE only", () => {
    const r = run("filled-no-evidence.md", CHANGED_UI);
    expect(verdict(r, "UNEDITED").pass).toBe(true);
    expect(verdict(r, "VERIFIED").pass).toBe(true);
    expect(verdict(r, "EVIDENCE").pass).toBe(false);
    expect(r.overall_pass).toBe(false);
  });

  it("e: real template, body keeps the HTML comments, still passes", () => {
    const r = run("filled-keeps-comments.md", CHANGED_NO_UI, "template-real.md");
    expect(verdict(r, "UNEDITED").pass).toBe(true);
    expect(verdict(r, "VERIFIED").pass).toBe(true);
    expect(r.overall_pass).toBe(true);
  });

  it("f: raw real template + UI touched fails all three", () => {
    const r = run("raw-template-real-body.md", CHANGED_UI, "template-real.md");
    expect(verdict(r, "UNEDITED").pass).toBe(false);
    expect(verdict(r, "VERIFIED").pass).toBe(false);
    expect(verdict(r, "EVIDENCE").pass).toBe(false);
    expect(r.overall_pass).toBe(false);
  });
});

describe("negative control", () => {
  it("EVIDENCE fails once the preview link is dropped from fixture b", () => {
    const body = read("filled-with-evidence.md")
      .split("\n")
      .filter((l) => !l.includes("pages.dev"))
      .join("\n");
    const r = check({
      body,
      template: read("template.md"),
      changedFiles: CHANGED_UI,
      uiPaths: UI_PATHS,
      previewHosts: PREVIEW_HOSTS,
    });
    expect(verdict(r, "EVIDENCE").pass).toBe(false);
    expect(verdict(r, "UNEDITED").pass).toBe(true);
    expect(verdict(r, "VERIFIED").pass).toBe(true);
  });
});

describe("path filter", () => {
  it("a single * crosses a slash, matching bash pattern matching", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**").test("docs/a.md")).toBe(false);
    expect(globToRegExp("src/**").test("other/src/a.ts")).toBe(false);
  });

  it("regex metacharacters in a pattern stay literal", () => {
    expect(globToRegExp("a.b/*").test("a.b/c")).toBe(true);
    expect(globToRegExp("a.b/*").test("axb/c")).toBe(false);
  });

  it("EVIDENCE is required only when a UI path is in the diff", () => {
    const base = {
      body: "## How I verified it\n\n```\nok\n```\n",
      template: "",
      uiPaths: ["src/**"],
      previewHosts: [],
    };
    expect(check({ ...base, changedFiles: ["src/deep/page.astro"] }).ui_touched).toBe(true);
    expect(check({ ...base, changedFiles: ["docs/readme.md"] }).ui_touched).toBe(false);
  });
});

describe("evidence detection", () => {
  const withBody = (body: string) =>
    check({ body, template: "", changedFiles: ["src/a.ts"], uiPaths: ["src/**"], previewHosts: ["pages.dev"] });

  it.each([
    ["markdown image", "## How I verified it\n\n```\nok\n```\n\n![shot](x)"],
    ["bare png link", "## How I verified it\n\n```\nok\n```\n\nhttps://x.example/a.png"],
    ["github attachment", "## How I verified it\n\n```\nok\n```\n\nhttps://github.com/user-attachments/assets/1"],
    ["loom", "## How I verified it\n\n```\nok\n```\n\nhttps://www.loom.com/share/1"],
    ["youtube", "## How I verified it\n\n```\nok\n```\n\nhttps://youtu.be/1"],
    ["preview host", "## How I verified it\n\n```\nok\n```\n\nhttps://abc.pages.dev/"],
  ])("accepts %s", (_name, body) => {
    expect(withBody(body).checks.find((c) => c.name === "EVIDENCE")!.pass).toBe(true);
  });

  it("rejects a body with none of them", () => {
    const r = withBody("## How I verified it\n\n```\nok\n```\n\nNothing to show.");
    expect(r.checks.find((c) => c.name === "EVIDENCE")!.pass).toBe(false);
    expect(r.overall_pass).toBe(false);
  });
});

describe("html comment stripping", () => {
  it("spans multiple lines", () => {
    expect(stripComments("a\n<!-- x\ny -->b\nc")).toBe("a\n\nb\nc");
  });

  it("leaves text outside a comment on the same line", () => {
    expect(stripComments("keep <!-- drop --> this")).toBe("keep  this");
  });
});

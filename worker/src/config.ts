// Per-installation config. This repo is public, so no repo name, path glob, or
// preview host is committed here: the whole table arrives as the REPOS
// wrangler secret, set at deploy from the operator's own store.
//
// Shape:
//   {"owner/repo": {"ui_paths": ["src/**"], "preview_hosts": ["pages.dev"]}}
//
// A secret rather than a var because `wrangler deploy` replaces the config's
// whole `vars` block on every deploy, and Workers Builds deploys from the
// public repo. Secrets survive a deploy; a var set out of band does not.

export interface RepoConfig {
  ui_paths: string[];
  preview_hosts: string[];
  template_path: string;
  bypass_label: string;
  convert_to_draft: boolean;
}

const DEFAULTS = {
  preview_hosts: ["pages.dev", "workers.dev"],
  template_path: ".github/PULL_REQUEST_TEMPLATE.md",
  bypass_label: "skip-evidence-check",
  convert_to_draft: true,
};

export function parseRepos(raw: string | undefined): Map<string, RepoConfig> {
  const out = new Map<string, RepoConfig>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[config] REPOS is not valid JSON; no repo is configured");
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[config] REPOS is not a JSON object; no repo is configured");
    return out;
  }
  for (const [repo, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = (value ?? {}) as Partial<RepoConfig>;
    // ui_paths has no default on purpose: an empty list means EVIDENCE is
    // never required, and silently waiving a check is the one failure mode
    // worth refusing to configure by accident.
    if (!Array.isArray(v.ui_paths) || v.ui_paths.length === 0) {
      console.error(`[config] ${repo}: ui_paths missing or empty; skipping this repo`);
      continue;
    }
    out.set(repo, {
      ui_paths: v.ui_paths.map(String),
      preview_hosts: Array.isArray(v.preview_hosts) ? v.preview_hosts.map(String) : DEFAULTS.preview_hosts,
      template_path: typeof v.template_path === "string" ? v.template_path : DEFAULTS.template_path,
      bypass_label: typeof v.bypass_label === "string" ? v.bypass_label : DEFAULTS.bypass_label,
      convert_to_draft: typeof v.convert_to_draft === "boolean" ? v.convert_to_draft : DEFAULTS.convert_to_draft,
    });
  }
  return out;
}

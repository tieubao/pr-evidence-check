import { defineConfig } from "vitest/config";

// Plain node environment, not workers-pool: every module under test is either
// pure (check, comment, config) or reachable with a stubbed global fetch. Node
// 20 provides crypto.subtle and atob, the only two runtime APIs the Worker
// uses beyond fetch.
export default defineConfig({
  test: { include: ["worker/test/**/*.test.ts"] },
});

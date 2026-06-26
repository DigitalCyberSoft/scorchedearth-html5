import { defineConfig } from "vitest/config";

// Vite serves the browser game (src/main.ts -> index.html); Vitest runs the
// differential gate (test/*.test.ts) in Node against the Python-dumped golden
// vectors in oracle/vectors/*.json.
export default defineConfig({
  base: "./",
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Coverage is OFF for `npm test` (no --coverage flag); this block only takes
    // effect under `npm run coverage:node` / `coverage:all`.  Provider v8 emits a
    // MERGEABLE istanbul coverage-final.json (json) plus the summary (json-summary)
    // and the human text table; all three are kept (text is required by spec).  The
    // raw per-file istanbul lands in coverage/node/ so scripts/coverage_merge.mjs can
    // union it with the two browser V8 captures.  `all: true` instruments every
    // src/*.ts (even ones no node test imports) so the merged denominator is the
    // whole port, not just node-reached files.
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "./coverage/node",
      include: ["src/**"],
      all: true,
      clean: true,
    },
  },
});

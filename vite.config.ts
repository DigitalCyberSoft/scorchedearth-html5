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
    // RESOURCE CAP (added 2026-06-27): bound the worker pool so a `test`/coverage run
    // cannot fan out to all 32 logical cores and spike memory -- each fork loads the
    // suite plus large golden vectors (oracle/vectors/*.json), so an uncapped pool on
    // a many-core box is multi-GB and starves the desktop.  Hard-capped to <=4 forks
    // regardless of core count; keeps a single run light on a shared machine.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
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

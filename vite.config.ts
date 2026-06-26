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
  },
});

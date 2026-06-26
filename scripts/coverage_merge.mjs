// Merge the THREE V8 coverage sources into ONE per-file line% table.
//
//   1. coverage/node/coverage-final.json   -- vitest v8 (istanbul) : node tests
//   2. coverage/browser-render/v8.json     -- playwright raw V8     : render harness
//   3. coverage/boot/v8.json               -- playwright raw V8     : real-app boot+play
//
// (2) and (3) are RAW V8; monocart-coverage-reports (MCR) maps each back to src/*.ts
// through the inline vite-dev sourcemaps and converts to istanbul.  All three istanbul
// maps are then re-keyed to a canonical `src/<basename>` and unioned with
// istanbul-lib-coverage, whose merge is keyed by SOURCE LOCATION (file-coverage.js
// keyFromLoc) -- so a line covered only in the browser counts as covered even though
// the node and browser v8->istanbul converters emit slightly different statement maps.
// This is why genuinely browser-exercised code (main.ts rAF loop, Canvas draw, fetch,
// AudioContext) stops reading as uncovered.
//
// Output: a per-file line% table + the All-files line%, the exact uncovered line
// ranges for every file < 100%, and a merged istanbul coverage-final.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import libCoverage from "istanbul-lib-coverage";
import MCR from "monocart-coverage-reports";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const COV = join(ROOT, "coverage");

const NODE_ISTANBUL = join(COV, "node", "coverage-final.json");
const RENDER_V8 = join(COV, "browser-render", "v8.json");
const BOOT_V8 = join(COV, "boot", "v8.json");
const MERGED_DIR = join(COV, "merged");

// The flat src/*.ts set (unique basenames).  Used as the canonical filter+key: the
// node side keys by ABS path (.../src/ai.ts) while the browser sides key by BARE
// basename (ai.ts -- vite's inline sourcemap `sources` are bare names), so both must
// reduce to one key.  This set also drops non-app entries (vite client, deps, env).
const SRC_FILES = new Set(readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts")));

// Canonicalize any path/URL to `src/<basename>` iff its basename is a real src file.
function canon(p) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, "/").replace(/\?.*$/, "");
  const base = s.slice(s.lastIndexOf("/") + 1);
  return SRC_FILES.has(base) ? `src/${base}` : null; // non-src -> dropped from merge
}

// Convert a raw playwright V8 capture to istanbul via MCR, keyed by src path.
async function v8ToIstanbul(v8Path, outDir, label) {
  if (!existsSync(v8Path)) {
    console.warn(`[merge] WARN: ${label} V8 capture missing (${v8Path}); skipping that source`);
    return {};
  }
  const v8list = JSON.parse(readFileSync(v8Path, "utf8"));
  const mcr = MCR({
    name: `${label} v8->istanbul`,
    outputDir: outDir,
    reports: [["json"]],
    logging: "error",
    clean: true,
    cleanCache: true,
    // Keep only the app's own modules served from /src/ (drop the vite client, the
    // pre-bundled deps, and HMR).  The resolved source paths are BARE basenames
    // (vite's inline sourcemap `sources`), so canon()/SRC_FILES does the final src
    // filtering after conversion; no sourceFilter here (a `src/`-anchored one would
    // wrongly drop every bare-named source).
    entryFilter: (entry) => typeof entry.url === "string" && entry.url.includes("/src/"),
  });
  await mcr.add(v8list);
  await mcr.generate();
  const finalPath = join(outDir, "coverage-final.json");
  if (!existsSync(finalPath)) {
    console.warn(`[merge] WARN: ${label} produced no coverage-final.json`);
    return {};
  }
  const obj = JSON.parse(readFileSync(finalPath, "utf8"));
  console.log(`[merge] ${label}: ${Object.keys(obj).length} src file(s) from raw V8`);
  return obj;
}

// Re-key an istanbul map to canonical src paths (sets both the object key and the
// fileCoverage .path that istanbul-lib-coverage merges on).
function recanon(istanbulObj) {
  const out = {};
  for (const [k, fc] of Object.entries(istanbulObj || {})) {
    const key = canon(fc && fc.path ? fc.path : k);
    if (!key) continue;
    const copy = { ...fc, path: key };
    out[key] = copy; // unique basenames -> no collision across a single source
  }
  return out;
}

function fmtRanges(lines) {
  // collapse a sorted list of line numbers into "a, b-c, d" ranges
  const nums = lines.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return "";
  const parts = [];
  let s = nums[0];
  let p = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === p + 1) {
      p = nums[i];
      continue;
    }
    parts.push(s === p ? `${s}` : `${s}-${p}`);
    s = p = nums[i];
  }
  parts.push(s === p ? `${s}` : `${s}-${p}`);
  return parts.join(", ");
}

async function main() {
  if (!existsSync(NODE_ISTANBUL)) {
    console.error(`[merge] FATAL: node istanbul missing (${NODE_ISTANBUL}). Run coverage:node first.`);
    process.exit(2);
  }
  const nodeObj = JSON.parse(readFileSync(NODE_ISTANBUL, "utf8"));
  console.log(`[merge] node: ${Object.keys(nodeObj).length} src file(s) from vitest v8 istanbul`);

  const renderObj = await v8ToIstanbul(RENDER_V8, join(COV, "_render_istanbul"), "browser-render");
  const bootObj = await v8ToIstanbul(BOOT_V8, join(COV, "_boot_istanbul"), "boot");

  // union all three (location-keyed merge)
  const map = libCoverage.createCoverageMap({});
  for (const obj of [nodeObj, renderObj, bootObj]) {
    map.merge(libCoverage.createCoverageMap(recanon(obj)));
  }

  // build the per-file table + totals
  const rows = [];
  let totLines = 0;
  let covLines = 0;
  const uncovered = {};
  for (const file of map.files().sort()) {
    const fc = map.fileCoverageFor(file);
    const s = fc.toSummary().lines; // {total, covered, skipped, pct}
    totLines += s.total;
    covLines += s.covered;
    rows.push({ file, pct: s.pct, covered: s.covered, total: s.total });
    if (s.covered < s.total) uncovered[file] = fmtRanges(fc.getUncoveredLines());
  }
  const allPct = totLines ? (covLines / totLines) * 100 : 0;

  // ---- print -----------------------------------------------------------------
  const nameW = Math.max(12, ...rows.map((r) => r.file.length));
  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);
  console.log("\n=== MERGED coverage (node + browser-render + boot), line% ===");
  console.log(`${pad("File", nameW)}  ${padL("Line%", 7)}  ${padL("Covered/Total", 15)}`);
  console.log("-".repeat(nameW + 2 + 7 + 2 + 15));
  for (const r of rows) {
    console.log(`${pad(r.file, nameW)}  ${padL(r.pct.toFixed(2), 7)}  ${padL(`${r.covered}/${r.total}`, 15)}`);
  }
  console.log("-".repeat(nameW + 2 + 7 + 2 + 15));
  console.log(`${pad("All files", nameW)}  ${padL(allPct.toFixed(2), 7)}  ${padL(`${covLines}/${totLines}`, 15)}`);

  console.log("\n=== Uncovered line ranges (files < 100%) ===");
  const lt = rows.filter((r) => r.covered < r.total);
  if (!lt.length) {
    console.log("  (none -- every file at 100% line coverage)");
  } else {
    for (const r of lt) console.log(`  ${r.file}: ${uncovered[r.file]}`);
  }

  // ---- persist ----------------------------------------------------------------
  mkdirSync(MERGED_DIR, { recursive: true });
  writeFileSync(join(MERGED_DIR, "coverage-final.json"), JSON.stringify(map.toJSON()));
  writeFileSync(
    join(MERGED_DIR, "summary.json"),
    JSON.stringify(
      {
        allFilesLinePct: Number(allPct.toFixed(2)),
        coveredLines: covLines,
        totalLines: totLines,
        files: rows.map((r) => ({
          file: r.file,
          linePct: Number(r.pct.toFixed(2)),
          covered: r.covered,
          total: r.total,
          uncovered: uncovered[r.file] || "",
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n[merge] merged istanbul -> ${join(MERGED_DIR, "coverage-final.json")}`);
  console.log(`[merge] summary        -> ${join(MERGED_DIR, "summary.json")}`);
  console.log(`\nAll-files merged line coverage: ${allPct.toFixed(2)}%`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

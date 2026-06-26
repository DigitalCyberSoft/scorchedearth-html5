// Browser render-crash driver (playwright + system chrome).
//
// Connects to an ALREADY-RUNNING vite DEV server (run.sh starts the server and this
// driver in ONE shell so the server outlives a subshell), opens the harness page,
// and for every visual state:
//   1. window.runState(name) -> renders the state through the REAL Renderer/screens
//      and returns {ok, meta} or {ok:false, error, stack} (a captured crash).
//   2. reads the #game canvas back and asserts it is NON-TRIVIALLY painted
//      (a green ok with a blank canvas is still a failure -- the renderer no-oped).
// It ALSO collects V8 JS coverage across the whole run so the browser-only draw
// code (pygame.ts, render.ts draw, sprites draw, screens/ingame/ui draw) is shown
// to have actually executed, and summarises covered bytes per module.
//
// A pageerror (uncaught exception that escaped runState) OR any ok:false OR any
// blank canvas makes the driver exit NON-ZERO.  No src is touched.
//
// Usage: node test-browser/run.mjs [baseURL]   (default http://localhost:4188)

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire("/home/user/Scorched Earth/scorch-html5/package.json");
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const BASE = process.argv[2] || "http://localhost:4188";

// Browser-only draw modules the per-module node tests cannot exercise (they run in
// node with stubbed surfaces).  We report coverage for each.
const DRAW_MODULES = [
  "pygame.ts",
  "render.ts",
  "sprites.ts",
  "sprites_data.ts",
  "screens.ts",
  "ingame.ts",
  "ui.ts",
  "widgets.ts",
  "main.ts",
];

// merge [start,end) intervals and return summed length
function mergedLen(ivals) {
  if (ivals.length === 0) return 0;
  ivals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = ivals[0];
  for (let i = 1; i < ivals.length; i++) {
    const [s, e] = ivals[i];
    if (s > ce) {
      total += ce - cs;
      cs = s;
      ce = e;
    } else if (e > ce) {
      ce = e;
    }
  }
  total += ce - cs;
  return total;
}

function moduleOf(url) {
  // vite dev urls look like http://host:port/src/render.ts?t=...  -> "render.ts"
  try {
    const p = new URL(url).pathname;
    if (!p.includes("/src/")) return null;
    const base = p.split("/").pop();
    return base || null;
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
  });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  const httpErrors = [];
  page.on("response", (res) => {
    const u = res.url();
    if (res.status() >= 400 && /\/(assets|src|test-browser)\//.test(u)) {
      httpErrors.push(`HTTP ${res.status()} ${u}`);
    }
  });

  // V8 coverage must be started BEFORE the navigation that loads the modules.
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });

  const url = `${BASE}/test-browser/harness.html`;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => window.harnessReady);

  if (httpErrors.length || pageErrors.length) {
    console.error("[boot] errors:\n" + [...httpErrors, ...pageErrors].join("\n"));
    await browser.close();
    process.exit(2);
  }

  const states = await page.evaluate(() => window.listStates());
  const results = [];
  for (const name of states) {
    const r = await page.evaluate((n) => window.runState(n), name);
    // read the canvas back and measure paint: distinct quantized colors over a
    // sample grid + fraction of pixels differing from the corner background.
    const paint = await page.evaluate(() => {
      const c = document.getElementById("game");
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      const bg = [d[0], d[1], d[2]];
      const seen = new Set();
      let diff = 0;
      let n = 0;
      const stepX = 16;
      const stepY = 16;
      for (let y = 0; y < c.height; y += stepY) {
        for (let x = 0; x < c.width; x += stepX) {
          const i = (y * c.width + x) * 4;
          n++;
          const q = (d[i] >> 4 << 8) | (d[i + 1] >> 4 << 4) | (d[i + 2] >> 4);
          seen.add(q);
          if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) diff++;
        }
      }
      return { distinct: seen.size, diffFrac: diff / n, samples: n };
    });
    // A blank / no-op canvas is uniform (1-2 quantized colors).  Any real scene or
    // panel yields many distinct colors; the diffFrac is reported for info.  Gate on
    // distinct colors so a grey-heavy opaque panel (shop) is not mis-flagged blank.
    const painted = paint.distinct >= 6 || paint.diffFrac > 0.03;
    results.push({ name, ...r, paint, painted });
    const tag = r.ok ? (painted ? "PASS" : "BLANK") : "CRASH";
    console.log(
      `[${tag}] ${name.padEnd(13)} distinct=${String(paint.distinct).padStart(3)} ` +
        `diff=${(paint.diffFrac * 100).toFixed(1).padStart(5)}%  ` +
        (r.ok ? JSON.stringify(r.meta) : `${r.error}`),
    );
    if (!r.ok && r.stack) console.error(r.stack);
  }

  const coverage = await page.coverage.stopJSCoverage();

  // Dump the RAW playwright V8 coverage (url + source + functions byte ranges) to
  // disk so scripts/coverage_merge.mjs can map it back to src/*.ts via the inline
  // vite sourcemaps and union it with the node + boot captures.  Each entry carries
  // its served source, which holds the inline sourcemap MCR needs.  Path is
  // overridable via COVER_V8_OUT; the per-module byte summary below is unchanged.
  const v8OutPath = process.env.COVER_V8_OUT || join(HERE, "..", "coverage", "browser-render", "v8.json");
  mkdirSync(dirname(v8OutPath), { recursive: true });
  writeFileSync(v8OutPath, JSON.stringify(coverage));
  console.log(`[cover] wrote raw V8 (${coverage.length} entries) -> ${v8OutPath}`);

  // per-module coverage summary.  V8 precise/block coverage is a RANGE TREE: the
  // outermost range is the whole-file module function (count>=1 once imported), so
  // unioning count>0 ranges would always report ~100%.  The honest figure is the
  // file MINUS the count==0 "holes" (sub-ranges V8 marks as never executed); no
  // count>0 range nests inside a count==0 parent, so the union of count==0 ranges is
  // exactly the uncovered region.  covered = total - union(count==0).
  // Dedupe ?t=/?v= transform variants by keeping, per module, the entry with the
  // largest source (the real served module).
  const byModule = new Map();
  for (const entry of coverage) {
    const mod = moduleOf(entry.url);
    if (!mod) continue;
    const total = entry.source ? entry.source.length : 0;
    const prev = byModule.get(mod);
    if (!prev || total > prev.total) byModule.set(mod, { total, entry });
  }
  const perModule = new Map();
  for (const [mod, { total, entry }] of byModule) {
    const holes = [];
    for (const fn of entry.functions) {
      for (const rg of fn.ranges) {
        if (rg.count === 0) holes.push([rg.startOffset, rg.endOffset]);
      }
    }
    const uncovered = mergedLen(holes);
    perModule.set(mod, { total, covered: Math.max(0, total - uncovered), loaded: true });
  }

  console.log("\n== V8 coverage (browser-only draw modules) ==");
  const covReport = [];
  for (const mod of DRAW_MODULES) {
    const m = perModule.get(mod);
    if (!m || !m.loaded) {
      console.log(`  ${mod.padEnd(16)} NOT LOADED`);
      covReport.push({ module: mod, loaded: false, pct: 0, covered: 0, total: 0 });
      continue;
    }
    const pct = m.total ? (m.covered / m.total) * 100 : 0;
    console.log(`  ${mod.padEnd(16)} ${pct.toFixed(1).padStart(5)}%  (${m.covered}/${m.total} bytes)`);
    covReport.push({ module: mod, loaded: true, pct: Number(pct.toFixed(1)), covered: m.covered, total: m.total });
  }
  // also list every other src module touched, for completeness
  const otherTouched = [...perModule.keys()].filter((m) => !DRAW_MODULES.includes(m)).sort();
  if (otherTouched.length) console.log("  (other src modules executed: " + otherTouched.join(", ") + ")");

  const crashes = results.filter((r) => !r.ok);
  const blanks = results.filter((r) => r.ok && !r.painted);

  writeFileSync(
    join(OUT, "report.json"),
    JSON.stringify(
      {
        baseURL: BASE,
        states: results,
        coverage: covReport,
        otherTouched,
        crashes: crashes.map((c) => ({ name: c.name, error: c.error, stack: c.stack })),
        blanks: blanks.map((b) => b.name),
        pageErrors,
        httpErrors,
      },
      null,
      2,
    ),
  );

  await browser.close();

  console.log(
    `\nSTATES: ${results.length}  PASS: ${results.filter((r) => r.ok && r.painted).length}  ` +
      `CRASH: ${crashes.length}  BLANK: ${blanks.length}  pageerrors: ${pageErrors.length}`,
  );

  if (crashes.length || blanks.length || pageErrors.length) {
    if (crashes.length) console.error("CRASHES:\n" + crashes.map((c) => `  ${c.name}: ${c.error}`).join("\n"));
    if (blanks.length) console.error("BLANK CANVAS: " + blanks.map((b) => b.name).join(", "));
    process.exit(1);
  }
  console.log("OK: every render state painted with no exception.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

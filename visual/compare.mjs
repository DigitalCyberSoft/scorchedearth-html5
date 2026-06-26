// Visual regression gate: DIFF + REPORT.
//
// For each scenario compares the Python ORACLE frame (out/ref_<name>.rgba) to the
// TS PORT frame (out/ts_<name>.rgba) pixel-by-pixel, and:
//   1. SANITY GATE: asserts the two STATE snapshots are byte-identical first
//      (out/state_<name>.json vs out/ts_state_<name>.json). A pixel diff on
//      divergent states is meaningless (DTM 3.12.1), so a snapshot mismatch is a
//      hard FAIL reported before any pixel metric.
//   2. REGION METRICS: % exactly-equal, % within +/-2 per channel, max channel
//      delta -- split into HUD (top BAR_H=22 px, the status bar) vs WORLD
//      (sky/terrain/tanks/projectiles, the rest of the frame). Text/HUD is
//      reported separately and NOT counted against the world-parity claim.
//   3. DIFF IMAGE: out/diff_<name>.png, differing pixels highlighted red over a
//      dimmed grayscale of the Python ref.
//
// Honesty: STARS sky (exact:false) is RNG-driven on BOTH sides (np.random vs
// Math.random) so its pixels are EXPECTED to differ; it is reported but excluded
// from the pass/fail world-parity verdict.
//
// Usage: node visual/compare.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SPEC = JSON.parse(readFileSync(join(HERE, "scenario_spec.json"), "utf8"));
const W = SPEC.width, H = SPEC.height;
const BAR_H = 22; // render.py:970 / render.ts:1300 -- top icon bar height (HUD bar)
// The wind readout ("Wind: <n>") is right-aligned text drawn JUST BELOW the bar
// (render.py:1083-1090: x ~ W-8, y = _hud_bottom+6 ~ 28). It is HUD TEXT but it
// floats into the y>=22 band, so it must be classified as TEXT (font raster
// differs: Canvas vs pygame FreeType -- EXPECTED, not a render bug) and kept out
// of the WORLD parity claim. Box sized to cover the readout with margin.
const WIND_BOX = { x0: 936, x1: W, y0: BAR_H, y1: 46 };

// ---- PNG writer (RGBA8), identical to diff_run.mjs ----
function pngChunk(tag, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function writePng(path, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const comp = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([sig, pngChunk("IHDR", ihdr),
    pngChunk("IDAT", comp), pngChunk("IEND", Buffer.alloc(0))]));
}

// Classify a pixel into one of three regions:
//   hud   = the top icon bar (y < BAR_H): black 190-alpha bar on BOTH sides,
//           plus Power/Angle/name/weapon text WHEN a shooter is set.
//   text  = the wind readout corner that floats below the bar (font raster).
//   world = sky / terrain / tanks / projectiles / explosions -- the parity claim.
function regionOf(x, y) {
  if (y < BAR_H) return "hud";
  if (x >= WIND_BOX.x0 && x < WIND_BOX.x1 && y >= WIND_BOX.y0 && y < WIND_BOX.y1) {
    return "text";
  }
  return "world";
}

// Canonical (key-sorted, recursive) JSON so object key ORDER does not register
// as a difference: Python json.dumps(sort_keys=True) emits alphabetical keys
// while the TS object literals keep insertion order. Only VALUES matter here.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

function snapEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function firstSnapDiff(a, b) {
  const diffs = [];
  for (const k of Object.keys(a)) {
    if (k === "tanks") continue;
    if (JSON.stringify(canon(a[k])) !== JSON.stringify(canon(b[k]))) {
      diffs.push(`${k}: py=${JSON.stringify(a[k])} ts=${JSON.stringify(b[k])}`);
    }
  }
  const na = (a.tanks || []).length, nb = (b.tanks || []).length;
  if (na !== nb) diffs.push(`tanks.length py=${na} ts=${nb}`);
  else {
    for (let i = 0; i < na; i++) {
      if (JSON.stringify(canon(a.tanks[i])) !== JSON.stringify(canon(b.tanks[i]))) {
        diffs.push(`tanks[${i}]: py=${JSON.stringify(canon(a.tanks[i]))} ts=${JSON.stringify(canon(b.tanks[i]))}`);
      }
    }
  }
  return diffs;
}

function compareScenario(scn) {
  const name = scn.name;
  const refPath = join(OUT, `ref_${name}.rgba`);
  const tsPath = join(OUT, `ts_${name}.rgba`);
  const pySnapPath = join(OUT, `state_${name}.json`);
  const tsSnapPath = join(OUT, `ts_state_${name}.json`);

  for (const p of [refPath, tsPath, pySnapPath, tsSnapPath]) {
    if (!existsSync(p)) {
      return { name, error: `missing ${p}` };
    }
  }

  // --- SANITY GATE ---
  const pySnap = JSON.parse(readFileSync(pySnapPath, "utf8"));
  const tsSnap = JSON.parse(readFileSync(tsSnapPath, "utf8"));
  const stateOk = snapEqual(pySnap, tsSnap);
  const snapDiffs = stateOk ? [] : firstSnapDiff(pySnap, tsSnap);

  const ref = readFileSync(refPath);
  const ts = readFileSync(tsPath);
  if (ref.length !== W * H * 4 || ts.length !== W * H * 4) {
    return { name, error: `rgba size ref=${ref.length} ts=${ts.length} want=${W * H * 4}` };
  }

  // --- pixel metrics per region ---
  const mk = () => ({ total: 0, exact: 0, within2: 0, maxDelta: 0, worst: null });
  const reg = { world: mk(), hud: mk(), text: mk() };
  const diff = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bucket = reg[regionOf(x, y)];
      const i = (y * W + x) * 4;
      const dr = Math.abs(ref[i] - ts[i]);
      const dg = Math.abs(ref[i + 1] - ts[i + 1]);
      const db = Math.abs(ref[i + 2] - ts[i + 2]);
      const dmax = Math.max(dr, dg, db);
      bucket.total++;
      if (dmax === 0) bucket.exact++;
      if (dmax <= 2) bucket.within2++;
      if (dmax > bucket.maxDelta) {
        bucket.maxDelta = dmax;
        bucket.worst = { x, y, py: [ref[i], ref[i + 1], ref[i + 2]],
                         ts: [ts[i], ts[i + 1], ts[i + 2]] };
      }
      // diff image: dimmed grayscale of ref, red where they differ
      const g = (ref[i] * 0.3 + ref[i + 1] * 0.59 + ref[i + 2] * 0.11) * 0.4 | 0;
      if (dmax === 0) {
        diff[i] = g; diff[i + 1] = g; diff[i + 2] = g; diff[i + 3] = 255;
      } else {
        diff[i] = 255; diff[i + 1] = 0; diff[i + 2] = 0; diff[i + 3] = 255;
      }
    }
  }

  writePng(join(OUT, `diff_${name}.png`), W, H, diff);

  // Side-by-side triptych (Python ref | TS port | diff) for one-glance review.
  const GAP = 6;
  const TW = W * 3 + GAP * 2;
  const trip = Buffer.alloc(TW * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const put = (panel, off) => {
        const d = (y * TW + (panel * (W + GAP)) + x) * 4;
        trip[d] = off[s]; trip[d + 1] = off[s + 1]; trip[d + 2] = off[s + 2]; trip[d + 3] = 255;
      };
      put(0, ref);
      put(1, ts);
      put(2, diff);
    }
  }
  writePng(join(OUT, `triptych_${name}.png`), TW, H, trip);

  const pct = (n, d) => (d === 0 ? 0 : (100 * n) / d);
  const fmt = (b) => ({
    exactPct: +pct(b.exact, b.total).toFixed(4),
    within2Pct: +pct(b.within2, b.total).toFixed(4),
    maxDelta: b.maxDelta,
    worst: b.worst,
    pixels: b.total,
  });

  return {
    name,
    sky: scn.sky,
    seed: scn.seed,
    exact: scn.exact,
    stateOk,
    snapDiffs,
    world: fmt(reg.world),
    hud: fmt(reg.hud),
    text: fmt(reg.text),
    diffImage: join(OUT, `diff_${name}.png`),
  };
}

function main() {
  const results = SPEC.scenarios.map(compareScenario);

  console.log("\n=== STATE SANITY GATE (snapshot equality, DTM 3.12.1) ===");
  let sanityFail = 0;
  for (const r of results) {
    if (r.error) { console.log(`  ${r.name.padEnd(12)} ERROR ${r.error}`); sanityFail++; continue; }
    const tag = r.stateOk ? "PASS" : "FAIL";
    console.log(`  ${r.name.padEnd(12)} ${tag}`);
    if (!r.stateOk) {
      sanityFail++;
      for (const d of r.snapDiffs.slice(0, 6)) console.log(`      - ${d}`);
    }
  }

  console.log("\n=== PIXEL DIFF (Python oracle vs TS port) ===");
  console.log("  WORLD = sky/terrain/tanks (the parity claim). TEXT = wind readout (font raster, EXPECTED to differ).");
  console.log("  HUD = top bar. maxd = max per-channel delta over the region.\n");
  console.log("  scenario     sky      exact?  WORLD-exact% WORLD-<=2%  WORLD-maxd  TEXT-exact%  HUD-exact%  HUD-<=2%");
  for (const r of results) {
    if (r.error) continue;
    console.log(
      "  " + r.name.padEnd(12) + " " + String(r.sky).padEnd(8) + " " +
      String(r.exact).padEnd(7) + " " +
      r.world.exactPct.toFixed(3).padStart(11) + "  " +
      r.world.within2Pct.toFixed(3).padStart(9) + "  " +
      String(r.world.maxDelta).padStart(9) + "  " +
      r.text.exactPct.toFixed(3).padStart(10) + "  " +
      r.hud.exactPct.toFixed(3).padStart(9) + "  " +
      r.hud.within2Pct.toFixed(3).padStart(7),
    );
  }
  console.log("  (HUD-exact may be <100% from a 1-LSB alpha-blend rounding of the 190/255 black bar");
  console.log("   over the sky; HUD-<=2% ~100% confirms it is sub-LSB rounding, not a divergence.)");

  // World-region verdict on the EXACT scenarios only.
  console.log("\n=== WORLD-REGION VERDICT (exact-comparable scenarios only) ===");
  let worldFail = 0;
  for (const r of results) {
    if (r.error || !r.exact) continue;
    // The WORLD region (sky/terrain/tanks, text excluded) shares the same palette
    // LUT + integer compositing on both ports, so it is byte-EXACT: the gate
    // requires 100% exactly-equal world pixels. Any non-text world pixel that
    // differs is a real render divergence (the gridAt/sky-fill class) and fails.
    const ok = r.world.exactPct >= 100.0;
    if (!ok) {
      worldFail++;
      console.log(`  ${r.name.padEnd(12)} DIVERGENCE  world exact=${r.world.exactPct}% within2=${r.world.within2Pct}% ` +
        `maxd=${r.world.maxDelta} worst@(${r.world.worst?.x},${r.world.worst?.y}) ` +
        `py=${JSON.stringify(r.world.worst?.py)} ts=${JSON.stringify(r.world.worst?.ts)}`);
      console.log(`               see ${r.diffImage}`);
    } else {
      console.log(`  ${r.name.padEnd(12)} OK          world exact=${r.world.exactPct}% (byte-identical) maxd=${r.world.maxDelta}`);
    }
  }
  for (const r of results) {
    if (!r.error && !r.exact) {
      console.log(`  ${r.name.padEnd(12)} (excluded: RNG sky, expected-divergent) world within2=${r.world.within2Pct}%`);
    }
  }

  writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2));
  console.log(`\n[diff] wrote out/report.json ; diff images out/diff_*.png`);
  console.log(`[diff] sanity failures=${sanityFail} ; world divergences (exact scns)=${worldFail}`);

  if (sanityFail > 0) {
    console.error("\nGATE FAIL: state sanity gate did not pass -- states diverge, pixel diff is not meaningful.");
    process.exit(3);
  }
  if (worldFail > 0) {
    console.error("\nGATE FAIL: a world-region rendering divergence was found on an exact-comparable scenario.");
    process.exit(4);
  }
  console.log("\nGATE PASS: states byte-identical; WORLD region (sky/terrain/tanks) byte-identical on all exact scenarios. Only TEXT (wind readout) differs -- expected font rasterization, not a render bug.");
}

main();

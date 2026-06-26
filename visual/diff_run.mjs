// Visual regression gate: TS-side capture driver (playwright + system chrome).
//
// Connects to an ALREADY-RUNNING vite dev server (see run_gate.sh, which starts
// the server and this driver in one shell so the server outlives a subshell),
// opens visual harness.html, and for each scenario:
//   1. calls window.stateSnapshot(name)  -> the TS state snapshot (sanity gate)
//   2. calls window.renderScenario(name) -> renders the battlefield to #game
//   3. reads the canvas RGBA back via getImageData and writes:
//        out/ts_<name>.png    (PNG, for eyeballing)
//        out/ts_<name>.rgba   (row-major RGBA bytes, for the pixel diff)
//        out/ts_state_<name>.json (the TS snapshot)
//
// It does NOT diff here; compare.mjs does that against the Python refs. It does
// NOT start or kill the server (no pkill -f vite -- that self-matches).
//
// Usage: node visual/diff_run.mjs [baseURL]   (default http://localhost:5180)

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";

const require = createRequire(
  "/home/user/Scorched Earth/scorch-html5/package.json",
);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const BASE = process.argv[2] || "http://localhost:5180";

const SPEC = JSON.parse(readFileSync(join(HERE, "scenario_spec.json"), "utf8"));

// Minimal RGBA8 PNG writer (matches render_python.write_png). node:zlib provides
// deflate + crc32, so no external PNG dependency.
function pngChunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function writePng(path, w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter 0 (None)
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
              : Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(
                  raw, y * (stride + 1) + 1);
  }
  const comp = deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10..12 = compression/filter/interlace = 0
  writeFileSync(
    path,
    Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", comp),
                   pngChunk("IEND", Buffer.alloc(0))]),
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({
    viewport: { width: SPEC.width, height: SPEC.height },
    deviceScaleFactor: 1,
  });
  // Fatal: uncaught JS exceptions (pageerror) and HTTP>=400 on APP assets
  // (/assets/, /visual/, /src/). A generic console "Failed to load resource"
  // with no URL is browser favicon/devtools noise and is NOT fatal -- we gate on
  // the response listener which carries the actual URL.
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("response", (res) => {
    const u = res.url();
    if (res.status() >= 400 && /\/(assets|visual|src)\//.test(u)) {
      errors.push(`HTTP ${res.status()} ${u}`);
    }
  });

  const url = `${BASE}/harness.html`;
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => window.harnessReady);

  if (errors.length) {
    console.error("[ts] harness boot errors:\n" + errors.join("\n"));
    await browser.close();
    process.exit(2);
  }

  const index = [];
  for (const scn of SPEC.scenarios) {
    const name = scn.name;
    const snap = await page.evaluate((n) => window.stateSnapshot(n), name);
    // NOTE: no replacer arg -- passing a key array to JSON.stringify is an
    // allowlist that recursively strips nested tank-object fields to {}.
    writeFileSync(
      join(OUT, `ts_state_${name}.json`),
      JSON.stringify(snap, null, 2),
    );

    const dim = await page.evaluate((n) => window.renderScenario(n), name);
    const { w, h } = dim;
    // Read the canvas RGBA back (row-major, the same layout as the Python rgba).
    const dataUrlLen = await page.evaluate(
      ({ w, h }) => {
        const c = document.getElementById("game");
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, w, h);
        // Stash on window so we can pull it as a transferable-ish array.
        window.__rgba = Array.from(img.data);
        return img.data.length;
      },
      { w, h },
    );
    const arr = await page.evaluate(() => window.__rgba);
    const rgba = Buffer.from(arr);
    if (rgba.length !== w * h * 4) {
      throw new Error(`${name}: rgba len ${rgba.length} != ${w * h * 4} (got ${dataUrlLen})`);
    }
    writeFileSync(join(OUT, `ts_${name}.rgba`), rgba);
    writePng(join(OUT, `ts_${name}.png`), w, h, rgba);

    index.push({ name, sky: scn.sky, seed: scn.seed, exact: scn.exact });
    console.log(
      `[ts] ${name.padEnd(12)} sky=${String(scn.sky).padEnd(7)} ` +
        `seed=${String(scn.seed).padEnd(5)} grid_crc=${(snap.grid_crc32 >>> 0)
          .toString(16)
          .padStart(8, "0")} tanks=${snap.tanks.length} phase=${snap.phase} ` +
        `shooter=${snap.current_shooter}`,
    );
  }

  writeFileSync(
    join(OUT, "ts_index.json"),
    JSON.stringify({ width: SPEC.width, height: SPEC.height, scenarios: index }, null, 2),
  );
  console.log(`[ts] wrote ${index.length} TS frames + snapshots to ${OUT}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

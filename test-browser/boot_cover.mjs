// Real-app BOOT + PLAY coverage driver (playwright + system chrome).
//
// Unlike run.mjs (which loads the render-crash HARNESS, test-browser/harness.html),
// this driver loads the ACTUAL shipping app -- index.html -> /src/main.ts -- against
// a running vite DEV server, so it exercises the code the harness never touches:
//   * src/main.ts boot(): asset fetch (assets.ts), IndexedDB save-store hydrate,
//     DOM input install, App construction.
//   * the requestAnimationFrame loop (App.step / _draw / _present) frame after frame.
//   * real keyboard + mouse input flowing through the installed window/canvas
//     listeners into the App and GameScreen.
//
// It drives: MainMenu --Enter(Start)--> TankInit(player 1) --Enter(Done)-->
// TankInit(player 2) --Enter(Done)--> battlefield, then ramps power and fires a few
// Space shots (best-effort kill); if the round ends it advances the rankings /
// game-over panels.  Throughout it records V8 coverage and writes the RAW capture to
// disk (coverage/boot/v8.json) so scripts/coverage_merge.mjs can map it back to
// src/*.ts via the inline vite sourcemaps and union it with the node + render runs.
//
// A pageerror (uncaught exception in the real app) makes the driver exit NON-ZERO.
// No src is touched.  A kill NOT happening is not a failure (blind fire may miss).
//
// Usage: node test-browser/boot_cover.mjs [baseURL]   (default http://localhost:4188)

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire("/home/user/Scorched Earth/scorch-html5/package.json");
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://localhost:4188";
const V8_OUT = process.env.COVER_V8_OUT || join(HERE, "..", "coverage", "boot", "v8.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
    if (res.status() >= 400 && /\/(assets|src)\//.test(u)) httpErrors.push(`HTTP ${res.status()} ${u}`);
  });

  // V8 coverage MUST start before the navigation that loads /src/main.ts and its
  // graph, so the boot-time module top-level code is recorded.
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });

  await page.goto(`${BASE}/index.html`, { waitUntil: "load", timeout: 60000 });

  // boot() finished when main.ts drops the #loading overlay (adds .done after the
  // first menu frame).  Wait for it so asset fetch + IndexedDB hydrate have run; on
  // timeout, continue anyway (partial boot coverage is still useful and a real boot
  // crash is caught separately via pageerror).
  try {
    await page.waitForFunction(
      () => document.getElementById("loading")?.classList.contains("done") === true,
      { timeout: 45000 },
    );
    console.log("[boot] menu up (loader hidden)");
  } catch {
    console.log("[boot] WARN: loader still visible after 45s; continuing to drive input");
  }
  await sleep(400); // let a few rAF frames settle the first menu frame

  // --- menu -> 2-player setup -> battlefield -----------------------------------
  // Each screen here is opaque (no zoom-wipe to swallow a keypress), and the name
  // TextField starts non-editing, so exactly ONE Enter activates each default
  // button: Start, then Done, then Done -> App._build_game -> GameScreen.
  const press = async (key, waitMs) => {
    await page.keyboard.press(key);
    await sleep(waitMs);
  };
  await press("Enter", 350); // MainMenu ~Start  -> TankInit(player 1)
  await press("Enter", 350); // TankInit ~Done   -> TankInit(player 2)
  await press("Enter", 700); // TankInit ~Done   -> build game, GameScreen (turn begins)
  console.log("[play] battlefield reached; firing");

  // --- fire a few shots (ramp power via held ArrowUp, then Space = Launch) ------
  // Space only fires while phase==aim (a human's turn); presses during flight are
  // ignored, so over-pressing is safe.  ArrowUp held feeds the continuous-aim path.
  for (let shot = 0; shot < 6; shot++) {
    await page.keyboard.down("ArrowUp"); // ramp power
    await sleep(350);
    await page.keyboard.up("ArrowUp");
    await page.keyboard.press("Space"); // ~Launch -> gs.fire()
    await sleep(1300); // flight + impact + hand-off to the next human turn
  }

  // --- mouse input: cover the canvas listeners + ingame HUD / tank-click paths ---
  await page.mouse.move(512, 700);
  await page.mouse.click(512, 745); // HUD strip (Power/Angle/weapon readout) -- LEFT btn
  await sleep(150);
  await page.mouse.click(400, 520); // battlefield body (tank info-box / dismiss)
  await sleep(150);
  // MIDDLE + RIGHT buttons exercise the non-left branches of the mousedown/up
  // listeners (_installInput maps button 2/3 to the pygame mouse-state array).
  await page.mouse.click(420, 520, { button: "middle" });
  await sleep(120);
  await page.mouse.click(440, 520, { button: "right" });
  await sleep(300);

  // --- best-effort: advance an interim rankings panel / game-over, if a kill ended
  //     the round.  Space=rankings_done, Enter=dismiss game-over; no-ops otherwise.
  await page.keyboard.press("Space");
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(500);

  // --- APP-DRIVE pass: the shallow play-through above never reaches the breadth of
  //     App._act's dispatch, the dialog zoom-wipe, Rankings/GameOver, fullscreen,
  //     config-save, the SIMULTANEOUS routes, or the IndexedDB save store.  Navigate
  //     to the app-drive harness (which constructs the SAME real App and invokes those
  //     real entry points) so its main.ts execution accumulates into THIS capture
  //     (coverage started with resetOnNavigation:false, so it survives the nav).  A
  //     scenario that throws is captured as ok:false and FAILS the driver.
  await page.goto(`${BASE}/test-browser/app_harness.html`, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => window.appReady);
  const scenarios = await page.evaluate(() => window.listScenarios());
  const appFails = [];
  for (const name of scenarios) {
    const r = await page.evaluate((n) => window.runScenario(n), name);
    const tag = r.ok ? "OK  " : "FAIL";
    console.log(`[app] ${tag} ${String(name).padEnd(16)} ${r.ok ? JSON.stringify(r.meta) : r.error}`);
    if (!r.ok) {
      appFails.push(r);
      if (r.stack) console.error(r.stack);
    }
  }

  const coverage = await page.coverage.stopJSCoverage();
  mkdirSync(dirname(V8_OUT), { recursive: true });
  writeFileSync(V8_OUT, JSON.stringify(coverage));
  const srcEntries = coverage.filter((e) => typeof e.url === "string" && e.url.includes("/src/")).length;
  console.log(`[cover] wrote raw V8 (${coverage.length} entries, ${srcEntries} from /src/) -> ${V8_OUT}`);

  await browser.close();

  if (httpErrors.length) console.error("[boot] HTTP errors:\n" + httpErrors.join("\n"));
  if (pageErrors.length) {
    console.error(`PAGEERRORS (${pageErrors.length}):\n` + pageErrors.join("\n\n"));
    process.exit(1);
  }
  if (appFails.length) {
    console.error(`APP-DRIVE FAILURES (${appFails.length}): ` + appFails.map((r) => `${r.name}: ${r.error}`).join(" | "));
    process.exit(1);
  }
  console.log("OK: real app booted, played, app-drive scenarios passed, coverage recorded.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

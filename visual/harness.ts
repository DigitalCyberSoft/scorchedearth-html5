// Visual regression gate: TS PORT side (browser harness).
//
// Loads assets exactly like src/main.ts boot() (the 10 .MTN files ->
// sprites.setMtnByteSource + setMtnRanges; TALK; sprites bundle wired into
// render), then exposes:
//
//   window.renderScenario(name) -> Promise<{w,h}>   renders the battlefield frame
//                                                    for scenario `name` onto the
//                                                    page canvas (#game).
//   window.stateSnapshot(name)  -> Promise<object>  the SAME snapshot fields the
//                                                    Python oracle dumps (sanity gate).
//   window.harnessReady         -> Promise<void>     resolves when assets are loaded.
//
// The scenario is built the SAME way render_python.py builds it:
//   createGameState(cfg, W, H, seed)  (seeds both RNG streams)
//   gs.add_player(...) x2 ; gs.new_game()
// with cfg overrides + pinned SKY from scenario_spec.json (fetched at boot).
//
// No menu flow: state is constructed directly so a frame diff is attributable to
// RENDERING, not state divergence.

import * as assets from "../src/assets";
import { Config } from "../src/config";
import {
  createGameState,
  setMtnRanges,
  type GameState,
} from "../src/game";
import { Renderer } from "../src/render";
import { setSpritesProvider } from "../src/render";
import * as sprites from "../src/sprites";
import * as pygame from "../src/pygame";

interface ScnSpec {
  width: number;
  height: number;
  config: { [k: string]: string | number };
  roster: [string, number, number, number][];
  scenarios: { name: string; seed: number; sky: string; exact: boolean }[];
}

let SPEC: ScnSpec;
let PAGE: HTMLCanvasElement;

function makeCfg(scn: { sky: string }): Config {
  const cfg = new Config();
  for (const k of Object.keys(SPEC.config)) {
    (cfg as unknown as { [k: string]: unknown })[k] = SPEC.config[k];
  }
  cfg.SKY = scn.sky; // PIN the sky -> resolve_round_sky returns it verbatim
  (cfg as unknown as { mayhem: boolean }).mayhem = false;
  cfg.live_elastic = cfg.elastic; // re-resolve after any ELASTIC override
  return cfg;
}

function buildState(scn: { name: string; seed: number; sky: string }): GameState {
  const cfg = makeCfg(scn);
  const gs = createGameState(cfg, SPEC.width, SPEC.height, scn.seed);
  // Pin the procedural _midpoint terrain path (matches render_python.py and the
  // proven test/game.test.ts setup). createGameState set gs.mtn_ranges from the
  // registered ranges; override to [] so terrain.generate skips _from_mtn and
  // the two ports build byte-identical terrain. (Render parity, not MTN-decoder
  // parity, is what this gate measures.)
  (gs as unknown as { mtn_ranges: unknown[] }).mtn_ranges = [];
  for (const [name, ai, team, icon] of SPEC.roster) {
    gs.add_player(name, ai, team, icon);
  }
  gs.new_game(); // INITIAL_CASH==0 -> start_round(): terrain + place + wind + sky
  return gs;
}

// CRC-32 (IEEE) over the terrain grid in the SAME logical order the Python side
// hashes its numpy [x, y] grid: x-major then y. The TS grid is column-major
// (grid[x*h + y]), so a straight linear scan of grid[0..w*h) is already x-major
// then y -- identical order to numpy tobytes(). Verified against zlib.crc32.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function snapshot(gs: GameState): object {
  const cur = gs.current_shooter;
  const curIdx = cur ? gs.tanks.indexOf(cur) : -1;
  return {
    phase: gs.phase,
    live_sky: gs.live_sky,
    wind: Math.trunc((gs.cfg as unknown as { wind: number }).wind),
    fire_index: gs.fire_index | 0,
    current_shooter: curIdx,
    terrain_w: gs.terrain.w,
    terrain_h: gs.terrain.h,
    grid_crc32: crc32(gs.terrain.grid),
    tanks: gs.tanks.map((t) => ({
      x: Math.trunc(t.x),
      y: Math.trunc(t.y),
      angle: Math.trunc(t.angle),
      power: Math.trunc(t.power),
      color: Math.trunc(t.color),
      half_width: Math.trunc(t.half_width),
      alive: !!t.alive,
    })),
  };
}

function findScn(name: string): { name: string; seed: number; sky: string } {
  const s = SPEC.scenarios.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario ${name}`);
  return s;
}

async function boot(): Promise<void> {
  // Absolute path: the harness page lives at project root (/harness.html) so a
  // page-relative URL would miss; the spec is under /visual/.
  SPEC = (await (await fetch("/visual/scenario_spec.json")).json()) as ScnSpec;

  // --- assets, mirroring src/main.ts boot() step 3 ---------------------------
  // TALK (latin-1 text). Not strictly needed for a battlefield frame, but loaded
  // to match the app boot and keep the talk module happy.
  await Promise.all([
    assets.fetchText("TALK1.CFG").catch(() => ""),
    assets.fetchText("TALK2.CFG").catch(() => ""),
  ]);

  // The 10 .MTN files -> sprites byte source + game mtn ranges (main.ts:1366-1380).
  const names = await assets.listMtnFiles();
  const mtnBytes = new Map<string, Uint8Array>();
  await Promise.all(
    names.map(async (n) => {
      try {
        mtnBytes.set(n.toUpperCase(), await assets.fetchBytes(n));
      } catch {
        /* a missing .MTN degrades to procedural terrain; not fatal for this gate */
      }
    }),
  );
  sprites.setMtnByteSource((nm) => mtnBytes.get(nm.toUpperCase()) ?? null);
  setMtnRanges([...mtnBytes].map(([name, data]) => ({ name, data })));

  // sprites bundle into the renderer (main.ts:1396 setRenderSprites).
  setSpritesProvider(sprites as unknown as Parameters<typeof setSpritesProvider>[0]);

  // Renderer is constructed fresh per scenario in renderScenario (mirrors the
  // Python oracle); nothing Renderer-related is cached at boot.
  PAGE = document.getElementById("game") as HTMLCanvasElement;
  PAGE.width = SPEC.width;
  PAGE.height = SPEC.height;
}

const ready = boot();

(window as unknown as { harnessReady: Promise<void> }).harnessReady = ready;

(window as unknown as {
  stateSnapshot: (name: string) => Promise<object>;
}).stateSnapshot = async (name: string) => {
  await ready;
  return snapshot(buildState(findScn(name)));
};

(window as unknown as {
  renderScenario: (name: string) => Promise<{ w: number; h: number }>;
}).renderScenario = async (name: string) => {
  await ready;
  const scn = findScn(name);
  const gs = buildState(scn);
  // Build a FRESH Renderer per scenario, matching the Python oracle
  // (render_python.py constructs Renderer(cfg, w, h) inside its loop). The TS
  // Renderer caches sky state and seeds the live-LUT sky band once per mode
  // (_sky_lut_seeded); reusing one Renderer across scenarios with DIFFERENT
  // GameState.lut objects would leave a later same-mode scenario's fresh LUT
  // unseeded -> a measurement artifact, not a render difference. Fresh per
  // scenario makes both sides do the identical thing.
  const renderer = new Renderer(makeCfg(scn), SPEC.width, SPEC.height);
  // Render onto a Surface (its own canvas), then blit to the page canvas exactly
  // like main.ts _present (drawImage(backbuffer.canvas, 0, 0)).
  const surf = new pygame.Surface([SPEC.width, SPEC.height]);
  renderer.render(surf, gs);
  const ctx = PAGE.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, SPEC.width, SPEC.height);
  ctx.drawImage(surf.canvas, 0, 0);
  return { w: SPEC.width, h: SPEC.height };
};

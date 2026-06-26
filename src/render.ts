/**
 * Rendering (Canvas2D, via the pygame shim).  A faithful TypeScript port of
 * scorch-py/scorch/render.py (the fidelity oracle).  The original VGA blit is
 * excluded by request; this draws the recovered world: the terrain index-plane
 * composited through the palette, tanks, projectiles, the explosion color band
 * (ring = 0xDD - curR*20/maxR), laser beams, and the HUD.  Renders to a fixed
 * logical surface; main.ts scales it to the window / fullscreen.
 *
 * The FUN_/DAT_ provenance from the Python source is preserved verbatim so the
 * lineage survives.
 *
 * WHAT IS NUMERICALLY TESTED (test/render.test.ts, golden = oracle/dump_render.py):
 *   - the terrain composite buffer: grid -> rgb gathered through the live LUT into
 *     the COLUMN-MAJOR (x*h + y)*3 surfarray buffer (compositeTerrainRgb), EXACT;
 *   - the title-backdrop vertical gradient (verticalGradient), EXACT;
 *   - the gradient sky INDEX plane (gradientIndexPlane), EXACT;
 *   - the banded (30-step) sunset ramp (bandedVerticalRamp), EXACT;
 *   - the baked BLACK/SUNSET/STORMY/CAVERN sky planes (makeSkyPlane), EXACT;
 *   - the explosion ring index 0xDD - r*20/maxR (explosionRingIndex), EXACT;
 *   - the HUD elevation map (hudAngle), the shield-percent (shieldPct), the
 *     parachute / death-tile geometry tables, EXACT;
 *   - the title mountain aspect-preserving scale/anchor (titleBackdropLayout), EXACT.
 *
 * WHAT DEFERS TO THE PHASE-3 VISUAL GATE (pixels this module strokes/blits):
 *   every pygame.draw / surf.blit / surf.set_at call. The arrays and the math
 *   that FEED those calls are tested here; the literal rasterized pixels are validated
 *   by the visual diff against the Python pygame renders.  pixelsDeferredToPhase3.
 *
 * STARS sky is NOT exact-tested: makeSkyPlane("STARS") scatters stars via the
 * runtime RNG (Python np.random vs JS Math.random), so its pixels are
 * non-reproducible across runtimes by construction (matching the binary, which
 * also seeds a fresh starfield per round).  Documented; excluded from the gate.
 */

import * as pygame from "./pygame";
import * as C from "./constants";
import * as weapons from "./weapons";
import * as widgets from "./widgets";
import * as _pal from "./palette";
import { build_palette, LiveLUT } from "./palette";

// ---------------------------------------------------------------------------
// Integrator hooks for not-yet-ported deps (the widgets.ts precedent:
// setCursorProvider/setMousePosProvider, no-op until the integrator wires them).
//
//  * `sprites` (scorch.sprites) is a downstream module not yet ported.  render.py
//    calls sprites.draw_tank / load_title_mountain / get_sprite / weapon_icon_
//    palette / WEAPON_ICON_BASE.  The port reads through a SpritesProvider so the
//    draw code is 1:1 with the Python sprites.* calls; until wired it draws the
//    documented fallbacks (a plain hull rect, no title mountain, a circle weapon
//    glyph) -- exactly the behaviour render.py's own try/except fallbacks take.
//  * ingame._in_choose_target is a module-private predicate in scorch.ingame; the
//    port routes the Choose Target banner gate through setChooseTargetPredicate
//    rather than importing a private symbol or duplicating ingame's logic.
// ---------------------------------------------------------------------------

/** The subset of scorch.sprites render.py touches.  Supplied by the integrator. */
export interface SpritesProvider {
  /** sprites.draw_tank(surf, x, y, icon_index, color, angle): procedural hull+barrel. */
  draw_tank(
    surf: pygame.Surface,
    x: number,
    y: number,
    icon_index: number,
    color: [number, number, number],
    angle: number,
  ): void;
  /** sprites.load_title_mountain(name) -> the digitized .MTN surface, or null. */
  load_title_mountain(name: string | null): pygame.Surface | null;
  /** sprites.get_sprite(table, index, {color, pal, scale}) -> a Surface, or null. */
  get_sprite(
    table: string,
    index: number,
    opts: { color?: number; pal?: _pal.PaletteTable; scale?: number },
  ): pygame.Surface | null;
  /** sprites.weapon_icon_palette() -> the band-0xAA shop icon palette table. */
  weapon_icon_palette(): _pal.PaletteTable;
  /** sprites.WEAPON_ICON_BASE (0xAA): the shop icon colour-band base index. */
  WEAPON_ICON_BASE: number;
}

let _sprites: SpritesProvider | null = null;

/** Integrator hook: supply the ported scorch.sprites module. */
export function setSpritesProvider(p: SpritesProvider | null): void {
  _sprites = p;
}

let _chooseTargetPredicate: ((state: GameState) => boolean) | null = null;

/** Integrator hook: supply ingame._in_choose_target (the Choose Target gate). */
export function setChooseTargetPredicate(p: ((state: GameState) => boolean) | null): void {
  _chooseTargetPredicate = p;
}

function _inChooseTarget(state: GameState): boolean {
  return _chooseTargetPredicate !== null ? _chooseTargetPredicate(state) : false;
}

// ---------------------------------------------------------------------------
// Structural types for the live GameState the renderer reads.  game.ts is not
// yet ported, so (like damage.ts's Tank/State interfaces) these are permissive
// structural shapes carrying exactly the fields render.py reads.  Optional/loose
// because the renderer guards almost every field with getattr(...) defaults.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

/** A live palette source the renderer composites through: either a LiveLUT
 *  (proxies indexing + carries `.table`) or a plain (256,3) table. */
export type ActiveLUT = LiveLUT | _pal.PaletteTable;

/** Read one RGB row from either a LiveLUT or a plain table (the Python
 *  `self._active[idx]` that works for both). */
function lutGet(active: ActiveLUT, idx: number): RGB {
  if (active instanceof LiveLUT) {
    return active.table[idx];
  }
  return active[idx];
}

/** The (256,3) row table behind a LiveLUT or plain table (Python `.table` else self). */
function lutTable(active: ActiveLUT): _pal.PaletteTable {
  return active instanceof LiveLUT ? active.table : active;
}

export interface Cfg {
  SKY: string | null;
  BOMB_ICON: string;
  wind: number;
  is_on(key: string): boolean;
}

export interface Tank {
  x: number;
  y: number;
  half_width: number;
  color: number;
  angle: number;
  alive: boolean;
  health: number;
  shield_hp: number;
  shield_item: number;
  selected_weapon: number;
  inventory: number[];
  name: string;
  ai_class: number;
  player_index: number;
  tank_icon?: number;
  chute_descent?: { path: Array<[number, number]>; i: number } | null;
  [extra: string]: unknown;
}

export interface GameState {
  cfg: Cfg;
  lut?: LiveLUT | null;
  terrain: { grid: Int32Array | Uint8Array | number[][] | GridLike };
  tanks: Tank[];
  projectiles: ProjectileLike[];
  explosions: ExplosionLike[];
  beams: Array<{ pts: Array<[number, number]> }>;
  phase: string;
  current_shooter: Tank | null;
  [extra: string]: unknown;
}

/** Grid access shim: the terrain plane is a (W,H) integer index grid.  The Python
 *  is a numpy (W,H) int array; the TS oracle/test build it as a flat column-major
 *  Int32Array with w,h.  `at(x,y)` reads it; iteration helpers below mask/gather. */
export interface GridLike {
  w: number;
  h: number;
  data: Int32Array;
}

interface ProjectileLike {
  sx: number;
  sy: number;
  owner?: { color: number } | null;
  state?: { get(k: string): unknown } | { [k: string]: unknown } | null;
  [extra: string]: unknown;
}

interface ExplosionLike {
  x: number;
  y: number;
  maxr: number;
  style: string;
  phase?: number;
  frame?: number;
  step?: number;
  dirt?: boolean;
  [extra: string]: unknown;
}

// ===========================================================================
// WEAPON_ICON map -- a weapon category -> one extracted sprite name (sprites.py
// tables).  Faithful to render.py:19-25.
// ===========================================================================
export const WEAPON_ICON: { readonly [category: string]: string } = {
  explosive: "shell_a",
  nuclear: "ball_big",
  multi: "mirv_split",
  fire: "napalm_a",
  tracer: "shell_tail",
  roller: "ball_5",
  riot: "spray",
  digger: "fork",
  sandhog: "fork",
  dirt: "clod_a",
  energy: "bolt_a",
  special: "spark_star",
  guidance: "guidance_cross",
  shield: "shield_ring_a",
  utility: "supply_box",
};

export function weaponIconName(item: { category: string }): string {
  return WEAPON_ICON[item.category] ?? "shell_a";
}

// Explosion SHRINK-phase length (FUN_4d1e_015a.c:75 `for iVar2=0; iVar2<0x19`).
// Mirrors game.GameState.EXPLO_SHRINK_FRAMES; kept here so the fade math in
// _draw_explosion does not reach across modules for a draw-only constant.
const _EXPLO_SHRINK_FRAMES = 25;

// ---------------------------------------------------------------------------
// Main-menu title backdrop: the right-panel title art (gradient sky + the
// digitized granite mountain from 1.5/*.MTN), faithful to the v1.5 menu builder
// FUN_4755_0283.  RECONSTRUCTED purple->magenta gradient endpoints, chosen to
// match the supplied v1.5 title screenshot (16_video.md s.2: the runtime DAC sky
// is not statically recoverable as RGB).
// ---------------------------------------------------------------------------
export const TITLE_SKY_TOP: RGB = [40, 24, 96]; // purple-blue
export const TITLE_SKY_BOTTOM: RGB = [208, 96, 150]; // pink/magenta

/** An (w, h, 3) uint8 vertical gradient from top_rgb (row 0) to bottom_rgb, as a
 *  COLUMN-MAJOR buffer data[(x*h + y)*3 + c] (the surfarray contract).
 *
 *  Per-row linear interpolation, matching the per-scanline ramp the engine uses
 *  for its gradient skies (FUN_42c2 sky builders; see Renderer._make_sky).
 *
 *  numpy fidelity: the Python does `(top*(1-t) + bot*t).astype(uint8)` in float32
 *  (np.linspace dtype=float32, top/bot float32), then casts to uint8 (truncates
 *  toward zero).  The port mirrors that with Math.fround at each op and Math.trunc
 *  on store -- the same float32-then-uint8 path palette.LiveLUT.reramp_band uses. */
export function verticalGradient(
  w: number,
  h: number,
  topRgb: RGB,
  bottomRgb: RGB,
): pygame.RgbArray {
  const data = new Uint8Array(w * h * 3);
  const top: RGB = [f32(topRgb[0]), f32(topRgb[1]), f32(topRgb[2])];
  const bot: RGB = [f32(bottomRgb[0]), f32(bottomRgb[1]), f32(bottomRgb[2])];
  // t = np.linspace(0,1,h,float32): float64 i/(h-1), endpoint pinned, cast f32.
  const row: RGB[] = [];
  for (let y = 0; y < h; y++) {
    let tk: number;
    if (h === 1) {
      tk = f32(0.0);
    } else if (y === h - 1) {
      tk = f32(1.0);
    } else {
      tk = f32(y * (1.0 / (h - 1)));
    }
    const oneMinus = f32(1.0 - tk);
    const r: RGB = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const v = f32(f32(top[ch] * oneMinus) + f32(bot[ch] * tk));
      r[ch] = Math.trunc(v) & 0xff; // uint8 store (astype trunc toward zero)
    }
    row.push(r);
  }
  // broadcast the (h,3) ramp over x, column-major.
  for (let x = 0; x < w; x++) {
    const base = x * h * 3;
    for (let y = 0; y < h; y++) {
      const s = base + y * 3;
      const r = row[y];
      data[s] = r[0];
      data[s + 1] = r[1];
      data[s + 2] = r[2];
    }
  }
  return { w, h, data };
}

/** Cast a JS double to IEEE-754 single precision (numpy float32 op matcher). */
function f32(x: number): number {
  return Math.fround(x);
}

/** Python `round()`: banker's rounding (round-half-to-even).  render.py's
 *  make_title_backdrop scales with `int(round(mw*scale))`, so the port must use
 *  Python's half-to-even, NOT JS Math.round (which rounds half away from zero):
 *  round(62.5) == 62 in Python, 63 in JS.  Mirrors damage.pyRound. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The aspect-preserving title-mountain layout (FUN_4755_0283 placement).  Pure
 *  number math separated out so it can be unit-tested without a Surface: given the
 *  panel (w,h) and the mountain (mw,mh), returns the scaled (sw,sh) and the
 *  bottom-right anchor (dx,dy).  Mirrors make_title_backdrop's scale block. */
export function titleBackdropLayout(
  w: number,
  h: number,
  mw: number,
  mh: number,
): { sw: number; sh: number; dx: number; dy: number; scale: number } {
  const maxH = Math.trunc(h * 0.62); // int(h * 0.62)
  let scale = w / mw;
  if (mh * scale > maxH) {
    scale = maxH / mh;
  }
  // max(1, int(round(...))): Python round() is banker's (half-to-even).
  const sw = Math.max(1, Math.trunc(pyRound(mw * scale)));
  const sh = Math.max(1, Math.trunc(pyRound(mh * scale)));
  return { sw, sh, dx: w - sw, dy: h - sh, scale };
}

/** Build the menu's right-panel title art as an (w, h) opaque pygame Surface.
 *  Faithful to make_title_backdrop: a vertical gradient sky with the digitized
 *  granite mountain (via the sprites provider) anchored bottom-right, scaled
 *  aspect-preserving.  Returns the gradient-only surface when no .MTN is available.
 *  (Pixel output -> Phase-3 gate; the gradient + layout math are tested above.) */
export function makeTitleBackdrop(
  w: number,
  h: number,
  mtnName: string | null = null,
  skyTop: RGB = TITLE_SKY_TOP,
  skyBottom: RGB = TITLE_SKY_BOTTOM,
): pygame.Surface {
  const surf = new pygame.Surface([w, h]);
  const grad = verticalGradient(w, h, skyTop, skyBottom);
  pygame.surfarray.blit_array(surf, grad);

  const mtnSurf = _sprites !== null ? _sprites.load_title_mountain(mtnName) : null;
  if (mtnSurf === null) {
    return surf;
  }
  const [mw, mh] = mtnSurf.get_size();
  const { sw, sh, dx, dy } = titleBackdropLayout(w, h, mw, mh);
  const scaled = pygame.transform.smoothscale(mtnSurf, [sw, sh]);
  surf.blit(scaled, [dx, dy]);
  return surf;
}

// ===========================================================================
// Pure sky-plane builders (the array math behind Renderer._make_sky / _sky_plane).
// Each returns a COLUMN-MAJOR buffer / index plane; all are deterministic except
// the STARS branch (RNG, documented at makeSkyPlane).
// ===========================================================================

/** A (W,H) int plane mapping each screen row to an index in the sky band
 *  0x78..0x95 (top row -> band lo, bottom row -> band hi), column-major
 *  data[x*h + y].  FUN_42c2_0ba5 maps rows to band indices the same way. */
export function gradientIndexPlane(w: number, h: number): Int32Array {
  const lo = _pal.SKY_BAND_LO;
  const hi = _pal.SKY_BAND_HI;
  const n = hi - lo + 1;
  const div = Math.max(1, h - 1);
  const out = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    // row_idx = lo + (y*(n-1) // (h-1))  -- Python floor-div, non-negative operands.
    const ri = lo + Math.floor((y * (n - 1)) / div);
    for (let x = 0; x < w; x++) {
      out[x * h + y] = ri;
    }
  }
  return out;
}

/** An (H,3) top->bottom gradient QUANTISED to the 30-entry sky band (the real VGA
 *  skies have only SKY_RAMP_LEN=30 sky colours), returned row-major [y*3+c].
 *  Mirrors _banded_vertical_ramp: band_k = min(n-1, y*n//h); tq = band_k/(n-1);
 *  ramp = top*(1-tq) + bot*tq in float32, cast uint8. */
export function bandedVerticalRamp(h: number, topRgb: RGB, botRgb: RGB): Uint8Array {
  const n = _pal.SKY_RAMP_LEN; // 30
  const top: RGB = [f32(topRgb[0]), f32(topRgb[1]), f32(topRgb[2])];
  const bot: RGB = [f32(botRgb[0]), f32(botRgb[1]), f32(botRgb[2])];
  const out = new Uint8Array(h * 3);
  for (let y = 0; y < h; y++) {
    const bandK = Math.min(n - 1, Math.floor((y * n) / h)); // 0..29
    const tq = f32(bandK / (n - 1));
    const oneMinus = f32(1.0 - tq);
    for (let ch = 0; ch < 3; ch++) {
      const v = f32(f32(top[ch] * oneMinus) + f32(bot[ch] * tq));
      out[y * 3 + ch] = Math.trunc(v) & 0xff;
    }
  }
  return out;
}

// SUNSET baked-gradient endpoints.  TOP byte-exact: FUN_42c2_101c.c:17 writes DAC
// 0x78 = 6-bit (0x3f,0x3f,0) -> 8-bit (252,252,0).  BOTTOM RECONSTRUCTED dusk
// (FUN_42c2_1140 FP body BLOCKED).
export const SUNSET_TOP_RGB: RGB = [252, 252, 0];
export const SUNSET_BOTTOM_RGB: RGB = [150, 40, 60];

/** Build a baked (non-cycling) sky RGB plane for the structured sky modes
 *  (BLACK / SUNSET / STORMY / CAVERN / STARS), as a COLUMN-MAJOR buffer
 *  data[(x*h + y)*3 + c].  Mirrors the baked branches of Renderer._make_sky.
 *
 *  Gradient (cycling) modes SHADED/PLAIN/_DEFAULT do NOT come through here -- they
 *  are an index plane (gradientIndexPlane) the live LUT recolors per frame.
 *
 *  STARS is RNG-driven (Math.random), so its output is NOT reproducible against
 *  the Python np.random oracle; it is documented and excluded from the exact gate. */
export function makeSkyPlane(mode: string, w: number, h: number): pygame.RgbArray {
  const m = (mode || "PLAIN").toUpperCase();
  const data = new Uint8Array(w * h * 3);
  const div = Math.max(1, h - 1);

  const fill = (x: number, y: number, r: number, g: number, b: number): void => {
    const s = (x * h + y) * 3;
    data[s] = r & 0xff;
    data[s + 1] = g & 0xff;
    data[s + 2] = b & 0xff;
  };

  if (m === "BLACK") {
    // "Pitch black... test your skills at night" (06_messages_world.md:113).
    // data is already zeros -> (0,0,0).
    return { w, h, data };
  }

  if (m === "SUNSET") {
    // STATIC sunset: per-row banded ramp top->bottom (FUN_42c2_101c), baked.
    const ramp = bandedVerticalRamp(h, SUNSET_TOP_RGB, SUNSET_BOTTOM_RGB);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        fill(x, y, ramp[y * 3], ramp[y * 3 + 1], ramp[y * 3 + 2]);
      }
    }
    return { w, h, data };
  }

  if (m === "STARS") {
    // Starfield (FUN_42c2_0c43): near-black blue field + scattered stars.
    // RNG-DRIVEN: not reproducible vs the Python oracle (np.random); see header.
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) fill(x, y, 4, 4, 16);
    }
    const n = Math.max(60, Math.floor((w * h) / 1400));
    for (let i = 0; i < n; i++) {
      const sx = Math.floor(Math.random() * w);
      const sy = Math.floor(Math.random() * h);
      const bright = 160 + Math.floor(Math.random() * 96); // [160,256)
      fill(sx, sy, bright, bright, bright);
    }
    for (let i = 0; i < Math.max(6, Math.floor(n / 30)); i++) {
      const px = Math.floor(Math.random() * w);
      const py = Math.floor(Math.random() * h);
      fill(px, py, 255, 255, 255);
    }
    return { w, h, data };
  }

  if (m === "STORMY") {
    // Smooth dark-slate gradient (RECONSTRUCTED endpoints; the real builder is
    // decompiler-corrupt -- the storm reads as the dark sky + the lightning band).
    for (let y = 0; y < h; y++) {
      const t = y / div;
      const r = Math.trunc(24 + 26 * t) & 0xff;
      const g = Math.trunc(26 + 28 * t) & 0xff;
      const b = Math.trunc(38 + 34 * t) & 0xff;
      for (let x = 0; x < w; x++) fill(x, y, r, g, b);
    }
    return { w, h, data };
  }

  if (m === "CAVERN") {
    // Dark near-black underground sky; darkens toward the top (the rock ceiling).
    for (let y = 0; y < h; y++) {
      const t = y / div;
      const r = Math.trunc(10 + 26 * t) & 0xff;
      const g = Math.trunc(8 + 20 * t) & 0xff;
      const b = Math.trunc(6 + 16 * t) & 0xff;
      for (let x = 0; x < w; x++) fill(x, y, r, g, b);
    }
    return { w, h, data };
  }

  // Unknown -> a baked black plane (the gradient/_DEFAULT case is an index plane,
  // handled by the caller; this baked builder only covers the structured modes).
  return { w, h, data };
}

/** Read a (W,H) grid cell, supporting the flat-Int32Array GridLike, a nested
 *  number[][] (grid[x][y]), or a bare Int32Array carried with explicit w,h. */
function gridAt(grid: GridLike | number[][] | Uint8Array | Int32Array, w: number, h: number, x: number, y: number): number {
  // The real Terrain.grid is a flat COLUMN-MAJOR Uint8Array (grid[x*h+y]).  Tests
  // also pass an Int32Array, a nested number[][], or a {data} GridLike wrapper.
  // ANY TypedArray (ArrayBuffer.isView) is the flat form; only a plain Array is
  // the nested [x][y] form.  (The earlier code handled Int32Array but fell through
  // to `.data` for a Uint8Array, which has none -> undefined[0] crash drawing the
  // battlefield.)
  if (ArrayBuffer.isView(grid)) {
    return (grid as Uint8Array | Int32Array)[x * h + y];
  }
  if (Array.isArray(grid)) {
    return (grid as number[][])[x][y];
  }
  return (grid as GridLike).data[x * h + y];
}

/** The composited terrain RGB buffer (the array Renderer._composite_terrain feeds
 *  to surfarray.blit_array), as COLUMN-MAJOR data[(x*h + y)*3 + c].
 *
 *  Faithful to _composite_terrain:
 *    rgb = sky_plane()                                   (the per-frame sky)
 *    dirt = (grid==COL_DIRT) | (DIRT_SHADE_LO<=grid<=DIRT_SHADE_HI)
 *    rgb[dirt]  = active[grid[dirt]]                      (dirt through the LUT)
 *    trail = DIGGER_BAND_LO<=grid<=DIGGER_BAND_HI
 *    rgb[trail] = active[grid[trail]]                     (digger glow through LUT)
 *
 *  `skyPlane` is either an index plane (sky_idx set -> gather through the LUT
 *  table per pixel) or a baked COLUMN-MAJOR rgb buffer (sky_rgb).  Exactly one is
 *  passed, mirroring the module's single-set invariant. */
export function compositeTerrainRgb(
  grid: GridLike | number[][] | Uint8Array | Int32Array,
  w: number,
  h: number,
  active: ActiveLUT,
  skyPlane: { idx: Int32Array } | { rgb: Uint8Array },
): Uint8Array {
  const tbl = lutTable(active);
  const out = new Uint8Array(w * h * 3);
  // Start from the sky.
  if ("idx" in skyPlane) {
    const idxPlane = skyPlane.idx;
    for (let i = 0; i < w * h; i++) {
      const row = tbl[idxPlane[i]];
      const d = i * 3;
      out[d] = row[0];
      out[d + 1] = row[1];
      out[d + 2] = row[2];
    }
  } else {
    out.set(skyPlane.rgb);
  }
  // Overlay dirt + digger-trail indices through the LUT (tank/object band is NOT
  // composited here -- _draw_tank draws those; matches the mask in render.py).
  const dlo = C.DIRT_SHADE_LO;
  const dhi = C.DIRT_SHADE_HI;
  const glo = _pal.DIGGER_BAND_LO;
  const ghi = _pal.DIGGER_BAND_HI;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const g = gridAt(grid, w, h, x, y);
      let src = -1;
      if (g === C.COL_DIRT || (g >= dlo && g <= dhi)) {
        src = g;
      } else if (g >= glo && g <= ghi) {
        src = g;
      }
      if (src >= 0) {
        const row = tbl[src];
        const d = (x * h + y) * 3;
        out[d] = row[0];
        out[d + 1] = row[1];
        out[d + 2] = row[2];
      }
    }
  }
  return out;
}

/** Recovered explosion ring INDEX: 0xDD - curR*20/maxR clamped into the explosion
 *  band [EXPLOSION_LO, EXPLOSION_HI] (FUN_4d1e_015a.c:48; catalog 09 s.1.4).
 *  Pure integer math, exact-tested. */
export function explosionRingIndex(r: number, maxr: number): number {
  // Python: int(EXPLOSION_RING_BASE - r * 20 / max(1, maxr)) then clamp.
  // `int(...)` truncates toward zero; the operand is non-negative here.
  let idx = Math.trunc(C.EXPLOSION_RING_BASE - (r * 20) / Math.max(1, maxr));
  idx = Math.max(C.EXPLOSION_LO, Math.min(C.EXPLOSION_HI, idx));
  return idx;
}

/** The HUD elevation map: internal 0-180 angle (0=E,90=up,180=W) -> (elev 0..90,
 *  side letter).  Mirrors _hud_angle. */
export function hudAngle(angle: number): [number, string] {
  if (angle <= 90) {
    return [angle, "R"]; // East (right)
  }
  return [180 - angle, "L"]; // West (left)
}

/** Active shield's remaining HP as a percent of its full HP (_shield_pct). */
export function shieldPct(t: { shield_hp: number; shield_item: number }): number {
  if (t.shield_hp <= 0 || !t.shield_item) {
    return 0;
  }
  const params = weapons.ITEMS[t.shield_item].params;
  const full = typeof params.hp === "number" ? params.hp : 100;
  // int(max(0, min(100, shield_hp*100 / max(1, full))))
  const v = (t.shield_hp * 100) / Math.max(1, full);
  return Math.trunc(Math.max(0, Math.min(100, v)));
}

// ===========================================================================
// Renderer
// ===========================================================================

export class Renderer {
  cfg: Cfg;
  w: number;
  h: number;
  pal: _pal.PaletteTable;
  font: pygame.Font;
  bigfont: pygame.Font;

  private _lut: LiveLUT | null = null;
  private _active: ActiveLUT;
  private _sky_mode: string;
  private sky_idx: Int32Array | null = null;
  private sky_rgb: Uint8Array | null = null;
  private _sky_ramp: [RGB, RGB] | null = null;
  private _sky_lut_seeded = false;
  private _dirt_lo: number;
  private _dirt_hi: number;

  constructor(cfg: Cfg, width: number, height: number) {
    this.cfg = cfg;
    this.w = width;
    this.h = height;
    // at-rest fallback table (used before a frame's state LUT is available).
    this.pal = build_palette();
    this._active = this.pal;
    this.font = pygame.font.SysFont("consolas,couriernew,monospace", 14);
    this.bigfont = pygame.font.SysFont("consolas,couriernew,monospace", 28, true);
    this._sky_mode = (cfg.SKY || "PLAIN").toUpperCase();
    this._dirt_lo = C.DIRT_SHADE_LO;
    this._dirt_hi = C.DIRT_SHADE_HI;
    this._make_sky(this._sky_mode);
  }

  // Gradient-sky band endpoints (RGB at TOP=band lo, BOTTOM=band hi).  SHADED +
  // _DEFAULT are BYTE-EXACT (FUN_42c2_0ba5 -> _pal.SKY_RAMP_TOP/BOTTOM).  PLAIN is
  // a RECONSTRUCTED flat single colour.  SUNSET is NOT here (it bakes -- see
  // _make_sky); routing it through the cycling band animated it incorrectly.
  private static readonly _SKY_GRADIENTS: { [k: string]: [RGB, RGB] } = {
    SHADED: [_pal.SKY_RAMP_TOP, _pal.SKY_RAMP_BOTTOM],
    PLAIN: [
      [30, 80, 170],
      [30, 80, 170],
    ],
    _DEFAULT: [_pal.SKY_RAMP_TOP, _pal.SKY_RAMP_BOTTOM],
  };

  sync_sky(state: GameState): void {
    const live = (state as { live_sky?: string | null }).live_sky;
    if (live === undefined || live === null) {
      return;
    }
    const mode = live.toUpperCase();
    if (mode !== this._sky_mode) {
      this._sky_mode = mode;
      this._make_sky(mode);
      this._sky_lut_seeded = false;
    }
    // Seed the gradient ramp into the live LUT's sky band once per (re)build.
    if (!this._sky_lut_seeded && this._sky_ramp !== null && state.lut != null) {
      const [top, bot] = this._sky_ramp;
      const lo = _pal.SKY_BAND_LO;
      const hi = _pal.SKY_BAND_HI;
      state.lut.reramp_band(lo, hi, top, bot);
      const base = (state as { _lut_base?: _pal.PaletteTable })._lut_base;
      if (base !== undefined) {
        for (let i = lo; i <= hi; i++) {
          const r = state.lut.table[i];
          base[i] = [r[0], r[1], r[2]];
        }
      }
      this._sky_lut_seeded = true;
    }
  }

  private _make_sky(mode: string): void {
    let m = (mode || "PLAIN").toUpperCase();
    if (m === "RANDOM") {
      m = "SHADED"; // defensive: should be pre-resolved
    }
    this.sky_idx = null;
    this.sky_rgb = null;
    this._sky_ramp = null;

    // gradient (cycling) skies: build a (W,H) index plane into the sky band.
    if (m === "SHADED" || m === "PLAIN") {
      this._sky_ramp = Renderer._SKY_GRADIENTS[m];
      this.sky_idx = gradientIndexPlane(this.w, this.h);
      return;
    }
    if (m !== "BLACK" && m !== "STARS" && m !== "STORMY" && m !== "CAVERN" && m !== "SUNSET") {
      // unknown -> safe blue gradient (still cycles through the band)
      this._sky_ramp = Renderer._SKY_GRADIENTS["_DEFAULT"];
      this.sky_idx = gradientIndexPlane(this.w, this.h);
      return;
    }
    // baked skies: structure the binary does not palette-cycle.
    this.sky_rgb = makeSkyPlane(m, this.w, this.h).data;
  }

  /** The sky as a fresh (W,H,3) column-major RGB buffer for this frame.  A
   *  gradient sky (sky_idx) is recolored through the live LUT; a baked sky
   *  (sky_rgb) is a copy.  Mirrors _sky_plane. */
  private _skyPlaneArg(): { idx: Int32Array } | { rgb: Uint8Array } {
    if (this.sky_idx !== null) {
      return { idx: this.sky_idx };
    }
    // sky_rgb is set when sky_idx is not (the module's single-set invariant).
    return { rgb: this.sky_rgb !== null ? this.sky_rgb : new Uint8Array(this.w * this.h * 3) };
  }

  // -------------------------------------------------------------- top level
  render(surf: pygame.Surface, state: GameState): void {
    this._lut = state.lut != null ? state.lut : null;
    this._active = this._lut !== null ? this._lut : this.pal;
    this.sync_sky(state);
    this._composite_terrain(surf, state);
    this._draw_trace_marks(surf, state);
    this._draw_bolts(surf, state);
    for (const ring of getList<{ x: number; y: number; r: number }>(state, "plasma_rings")) {
      this._draw_plasma_ring(surf, ring);
    }
    for (const fw of getList<{ x: number; y0: number; y1: number }>(state, "firewalls")) {
      this._draw_firewall(surf, fw);
    }
    for (const b of state.beams) {
      this._draw_beam(surf, b);
    }
    for (const t of state.tanks) {
      if (t.alive) {
        this._draw_tank(surf, t, state);
      } else {
        this._draw_wreck(surf, t);
      }
    }
    for (const p of state.projectiles) {
      this._draw_projectile(surf, p);
    }
    for (const e of state.explosions) {
      this._draw_explosion(surf, e);
    }
    this._draw_death_tiles(surf, state);
    this._draw_throe_fx(surf, state);
    this._draw_speech(surf, state);
    this._draw_wind(surf, state);
    this._draw_hud(surf, state);
    this._draw_info_box(surf, state);
    for (const f of getList<FlashLike>(state, "flashes")) {
      this._draw_flash(surf, f);
    }
    // software arrow cursor over the playfield while a human is aiming.
    if ((state as { awaiting_human?: boolean }).awaiting_human === true && state.phase === "aim") {
      const t = state.current_shooter;
      if (t !== null && t.ai_class === C.AI_HUMAN) {
        widgets.draw_cursor(surf);
      }
    }
  }

  private _draw_speech(surf: pygame.Surface, state: GameState): void {
    const sp = (state as { speech?: { text?: string; tank?: Tank } | null }).speech;
    if (!sp || !sp.text) {
      return;
    }
    const t = sp.tank as Tank;
    const r = this.font.render(sp.text, true, [0, 0, 0]);
    const bw = r.get_width() + 8;
    const bh = r.get_height() + 6;
    const bx = Math.max(2, Math.min(this.w - bw - 2, t.x - Math.floor(bw / 2)));
    const by = Math.max(2, t.y - t.half_width - 20 - bh);
    pygame.draw.rect(surf, [245, 245, 245], [bx, by, bw, bh]);
    pygame.draw.rect(surf, [0, 0, 0], [bx, by, bw, bh], 1);
    pygame.draw.polygon(surf, [245, 245, 245], [
      [t.x - 3, by + bh],
      [t.x + 3, by + bh],
      [t.x, by + bh + 5],
    ]);
    surf.blit(r, [bx + 4, by + 3]);
  }

  private _draw_info_box(surf: pygame.Surface, state: GameState): void {
    const box = (state as { info_box?: InfoBoxLike | null }).info_box;
    if (!box) {
      (state as { _info_box_rect?: pygame.Rect | null })._info_box_rect = null;
      return;
    }
    const t = box.tank;
    const ai = box.ai_class;
    const kind = ai === C.AI_HUMAN ? "Human" : (C.AI_NAMES[ai] ?? "Computer");
    const lines = [
      box.name,
      `Type: ${kind}`,
      `Score: ${box.score}`,
      `Shield: ${box.shield}`,
      `Power: ${box.power}`,
    ];
    const rends = lines.map((s) => this.font.render(s, true, [235, 235, 235]));
    const bw = Math.max(...rends.map((r) => r.get_width())) + 12;
    const bh = rends.reduce((acc, r) => acc + r.get_height(), 0) + 10;
    const bx = Math.max(2, Math.min(this.w - bw - 2, t.x + t.half_width + 6));
    const by = Math.max(2, Math.min(this.h - bh - 2, t.y - bh));
    pygame.draw.rect(surf, [20, 20, 40], [bx, by, bw, bh]);
    pygame.draw.rect(surf, [235, 235, 235], [bx, by, bw, bh], 1);
    let yy = by + 5;
    const title = this.font.render(box.name, true, tupRgb(lutGet(this._active, t.color)));
    surf.blit(title, [bx + 6, yy]);
    yy += title.get_height();
    for (let i = 1; i < rends.length; i++) {
      surf.blit(rends[i], [bx + 6, yy]);
      yy += rends[i].get_height();
    }
    (state as { _info_box_rect?: pygame.Rect | null })._info_box_rect = new pygame.Rect(bx, by, bw, bh);
  }

  private _composite_terrain(surf: pygame.Surface, state: GameState): void {
    const grid = state.terrain.grid as GridLike | number[][] | Uint8Array | Int32Array;
    const rgb = compositeTerrainRgb(grid, this.w, this.h, this._active, this._skyPlaneArg());
    pygame.surfarray.blit_array(surf, { w: this.w, h: this.h, data: rgb });
  }

  // ------------------------------------------------------------------ tanks
  private _draw_tank(surf: pygame.Surface, t: Tank, state: GameState): void {
    const col = tupRgb(lutGet(this._active, t.color));
    let x = t.x;
    let y = t.y;
    const hw = t.half_width;
    const cd = t.chute_descent;
    if (cd) {
      const pth = cd.path;
      const i = Math.max(0, Math.min(pth.length - 1, Math.trunc(cd.i)));
      [x, y] = pth[i];
      this._spritesDrawTank(surf, x, y, t, col);
      this._draw_parachute(surf, x, y - hw, col);
      return;
    }
    this._spritesDrawTank(surf, x, y, t, col);
    if (t.shield_hp > 0) {
      this._draw_shield_ring(surf, t, x, y, hw);
    }
    this._health_bar(surf, t);
    if (
      state.current_shooter === t &&
      (state.phase === "aim" || state.phase === "turn_start")
    ) {
      pygame.draw.polygon(surf, [255, 255, 0], [
        [x, y - hw - 18],
        [x - 4, y - hw - 11],
        [x + 4, y - hw - 11],
      ]);
    }
  }

  /** sprites.draw_tank with the integrator fallback (a plain hull rect) when no
   *  sprites provider is wired -- the same fallback shape render.py's own draw
   *  path degrades to (the procedural hull lives in sprites.py). */
  private _spritesDrawTank(surf: pygame.Surface, x: number, y: number, t: Tank, col: RGB): void {
    if (_sprites !== null) {
      _sprites.draw_tank(surf, x, y, t.tank_icon ?? 0, col, t.angle);
      return;
    }
    const hw = t.half_width;
    pygame.draw.rect(surf, col, [x - hw, y - 3, hw * 2, 3]);
  }

  // Parachute canopy geometry (FUN_4912_0526, byte-exact 2026-06-25): a 17w x 10h
  // domed canopy, rim wings, a 1px centre seam, and two V-shrouds.
  static readonly PARACHUTE: ReadonlyArray<[number, number]> = (() => {
    const out: Array<[number, number]> = [];
    for (let dx = -2; dx < 3; dx++) out.push([dx, -9]);
    for (let dx = -5; dx < 6; dx++) out.push([dx, -8]);
    for (let dx = -7; dx < 8; dx++) out.push([dx, -7]);
    for (let dx = -8; dx < -4; dx++) out.push([dx, -6]);
    for (let dx = 5; dx < 9; dx++) out.push([dx, -6]);
    for (let dy = -6; dy < 1; dy++) out.push([0, dy]);
    // `0 - k` (not unary `-k`) so k=0 yields +0, matching Python's int 0 (unary
    // negation of 0 in JS is -0, which Object.is-differs from the oracle's 0).
    for (let k = 0; k < 6; k++) out.push([2 + k, 0 - k]);
    for (let k = 0; k < 6; k++) out.push([-2 - k, 0 - k]);
    return out;
  })();

  private _draw_parachute(surf: pygame.Surface, cx: number, cy: number, col: RGB): void {
    const canopy: RGB = [Math.min(255, col[0] + 70), Math.min(255, col[1] + 70), Math.min(255, col[2] + 70)];
    const W = this.w;
    const H = this.h;
    for (const [dx, dy] of Renderer.PARACHUTE) {
      const X = cx + dx;
      const Y = cy + dy;
      if (X >= 0 && X < W && Y >= 0 && Y < H) {
        surf.set_at([X, Y], canopy);
      }
    }
  }

  // Static shield ring colour (single fixed colour via the plot callback in
  // FUN_4912_09a9; no recolor on hit/push).  Cool blue-white outline.
  static readonly SHIELD_RING_RGB: RGB = [120, 200, 255];

  private _draw_shield_ring(surf: pygame.Surface, t: Tank, x: number, y: number, hw: number): void {
    const cy = y - 4;
    const base = hw + 8; // port's *(item+4) stand-in radius
    const col = Renderer.SHIELD_RING_RGB;
    if (t.shield_item === weapons.SLOT_MAG_DEFLECTOR) {
      // two concentric rings (binary r=13 and r=16 -> base and base+3)
      pygame.draw.circle(surf, col, [x, cy], base, 1);
      pygame.draw.circle(surf, col, [x, cy], base + 3, 1);
    } else if (t.shield_item === weapons.SLOT_FORCE_SHIELD || t.shield_item === weapons.SLOT_SUPER_MAG) {
      // ring + inner ring at radius-1 (binary :36-38)
      pygame.draw.circle(surf, col, [x, cy], base, 1);
      pygame.draw.circle(surf, col, [x, cy], Math.max(1, base - 1), 1);
    } else {
      pygame.draw.circle(surf, col, [x, cy], base, 1);
    }
  }

  private _health_bar(surf: pygame.Surface, t: Tank): void {
    const w = 22;
    const x = t.x - (w >> 1);
    const y = t.y - t.half_width - 9;
    pygame.draw.rect(surf, [60, 0, 0], [x, y, w, 3]);
    const hp = Math.max(0, Math.min(C.TANK_DEFAULT_HEALTH, t.health));
    pygame.draw.rect(surf, [0, 220, 0], [x, y, Math.trunc((w * hp) / C.TANK_DEFAULT_HEALTH), 3]);
  }

  private _draw_wreck(surf: pygame.Surface, t: Tank): void {
    pygame.draw.rect(surf, [40, 40, 40], [t.x - t.half_width, t.y - 3, t.half_width * 2, 3]);
  }

  // The UFO-ABDUCTION sprite (6x5 grid @ data 0x60c3 / file 0x5be43, FUN_3ef5_067b).
  // kind: 0=cap grey60, 1=neck grey50, 2=body (owner colour), 3=edge grey40.
  static readonly DEATH_TILE: ReadonlyArray<[number, number, number]> = [
    [-2, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0],
    [0, 1, 1],
    [-1, 2, 3], [0, 2, 2], [1, 2, 2], [3, 2, 2],
    [-2, 3, 3], [-1, 3, 3], [0, 3, 2], [1, 3, 2], [2, 3, 2], [3, 3, 2],
    [-2, 4, 2], [-1, 4, 2], [0, 4, 2], [1, 4, 2],
  ];
  static readonly DEATH_TILE_GREY: { readonly [k: number]: RGB } = {
    0: [60, 60, 60],
    1: [50, 50, 50],
    3: [40, 40, 40],
  };

  private _draw_death_tiles(surf: pygame.Surface, state: GameState): void {
    const fountains = getList<{ color: number; col: number; y: number }>(state, "death_fountains");
    if (fountains.length === 0) {
      return;
    }
    const W = this.w;
    const H = this.h;
    for (const f of fountains) {
      const body = tupRgb(lutGet(this._active, f.color));
      const cx = f.col;
      const cy = f.y;
      for (const [dx, dy, kind] of Renderer.DEATH_TILE) {
        const px = cx + dx;
        const py = cy + dy;
        if (px >= 0 && px < W && py >= 0 && py < H) {
          surf.set_at([px, py], kind === 2 ? body : Renderer.DEATH_TILE_GREY[kind]);
        }
      }
    }
  }

  private _draw_throe_fx(surf: pygame.Surface, state: GameState): void {
    const fx = getList<ThroeLike>(state, "throe_fx");
    if (fx.length === 0) {
      return;
    }
    const W = this.w;
    const H = this.h;
    const put = (px: number, py: number, c: RGB): void => {
      const ix = Math.trunc(px);
      const iy = Math.trunc(py);
      if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
        surf.set_at([ix, iy], c);
      }
    };
    for (const e of fx) {
      const kind = e.kind;
      const fcount = e.frame;
      const cx = e.x;
      const cy = e.y;
      const base = tupRgb(lutGet(this._active, e.color));
      const hot: RGB = [Math.min(255, base[0] + 90), Math.min(255, base[1] + 90), Math.min(255, base[2] + 90)];
      if (kind === "spiral") {
        const tmax = fcount * 0.5;
        let th = 0.0;
        while (th < tmax) {
          const r = 2.0 + 1.6 * th;
          put(cx + r * Math.cos(th), cy - r * Math.sin(th), Math.trunc(th * 2) % 2 ? hot : base);
          th += 0.32;
        }
      } else if (kind === "ring") {
        const rad = 3 + fcount * 1.7;
        for (let k = 0; k < 12; k++) {
          const a = (k * Math.PI) / 6 + fcount * 0.04;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          for (let rr = 3; rr < Math.trunc(rad); rr += 2) {
            put(cx + rr * ca, cy - rr * sa, rr > rad - 6 ? hot : base);
          }
        }
      } else if (kind === "geyser") {
        const top = cy - fcount * 4;
        for (let j = 0; j < 6; j++) {
          const ox = Math.trunc((j - 2.5) * 5);
          let yy = cy;
          while (yy > top) {
            put(cx + ox + (Math.trunc(yy) % 3 ? 1 : -1), yy, yy < top + 8 ? hot : base);
            yy -= 2;
          }
        }
      } else if (kind === "sparkle") {
        for (const p of e.parts ?? []) {
          put(p[0], p[1], hot);
          put(p[0], p[1] - 1, base);
        }
      } else if (kind === "sink") {
        for (let k = 0; k < 16; k++) {
          const sx = cx + (k - 8) * 2;
          const sy = cy - 6 + ((fcount + k * 3) % 14);
          put(sx, sy, (fcount + k) % 2 ? hot : base);
        }
      }
    }
  }

  // ------------------------------------------------------------ projectiles
  private _draw_projectile(surf: pygame.Surface, p: ProjectileLike): void {
    const tp = projTracePath(p);
    if (tp && tp.length) {
      const col = this._trace_color(p);
      for (const [tx, ty] of tp) {
        surf.set_at([Math.max(0, Math.min(this.w - 1, tx)), Math.max(0, Math.min(this.h - 1, ty))], col);
      }
    }
    const icon = this.cfg.BOMB_ICON.toUpperCase();
    if (icon === "INVISIBLE") {
      return;
    }
    // White (pal 0xff) in-flight dot; Small=1px, Big=5px plus.
    const white = tupRgb(lutGet(this._active, 0xff));
    const x = p.sx;
    const y = p.sy;
    const W = this.w;
    const H = this.h;
    if (x >= 0 && x < W && y >= 0 && y < H) {
      surf.set_at([x, y], white);
    }
    if (icon === "BIG") {
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as Array<[number, number]>) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          surf.set_at([nx, ny], white);
        }
      }
    }
  }

  private _draw_trace_marks(surf: pygame.Surface, state: GameState): void {
    const marks = getList<[number, number, number]>(state, "trace_marks");
    if (marks.length === 0) {
      return;
    }
    const w = this.w;
    const h = this.h;
    for (const [x, y, cidx] of marks) {
      if (x >= 0 && x < w && y >= 0 && y < h) {
        surf.set_at([x, y], tupRgb(lutGet(this._active, cidx)));
      }
    }
  }

  /** Persistent-trail colour: player's colour index + 110 clamped (FUN_2a4a_0763.c:95). */
  private _trace_color(p: ProjectileLike): RGB {
    const owner = p.owner ?? null;
    const base = owner !== null ? owner.color : C.COL_TRACER;
    const idx = Math.max(0, Math.min(0xff, Math.trunc(base) + 110));
    return tupRgb(lutGet(this._active, idx));
  }

  private _draw_explosion(surf: pygame.Surface, e: ExplosionLike): void {
    const cx = e.x;
    const cy = e.y;
    const maxr = e.maxr;
    if (e.style === "stamp") {
      const col: RGB = e.dirt ? [90, 60, 30] : this._explosion_rgb(maxr, maxr);
      pygame.draw.circle(surf, col, [cx, cy], maxr);
      return;
    }
    if (e.style === "nuke") {
      this._draw_nuke(surf, e);
      return;
    }
    const phase = e.phase ?? 0;
    const core = this._band_rgb(C.EXPLOSION_RING_BASE);
    const inner = this._band_rgb(C.EXPLOSION_HI);
    if (phase === 0) {
      const r = Math.min(maxr, Math.max(1, (e.frame ?? 0) * (e.step ?? 1)));
      pygame.draw.circle(surf, this._explosion_rgb(r, maxr), [cx, cy], r);
      pygame.draw.circle(surf, inner, [cx, cy], Math.max(1, Math.trunc(r / 3)));
    } else if (phase === 1) {
      pygame.draw.circle(surf, this._explosion_rgb(maxr, maxr), [cx, cy], maxr);
      pygame.draw.circle(surf, core, [cx, cy], Math.max(2, Math.trunc(maxr * 0.45)));
      pygame.draw.circle(surf, inner, [cx, cy], Math.max(1, Math.trunc(maxr * 0.22)));
    } else {
      pygame.draw.circle(surf, this._explosion_rgb(maxr, maxr), [cx, cy], maxr);
      pygame.draw.circle(surf, core, [cx, cy], Math.max(1, Math.trunc(maxr * 0.45)));
    }
  }

  /** One explosion-band entry through the live LUT (carries the per-frame flash). */
  private _band_rgb(idx: number): RGB {
    const i = Math.max(C.EXPLOSION_LO, Math.min(C.EXPLOSION_HI, Math.trunc(idx)));
    return tupRgb(lutGet(this._active, i));
  }

  /** Recovered explosion ring colour: index 0xDD - curR*20/maxR through the LUT. */
  private _explosion_rgb(r: number, maxr: number): RGB {
    return tupRgb(lutGet(this._active, explosionRingIndex(r, maxr)));
  }

  // Nuclear fireball at-rest fallback (BYTE-EXACT FUN_4d1e_00ae.c:11-17: pure red).
  static readonly NUKE_CORE: RGB = [252, 0, 0];
  static readonly NUKE_MID: RGB = [168, 0, 0];
  static readonly NUKE_EDGE: RGB = [72, 0, 0];

  private _draw_nuke(surf: pygame.Surface, e: ExplosionLike): void {
    const cx = e.x;
    const cy = e.y;
    const maxr = e.maxr;
    const phase = e.phase ?? 0;
    let r: number;
    if (phase === 0) {
      r = Math.min(maxr, Math.max(1, (e.frame ?? 0) * (e.step ?? 1)));
    } else {
      r = maxr;
    }
    let edge: RGB;
    let mid: RGB;
    let core: RGB;
    if (this._lut !== null) {
      edge = this._band_rgb(C.EXPLOSION_LO + 8);
      mid = this._band_rgb(C.EXPLOSION_LO + 22);
      core = this._band_rgb(C.EXPLOSION_HI);
    } else if (phase === 2) {
      const t = Math.min(1.0, (e.frame ?? 0) / _EXPLO_SHRINK_FRAMES);
      const dim = 1.0 - 0.9 * t;
      edge = Renderer.NUKE_EDGE.map((c) => Math.trunc(c * dim)) as RGB;
      mid = Renderer.NUKE_MID.map((c) => Math.trunc(c * dim)) as RGB;
      core = Renderer.NUKE_CORE.map((c) => Math.trunc(c * dim)) as RGB;
    } else {
      edge = Renderer.NUKE_EDGE;
      mid = Renderer.NUKE_MID;
      core = Renderer.NUKE_CORE;
    }
    pygame.draw.circle(surf, edge, [cx, cy], r);
    pygame.draw.circle(surf, mid, [cx, cy], Math.max(1, Math.trunc(r * 0.7)));
    pygame.draw.circle(surf, core, [cx, cy], Math.max(1, Math.trunc(r * 0.4)));
  }

  private _draw_beam(surf: pygame.Surface, b: { pts: Array<[number, number]> }): void {
    const pts = b.pts;
    if (pts.length >= 2) {
      const col = tupRgb(lutGet(this._active, C.COL_LASER));
      pygame.draw.lines(surf, col, false, pts, 2);
    }
  }

  // Plasma ring colour: FUN_3f76_03bd.c:15 -> 6-bit (0x28,0x0f,0x0f) -> (162,60,60).
  static readonly PLASMA_RING_RGB: RGB = [162, 60, 60];

  private _draw_plasma_ring(surf: pygame.Surface, ring: { x: number; y: number; r: number }): void {
    const r = ring.r;
    if (r < 1) {
      return;
    }
    pygame.draw.circle(surf, Renderer.PLASMA_RING_RGB, [ring.x, ring.y], Math.trunc(r), 1);
  }

  private _draw_firewall(surf: pygame.Surface, fw: { x: number; y0: number; y1: number }): void {
    const x = fw.x;
    const y0 = fw.y0;
    const y1 = fw.y1;
    if (y1 < y0) {
      return;
    }
    const flo = _pal.FIREWALL_FLAME_LO;
    const fhi = _pal.FIREWALL_FLAME_HI;
    const elo = _pal.FIREWALL_EMBER_LO;
    const ehi = _pal.FIREWALL_EMBER_HI;
    const nflame = fhi - flo + 1;
    const nember = ehi - elo + 1;
    const half = 3;
    for (let yy = Math.max(0, y0); yy < Math.min(this.h, y1 + 1); yy++) {
      const fi = flo + ((yy + x) % nflame);
      const fcol = tupRgb(lutGet(this._active, fi));
      for (let dx = -half; dx <= half; dx++) {
        const px = x + dx;
        if (px >= 0 && px < this.w) {
          surf.set_at([px, yy], fcol);
        }
      }
      const ei = elo + (((yy * 2 + x) % nember) + nember) % nember;
      const ecol = tupRgb(lutGet(this._active, ei));
      for (const px of [x - half, x + half]) {
        if (px >= 0 && px < this.w) {
          surf.set_at([px, yy], ecol);
        }
      }
    }
  }

  // Lightning flash overlay peak alpha (RECONSTRUCTED additive scene-wide lift).
  static readonly FLASH_OVERLAY_PEAK = 70;

  private _draw_flash(surf: pygame.Surface, f: FlashLike): void {
    const fr = f.frame;
    if (fr < 0) {
      return; // still in its stagger delay
    }
    const up = f.up;
    const down = f.down;
    let level: number;
    if (fr <= up) {
      level = fr / up;
    } else {
      level = Math.max(0.0, 1.0 - (fr - up) / down);
    }
    if (level <= 0.0) {
      return;
    }
    const amt = (Renderer.FLASH_OVERLAY_PEAK / 255.0) * level;
    const ov = new pygame.Surface([this.w, this.h]);
    ov.fill([Math.trunc(f.rgb[0] * amt), Math.trunc(f.rgb[1] * amt), Math.trunc(f.rgb[2] * amt)]);
    surf.blit(ov, [0, 0], null, pygame.BLEND_RGB_ADD);
  }

  private _draw_bolts(surf: pygame.Surface, state: GameState): void {
    const bolts = getList<{ pts: Array<[number, number]>; frame?: number }>(state, "active_bolts");
    if (bolts.length === 0) {
      return;
    }
    for (const b of bolts) {
      const pts = b.pts;
      if (pts.length < 2) {
        continue;
      }
      const fade = Math.max(0, 6 - (b.frame ?? 0));
      const core: RGB = [255, 255, Math.min(255, 200 + fade * 8)];
      const glow: RGB = [90, 120, 255];
      pygame.draw.lines(surf, glow, false, pts, 3);
      pygame.draw.lines(surf, core, false, pts, 1);
    }
  }

  static readonly SHIELD_SWATCH = 16;
  static readonly _SHIELD_FADE_FRAMES = 51;

  private _draw_shield_swatch(surf: pygame.Surface, state: GameState, t: Tank, x: number, y: number): void {
    const fades = (state as { shield_fades?: { [k: number]: { frame: number; dir: number } } }).shield_fades;
    const fade = fades ? fades[t.player_index] : undefined;
    let level: number;
    if (fade !== undefined) {
      const fr = Math.min(Renderer._SHIELD_FADE_FRAMES, fade.frame);
      if (fade.dir > 0) {
        level = fr / Renderer._SHIELD_FADE_FRAMES;
      } else {
        level = Math.max(0.0, 1.0 - fr / Renderer._SHIELD_FADE_FRAMES);
      }
    } else if (t.shield_hp > 0) {
      level = 1.0;
    } else {
      return;
    }
    const base = tupRgb(lutGet(this._active, t.color));
    const col: RGB = [Math.trunc(base[0] * level), Math.trunc(base[1] * level), Math.trunc(base[2] * level)];
    const sz = Renderer.SHIELD_SWATCH;
    pygame.draw.rect(surf, col, [x, y, sz, sz]);
    pygame.draw.rect(surf, [90, 90, 90], [x, y, sz, sz], 1);
  }

  // -------------------------------------------------------------------- HUD
  static readonly BAR_H = 22;

  private _hud_angle(angle: number): [number, string] {
    return hudAngle(angle);
  }

  private _draw_hud(surf: pygame.Surface, state: GameState): void {
    const t = state.current_shooter;
    const hitboxes: { [k: string]: pygame.Rect } = {};
    (state as { _hud_hitboxes?: { [k: string]: pygame.Rect } })._hud_hitboxes = hitboxes;
    if (state.cfg.is_on("ICON_BAR")) {
      const bar = new pygame.Surface([this.w, Renderer.BAR_H]);
      bar.set_alpha(190);
      bar.fill([0, 0, 0]);
      surf.blit(bar, [0, 0]);
      if (t !== null) {
        const [elev, side] = this._hud_angle(t.angle);
        const pwTxt = `Power: ${Math.trunc(t.power as number)}`;
        this._text(surf, pwTxt, 6, 4);
        hitboxes["power"] = new pygame.Rect(6, 4, this.font.size(pwTxt)[0], this.font.get_height());
        const anTxt = `Angle: ${elev}${side}`;
        this._text(surf, anTxt, 150, 4);
        hitboxes["angle"] = new pygame.Rect(150, 4, this.font.size(anTxt)[0], this.font.get_height());
        const ncol = tupRgb(lutGet(this._active, t.color));
        const nr = this.font.render(t.name, true, ncol);
        const nx = Math.floor(this.w / 2) - Math.floor(nr.get_width() / 2);
        this._draw_shield_swatch(surf, state, t, nx - 22, 3);
        surf.blit(nr, [nx, 4]);
        hitboxes["name"] = new pygame.Rect(nx, 4, nr.get_width(), nr.get_height());
        this._draw_weapon_readout(surf, t, state);
      }
    }
    if (_inChooseTarget(state)) {
      const ct = "Choose Target";
      const ctw = this.font.size(ct)[0];
      this._text(surf, ct, Math.floor(this.w / 2) - Math.floor(ctw / 2), Renderer.BAR_H + 6, [255, 255, 120]);
    }
    if (state.cfg.is_on("STATUS_BAR") && t !== null) {
      this._draw_status_bar(surf, state, t);
    }
  }

  private _draw_weapon_readout(surf: pygame.Surface, t: Tank, state: GameState | null = null): void {
    const slot = t.selected_weapon;
    const item = weapons.ITEMS[slot];
    const name = item.name;
    const label = slot === weapons.SLOT_BABY_MISSILE ? name : `${t.inventory[slot]}: ${name}`;
    const tw = this.font.size(label)[0];
    const iconW = 14;
    const xIcon = this.w - 8 - tw - iconW - 4;
    this._draw_weapon_icon(surf, xIcon, 3, iconW, item);
    this._text(surf, label, xIcon + iconW + 4, 4);
    if (state !== null) {
      const hitboxes = (state as unknown as { _hud_hitboxes: { [k: string]: pygame.Rect } })._hud_hitboxes;
      hitboxes["weapon"] = new pygame.Rect(xIcon, 2, this.w - 8 - xIcon, this.font.get_height() + 2);
    }
  }

  private _draw_weapon_icon(surf: pygame.Surface, x: number, y: number, sz: number, item: weapons.Item): void {
    if (_sprites !== null) {
      const spr = _sprites.get_sprite("A", item.idx, {
        color: _sprites.WEAPON_ICON_BASE,
        pal: _sprites.weapon_icon_palette(),
        scale: 1,
      });
      if (spr !== null) {
        surf.blit(spr, [x, y + 1]);
        return;
      }
    }
    // fallback (render.py's except branch): a small white glyph circle.
    pygame.draw.circle(surf, [235, 235, 235], [x + (sz >> 1), y + (sz >> 1)], 3);
  }

  private _hud_bottom(state: GameState): number {
    let bottom = state.cfg.is_on("ICON_BAR") ? Renderer.BAR_H : 0;
    if (state.cfg.is_on("STATUS_BAR") && state.current_shooter !== null) {
      bottom = Math.max(bottom, Renderer.BAR_H + 18);
    }
    return bottom;
  }

  private _draw_wind(surf: pygame.Surface, state: GameState): void {
    const wind = Math.trunc(state.cfg.wind);
    const margin = 8;
    const top = this._hud_bottom(state) + 6;
    if (wind === 0) {
      const r = this.font.render("No Wind", true, [235, 235, 235]);
      surf.blit(r, [this.w - margin - r.get_width(), top]);
      return;
    }
    const speed = Math.abs(wind);
    const lbl = this.font.render("Wind", true, [235, 235, 235]);
    const num = this.font.render(String(speed), true, [235, 235, 235]);
    const arrowW = 26;
    const total = lbl.get_width() + 6 + arrowW + 6 + num.get_width();
    const x = this.w - margin - total;
    surf.blit(lbl, [x, top]);
    const ax = x + lbl.get_width() + 6;
    const ay = top + Math.floor(lbl.get_height() / 2);
    this._draw_wind_arrow(surf, ax, ay, arrowW, wind > 0);
    surf.blit(num, [ax + arrowW + 6, top]);
  }

  private _draw_wind_arrow(surf: pygame.Surface, x: number, y: number, w: number, pointingRight: boolean): void {
    const col: RGB = [255, 255, 120];
    if (pointingRight) {
      pygame.draw.line(surf, col, [x, y], [x + w, y], 2);
      pygame.draw.lines(surf, col, false, [
        [x + w - 6, y - 5],
        [x + w, y],
        [x + w - 6, y + 5],
      ], 2);
    } else {
      pygame.draw.line(surf, col, [x, y], [x + w, y], 2);
      pygame.draw.lines(surf, col, false, [
        [x + 6, y - 5],
        [x, y],
        [x + 6, y + 5],
      ], 2);
    }
  }

  private _draw_status_bar(surf: pygame.Surface, state: GameState, t: Tank): void {
    const y = Renderer.BAR_H;
    const bar = new pygame.Surface([this.w, 18]);
    bar.set_alpha(190);
    bar.fill([0, 0, 0]);
    surf.blit(bar, [0, y]);
    const maxv = t.health <= 0 ? 0 : Math.trunc(t.power as number) * 10;
    const batt = t.inventory[weapons.SLOT_BATTERY];
    const para = t.inventory[weapons.SLOT_PARACHUTE];
    let shldN = 0;
    for (const s of weapons.SHIELD_SLOTS) shldN += t.inventory[s];
    const shldPctVal = this._shield_pct(t);
    let guid = 0;
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      if (weapons.ITEMS[i].category === "guidance") guid += t.inventory[i];
    }
    const trig = t.inventory[weapons.SLOT_CONTACT_TRIGGER];
    const fuel = t.inventory[weapons.SLOT_FUEL];
    const cells: Array<[string | null, string]> = [
      [null, `Max: ${maxv}`],
      ["batt", `${batt} [batt]`],
      ["para", `${para} [para]`],
      ["shld", `${shldN} [shlds] ${shldPctVal}%`],
      ["guid", `${guid} [guid]`],
      ["trig", `${trig} [trig]`],
      ["fuel", `${fuel} [fuel]`],
    ];
    const sepW = this.font.size("   ")[0];
    let x = 6;
    const ty = y + 2;
    const hitboxes = (state as unknown as { _hud_hitboxes: { [k: string]: pygame.Rect } })._hud_hitboxes;
    for (const [key, text] of cells) {
      const w = this.font.size(text)[0];
      this._text(surf, text, x, ty);
      if (key !== null) {
        hitboxes["status_" + key] = new pygame.Rect(x, ty, w, this.font.get_height());
      }
      x += w + sepW;
    }
  }

  private _shield_pct(t: Tank): number {
    return shieldPct(t);
  }

  private _text(surf: pygame.Surface, s: string, x: number, y: number, color: RGB = [230, 230, 230]): void {
    surf.blit(this.font.render(s, true, color), [x, y]);
  }

  banner(surf: pygame.Surface, lines: string[], sub: string | null = null): void {
    const ov = new pygame.Surface([this.w, this.h]);
    ov.set_alpha(150);
    ov.fill([0, 0, 0]);
    surf.blit(ov, [0, 0]);
    let y = Math.floor(this.h / 2) - 40;
    for (const ln of lines) {
      const r = this.bigfont.render(ln, true, [255, 255, 120]);
      surf.blit(r, [Math.floor(this.w / 2) - Math.floor(r.get_width() / 2), y]);
      y += 34;
    }
    if (sub) {
      const r = this.font.render(sub, true, [220, 220, 220]);
      surf.blit(r, [Math.floor(this.w / 2) - Math.floor(r.get_width() / 2), y + 8]);
    }
  }
}

// ---------------------------------------------------------------------------
// Small structural helpers shared by the draw methods.
// ---------------------------------------------------------------------------

interface FlashLike {
  frame: number;
  up: number;
  down: number;
  rgb: RGB;
}

interface InfoBoxLike {
  tank: Tank;
  ai_class: number;
  name: string;
  score: number;
  shield: number;
  power: number;
}

interface ThroeLike {
  kind: string;
  frame: number;
  x: number;
  y: number;
  color: number;
  parts?: Array<[number, number]>;
}

/** getattr(state, key, ()) -> the list, or [] when absent/falsy. */
function getList<T>(state: GameState, key: string): T[] {
  const v = (state as { [k: string]: unknown })[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

/** int-tuple an RGB row (the Python `tuple(int(c) for c in active[idx])`). */
function tupRgb(row: RGB | number[]): RGB {
  return [Math.trunc(row[0]), Math.trunc(row[1]), Math.trunc(row[2])];
}

/** p.state.get("trace_path") supporting either a Map-like (.get) or a plain object. */
function projTracePath(p: ProjectileLike): Array<[number, number]> | null {
  const st = p.state;
  if (!st) {
    return null;
  }
  let v: unknown;
  if (typeof (st as { get?: unknown }).get === "function") {
    v = (st as { get(k: string): unknown }).get("trace_path");
  } else {
    v = (st as { [k: string]: unknown })["trace_path"];
  }
  return Array.isArray(v) ? (v as Array<[number, number]>) : null;
}

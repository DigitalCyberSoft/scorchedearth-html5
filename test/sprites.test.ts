/**
 * Differential gate: TS sprites == Python scorch.sprites (the fidelity oracle).
 *
 * Golden vectors come from oracle/dump_sprites.py -> oracle/vectors/sprites.json,
 * which drives the REAL scorch.sprites headless (SDL_VIDEODRIVER=dummy) and reads
 * every sprite Surface back through pygame.surfarray in the COLUMN-MAJOR layout the
 * HTML5 pygame shim uses and the TS sprite core emits:
 *     rgb   : array3d(surf).reshape(-1)     -> rgb[(x*h + y)*3 + c]
 *     alpha : array_alpha(surf).reshape(-1) -> alpha[x*h + y]
 *
 * This gate drives the PURE pixel core of src/sprites.ts (buildSpritePixels /
 * tankBodyPixels / fontGlyphPixels / cursorPixels / windowIconPixels /
 * loadTitleMountainPixels) -- the SAME code path the Surface-returning methods
 * (get_sprite/draw_tank/draw_tank_icon_cell/get_font_glyph/get_cursor/
 * get_window_icon/load_title_mountain) feed into (each is buf -> surfaceFromBuffer
 * or buf -> stampBuffer).  So asserting the buffers asserts what the Surfaces hold.
 * The pure core is DOM-free, so the gate runs under vitest's "node" environment
 * (no canvas), exactly like every other module's differential gate here.
 *
 * EXACTNESS: every datum is an integer RGB byte / alpha byte / palette index /
 * pixel width.  The ONLY non-integer-arithmetic path is the barrel line
 * (pygame.draw.line): width-1 Bresenham is reproduced byte-exact (validated vs
 * pygame 2.6.1 across every degree 0..180 at all four barrel lengths), and the
 * scale>=2 barrel is always angle 90 (vertical), a deterministic axis-aligned fill.
 * So EVERY assertion here is exact equality.  No epsilon is used or warranted.
 *
 * Per-case strategy (mirrors mtn.test.ts for the 2M-cell grids): each case scans
 * EVERY rgb + alpha cell, locates the first mismatch (flat index, expected, actual),
 * and asserts on that.  This is a full exact check of every cell -- the loop visits
 * all of them; it reports via one assertion per array instead of millions, and a
 * mismatch is caught AND located.  The total asserted-cell count is summed and
 * checked so the battery cannot silently shrink.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as sprites from "../src/sprites";
import type { PixelBuffer } from "../src/sprites";
import type { SpritesProvider as RenderSpritesProvider } from "../src/render";
import type { SpritesProvider as ScreensSpritesProvider } from "../src/screens";

// ---------------------------------------------------------------------------
// COMPILE-TIME conformance: the single sprites object MUST satisfy the UNION of
// both SpritesProvider shapes (render.ts ~L58 and screens.ts ~L89).  This block
// is type-checked by `npm run typecheck`; a signature drift fails the build, not
// just this test.  (The methods carry trailing OPTIONAL args beyond the interface
// minimum, which is assignable: the implementation tolerates >= the required call.)
// ---------------------------------------------------------------------------
const _spritesProvider = {
  get_sprite: sprites.get_sprite,
  draw_tank: sprites.draw_tank,
  draw_tank_icon_cell: sprites.draw_tank_icon_cell,
  weapon_icon_palette: sprites.weapon_icon_palette,
  load_title_mountain: sprites.load_title_mountain,
  WEAPON_ICON_BASE: sprites.WEAPON_ICON_BASE,
};
const _asRender: RenderSpritesProvider = _spritesProvider;
const _asScreens: ScreensSpritesProvider = _spritesProvider;
void _asRender;
void _asScreens;

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "sprites.json");

type RGB = [number, number, number];

interface SurfCase {
  w: number;
  h: number;
  rgb: number[];
  alpha: number[];
}
interface TankCase extends SurfCase {
  design: number;
  color: number[];
  angle: number;
  facing: number;
  x: number;
  y: number;
}
interface CellCase extends SurfCase {
  design: number;
  grayed: boolean;
  box: [number, number, number, number];
  color: number[];
}
interface GlyphCase extends SurfCase {
  code: number;
  width: number;
}
interface MtnCase extends SurfCase {
  name: string;
  bytes_hex: string;
}
interface Vectors {
  module: string;
  WEAPON_ICON_BASE: number;
  table_a: SurfCase[];
  table_b: SurfCase[];
  table_a_scale2: SurfCase[];
  table_a_remap: SurfCase[];
  weapon_icon_palette: number[][];
  draw_tank: TankCase[];
  draw_tank_palidx: SurfCase & { color_index: number };
  draw_tank_icon_cell: CellCase[];
  font_glyphs: GlyphCase[];
  font_text: SurfCase & { s: string; width: number };
  cursor: SurfCase & { hotspot: [number, number] };
  cursor_scale2: SurfCase & { hotspot: [number, number] };
  window_icon: SurfCase;
  title_mountain: MtnCase[];
}

const V: Vectors = JSON.parse(readFileSync(VECTORS, "utf8"));

// Running tally so the battery cannot silently shrink.
let assertedCells = 0;

/** Compare a TS PixelBuffer against an oracle SurfCase EXACTLY. Returns the cells
 *  checked; throws (via expect) located at the first mismatch. */
function expectBufferMatches(label: string, buf: PixelBuffer, exp: SurfCase): number {
  // Dimensions first -- a size mismatch is the most informative failure.
  expect([buf.w, buf.h], `${label}: size`).toEqual([exp.w, exp.h]);
  const n = exp.w * exp.h;
  expect(buf.alpha.length, `${label}: alpha length`).toBe(n);
  expect(buf.rgb.length, `${label}: rgb length`).toBe(n * 3);
  expect(exp.alpha.length, `${label}: oracle alpha length`).toBe(n);
  expect(exp.rgb.length, `${label}: oracle rgb length`).toBe(n * 3);

  // Alpha plane: locate first mismatch.
  let aMismatch = -1;
  for (let i = 0; i < n; i++) {
    if (buf.alpha[i] !== exp.alpha[i]) {
      aMismatch = i;
      break;
    }
  }
  if (aMismatch !== -1) {
    const x = Math.floor(aMismatch / exp.h);
    const y = aMismatch % exp.h;
    expect(
      buf.alpha[aMismatch],
      `${label}: alpha mismatch at flat=${aMismatch} (x=${x},y=${y})`,
    ).toBe(exp.alpha[aMismatch]);
  }

  // RGB: locate first mismatch (only meaningful where opaque, but the oracle's
  // transparent cells are RGB 0 from the (0,0,0,0) fill and the TS buffer is 0 too,
  // so an exact full-array compare is correct and stricter).
  let rMismatch = -1;
  for (let i = 0; i < n * 3; i++) {
    if (buf.rgb[i] !== exp.rgb[i]) {
      rMismatch = i;
      break;
    }
  }
  if (rMismatch !== -1) {
    const cell = Math.floor(rMismatch / 3);
    const c = rMismatch % 3;
    const x = Math.floor(cell / exp.h);
    const y = cell % exp.h;
    expect(
      buf.rgb[rMismatch],
      `${label}: rgb mismatch at flat=${rMismatch} (x=${x},y=${y},c=${c})`,
    ).toBe(exp.rgb[rMismatch]);
  }
  assertedCells += n * 4; // rgb (3) + alpha (1) per cell
  return n;
}

describe("sprites: constants + weapon palette", () => {
  it("WEAPON_ICON_BASE matches the oracle (0xAA)", () => {
    expect(sprites.WEAPON_ICON_BASE).toBe(V.WEAPON_ICON_BASE);
    expect(sprites.WEAPON_ICON_BASE).toBe(0xaa);
  });

  it("weapon_icon_palette reproduces the full (256,3) table exactly", () => {
    const pal = sprites.weapon_icon_palette();
    expect(pal.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      const got = pal[i] as RGB;
      const want = V.weapon_icon_palette[i];
      expect(
        [got[0], got[1], got[2]],
        `weapon_icon_palette[${i}] (0x${i.toString(16)})`,
      ).toEqual([want[0], want[1], want[2]]);
    }
    // The overlaid band base 0xAA..0xBE must be the shop RGB6 << 2.
    expect(pal[0xaa]).toEqual([0, 0, 0]);
    expect(pal[0xab]).toEqual([0xfc, 0xfc, 0]); // (0x3f,0x3f,0)<<2
  });
});

describe("sprites: Table A (48 weapon/HUD icons)", () => {
  it("decodes every record byte-exact (default VIS_RGB palette)", () => {
    expect(V.table_a.length).toBe(48);
    for (let i = 0; i < 48; i++) {
      const buf = sprites.buildSpritePixels(rawA(i));
      expectBufferMatches(`table_a[${i}]`, buf, V.table_a[i]);
    }
  });

  it("decodes the scaled variants (scale=2) byte-exact", () => {
    const idxs = [0, 5, 9];
    for (let k = 0; k < idxs.length; k++) {
      const buf = sprites.buildSpritePixels(rawA(idxs[k]), { scale: 2 });
      expectBufferMatches(`table_a_scale2[${idxs[k]}]`, buf, V.table_a_scale2[k]);
    }
  });

  it("decodes the real-palette REMAP path (color+pal) byte-exact", () => {
    const pal = sprites.weapon_icon_palette();
    expect(V.table_a_remap.length).toBe(48);
    for (let i = 0; i < 48; i++) {
      const buf = sprites.buildSpritePixels(rawA(i), {
        color: sprites.WEAPON_ICON_BASE,
        pal,
      });
      expectBufferMatches(`table_a_remap[${i}]`, buf, V.table_a_remap[i]);
    }
  });
});

describe("sprites: Table B (12 cursor/parachute/tank/bomb)", () => {
  it("decodes every record byte-exact", () => {
    expect(V.table_b.length).toBe(12);
    for (let i = 0; i < 12; i++) {
      const buf = sprites.buildSpritePixels(rawB(i));
      expectBufferMatches(`table_b[${i}]`, buf, V.table_b[i]);
    }
  });
});

describe("sprites: draw_tank battery (designs x angles x colors x facing)", () => {
  it("reproduces every tank body + barrel exactly", () => {
    expect(V.draw_tank.length).toBeGreaterThan(0);
    for (let k = 0; k < V.draw_tank.length; k++) {
      const c = V.draw_tank[k];
      const buf = sprites.tankBodyPixels(
        c.w,
        c.h,
        c.x,
        c.y,
        c.color as RGB,
        c.design,
        { angle: c.angle, facing: c.facing, scale: 1 },
      );
      expectBufferMatches(
        `draw_tank[d=${c.design},a=${c.angle},f=${c.facing},col=${c.color}]`,
        buf,
        c,
      );
    }
  });

  it("reproduces the int-palette-index color path exactly", () => {
    const pal = sprites.weapon_icon_palette();
    const c = V.draw_tank_palidx;
    // resolveColor(0x6e, pal) -> pal[0x6e]; replicate via tankBodyPixels with that RGB.
    const rgb = pal[c.color_index] as RGB;
    const buf = sprites.tankBodyPixels(c.w, c.h, 24, 30, rgb, 0, { angle: 90, scale: 1 });
    expectBufferMatches("draw_tank_palidx", buf, c);
  });
});

describe("sprites: draw_tank_icon_cell (Tank-Initialization appearance cells)", () => {
  it("reproduces every design cell (grayed + tinted) exactly", () => {
    expect(V.draw_tank_icon_cell.length).toBe(14);
    for (let k = 0; k < V.draw_tank_icon_cell.length; k++) {
      const c = V.draw_tank_icon_cell[k];
      // Replicate draw_tank_icon_cell's centering math against the same box, then
      // render the body buffer (this is exactly what the Surface method stamps).
      const buf = iconCellBuffer(c);
      expectBufferMatches(`icon_cell[d=${c.design},gray=${c.grayed}]`, buf, c);
    }
  });
});

describe("sprites: proportional bitmap font", () => {
  it("reproduces every glyph byte-exact + correct width", () => {
    expect(V.font_glyphs.length).toBeGreaterThan(100);
    for (const c of V.font_glyphs) {
      expect(sprites.font_glyph_width(c.code), `font width code=${c.code}`).toBe(c.width);
      const buf = sprites.fontGlyphPixels(c.code);
      expectBufferMatches(`font_glyph[${c.code}]`, buf, c);
    }
  });

  it("reproduces a rendered string exactly", () => {
    expect(sprites.font_text_width(V.font_text.s)).toBe(V.font_text.width);
    const buf = sprites.renderTextPixels(V.font_text.s);
    expectBufferMatches("font_text", buf, V.font_text);
  });
});

describe("sprites: mouse cursor + window icon", () => {
  it("reproduces the default arrow cursor + hotspot exactly", () => {
    const { buf, hotspot } = sprites.cursorPixels();
    expect(hotspot).toEqual(V.cursor.hotspot);
    expectBufferMatches("cursor", buf, V.cursor);
  });

  it("reproduces the scaled cursor exactly", () => {
    const { buf, hotspot } = sprites.cursorPixels([255, 255, 255], 2);
    expect(hotspot).toEqual(V.cursor_scale2.hotspot);
    expectBufferMatches("cursor_scale2", buf, V.cursor_scale2);
  });

  it("reproduces the window icon exactly", () => {
    const buf = sprites.windowIconPixels();
    expectBufferMatches("window_icon", buf, V.window_icon);
  });
});

describe("sprites: load_title_mountain (real shipped .MTN bytes)", () => {
  it("decodes each real .MTN into the exact RGBA surface (ground + sky-alpha-0)", () => {
    expect(V.title_mountain.length).toBeGreaterThan(0);
    for (const c of V.title_mountain) {
      const bytes = hexToBytes(c.bytes_hex);
      // Feed the IDENTICAL shipped bytes through the injectable byte source path.
      const buf = sprites.loadTitleMountainPixels(c.name, bytes);
      expect(buf, `title_mountain ${c.name} decoded`).not.toBeNull();
      expectBufferMatches(`title_mountain[${c.name}]`, buf as PixelBuffer, c);
    }
  });

  it("returns null for an off-whitelist name", () => {
    expect(sprites.loadTitleMountainPixels("NOTREAL.MTN", new Uint8Array([1]))).toBeNull();
    expect(sprites.titleMountainName("ROCK001.MTN")).toBe("ROCK001.MTN");
    expect(sprites.titleMountainName("notreal")).toBeNull();
  });
});

describe("sprites: battery completeness", () => {
  it("asserted the expected number of pixel-cells (battery did not shrink)", () => {
    // Sum of every case's w*h*4 (rgb+alpha). Recomputed from the vectors so it
    // tracks the dump; a >0 floor guards against an empty/short JSON.
    let want = 0;
    const surfSets: SurfCase[][] = [
      V.table_a,
      V.table_b,
      V.table_a_scale2,
      V.table_a_remap,
      V.draw_tank,
      V.draw_tank_icon_cell,
      V.font_glyphs,
      V.title_mountain,
    ];
    for (const set of surfSets) for (const c of set) want += c.w * c.h * 4;
    for (const c of [V.draw_tank_palidx, V.font_text, V.cursor, V.cursor_scale2, V.window_icon]) {
      want += c.w * c.h * 4;
    }
    expect(assertedCells).toBe(want);
    expect(assertedCells).toBeGreaterThan(7_000_000); // ~1.98M cells * 4
  });
});

// --------------------------------------------------------------------------
// helpers: raw record access (the data module is the byte-exact source) and the
// icon-cell centering math (replicated so the test feeds the same body buffer the
// Surface method stamps).
// --------------------------------------------------------------------------

// Re-import the raw tables through the public decode path: buildSpritePixels takes a
// raw Uint8Array, so the test needs the records.  They live in src/sprites_data.
import * as spriteData from "../src/sprites_data";

function rawA(i: number): Uint8Array {
  return spriteData.TABLE_A_RAW[i];
}
function rawB(i: number): Uint8Array {
  return spriteData.TABLE_B_RAW[i];
}

/** Replicate draw_tank_icon_cell's centering + render the body buffer. Mirrors
 *  src/sprites.ts draw_tank_icon_cell exactly (same floor-div, same bbox). */
function iconCellBuffer(c: CellCase): PixelBuffer {
  const design = c.design;
  const grayed = c.grayed;
  const scale = 2;
  const rgb: RGB = grayed ? [120, 120, 120] : (c.color as RGB);
  const barrel: RGB | null = grayed ? [150, 150, 150] : null;
  const strokes = spriteData.TANK_STROKES[design >= 0 && design < 7 ? design : 0];
  let minx = Infinity;
  let miny = Infinity;
  let maxyv = -Infinity;
  for (const p of strokes) {
    if (p[0] < minx) minx = p[0];
    if (p[1] < miny) miny = p[1];
    if (p[1] > maxyv) maxyv = p[1];
  }
  const mount = spriteData.TANK_TURRET[design >= 0 && design < 7 ? design : 0] ?? [0, 0];
  const ty = mount[1];
  const word0 = spriteData.TANK_WORD0[design] ?? spriteData.BARREL_LEN_DEFAULT;
  const top = Math.min(miny, ty - word0);
  const bottom = maxyv;
  const box = c.box;
  const centerx = box[0] + (box[2] >> 1);
  const centery = box[1] + (box[3] >> 1);
  const extentH = (bottom - top) * scale;
  const originY = centery + Math.floor(extentH / 2) - bottom * scale;
  return sprites.tankBodyPixels(c.w, c.h, centerx, originY, rgb, design, {
    angle: 90,
    scale,
    barrelRgb: barrel,
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

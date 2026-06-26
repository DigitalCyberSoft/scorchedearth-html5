/**
 * Differential gate: TS render == Python scorch.render (the fidelity oracle).
 *
 * render.py draws the recovered world (terrain composite, tanks, projectiles,
 * explosion band, laser, HUD, title backdrop).  The LITERAL pixels it strokes/
 * blits are validated by the Phase-3 VISUAL gate, NOT here.  What this gate tests
 * is the NUMERIC SUBSTRATE -- the arrays and math that FEED those draws, which the
 * port must reproduce byte-for-byte:
 *
 *   - verticalGradient: the title-backdrop (w,h,3) gradient, COLUMN-MAJOR EXACT.
 *   - gradientIndexPlane: the sky band-index plane, EXACT.
 *   - bandedVerticalRamp: the 30-step quantised sunset ramp, EXACT.
 *   - makeSkyPlane: the baked BLACK/SUNSET/STORMY/CAVERN sky planes, EXACT.
 *   - compositeTerrainRgb: the composited terrain buffer (grid -> rgb through the
 *     live LUT into the column-major surfarray buffer), EXACT, vs the REAL
 *     _composite_terrain output read back from the Python Surface (array3d).
 *   - explosionRingIndex: the recovered ring index 0xDD - r*20/maxR, EXACT.
 *   - hudAngle / shieldPct: the HUD elevation + shield %, EXACT.
 *   - weaponIconName / WEAPON_ICON: the category->sprite map, EXACT (string).
 *   - the PARACHUTE / DEATH_TILE geometry tables, EXACT.
 *   - titleBackdropLayout: the aspect-preserving scale/anchor, EXACT.
 *
 * EPSILON POLICY: every recorded datum is an integer / index / pixel byte / bool /
 * string -- there is NO transcendental on any tested path (the gradients and ramps
 * are float32 linear-interp then uint8-truncate, reproduced bit-for-bit with
 * Math.fround/Math.trunc exactly as palette.LiveLUT.reramp_band does, which the
 * palette gate already proves over 18,960 channel values).  So ALL assertions are
 * EXACT (.toBe / .toEqual).  No epsilon is used.  pixelsDeferredToPhase3.
 *
 * STARS sky is excluded: makeSkyPlane("STARS") is RNG-driven (Math.random) and is
 * not reproducible against the Python np.random oracle by construction; it is not
 * dumped and not asserted here (documented in render.ts).
 *
 * DOM / PIXELS: the Renderer class draws through the pygame shim, which needs a
 * DOM to construct a Surface (vitest runs under Node).  So this gate does NOT
 * construct a Renderer or any Surface; it tests the PURE exported helpers (arrays
 * + scalars), which are DOM-free.  The drawing methods are the Phase-3 gate's job.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as render from "../src/render";
import * as C from "../src/constants";
import * as _pal from "../src/palette";
import { build_palette, LiveLUT } from "../src/palette";
import * as weapons from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "render.json");

type RGB = [number, number, number];

interface RenderVectors {
  module: string;
  consts: { [k: string]: number | number[] };
  weapon_icon: { [category: string]: string };
  weapon_icon_name: Array<{ category: string; name: string }>;
  parachute: Array<[number, number]>;
  death_tile: Array<[number, number, number]>;
  death_tile_grey: { [k: string]: RGB };
  vertical_gradient: Array<{ w: number; h: number; top: RGB; bottom: RGB; flat: number[] }>;
  gradient_index_plane: Array<{ w: number; h: number; flat: number[] }>;
  banded_ramp: Array<{ h: number; top: RGB; bottom: RGB; flat: number[] }>;
  baked_sky: Array<{ mode: string; w: number; h: number; flat: number[] }>;
  composite: Array<{
    label: string; w: number; h: number; sky_idx_set: boolean;
    grid_flat: number[]; rgb_flat: number[];
  }>;
  explosion_ring_index: Array<{ r: number; maxr: number; idx: number }>;
  hud_angle: Array<{ angle: number; elev: number; side: string }>;
  shield_pct: Array<{ shield_hp: number; shield_item: number; full: number | null; pct: number }>;
  title_layout: Array<{ w: number; h: number; mw: number; mh: number; sw: number; sh: number; dx: number; dy: number }>;
  title_backdrop_real: { w: number; h: number; mw: number; mh: number; scaled_size: number[]; blit_dest: number[] };
}

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as RenderVectors;

/** Compare two numeric arrays exactly, with a precise first-mismatch message. */
function expectArrayExact(got: ArrayLike<number>, want: number[], label: string): void {
  expect(got.length, `${label} length`).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      expect(got[i], `${label} mismatch at index ${i}`).toBe(want[i]);
    }
  }
}

describe("render: oracle invariants", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("render");
  });
  it("vector battery is non-trivial", () => {
    const n =
      vec.vertical_gradient.length +
      vec.gradient_index_plane.length +
      vec.banded_ramp.length +
      vec.baked_sky.length +
      vec.composite.length +
      vec.explosion_ring_index.length +
      vec.hud_angle.length +
      vec.shield_pct.length +
      vec.title_layout.length;
    expect(n).toBeGreaterThan(500);
  });
});

describe("render: module constants pinned to the recovered values", () => {
  it("band bounds + draw constants match the oracle", () => {
    const c = vec.consts;
    expect(_pal.SKY_BAND_LO).toBe(c.SKY_BAND_LO);
    expect(_pal.SKY_BAND_HI).toBe(c.SKY_BAND_HI);
    expect(_pal.SKY_RAMP_LEN).toBe(c.SKY_RAMP_LEN);
    expect(_pal.DIGGER_BAND_LO).toBe(c.DIGGER_BAND_LO);
    expect(_pal.DIGGER_BAND_HI).toBe(c.DIGGER_BAND_HI);
    expect(C.EXPLOSION_LO).toBe(c.EXPLOSION_LO);
    expect(C.EXPLOSION_HI).toBe(c.EXPLOSION_HI);
    expect(C.EXPLOSION_RING_BASE).toBe(c.EXPLOSION_RING_BASE);
    expect(C.DIRT_SHADE_LO).toBe(c.DIRT_SHADE_LO);
    expect(C.DIRT_SHADE_HI).toBe(c.DIRT_SHADE_HI);
    expect(C.COL_DIRT).toBe(c.COL_DIRT);
    expect(render.Renderer.BAR_H).toBe(c.BAR_H);
    expect(render.Renderer.SHIELD_SWATCH).toBe(c.SHIELD_SWATCH);
    expect(render.Renderer.FLASH_OVERLAY_PEAK).toBe(c.FLASH_OVERLAY_PEAK);
  });
  it("render-owned RGB constants match the oracle", () => {
    const c = vec.consts;
    expect(render.TITLE_SKY_TOP).toEqual(c.TITLE_SKY_TOP);
    expect(render.TITLE_SKY_BOTTOM).toEqual(c.TITLE_SKY_BOTTOM);
    expect(render.SUNSET_TOP_RGB).toEqual(c.SUNSET_TOP_RGB);
    expect(render.SUNSET_BOTTOM_RGB).toEqual(c.SUNSET_BOTTOM_RGB);
    expect(render.Renderer.SHIELD_RING_RGB).toEqual(c.SHIELD_RING_RGB);
    expect(render.Renderer.PLASMA_RING_RGB).toEqual(c.PLASMA_RING_RGB);
    expect(render.Renderer.NUKE_CORE).toEqual(c.NUKE_CORE);
    expect(render.Renderer.NUKE_MID).toEqual(c.NUKE_MID);
    expect(render.Renderer.NUKE_EDGE).toEqual(c.NUKE_EDGE);
  });
});

describe("render: WEAPON_ICON map + weapon_icon_name (string EXACT)", () => {
  it("the category->sprite map matches the oracle entry-for-entry", () => {
    const got = render.WEAPON_ICON;
    const want = vec.weapon_icon;
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) {
      expect(got[k], `WEAPON_ICON[${k}]`).toBe(want[k]);
    }
  });
  it("weapon_icon_name resolves each category (incl. unknown -> default)", () => {
    for (const c of vec.weapon_icon_name) {
      expect(render.weaponIconName({ category: c.category }), `cat=${c.category}`).toBe(c.name);
    }
  });
});

describe("render: geometry tables (PARACHUTE / DEATH_TILE) EXACT", () => {
  it("PARACHUTE canopy offsets match byte-for-byte", () => {
    const got = render.Renderer.PARACHUTE.map((p) => [p[0], p[1]]);
    expect(got).toEqual(vec.parachute);
  });
  it("DEATH_TILE (dx,dy,kind) triples match byte-for-byte", () => {
    const got = render.Renderer.DEATH_TILE.map((p) => [p[0], p[1], p[2]]);
    expect(got).toEqual(vec.death_tile);
  });
  it("DEATH_TILE_GREY shades match", () => {
    for (const k of Object.keys(vec.death_tile_grey)) {
      expect(render.Renderer.DEATH_TILE_GREY[Number(k)], `grey[${k}]`).toEqual(vec.death_tile_grey[k]);
    }
  });
});

describe("render: verticalGradient (title backdrop) COLUMN-MAJOR EXACT", () => {
  for (let i = 0; i < vec.vertical_gradient.length; i++) {
    const c = vec.vertical_gradient[i];
    it(`#${i} ${c.w}x${c.h} ${JSON.stringify(c.top)}->${JSON.stringify(c.bottom)}`, () => {
      const g = render.verticalGradient(c.w, c.h, c.top, c.bottom);
      expect(g.w).toBe(c.w);
      expect(g.h).toBe(c.h);
      expectArrayExact(g.data, c.flat, `vgrad#${i}`);
    });
  }
});

describe("render: gradientIndexPlane (sky band-index plane) EXACT", () => {
  for (let i = 0; i < vec.gradient_index_plane.length; i++) {
    const c = vec.gradient_index_plane[i];
    it(`#${i} ${c.w}x${c.h}`, () => {
      const plane = render.gradientIndexPlane(c.w, c.h);
      expectArrayExact(plane, c.flat, `gip#${i}`);
    });
  }
});

describe("render: bandedVerticalRamp (30-step quantised sunset ramp) EXACT", () => {
  for (let i = 0; i < vec.banded_ramp.length; i++) {
    const c = vec.banded_ramp[i];
    it(`#${i} h=${c.h} ${JSON.stringify(c.top)}->${JSON.stringify(c.bottom)}`, () => {
      const ramp = render.bandedVerticalRamp(c.h, c.top, c.bottom);
      expectArrayExact(ramp, c.flat, `banded#${i}`);
    });
  }
});

describe("render: makeSkyPlane baked planes (BLACK/SUNSET/STORMY/CAVERN) EXACT", () => {
  for (let i = 0; i < vec.baked_sky.length; i++) {
    const c = vec.baked_sky[i];
    it(`${c.mode} ${c.w}x${c.h}`, () => {
      const sky = render.makeSkyPlane(c.mode, c.w, c.h);
      expect(sky.w).toBe(c.w);
      expect(sky.h).toBe(c.h);
      expectArrayExact(sky.data, c.flat, `baked ${c.mode}`);
    });
  }
});

describe("render: compositeTerrainRgb vs REAL _composite_terrain (array3d readback) EXACT", () => {
  // The golden rgb_flat is the Python Surface read back via pygame.surfarray.
  // array3d after the REAL Renderer._composite_terrain ran -- so this asserts the
  // TS composite reproduces the actual module output, not a re-derivation.
  for (let i = 0; i < vec.composite.length; i++) {
    const c = vec.composite[i];
    it(`${c.label} ${c.w}x${c.h} (sky_idx=${c.sky_idx_set})`, () => {
      // Rebuild the grid as a column-major Int32Array (the dumper raveled (W,H)
      // C-order == x*h + y).
      const grid = new Int32Array(c.grid_flat);
      // The frame LUT is a fresh LiveLUT (= build_palette at rest), matching the
      // dumper's palette.LiveLUT().
      const lut = new LiveLUT();
      // The sky plane: a GRADIENT sky (sky_idx_set) is the band-index plane
      // gathered through the LUT; a BAKED sky (sunset) is the baked rgb plane.
      let skyPlane: { idx: Int32Array } | { rgb: Uint8Array };
      if (c.sky_idx_set) {
        skyPlane = { idx: render.gradientIndexPlane(c.w, c.h) };
      } else {
        // The baked-sky composite case in the dumper is SUNSET.
        skyPlane = { rgb: render.makeSkyPlane("SUNSET", c.w, c.h).data };
      }
      const rgb = render.compositeTerrainRgb(grid, c.w, c.h, lut, skyPlane);
      expectArrayExact(rgb, c.rgb_flat, `composite ${c.label}`);
    });
  }
});

// gridAt() accepts the flat-TypedArray form (asserted above) AND a NESTED number[][]
// (grid[x][y]) the port hands it from a non-typed grid (render.ts:497-509).  Feeding
// the SAME golden grid as a nested array MUST yield the byte-identical composite the
// flat path (already oracle-verified vs the REAL _composite_terrain) produced -- this
// drives the nested-array branch (render.ts:507-509) with that exactness as the check.
describe("render: compositeTerrainRgb nested number[][] grid == flat (gridAt[x][y]) EXACT", () => {
  for (let i = 0; i < vec.composite.length; i++) {
    const c = vec.composite[i];
    it(`${c.label} ${c.w}x${c.h} nested grid matches the flat composite`, () => {
      // nested[x][y] = grid_flat[x*h + y] (the column-major raveling the dumper used).
      const nested: number[][] = [];
      for (let x = 0; x < c.w; x++) {
        const col: number[] = [];
        for (let y = 0; y < c.h; y++) col.push(c.grid_flat[x * c.h + y]);
        nested.push(col);
      }
      const lut = new LiveLUT();
      let skyPlane: { idx: Int32Array } | { rgb: Uint8Array };
      if (c.sky_idx_set) {
        skyPlane = { idx: render.gradientIndexPlane(c.w, c.h) };
      } else {
        skyPlane = { rgb: render.makeSkyPlane("SUNSET", c.w, c.h).data };
      }
      const rgb = render.compositeTerrainRgb(nested, c.w, c.h, lut, skyPlane);
      expectArrayExact(rgb, c.rgb_flat, `nested composite ${c.label}`);
    });
  }
});

describe("render: explosionRingIndex (0xDD - r*20/maxR clamped) EXACT", () => {
  it(`${vec.explosion_ring_index.length} (r, maxr) samples match`, () => {
    for (const c of vec.explosion_ring_index) {
      expect(render.explosionRingIndex(c.r, c.maxr), `ring(${c.r},${c.maxr})`).toBe(c.idx);
    }
  });
});

describe("render: hudAngle (0-180 -> elev + side) EXACT", () => {
  it(`${vec.hud_angle.length} angle samples match`, () => {
    for (const c of vec.hud_angle) {
      const [elev, side] = render.hudAngle(c.angle);
      expect(elev, `hudAngle(${c.angle}) elev`).toBe(c.elev);
      expect(side, `hudAngle(${c.angle}) side`).toBe(c.side);
    }
  });
});

describe("render: shieldPct (active shield HP %) EXACT", () => {
  for (let i = 0; i < vec.shield_pct.length; i++) {
    const c = vec.shield_pct[i];
    it(`#${i} hp=${c.shield_hp} item=${c.shield_item}`, () => {
      // Sanity-lock the "full" the port reads from the item params equals the
      // oracle's (params.hp or 100), so the % derives from the same denominator.
      if (c.shield_item) {
        const params = weapons.ITEMS[c.shield_item].params;
        const full = typeof params.hp === "number" ? params.hp : 100;
        if (c.full !== null) {
          expect(full, `#${i} full`).toBe(c.full);
        }
      }
      const pct = render.shieldPct({ shield_hp: c.shield_hp, shield_item: c.shield_item });
      expect(pct, `#${i} pct`).toBe(c.pct);
    });
  }
});

describe("render: titleBackdropLayout (aspect-preserving scale/anchor) EXACT", () => {
  for (let i = 0; i < vec.title_layout.length; i++) {
    const c = vec.title_layout[i];
    it(`#${i} panel ${c.w}x${c.h} mtn ${c.mw}x${c.mh}`, () => {
      const lay = render.titleBackdropLayout(c.w, c.h, c.mw, c.mh);
      expect(lay.sw, `#${i} sw`).toBe(c.sw);
      expect(lay.sh, `#${i} sh`).toBe(c.sh);
      expect(lay.dx, `#${i} dx`).toBe(c.dx);
      expect(lay.dy, `#${i} dy`).toBe(c.dy);
    });
  }
  it("matches the REAL make_title_backdrop smoothscale target (1024x768, 640x480 mtn)", () => {
    const r = vec.title_backdrop_real;
    const lay = render.titleBackdropLayout(r.w, r.h, r.mw, r.mh);
    expect([lay.sw, lay.sh], "scaled size").toEqual(r.scaled_size);
    expect([lay.dx, lay.dy], "blit dest").toEqual(r.blit_dest);
  });
});

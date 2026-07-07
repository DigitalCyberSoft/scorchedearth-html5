/**
 * Differential gate (extension): the parts of src/sprites.ts the per-buffer gate
 * (test/sprites.test.ts) does not reach -- the SURFACE-returning wrappers, the
 * REAL draw_tank / draw_tank_icon_cell / get_tank_icons paths (not the test's own
 * replica of their math), and the pure introspection helpers
 * (tank_design_wheels / tank_silhouette / font_codes / setMtnByteSource).
 *
 * SURFACE PIPELINE UNDER NODE: pygame.Surface needs a DOM (src/pygame.ts header).
 * This file installs a faithful, headless ImageData-backed Canvas2D stub (only the
 * ops the sprite Surface path touches: clearRect/fillRect/createImageData/
 * getImageData/putImageData), so the REAL src/pygame.ts Surface +
 * surfarray.blit_array + pixels_alpha + set_at code runs.  Every Surface built
 * here is then READ BACK (column-major, the surfarray contract) and asserted
 * EXACTLY against the Python oracle (oracle/vectors/sprites.json).  The stub is
 * NOT trusted: a wrong stub produces wrong pixels and the oracle comparison fails.
 * So these assertions exercise real behavior; the canvas is the only thing faked
 * (the genuine browser boundary), exactly as node-canvas/jsdom would stand in.
 *
 * EXACTNESS: every datum is an integer RGB/alpha byte, a width, a bool, or a code.
 * All assertions are exact equality; no epsilon is used or warranted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import * as sprites from "../src/sprites";
import type { PixelBuffer } from "../src/sprites";
import * as pygame from "../src/pygame";
import * as spriteData from "../src/sprites_data";

// ---------------------------------------------------------------------------
// Headless Canvas2D stub -- installed BEFORE src/sprites (hence src/pygame) is
// imported, so the first `new pygame.Surface()` finds a working `document`.
// ---------------------------------------------------------------------------

/** Parse the exact strings src/pygame.ts's rgbaToCss emits ("rgb(r,g,b)" /
 *  "rgba(r,g,b,a)"), plus "#rgb"/"#rrggbb" (the non-alpha Surface ctor seed). */
function parseColor(s: string): [number, number, number, number] {
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const p = fn[1].split(",").map((t) => t.trim());
    const a = p.length >= 4 ? Math.round(parseFloat(p[3]) * 255) : 255;
    return [parseInt(p[0], 10) & 255, parseInt(p[1], 10) & 255, parseInt(p[2], 10) & 255, a & 255];
  }
  const hexm = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
  if (hexm) {
    let h = hexm[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
  }
  return [0, 0, 0, 255]; // Canvas default fillStyle is opaque black.
}

interface StubImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A row-major RGBA store implementing the Canvas2D ops the sprite path uses. */
class Ctx2D {
  data: Uint8ClampedArray;
  fillStyle = "#000";
  constructor(
    readonly _w: number,
    readonly _h: number,
  ) {
    this.data = new Uint8ClampedArray(_w * _h * 4); // fresh canvas: transparent black
  }
  private clampRect(x: number, y: number, w: number, h: number): [number, number, number, number] {
    return [
      Math.max(0, Math.floor(x)),
      Math.max(0, Math.floor(y)),
      Math.min(this._w, Math.floor(x + w)),
      Math.min(this._h, Math.floor(y + h)),
    ];
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    const [x0, y0, x1, y1] = this.clampRect(x, y, w, h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const d = (yy * this._w + xx) * 4;
        this.data[d] = this.data[d + 1] = this.data[d + 2] = this.data[d + 3] = 0;
      }
    }
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const [sr, sg, sb, sa] = parseColor(this.fillStyle);
    const [x0, y0, x1, y1] = this.clampRect(x, y, w, h);
    const a = sa / 255;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const d = (yy * this._w + xx) * 4;
        if (sa === 255) {
          this.data[d] = sr;
          this.data[d + 1] = sg;
          this.data[d + 2] = sb;
          this.data[d + 3] = 255;
        } else if (sa !== 0) {
          // source-over (sprite path only ever passes a in {0,255}; full blend for safety)
          const da = this.data[d + 3] / 255;
          const oa = a + da * (1 - a);
          const mix = (s: number, dd: number) => (oa === 0 ? 0 : Math.round((s * a + dd * da * (1 - a)) / oa));
          this.data[d] = mix(sr, this.data[d]);
          this.data[d + 1] = mix(sg, this.data[d + 1]);
          this.data[d + 2] = mix(sb, this.data[d + 2]);
          this.data[d + 3] = Math.round(oa * 255);
        } // sa === 0: no-op
      }
    }
  }
  createImageData(w: number, h: number): StubImage {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(x: number, y: number, w: number, h: number): StubImage {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        const sy = y + yy;
        if (sx < 0 || sx >= this._w || sy < 0 || sy >= this._h) continue;
        const s = (sy * this._w + sx) * 4;
        const d = (yy * w + xx) * 4;
        out[d] = this.data[s];
        out[d + 1] = this.data[s + 1];
        out[d + 2] = this.data[s + 2];
        out[d + 3] = this.data[s + 3];
      }
    }
    return { width: w, height: h, data: out };
  }
  putImageData(img: StubImage, dx: number, dy: number): void {
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const tx = dx + xx;
        const ty = dy + yy;
        if (tx < 0 || tx >= this._w || ty < 0 || ty >= this._h) continue;
        const s = (yy * img.width + xx) * 4;
        const d = (ty * this._w + tx) * 4;
        this.data[d] = img.data[s];
        this.data[d + 1] = img.data[s + 1];
        this.data[d + 2] = img.data[s + 2];
        this.data[d + 3] = img.data[s + 3];
      }
    }
  }
  drawImage(src: FakeCanvas, ...args: number[]): void {
    // The drawers now build each tank variant ONCE and BLIT it (sprites.ts
    // tankSprite; per-pixel set_at stamping was the tank-setup hot spot), so the
    // stub composites source-over exactly like a real canvas: integer coords,
    // 1:1 scale, the 3-arg (dx,dy) and 9-arg (sx,sy,sw,sh,dx,dy,sw,sh) forms
    // pygame.ts blit/copy/subsurface use. Anything else still fails loudly.
    let sx = 0;
    let sy = 0;
    let sw = src.width;
    let sh = src.height;
    let dx = 0;
    let dy = 0;
    if (args.length === 2) {
      [dx, dy] = args;
    } else if (args.length === 8) {
      [sx, sy, sw, sh, dx, dy] = args;
      if (args[6] !== sw || args[7] !== sh) {
        throw new Error("Ctx2D.drawImage: scaling unsupported in the stub");
      }
    } else {
      throw new Error(`Ctx2D.drawImage: unsupported arity ${args.length + 1}`);
    }
    const sctx = src.getContext("2d");
    for (let yy = 0; yy < sh; yy++) {
      for (let xx = 0; xx < sw; xx++) {
        const fx = sx + xx;
        const fy = sy + yy;
        if (fx < 0 || fx >= src.width || fy < 0 || fy >= src.height) continue;
        const tx = Math.floor(dx) + xx;
        const ty = Math.floor(dy) + yy;
        if (tx < 0 || tx >= this._w || ty < 0 || ty >= this._h) continue;
        const s = (fy * src.width + fx) * 4;
        const d = (ty * this._w + tx) * 4;
        const sa = sctx.data[s + 3];
        if (sa === 0) continue;
        if (sa === 255) {
          this.data[d] = sctx.data[s];
          this.data[d + 1] = sctx.data[s + 1];
          this.data[d + 2] = sctx.data[s + 2];
          this.data[d + 3] = 255;
        } else {
          // general source-over (the sprite path only carries a in {0,255})
          const a = sa / 255;
          const da = this.data[d + 3] / 255;
          const oa = a + da * (1 - a);
          const mix = (sv: number, dv: number): number =>
            oa === 0 ? 0 : Math.round((sv * a + dv * da * (1 - a)) / oa);
          this.data[d] = mix(sctx.data[s], this.data[d]);
          this.data[d + 1] = mix(sctx.data[s + 1], this.data[d + 1]);
          this.data[d + 2] = mix(sctx.data[s + 2], this.data[d + 2]);
          this.data[d + 3] = Math.round(oa * 255);
        }
      }
    }
  }
}

class FakeCanvas {
  width = 1;
  height = 1;
  private _ctx: Ctx2D | null = null;
  getContext(type: string): Ctx2D {
    if (type !== "2d") throw new Error(`FakeCanvas.getContext: only 2d (got ${type})`);
    if (this._ctx === null || this._ctx._w !== this.width || this._ctx._h !== this.height) {
      this._ctx = new Ctx2D(this.width, this.height);
    }
    return this._ctx;
  }
}

const _prevDocument = (globalThis as unknown as { document?: unknown }).document;
(globalThis as unknown as { document: unknown }).document = {
  createElement(tag: string): unknown {
    if (tag === "canvas") return new FakeCanvas();
    return {};
  },
};
afterAll(() => {
  (globalThis as unknown as { document?: unknown }).document = _prevDocument;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(__dirname, "..", "oracle", "vectors", "sprites.json"), "utf8"));

type RGB = [number, number, number];
interface SurfCase {
  w: number;
  h: number;
  rgb: number[];
  alpha: number[];
}

// ---------------------------------------------------------------------------
// Readback + exact comparison.
// ---------------------------------------------------------------------------

/** Read a real (stubbed) Surface back into the column-major surfarray contract,
 *  identical to oracle/dump_sprites.py's surf_arrays (array3d/array_alpha). */
function surfaceToBuffer(surf: pygame.Surface): PixelBuffer {
  const [w, h] = surf.get_size();
  const img = surf.ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const s = (y * w + x) * 4;
      const ai = x * h + y;
      rgb[ai * 3] = img[s];
      rgb[ai * 3 + 1] = img[s + 1];
      rgb[ai * 3 + 2] = img[s + 2];
      alpha[ai] = img[s + 3];
    }
  }
  return { w, h, rgb, alpha };
}

let cellsAsserted = 0;
/** Exact full-array compare; locates and reports the first mismatch. */
function expectExact(label: string, buf: PixelBuffer, exp: SurfCase): void {
  expect([buf.w, buf.h], `${label}: size`).toEqual([exp.w, exp.h]);
  const n = exp.w * exp.h;
  let am = -1;
  for (let i = 0; i < n; i++) {
    if (buf.alpha[i] !== exp.alpha[i]) {
      am = i;
      break;
    }
  }
  if (am !== -1) {
    expect(buf.alpha[am], `${label}: alpha@flat=${am} (x=${Math.floor(am / exp.h)},y=${am % exp.h})`).toBe(
      exp.alpha[am],
    );
  }
  let rm = -1;
  for (let i = 0; i < n * 3; i++) {
    if (buf.rgb[i] !== exp.rgb[i]) {
      rm = i;
      break;
    }
  }
  if (rm !== -1) {
    const cell = Math.floor(rm / 3);
    expect(
      buf.rgb[rm],
      `${label}: rgb@flat=${rm} (x=${Math.floor(cell / exp.h)},y=${cell % exp.h},c=${rm % 3})`,
    ).toBe(exp.rgb[rm]);
  }
  cellsAsserted += n * 4;
}

/** Build a transparent SRCALPHA Surface the way the oracle drivers do. */
function blankSurface(w: number, h: number): pygame.Surface {
  const s = new pygame.Surface([w, h], pygame.SRCALPHA);
  s.fill([0, 0, 0, 0]);
  return s;
}

// ===========================================================================
// Pure introspection helpers (DOM-free; assert directly against the oracle).
// ===========================================================================

describe("sprites_more: pure introspection helpers == oracle", () => {
  it("tank_design_wheels matches the oracle for idx -1..7 (incl out-of-range)", () => {
    expect(V.tank_design_wheels.length).toBe(9);
    for (const [idx, want] of V.tank_design_wheels as [number, boolean][]) {
      expect(sprites.tank_design_wheels(idx), `tank_design_wheels(${idx})`).toBe(want);
    }
    // Recovered facts: only designs 0 and 1 lack the colour-7 tread band.
    expect(sprites.tank_design_wheels(0)).toBe(false);
    expect(sprites.tank_design_wheels(1)).toBe(false);
    expect(sprites.tank_design_wheels(2)).toBe(true);
  });

  it("tank_silhouette reproduces (w,h,local) for every design + an OOB clamp", () => {
    expect(V.tank_silhouette.length).toBe(8); // designs 0..6 + idx 99
    for (const c of V.tank_silhouette as { idx: number; w: number; h: number; local: string[] }[]) {
      const got = sprites.tank_silhouette(c.idx);
      expect([got.w, got.h], `silhouette(${c.idx}) size`).toEqual([c.w, c.h]);
      const localSorted = Array.from(got.local).sort();
      expect(localSorted, `silhouette(${c.idx}) local cells`).toEqual(c.local);
      // local cell count == stroke count for that design (no de-dup loss).
      expect(got.local.size, `silhouette(${c.idx}) cell count`).toBe(c.local.length);
    }
    // OOB idx 99 clamps to design 0 (designIndex), so it equals the idx-0 case.
    const oob = V.tank_silhouette.find((c: { idx: number }) => c.idx === 99);
    const d0 = V.tank_silhouette.find((c: { idx: number }) => c.idx === 0);
    expect(oob.local).toEqual(d0.local);
  });

  it("font_codes equals the oracle (every width>0 glyph code, sorted)", () => {
    const got = sprites.font_codes();
    expect(got).toEqual(V.font_codes);
    expect(got.length).toBe(160);
    expect(got).toEqual([...got].sort((a, b) => a - b)); // sorted ascending
    expect(got.includes(34)).toBe(false); // 0x22 double-quote: width-0 stub, excluded
    expect(got.includes(32)).toBe(true); // space has a real (width-4) glyph
  });
});

// ===========================================================================
// get_sprite out-of-range -> null (rawRecord undefined branch).
// ===========================================================================

describe("sprites_more: get_sprite out-of-range", () => {
  it("returns null for an index past either table (no Surface built)", () => {
    // DIVERGENCE FROM ORACLE (reported, not papered over): Python get_sprite raises
    // IndexError on an out-of-range index (list index); the TS chose graceful null.
    // The src/sprites.ts:234 doc comment ("throws like the Python list index") is
    // therefore stale -- the code returns null.  Asserting the ACTUAL TS behavior.
    expect(sprites.get_sprite("A", 48)).toBeNull();
    expect(sprites.get_sprite("A", 999)).toBeNull();
    expect(sprites.get_sprite("B", 12)).toBeNull();
    expect(sprites.get_sprite("B", -1)).toBeNull();
  });
});

// ===========================================================================
// REAL Surface pipeline (headless Canvas2D) == oracle.
// ===========================================================================

describe("sprites_more: get_sprite / get_table_a / get_table_b (real Surfaces)", () => {
  it("get_sprite('A',i) rendered Surface reads back == oracle (VIS_RGB default)", () => {
    for (const i of [0, 5, 9, 19, 30, 44, 47]) {
      const surf = sprites.get_sprite("A", i);
      expect(surf, `get_sprite A[${i}]`).not.toBeNull();
      expectExact(`get_sprite_A[${i}]`, surfaceToBuffer(surf as pygame.Surface), V.table_a[i]);
    }
  });

  it("get_sprite('B',i) rendered Surface reads back == oracle", () => {
    for (const i of [0, 4, 7, 9, 11]) {
      const surf = sprites.get_sprite("B", i);
      expect(surf, `get_sprite B[${i}]`).not.toBeNull();
      expectExact(`get_sprite_B[${i}]`, surfaceToBuffer(surf as pygame.Surface), V.table_b[i]);
    }
  });

  it("get_sprite REMAP path (color+pal) Surface reads back == oracle", () => {
    const pal = sprites.weapon_icon_palette();
    for (const i of [0, 19, 41, 47]) {
      const surf = sprites.get_sprite("A", i, { color: sprites.WEAPON_ICON_BASE, pal });
      expectExact(`get_sprite_remap[${i}]`, surfaceToBuffer(surf as pygame.Surface), V.table_a_remap[i]);
    }
  });

  it("get_table_a returns 48 Surfaces, each == oracle (sampled)", () => {
    const a = sprites.get_table_a();
    expect(a.length).toBe(48);
    for (const i of [0, 23, 47]) expectExact(`get_table_a[${i}]`, surfaceToBuffer(a[i]), V.table_a[i]);
  });

  it("get_table_b returns 12 Surfaces, each == oracle (sampled)", () => {
    const b = sprites.get_table_b();
    expect(b.length).toBe(12);
    for (const i of [0, 6, 11]) expectExact(`get_table_b[${i}]`, surfaceToBuffer(b[i]), V.table_b[i]);
  });
});

describe("sprites_more: REAL draw_tank (Surface stamp path) == oracle", () => {
  it("reproduces a representative draw_tank battery exactly (designs/angles/facings/colors)", () => {
    let n = 0;
    // Stride across the full 630-case oracle to span every design, angle, facing,
    // and colour while keeping the surface readback bounded.
    for (let k = 0; k < V.draw_tank.length; k += 17) {
      const c = V.draw_tank[k];
      const surf = blankSurface(c.w, c.h);
      sprites.draw_tank(surf, c.x, c.y, c.design, c.color as RGB, c.angle, { facing: c.facing });
      expectExact(`draw_tank[d=${c.design},a=${c.angle},f=${c.facing}]`, surfaceToBuffer(surf), c);
      n++;
    }
    expect(n).toBeGreaterThan(30); // battery cannot silently shrink to nothing
  });

  it("int-palette-index color path (resolveColor numeric + pal) == oracle", () => {
    const pal = sprites.weapon_icon_palette();
    const c = V.draw_tank_palidx;
    const surf = blankSurface(c.w, c.h);
    sprites.draw_tank(surf, 24, 30, 0, c.color_index, 90, { pal });
    expectExact("draw_tank_palidx", surfaceToBuffer(surf), c);
  });

  it("int color WITHOUT pal falls back to VIS_RGB (resolveColor numeric, no pal) == oracle", () => {
    const c = V.draw_tank_intcolor_nopal;
    const surf = blankSurface(c.w, c.h);
    sprites.draw_tank(surf, 24, 30, 0, c.color_index, 90); // color 3, no pal -> VIS_RGB[3]
    const buf = surfaceToBuffer(surf);
    expectExact("draw_tank_intcolor_nopal", buf, c);
    // VIS_RGB[3] = (255,90,40): confirm the body resolved to that exact hue.
    const ai = (24 * c.h + 22) * 3; // a body pixel near the origin (x=24,y=22 was opaque)
    expect([buf.rgb[ai], buf.rgb[ai + 1], buf.rgb[ai + 2]]).toEqual([255, 90, 40]);
  });
});

describe("sprites_more: REAL draw_tank_icon_cell (centering + stamp) == oracle", () => {
  it("reproduces every appearance cell (grayed + tinted) via the real function", () => {
    expect(V.draw_tank_icon_cell.length).toBe(14);
    for (const c of V.draw_tank_icon_cell as (SurfCase & {
      design: number;
      grayed: boolean;
      box: [number, number, number, number];
      color: number[];
    })[]) {
      const surf = blankSurface(c.w, c.h);
      const box = new pygame.Rect(c.box[0], c.box[1], c.box[2], c.box[3]);
      sprites.draw_tank_icon_cell(surf, box, c.color as RGB, {
        design_index: c.design,
        grayed: c.grayed,
      });
      expectExact(`icon_cell[d=${c.design},gray=${c.grayed}]`, surfaceToBuffer(surf), c);
    }
  });
});

describe("sprites_more: get_tank_icons (default-color battery) == oracle", () => {
  it("reproduces each design's per-colour preview Surfaces exactly", () => {
    for (const battery of V.get_tank_icons as { idx: number; count: number; icons: SurfCase[] }[]) {
      const icons = sprites.get_tank_icons({ idx: battery.idx });
      expect(icons.length, `get_tank_icons idx=${battery.idx} count`).toBe(battery.count);
      for (let k = 0; k < icons.length; k++) {
        expectExact(`get_tank_icons[idx=${battery.idx}][${k}]`, surfaceToBuffer(icons[k]), battery.icons[k]);
      }
    }
  });
});

describe("sprites_more: font / cursor / window-icon Surfaces == oracle", () => {
  it("get_font_glyph Surface reads back == oracle (sampled codes)", () => {
    const byCode = new Map<number, SurfCase>();
    for (const g of V.font_glyphs as (SurfCase & { code: number })[]) byCode.set(g.code, g);
    for (const code of [32, 65, 83, 97, 49, 33, 46]) {
      const exp = byCode.get(code);
      expect(exp, `oracle has glyph ${code}`).toBeTruthy();
      expectExact(`get_font_glyph[${code}]`, surfaceToBuffer(sprites.get_font_glyph(code)), exp as SurfCase);
    }
  });

  it("render_text Surface reads back == oracle", () => {
    const surf = sprites.render_text(V.font_text.s);
    expectExact("render_text", surfaceToBuffer(surf), V.font_text);
  });

  it("get_cursor Surface + hotspot == oracle (scale 1 and 2)", () => {
    const c1 = sprites.get_cursor();
    expect(c1.hotspot).toEqual(V.cursor.hotspot);
    expectExact("cursor", surfaceToBuffer(c1.surf), V.cursor);
    const c2 = sprites.get_cursor([255, 255, 255], 2);
    expect(c2.hotspot).toEqual(V.cursor_scale2.hotspot);
    expectExact("cursor_scale2", surfaceToBuffer(c2.surf), V.cursor_scale2);
  });

  it("get_window_icon Surface reads back == oracle", () => {
    expectExact("window_icon", surfaceToBuffer(sprites.get_window_icon()), V.window_icon);
  });
});

describe("sprites_more: load_title_mountain (real Surface) == oracle", () => {
  it("decodes a real .MTN to a Surface that reads back == oracle (ground + sky-alpha-0)", () => {
    const c = V.title_mountain[0]; // ROCK001.MTN
    const bytes = hexToBytes(c.bytes_hex);
    const surf = sprites.load_title_mountain(c.name, bytes);
    expect(surf, `load_title_mountain ${c.name}`).not.toBeNull();
    expectExact(`load_title_mountain[${c.name}]`, surfaceToBuffer(surf as pygame.Surface), c);
  });

  it("returns null Surface for an off-whitelist name", () => {
    expect(sprites.load_title_mountain("NOTREAL.MTN", new Uint8Array([1]))).toBeNull();
  });
});

// ===========================================================================
// setMtnByteSource: the injected byte-source decode path (no bytesOverride).
// ===========================================================================

describe("sprites_more: setMtnByteSource (injected .MTN reader)", () => {
  afterAll(() => sprites.setMtnByteSource(null)); // restore the unset default

  it("decodes through the injected source (no override) == oracle", () => {
    const c = V.title_mountain[0]; // ROCK001.MTN
    const bytes = hexToBytes(c.bytes_hex);
    sprites.setMtnByteSource((name) => (name === "ROCK001.MTN" ? bytes : null));
    // No bytesOverride: loadTitleMountainPixels MUST pull bytes from the source.
    const buf = sprites.loadTitleMountainPixels("ROCK001.MTN");
    expect(buf, "decoded via injected source").not.toBeNull();
    expectExact("mtn_via_source", buf as PixelBuffer, c);
  });

  it("returns null when the source yields no bytes for a whitelisted name", () => {
    // Source above only serves ROCK001; a whitelisted ICE001 with no bytes -> null.
    expect(sprites.loadTitleMountainPixels("ICE001.MTN")).toBeNull();
  });

  it("returns null once the source is cleared (default unset state)", () => {
    sprites.setMtnByteSource(null);
    expect(sprites.loadTitleMountainPixels("ROCK001.MTN")).toBeNull();
  });
});

// ===========================================================================
// Default-option call paths + documented edge behaviors (the `~` colour-escape,
// absent glyphs, the default title) -- each a real path a caller can hit.
// ===========================================================================

describe("sprites_more: default-option call paths == oracle", () => {
  it("tankBodyPixels with NO opts uses angle 90 / scale 1 / facing 1 / barrel on", () => {
    // Find the matching oracle draw_tank case (design 0, colour 255,64,64, angle 90,
    // facing 1) and assert the all-defaults call reproduces it.
    const c = (V.draw_tank as (SurfCase & { design: number; angle: number; facing: number; color: number[] })[]).find(
      (k) => k.design === 0 && k.angle === 90 && k.facing === 1 && k.color[0] === 255 && k.color[1] === 64 && k.color[2] === 64,
    );
    expect(c, "oracle has design0/angle90/facing1/(255,64,64)").toBeTruthy();
    const cc = c as SurfCase;
    const buf = sprites.tankBodyPixels(cc.w, cc.h, 24, 30, [255, 64, 64], 0);
    expectExact("tankBodyPixels_defaults", buf, cc);
  });

  it("draw_tank_icon_cell with NO opts renders design 0, not grayed", () => {
    const c = (V.draw_tank_icon_cell as (SurfCase & { design: number; grayed: boolean; box: number[]; color: number[] })[]).find(
      (k) => k.design === 0 && k.grayed === false,
    ) as SurfCase & { box: number[]; color: number[] };
    const surf = blankSurface(c.w, c.h);
    sprites.draw_tank_icon_cell(surf, new pygame.Rect(c.box[0], c.box[1], c.box[2], c.box[3]), c.color as RGB);
    expectExact("icon_cell_defaults", surfaceToBuffer(surf), c);
  });

  it("get_tank_icons with NO opts uses idx 0 + the default colours", () => {
    const battery = (V.get_tank_icons as { idx: number; count: number; icons: SurfCase[] }[]).find((b) => b.idx === 0)!;
    const icons = sprites.get_tank_icons();
    expect(icons.length).toBe(battery.count);
    for (let k = 0; k < icons.length; k++) {
      expectExact(`get_tank_icons_default[${k}]`, surfaceToBuffer(icons[k]), battery.icons[k]);
    }
  });
});

describe("sprites_more: documented font + title edge behaviors == oracle", () => {
  it("font_text_width skips the `~` colour-escape (consumes no width)", () => {
    for (const [s, want] of V.font_text_width_cases as [string, number][]) {
      expect(sprites.font_text_width(s), `font_text_width(${JSON.stringify(s)})`).toBe(want);
    }
    // Cross-check the documented invariant: `~` adds nothing.
    expect(sprites.font_text_width("a~b")).toBe(sprites.font_text_width("ab"));
  });

  it("renderTextPixels skips `~` -- 'S~c' renders identically to 'Sc'", () => {
    const a = sprites.renderTextPixels("S~c");
    const b = sprites.renderTextPixels("Sc");
    expect([a.w, a.h]).toEqual([b.w, b.h]);
    expect(Array.from(a.rgb)).toEqual(Array.from(b.rgb));
    expect(Array.from(a.alpha)).toEqual(Array.from(b.alpha));
  });

  it("font_glyph_width / fontDecode return 0 / empty for codes without a glyph", () => {
    for (const [code, want] of V.font_glyph_width_cases as [number, number][]) {
      expect(sprites.font_glyph_width(code), `font_glyph_width(${code})`).toBe(want);
    }
    // fontDecode for an absent code yields width 0 and no rows (blank, faithful).
    const d = sprites.fontDecode(1); // code 1: absent from the glyph table
    expect(d.width).toBe(0);
    expect(d.rows).toEqual([]);
  });

  it("titleMountainName defaults to ROCK001.MTN for empty/absent names", () => {
    expect(sprites.titleMountainName()).toBe(sprites.TITLE_MTN_DEFAULT);
    expect(sprites.titleMountainName()).toBe("ROCK001.MTN");
    expect(sprites.titleMountainName("")).toBe(sprites.TITLE_MTN_DEFAULT);
    expect(sprites.titleMountainName(null)).toBe(sprites.TITLE_MTN_DEFAULT);
  });
});

describe("sprites_more: battery did real work", () => {
  it("asserted a non-trivial number of pixel cells across the Surface pipeline", () => {
    expect(cellsAsserted).toBeGreaterThan(500_000);
  });
});

// ---------------------------------------------------------------------------
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

void spriteData; // raw-table module kept imported for parity with sprites.test.ts

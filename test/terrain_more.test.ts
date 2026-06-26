/**
 * Coverage mop-up: level_under_tank's off-field early-out (the degenerate
 * footprint guard `if (x0 >= x1) return`). The normal in-field seat carve is
 * already covered by terrain.test.ts; here we drive the guard with a tank whose
 * footprint lies entirely off the left/right edge and assert it is a NO-OP,
 * matching the Python FUN_33a1_08e7 span check (read directly from terrain.py).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Terrain, type MtnFile } from "../src/terrain";
import { Rng } from "../src/rng";
import * as C from "../src/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(
  readFileSync(join(__dirname, "..", "oracle", "vectors", "terrain_more.json"), "utf-8"),
);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function dirtBlock(): Terrain {
  const t = new Terrain(360, 480);
  for (let x = 100; x < 120; x++) {
    for (let y = 200; y < 480; y++) t.write(x, y, C.COL_DIRT);
  }
  return t;
}

describe("terrain(more): level_under_tank off-field footprint is a no-op", () => {
  it("a tank centered off the left/right edge leaves the grid untouched", () => {
    const t = dirtBlock();
    const snap = Uint8Array.from(t.grid);
    t.level_under_tank(-100, 250, 7); // x1 = min(w, -92) = -92 -> x0(0) >= x1
    t.level_under_tank(t.w + 200, 250, 7); // x0 = w+193 >= x1(w)
    expect(t.grid).toEqual(snap);
  });

  it("an in-field tank DOES carve the seat (guard is selective, not a blanket no-op)", () => {
    const t = dirtBlock();
    const snap = Uint8Array.from(t.grid);
    // seat_y 250 sits below the surface (200), so the footprint has dirt to carve.
    t.level_under_tank(110, 250, 7);
    expect(t.grid).not.toEqual(snap);
  });
});

// A synthetic MTN whose columns are all identical decodes to a CONSTANT surface,
// so _from_mtn's per-slice normalize hits the flat-slice plateau branch
// (hi - lo < 1e-6) the shipped mountainous MTNs never reach. Golden bytes +
// heights from oracle/dump_more.py driving scorch.terrain.Terrain._from_mtn.
describe("terrain(more): _from_mtn flat MTN -> plateau (flat-slice branch)", () => {
  for (const c of vec.from_mtn_flat) {
    it(`${c.label} ${c.w}x${c.h} seed ${c.seed} -> flat plateau`, () => {
      const mtn: MtnFile = { name: c.label, data: hexToBytes(c.hex) };
      const heights = new Terrain(c.w, c.h)._from_mtn(mtn, new Rng(c.seed));
      expect(heights.length, "len").toBe(c.heights.length);
      for (let x = 0; x < heights.length; x++) {
        expect(heights[x], `h[${x}]`).toBe(c.heights[x]);
      }
      // the whole point: the constant surface drove the hi-lo<1e-6 plateau branch.
      expect(c.flat, "oracle recorded a flat result").toBe(true);
      expect(new Set(heights.map((v) => Math.round(v * 1e9))).size).toBe(1);
    });
  }
});

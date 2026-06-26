/**
 * Coverage mop-up: level_under_tank's off-field early-out (the degenerate
 * footprint guard `if (x0 >= x1) return`). The normal in-field seat carve is
 * already covered by terrain.test.ts; here we drive the guard with a tank whose
 * footprint lies entirely off the left/right edge and assert it is a NO-OP,
 * matching the Python FUN_33a1_08e7 span check (read directly from terrain.py).
 */
import { describe, it, expect } from "vitest";
import { Terrain } from "../src/terrain";
import * as C from "../src/constants";

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

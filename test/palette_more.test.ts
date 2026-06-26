/**
 * Coverage mop-up: LiveLUT's shape-validation guards. The Python LiveLUT relies on
 * np.ascontiguousarray((256,3), uint8); the TS port has no numpy, so it enforces
 * the same (256,3) contract explicitly and THROWS on a malformed table. These are
 * the JS-side equivalents of numpy's shape error; assert they reject bad input and
 * accept a valid 256x3 table.
 */
import { describe, it, expect } from "vitest";
import { LiveLUT, build_palette, type PaletteTable } from "../src/palette";

describe("palette(more): LiveLUT rejects malformed tables", () => {
  it("throws when the table is not 256 rows", () => {
    const short = Array.from({ length: 10 }, () => [0, 0, 0]) as PaletteTable;
    expect(() => new LiveLUT(short)).toThrow(/256/);
    expect(() => new LiveLUT([] as PaletteTable)).toThrow();
  });

  it("throws when a row is not an RGB triple", () => {
    const bad = Array.from({ length: 256 }, () => [0, 0, 0]) as number[][];
    bad[42] = [1, 2]; // length 2
    expect(() => new LiveLUT(bad as PaletteTable)).toThrow(/row 42/);
  });

  it("accepts a valid 256x3 table and indexes it; rev starts at 0", () => {
    const tbl = build_palette();
    const lut = new LiveLUT(tbl);
    expect(lut.table.length).toBe(256);
    expect(lut.rev).toBe(0);
    // get(i) returns the stored [r,g,b] row, masked to bytes.
    for (const i of [0, 1, 127, 255]) {
      expect(lut.get(i)).toEqual([
        tbl[i][0] & 0xff,
        tbl[i][1] & 0xff,
        tbl[i][2] & 0xff,
      ]);
    }
  });

  it("masks out-of-byte channel values to 0..255 on construction", () => {
    const tbl = Array.from({ length: 256 }, () => [0, 0, 0]) as PaletteTable;
    tbl[5] = [256 + 7, -1 & 0xff, 511]; // 263 & 0xff = 7 ; 511 & 0xff = 255
    const lut = new LiveLUT(tbl);
    expect(lut.get(5)).toEqual([7, 255, 255]);
  });
});

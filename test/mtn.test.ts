/**
 * Differential gate: TS mtn decoder == the Python port's port/mtn.py, byte-exact.
 *
 * Golden vectors are produced by oracle/dump_mtn.py from the Python port (itself
 * read byte-for-byte from the FP-patched DOS binary and cross-checked against the
 * 10 shipped .MTN assets) and written to oracle/vectors/mtn.json. Each record
 * carries the raw .MTN bytes (hex) PLUS every decoded output, so the TS side
 * decodes the identical bytes and the comparison reconstructs nothing.
 *
 * The 10 shipped assets give the strongest possible test: every header field,
 * every per-column count, the full surface profile, and EVERY cell of each
 * decoded (height x width) grid (2.12M cells) are checked exactly. Synthetic
 * blobs add edge branches (empty/full columns, odd/even counts, width 1, the
 * white index-0 hole pixel that to_rgb must render as palette white not sky).
 *
 * EXACTNESS: mtn has NO transcendental math and NO RNG on any decode path -- every
 * value is an integer palette index, a u16 header field, or an (r,g,b) byte. So
 * EVERY assertion here is exact equality (toBe). There is no epsilon anywhere in
 * this module; none is warranted.
 *
 * Grid check note: a per-cell expect() over 2.12M cells would dominate runtime,
 * so for each grid this test scans every cell, locates the first mismatch (index,
 * expected, actual), and asserts on that. This is still a full exact check of
 * every cell -- the loop visits all of them; it just reports via one assertion
 * per grid instead of millions. A mismatch is caught AND located.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseHeader,
  decode,
  surfaceProfile,
  toRgb,
  HEADER_LEN,
  MAGIC,
  SKY,
  TERRAIN_VGA_BASE,
} from "../src/mtn";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "mtn.json");

type HeaderJson = {
  version: number;
  width: number;
  height: number;
  xoff: number;
  ncolors: number;
  sky_index: number;
  palette: number[][];
  header_extra: number[];
  palette_offset: number;
  body_offset: number;
};

type Record = {
  name: string;
  header: HeaderJson;
  counts: number[];
  surface: number[];
  sky_indices: number[];
  ground_indices: number[];
  grid: number[];
  grid_shape: [number, number];
  rgb_samples: number[][]; // [y, x, r, g, b]
  bytes_hex: string;
};

type MtnVectors = {
  module: string;
  asset_dir: string;
  files: Record[];
  synthetic: Record[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as MtnVectors;

/** Decode a hex string to a Uint8Array (the browser fetches bytes; here we
 * rehydrate the bytes the oracle captured). */
function hexToBytes(hex: string): Uint8Array {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** Find the first index where a !== b (a is the TS-decoded array, b the golden
 * array). Returns -1 if identical. Also checks length first. */
function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -2; // length mismatch sentinel
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

describe("mtn: module constants match the Python port", () => {
  it("HEADER_LEN, SKY, TERRAIN_VGA_BASE, MAGIC", () => {
    expect(HEADER_LEN).toBe(24);
    expect(SKY).toBe(-1);
    expect(TERRAIN_VGA_BASE).toBe(0x58);
    expect(Array.from(MAGIC)).toEqual([0x4d, 0x54, 0xbe, 0xef]);
  });
});

function recordSuite(rec: Record): void {
  const bytes = hexToBytes(rec.bytes_hex);
  const exp = rec.header;

  describe(`mtn[${rec.name}]: header`, () => {
    it("scalar header fields match exactly", () => {
      const h = parseHeader(bytes, rec.name);
      expect(h.version, "version").toBe(exp.version);
      expect(h.width, "width").toBe(exp.width);
      expect(h.height, "height").toBe(exp.height);
      expect(h.xoff, "xoff").toBe(exp.xoff);
      expect(h.ncolors, "ncolors").toBe(exp.ncolors);
      expect(h.sky_index, "sky_index").toBe(exp.sky_index);
      expect(h.palette_offset, "palette_offset").toBe(exp.palette_offset);
      expect(h.body_offset, "body_offset").toBe(exp.body_offset);
    });

    it("header_extra (4 words) match exactly", () => {
      const h = parseHeader(bytes, rec.name);
      expect(h.header_extra).toEqual(exp.header_extra);
    });

    it(`palette (${exp.ncolors} RGB triples) match exactly`, () => {
      const h = parseHeader(bytes, rec.name);
      expect(h.palette.length).toBe(exp.palette.length);
      for (let i = 0; i < exp.palette.length; i++) {
        expect(h.palette[i], `palette[${i}]`).toEqual(exp.palette[i] as [number, number, number]);
      }
    });
  });

  describe(`mtn[${rec.name}]: surface_profile`, () => {
    it("counts, surface, width/height/xoff, sky/ground indices match exactly", () => {
      const sp = surfaceProfile(bytes, rec.name);
      expect(sp.width, "width").toBe(exp.width);
      expect(sp.height, "height").toBe(exp.height);
      expect(sp.xoff, "xoff").toBe(exp.xoff);

      const cDiff = firstDiff(sp.counts, rec.counts);
      expect(cDiff, `counts mismatch at index ${cDiff} (len ${sp.counts.length} vs ${rec.counts.length})`).toBe(-1);

      const sDiff = firstDiff(sp.surface, rec.surface);
      expect(sDiff, `surface mismatch at index ${sDiff} (len ${sp.surface.length} vs ${rec.surface.length})`).toBe(-1);

      expect(sp.sky_indices, "sky_indices").toEqual(rec.sky_indices);
      expect(sp.ground_indices, "ground_indices").toEqual(rec.ground_indices);
    });
  });

  describe(`mtn[${rec.name}]: decode grid (${rec.grid_shape[0]}x${rec.grid_shape[1]} = ${rec.grid.length} cells)`, () => {
    it("every grid cell matches exactly (full scan, first-diff reported)", () => {
      const g = decode(bytes, rec.name);
      expect(g.height, "grid height").toBe(rec.grid_shape[0]);
      expect(g.width, "grid width").toBe(rec.grid_shape[1]);
      const d = firstDiff(g.data, rec.grid);
      if (d >= 0) {
        const y = Math.floor(d / g.width);
        const x = d % g.width;
        expect(
          g.data[d],
          `grid cell #${d} (row ${y}, col ${x}): TS=${g.data[d]} expected=${rec.grid[d]}`,
        ).toBe(rec.grid[d]);
      } else {
        expect(d, "grid length/content").toBe(-1);
      }
    });
  });

  describe(`mtn[${rec.name}]: to_rgb (${rec.rgb_samples.length} sampled cells)`, () => {
    it("every sampled RGB cell matches exactly (sky-fill, ground, white-hole)", () => {
      const rgb = toRgb(bytes, [96, 128, 192], rec.name);
      expect(rgb.height, "rgb height").toBe(rec.grid_shape[0]);
      expect(rgb.width, "rgb width").toBe(rec.grid_shape[1]);
      for (const s of rec.rgb_samples) {
        const [y, x, r, gg, b] = s;
        const o = (y * rgb.width + x) * 3;
        expect(rgb.data[o], `rgb[${y},${x}].r`).toBe(r);
        expect(rgb.data[o + 1], `rgb[${y},${x}].g`).toBe(gg);
        expect(rgb.data[o + 2], `rgb[${y},${x}].b`).toBe(b);
      }
    });
  });
}

describe("mtn: 10 shipped .MTN assets (byte-exact decode of real game data)", () => {
  for (const rec of vec.files) recordSuite(rec);
});

describe("mtn: synthetic edge-case blobs", () => {
  for (const rec of vec.synthetic) recordSuite(rec);
});

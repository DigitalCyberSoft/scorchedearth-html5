/**
 * Differential gate: TS Terrain == the Python port's scorch/terrain.py, exact.
 *
 * Golden vectors are produced by oracle/dump_terrain.py from the Python port (the
 * fidelity oracle, itself byte-verified against the DOS binary) and written to
 * oracle/vectors/terrain.json. Each mutating-op record references a starting grid
 * in the `inputs` pool (or raw .MTN bytes in `mtn_bytes`); the TS side loads the
 * identical starting bytes, applies the op, and compares -- it reconstructs
 * nothing. RNG-driven paths (_midpoint, _from_mtn slice, generate, settle gating)
 * are reproduced with `new Rng(seed)`, the same CPython MT stream the Python used.
 *
 * EXACTNESS / EPSILON: every emitted height/index/pixel/flag is an integer,
 * boolean, or PURE-DOUBLE float and is asserted with EXACT equality (toBe).
 *   - _midpoint heights come from rng.uniform (pure MT arithmetic) and *0.58, /2.0,
 *     min/max -- no transcendental -> exact double.
 *   - _from_mtn heights come from linspace/interp (division + multiplication) and a
 *     min/max normalization -- no transcendental -> exact double.
 *   - carve_wedge is the ONLY transcendental site (Math.cos/Math.sin). But its
 *     outputs are INTEGER pixel writes (trunc(cx + cos*rr)); there is no
 *     transcendental-derived FLOAT output to compare. The resulting integer grid is
 *     asserted EXACT. CAVEAT: this relies on V8 Math.cos/sin agreeing with CPython
 *     math.cos/sin (glibc libm) at the exact angles used, which they do on this
 *     host; if a future host's libm differed by 1 ULP at a cell that truncates on
 *     an integer boundary, that cell could flip. No such divergence is observed.
 * So NO epsilon (toBeCloseTo) is used anywhere in this module; none is warranted.
 *
 * Grid check note: a per-cell expect() over millions of cells would dominate
 * runtime, so for each grid this test scans every cell, locates the first mismatch
 * (index, expected, actual), and asserts on that single located result. The loop
 * still visits every cell -- it is a full exact check, reported via one assertion.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Terrain, TerrainCfg, MtnFile } from "../src/terrain";
import { Rng } from "../src/rng";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "terrain.json");

// ---- vector types ----
type GridSpec = { w: number; h: number; grid: number[] };
type MidRec = {
  seed: number; w: number; h: number;
  random_land: boolean; flatland: boolean; land1: number; land2: number;
  heights: number[];
};
type FromMtnRec = {
  name: string; w: number; h: number; seed: number; branch: string;
  heights: number[];
};
type GenRec = {
  seed: number; w: number; h: number; path: string;
  mtn_names: string[]; mtn_percent?: number; grid: number[];
};
type ColTopRec = {
  input: string; w: number; h: number; x_lo: number; x_hi: number;
  column_top: number[];
  drop_to_footprint: { half_width: number; out: number[] }[];
};
type CarveRec = { op: string; input: string; cx: number; cy: number; r: number; grid: number[] };
type WedgeRec = {
  input: string; cx: number; cy: number; r: number;
  half_angle: number; aim: number; grid: number[];
};
type LevelRec = { input: string; cx: number; seat_y: number; half_width: number; grid: number[] };
type BandRec = { input: string; lo: number; hi: number; fill: number; grid: number[] };
type SettleRec = {
  kind: string; input: string; suspend_dirt?: number; seed?: number;
  x_lo?: number; x_hi?: number; grid: number[];
};
type SupportRec = {
  input: string; w: number; h: number;
  rows: { half_width: number; support_count: number[]; is_supported: boolean[] }[];
};

type Vectors = {
  inputs: { [label: string]: GridSpec };
  mtn_bytes: { [name: string]: string };
  midpoint: MidRec[];
  from_mtn: FromMtnRec[];
  generate: GenRec[];
  coltop: ColTopRec[];
  carve: CarveRec[];
  wedge: WedgeRec[];
  level: LevelRec[];
  band: BandRec[];
  settle: SettleRec[];
  support: SupportRec[];
  pixels: {
    read: { input: string; coords: [number, number][]; read: number[]; is_dirt: boolean[]; is_solid: boolean[] };
    writes: { x: number; y: number; c: number; back: number }[];
    write_seed: number; write_w: number; write_h: number;
  };
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as Vectors;

// ---- helpers ----
/** Build a Terrain whose grid is the supplied column-major flat array. */
function terrainFrom(spec: GridSpec): Terrain {
  const t = new Terrain(spec.w, spec.h);
  t.grid.set(spec.grid);
  return t;
}

/** Decode a hex string to a Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

const MTN_FILES: { [name: string]: Uint8Array } = {};
for (const [name, hex] of Object.entries(vec.mtn_bytes)) MTN_FILES[name] = hexToBytes(hex);
function mtnFile(name: string): MtnFile {
  return { name, data: MTN_FILES[name] };
}

/** A minimal TerrainCfg from explicit fields. is_on mirrors Config.is_on. */
function makeCfg(over: Partial<{
  MTN_PERCENT: number; LAND1: number; LAND2: number; SUSPEND_DIRT: number;
  RANDOM_LAND: string; FLATLAND: string;
}>): TerrainCfg {
  const fields: { [k: string]: string | number } = {
    MTN_PERCENT: over.MTN_PERCENT ?? 20.0,
    LAND1: over.LAND1 ?? 20,
    LAND2: over.LAND2 ?? 20,
    SUSPEND_DIRT: over.SUSPEND_DIRT ?? 0,
    RANDOM_LAND: over.RANDOM_LAND ?? "ON",
    FLATLAND: over.FLATLAND ?? "ON",
  };
  return {
    MTN_PERCENT: fields.MTN_PERCENT as number,
    LAND1: fields.LAND1 as number,
    LAND2: fields.LAND2 as number,
    SUSPEND_DIRT: fields.SUSPEND_DIRT as number,
    is_on(key: string): boolean {
      return String(fields[key]).toUpperCase() === "ON";
    },
  };
}

/** Full exact grid compare: scan every cell, assert on the first mismatch. */
function expectGridEqual(actual: Uint8Array, expected: number[], ctx: string): void {
  expect(actual.length, `${ctx}: length`).toBe(expected.length);
  let firstBad = -1;
  let aVal = 0;
  let eVal = 0;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      firstBad = i;
      aVal = actual[i];
      eVal = expected[i];
      break;
    }
  }
  expect(firstBad, `${ctx}: first mismatch at flat idx ${firstBad} (got ${aVal}, want ${eVal})`).toBe(-1);
}

// ---------------------------------------------------------------------------
describe("terrain: _midpoint (procedural heightfield, pure double)", () => {
  for (let i = 0; i < vec.midpoint.length; i++) {
    const rec = vec.midpoint[i];
    it(`#${i} seed ${rec.seed} ${rec.w}x${rec.h} RL=${rec.random_land} FL=${rec.flatland} L1=${rec.land1} L2=${rec.land2}`, () => {
      const cfg = makeCfg({
        RANDOM_LAND: rec.random_land ? "ON" : "OFF",
        FLATLAND: rec.flatland ? "ON" : "OFF",
        LAND1: rec.land1,
        LAND2: rec.land2,
      });
      const t = new Terrain(rec.w, rec.h);
      const r = new Rng(rec.seed);
      const heights = t._midpoint(cfg, r);
      expect(heights.length, "len").toBe(rec.heights.length);
      for (let x = 0; x < heights.length; x++) {
        expect(heights[x], `h[${x}]`).toBe(rec.heights[x]);
      }
    });
  }
});

describe("terrain: _from_mtn (scanned-mountain heights, slice + interp branches)", () => {
  for (let i = 0; i < vec.from_mtn.length; i++) {
    const rec = vec.from_mtn[i];
    it(`#${i} ${rec.name} ${rec.w}x${rec.h} seed ${rec.seed} [${rec.branch}]`, () => {
      const t = new Terrain(rec.w, rec.h);
      const r = new Rng(rec.seed);
      const heights = t._from_mtn(mtnFile(rec.name), r);
      expect(heights.length, "len").toBe(rec.heights.length);
      for (let x = 0; x < heights.length; x++) {
        expect(heights[x], `h[${x}]`).toBe(rec.heights[x]);
      }
    });
  }
});

describe("terrain: generate (procedural + MTN paths, full grid)", () => {
  for (let i = 0; i < vec.generate.length; i++) {
    const rec = vec.generate[i];
    it(`#${i} seed ${rec.seed} ${rec.w}x${rec.h} [${rec.path}]`, () => {
      const cfg = makeCfg(
        rec.path === "mtn"
          ? { RANDOM_LAND: "ON", MTN_PERCENT: rec.mtn_percent ?? 100.0 }
          : { RANDOM_LAND: "ON" },
      );
      const t = new Terrain(rec.w, rec.h);
      const r = new Rng(rec.seed);
      const files = rec.mtn_names.length > 0 ? rec.mtn_names.map(mtnFile) : null;
      t.generate(cfg, r, files);
      expectGridEqual(t.grid, rec.grid, `generate #${i}`);
    });
  }
});

describe("terrain: column_top + drop_to_footprint (all x incl OOB)", () => {
  for (let i = 0; i < vec.coltop.length; i++) {
    const rec = vec.coltop[i];
    it(`#${i} ${rec.input}: column_top over [${rec.x_lo}, ${rec.x_hi})`, () => {
      const t = terrainFrom(vec.inputs[rec.input]);
      let k = 0;
      for (let x = rec.x_lo; x < rec.x_hi; x++) {
        expect(t.column_top(x), `column_top(${x})`).toBe(rec.column_top[k]);
        k++;
      }
    });
    for (const foot of rec.drop_to_footprint) {
      it(`#${i} ${rec.input}: drop_to_footprint hw=${foot.half_width}`, () => {
        const t = terrainFrom(vec.inputs[rec.input]);
        for (let cx = 0; cx < rec.w; cx++) {
          expect(t.drop_to_footprint(cx, foot.half_width), `drop(${cx},${foot.half_width})`).toBe(foot.out[cx]);
        }
      });
    }
  }
});

describe("terrain: carve_circle / deposit_circle (full grid)", () => {
  for (let i = 0; i < vec.carve.length; i++) {
    const rec = vec.carve[i];
    it(`#${i} ${rec.op}(${rec.cx},${rec.cy},${rec.r}) on ${rec.input}`, () => {
      const t = terrainFrom(vec.inputs[rec.input]);
      if (rec.op === "carve") t.carve_circle(rec.cx, rec.cy, rec.r);
      else t.deposit_circle(rec.cx, rec.cy, rec.r);
      expectGridEqual(t.grid, rec.grid, `carve #${i} ${rec.op}`);
    });
  }
});

describe("terrain: carve_wedge (transcendental -> integer pixels, full grid)", () => {
  // cos/sin feed trunc(cx + cos*rr) -> integer writes; asserted EXACT (see header
  // note on the V8/glibc libm agreement this relies on).
  for (let i = 0; i < vec.wedge.length; i++) {
    const rec = vec.wedge[i];
    it(`#${i} wedge(${rec.cx},${rec.cy},${rec.r},H=${rec.half_angle},aim=${rec.aim})`, () => {
      const t = terrainFrom(vec.inputs[rec.input]);
      t.carve_wedge(rec.cx, rec.cy, rec.r, rec.half_angle, rec.aim);
      expectGridEqual(t.grid, rec.grid, `wedge #${i}`);
    });
  }
});

describe("terrain: level_under_tank (full grid)", () => {
  for (let i = 0; i < vec.level.length; i++) {
    const rec = vec.level[i];
    it(`#${i} level(${rec.cx},seat=${rec.seat_y},hw=${rec.half_width})`, () => {
      const t = terrainFrom(vec.inputs[rec.input]);
      t.level_under_tank(rec.cx, rec.seat_y, rec.half_width);
      expectGridEqual(t.grid, rec.grid, `level #${i}`);
    });
  }
});

describe("terrain: clear_index_band (full grid)", () => {
  for (let i = 0; i < vec.band.length; i++) {
    const rec = vec.band[i];
    it(`#${i} clear_index_band(${rec.lo},${rec.hi},fill=${rec.fill})`, () => {
      const t = terrainFrom(vec.inputs[rec.input]);
      t.clear_index_band(rec.lo, rec.hi, rec.fill === -1 ? null : rec.fill);
      expectGridEqual(t.grid, rec.grid, `band #${i}`);
    });
  }
});

describe("terrain: settle / _settle_column (full grid)", () => {
  for (let i = 0; i < vec.settle.length; i++) {
    const rec = vec.settle[i];
    it(`#${i} ${rec.kind} ${rec.kind === "settle" ? `sd=${rec.suspend_dirt} seed=${rec.seed} [${rec.x_lo},${rec.x_hi}]` : ""}`, () => {
      const t = terrainFrom(vec.inputs[rec.input]);
      if (rec.kind === "settle_column_all") {
        for (let x = 0; x < t.w; x++) t._settle_column(x);
      } else {
        const cfg = makeCfg({ SUSPEND_DIRT: rec.suspend_dirt ?? 0 });
        const r = new Rng(rec.seed ?? 0);
        t.settle(cfg, r, rec.x_lo ?? 0, (rec.x_hi ?? -1) === -1 ? null : (rec.x_hi ?? null));
      }
      expectGridEqual(t.grid, rec.grid, `settle #${i}`);
    });
  }
});

describe("terrain: support_count / is_supported", () => {
  for (let i = 0; i < vec.support.length; i++) {
    const rec = vec.support[i];
    for (const row of rec.rows) {
      it(`#${i} ${rec.input} hw=${row.half_width}`, () => {
        const t = terrainFrom(vec.inputs[rec.input]);
        let k = 0;
        for (let cx = 0; cx < rec.w; cx += 3) {
          for (let by = 0; by < rec.h; by += 7) {
            expect(t.support_count(cx, by, row.half_width), `support_count(${cx},${by})`).toBe(row.support_count[k]);
            expect(t.is_supported(cx, by, row.half_width), `is_supported(${cx},${by})`).toBe(row.is_supported[k]);
            k++;
          }
        }
      });
    }
  }
});

describe("terrain: read / is_dirt / is_solid + write", () => {
  it("read / is_dirt / is_solid over coords (incl OOB)", () => {
    const rec = vec.pixels.read;
    const t = terrainFrom(vec.inputs[rec.input]);
    for (let k = 0; k < rec.coords.length; k++) {
      const [x, y] = rec.coords[k];
      expect(t.read(x, y), `read(${x},${y})`).toBe(rec.read[k]);
      expect(t.is_dirt(x, y), `is_dirt(${x},${y})`).toBe(rec.is_dirt[k]);
      expect(t.is_solid(x, y), `is_solid(${x},${y})`).toBe(rec.is_solid[k]);
    }
  });
  it("write then read-back (in-bounds writes + OOB no-ops)", () => {
    const p = vec.pixels;
    const t = new Terrain(p.write_w, p.write_h);
    const r = new Rng(p.write_seed);
    for (let i = 0; i < p.writes.length; i++) {
      const x = r.pick(48) - 4;
      const y = r.pick(38) - 4;
      const c = r.pick(256);
      // sanity: the TS RNG must reproduce the same draw sequence the Python used.
      expect([x, y, c], `draw #${i}`).toEqual([p.writes[i].x, p.writes[i].y, p.writes[i].c]);
      t.write(x, y, c);
      expect(t.read(x, y), `back #${i}`).toBe(p.writes[i].back);
    }
  });
});

/**
 * Differential gate: TS palette == Python scorch/palette.py (the byte-verified
 * oracle), exactly.
 *
 * Golden vectors are produced by oracle/dump_palette.py from the Python port and
 * written to oracle/vectors/palette.json. Every value asserted here is an integer
 * RGB channel (0..255), a palette index, a rev counter, or an integer constant, so
 * ALL assertions are exact equality (expect(x).toBe(y)).
 *
 * EPSILON NOTE: the spec allows a tight epsilon (toBeCloseTo, 12 digits) for
 * transcendental-derived floats. None is used here, deliberately. The only
 * transcendental in this module is build_palette()'s explosion band (Math.pow),
 * but its result is truncated to an integer byte before it leaves the function, so
 * the dumped value is an exact integer and is asserted with toBe. LiveLUT.
 * reramp_band runs numpy FLOAT32 ramp math, but it too clips+truncates to integer
 * uint8 bytes; the TS reproduces numpy's float32 arithmetic bit-for-bit (compute
 * the linspace in JS doubles == float64, then Math.fround == cast-to-float32 at
 * each op, matching numpy 2.5.0's linspace(...,float32) == linspace(...,float64).
 * astype(float32)), so those bytes are also exact. If float32 reproduction were
 * off by an ULP it would land on a different truncated byte and toBe would catch
 * it -- which is the point. (Reproduction verified: 0 mismatches over 18,960
 * channel values across n=1..79 and 6 endpoint sets, in the oracle build notes.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  build_palette,
  tank_color_index,
  digger_glow_ramp6,
  digger_glow_rgb,
  firewall_apply,
  LiveLUT,
  TANK_COLOR_BASE,
  TEAM_RGB,
  SKY_RAMP_LEN,
  SKY_RAMP_TOP6,
  SKY_RAMP_BOTTOM6,
  SKY_RAMP_TOP,
  SKY_RAMP_BOTTOM,
  SKY_BAND_LO,
  SKY_BAND_HI,
  EXPLO_BAND_LO,
  EXPLO_BAND_HI,
  LIGHTNING_BAND_LO,
  LIGHTNING_BAND_HI,
  THUNDER_BAND_LO,
  THUNDER_BAND_HI,
  DIGGER_BAND_LO,
  DIGGER_BAND_HI,
  RANKINGS_BAND_LO,
  RANKINGS_BAND_HI,
  DIALOG_BAND_LO,
  DIALOG_BAND_HI,
  FIREWALL_BAND_LO,
  FIREWALL_BAND_HI,
  FIREWALL_FLAME_LO,
  FIREWALL_FLAME_HI,
  FIREWALL_EMBER_LO,
  FIREWALL_EMBER_HI,
  FIREWALL_PULSE_IDX,
} from "../src/palette";

type RGB = [number, number, number];

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "palette.json");

type Vectors = {
  base_palette: number[][];
  statics: Record<string, number | number[] | number[][]>;
  tank_color_index: [number, number][];
  digger: { dirt: number[] | null; ramp6: number[][]; rgb8: number[][] }[];
  firewall: { counter: number; table: number[][]; rev: number }[];
  rotate: { lo: number; hi: number; step: number; table: number[][]; rev: number }[];
  rotate_chain: { lo: number; hi: number; step: number; table: number[][]; rev: number }[];
  reramp: {
    lo: number;
    hi: number;
    rgb_lo: number[];
    rgb_hi: number[];
    table: number[][];
    rev: number;
  }[];
  reramp_lengths: { lo: number; hi: number; n: number; rows: number[][]; rev: number }[];
  setband: { lo: number; hi: number; rows: number[][]; table: number[][]; rev: number }[];
  setindex: { idx: number; rgb: number[]; row: number[]; rev: number }[];
  init_default: {
    rev: number;
    table: number[][];
    copy: number[][];
    get_samples: [number, number[]][];
  };
  seq: { op: string; args: unknown; table: number[][]; rev: number }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as Vectors;

/** Assert a whole 256x3 table equals the golden rows, channel by channel. */
function expectTable(actual: RGB[], expected: number[][], ctx: string): void {
  expect(actual.length, `${ctx}: table length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    for (let ch = 0; ch < 3; ch++) {
      expect(actual[i][ch], `${ctx}: idx ${i} ch ${ch}`).toBe(expected[i][ch]);
    }
  }
}

describe("palette: build_palette() full 256-entry RGB table (exact)", () => {
  const pal = build_palette();
  it("has 256 rows of 3 channels", () => {
    expect(pal.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(pal[i].length, `row ${i}`).toBe(3);
  });
  it("every channel of every index matches the oracle", () => {
    for (let i = 0; i < 256; i++) {
      for (let ch = 0; ch < 3; ch++) {
        expect(pal[i][ch], `idx ${i} (0x${i.toString(16)}) ch ${ch}`).toBe(
          vec.base_palette[i][ch],
        );
      }
    }
  });
});

describe("palette: static-table exports (exact)", () => {
  const s = vec.statics;
  it("scalar band/index constants", () => {
    expect(TANK_COLOR_BASE).toBe(s.TANK_COLOR_BASE);
    expect(SKY_RAMP_LEN).toBe(s.SKY_RAMP_LEN);
    expect(SKY_BAND_LO).toBe(s.SKY_BAND_LO);
    expect(SKY_BAND_HI).toBe(s.SKY_BAND_HI);
    expect(EXPLO_BAND_LO).toBe(s.EXPLO_BAND_LO);
    expect(EXPLO_BAND_HI).toBe(s.EXPLO_BAND_HI);
    expect(LIGHTNING_BAND_LO).toBe(s.LIGHTNING_BAND_LO);
    expect(LIGHTNING_BAND_HI).toBe(s.LIGHTNING_BAND_HI);
    expect(THUNDER_BAND_LO).toBe(s.THUNDER_BAND_LO);
    expect(THUNDER_BAND_HI).toBe(s.THUNDER_BAND_HI);
    expect(DIGGER_BAND_LO).toBe(s.DIGGER_BAND_LO);
    expect(DIGGER_BAND_HI).toBe(s.DIGGER_BAND_HI);
    expect(RANKINGS_BAND_LO).toBe(s.RANKINGS_BAND_LO);
    expect(RANKINGS_BAND_HI).toBe(s.RANKINGS_BAND_HI);
    expect(DIALOG_BAND_LO).toBe(s.DIALOG_BAND_LO);
    expect(DIALOG_BAND_HI).toBe(s.DIALOG_BAND_HI);
    expect(FIREWALL_BAND_LO).toBe(s.FIREWALL_BAND_LO);
    expect(FIREWALL_BAND_HI).toBe(s.FIREWALL_BAND_HI);
    expect(FIREWALL_FLAME_LO).toBe(s.FIREWALL_FLAME_LO);
    expect(FIREWALL_FLAME_HI).toBe(s.FIREWALL_FLAME_HI);
    expect(FIREWALL_EMBER_LO).toBe(s.FIREWALL_EMBER_LO);
    expect(FIREWALL_EMBER_HI).toBe(s.FIREWALL_EMBER_HI);
    expect(FIREWALL_PULSE_IDX).toBe(s.FIREWALL_PULSE_IDX);
  });
  it("TEAM_RGB (10 8-bit hues)", () => {
    const exp = s.TEAM_RGB as number[][];
    expect(TEAM_RGB.length).toBe(exp.length);
    for (let i = 0; i < exp.length; i++) {
      for (let ch = 0; ch < 3; ch++) {
        expect(TEAM_RGB[i][ch], `TEAM_RGB[${i}][${ch}]`).toBe(exp[i][ch]);
      }
    }
  });
  it("sky ramp endpoints (6-bit and 8-bit)", () => {
    const t6 = s.SKY_RAMP_TOP6 as number[];
    const b6 = s.SKY_RAMP_BOTTOM6 as number[];
    const t8 = s.SKY_RAMP_TOP as number[];
    const b8 = s.SKY_RAMP_BOTTOM as number[];
    for (let ch = 0; ch < 3; ch++) {
      expect(SKY_RAMP_TOP6[ch], `TOP6[${ch}]`).toBe(t6[ch]);
      expect(SKY_RAMP_BOTTOM6[ch], `BOTTOM6[${ch}]`).toBe(b6[ch]);
      expect(SKY_RAMP_TOP[ch], `TOP[${ch}]`).toBe(t8[ch]);
      expect(SKY_RAMP_BOTTOM[ch], `BOTTOM[${ch}]`).toBe(b8[ch]);
    }
  });
});

describe("palette: tank_color_index over full player range incl. negatives", () => {
  it(`${vec.tank_color_index.length} inputs match (engine 0x6e + player mod 10)`, () => {
    for (const [p, expected] of vec.tank_color_index) {
      expect(tank_color_index(p), `tank_color_index(${p})`).toBe(expected);
    }
  });
});

describe("palette: digger glow ramps (6-bit + 8-bit) over every dirt option", () => {
  for (let c = 0; c < vec.digger.length; c++) {
    const { dirt, ramp6, rgb8 } = vec.digger[c];
    it(`dirt=${JSON.stringify(dirt)}: ramp6 + rgb8 match`, () => {
      const arg = dirt === null ? undefined : (dirt as RGB);
      const r6 = digger_glow_ramp6(arg);
      const r8 = digger_glow_rgb(arg);
      expect(r6.length, "ramp6 length").toBe(ramp6.length);
      expect(r8.length, "rgb8 length").toBe(rgb8.length);
      for (let i = 0; i < ramp6.length; i++) {
        for (let ch = 0; ch < 3; ch++) {
          expect(r6[i][ch], `ramp6[${i}][${ch}]`).toBe(ramp6[i][ch]);
          expect(r8[i][ch], `rgb8[${i}][${ch}]`).toBe(rgb8[i][ch]);
        }
      }
    });
  }
});

describe("palette: firewall_apply over counter sweep (full table + rev)", () => {
  for (const { counter, table, rev } of vec.firewall) {
    it(`counter=${counter}: 256x3 table + rev match`, () => {
      const lut = new LiveLUT(build_palette());
      firewall_apply(lut, counter);
      expect(lut.rev, `counter ${counter} rev`).toBe(rev);
      expectTable(lut.table, table, `firewall counter=${counter}`);
    });
  }
});

describe("palette: LiveLUT.rotate_band (np.roll, step%n==0 no-op, full table + rev)", () => {
  for (const { lo, hi, step, table, rev } of vec.rotate) {
    it(`rotate(0x${lo.toString(16)},0x${hi.toString(16)},${step}): table + rev match`, () => {
      const lut = new LiveLUT(build_palette());
      lut.rotate_band(lo, hi, step);
      expect(lut.rev, `rotate(${lo},${hi},${step}) rev`).toBe(rev);
      expectTable(lut.table, table, `rotate(${lo},${hi},${step})`);
    });
  }
});

describe("palette: LiveLUT.rotate_band chained (rev accumulation)", () => {
  it("seven chained rotations match step-by-step", () => {
    const lut = new LiveLUT(build_palette());
    for (let i = 0; i < vec.rotate_chain.length; i++) {
      const { lo, hi, step, table, rev } = vec.rotate_chain[i];
      lut.rotate_band(lo, hi, step);
      expect(lut.rev, `chain[${i}] rotate(${lo},${hi},${step}) rev`).toBe(rev);
      expectTable(lut.table, table, `chain[${i}] rotate(${lo},${hi},${step})`);
    }
  });
});

describe("palette: LiveLUT.reramp_band (float32 ramp -> exact uint8 bytes)", () => {
  for (const { lo, hi, rgb_lo, rgb_hi, table, rev } of vec.reramp) {
    it(`reramp(0x${lo.toString(16)},0x${hi.toString(16)},${JSON.stringify(
      rgb_lo,
    )}->${JSON.stringify(rgb_hi)}): table + rev match`, () => {
      const lut = new LiveLUT(build_palette());
      lut.reramp_band(lo, hi, rgb_lo as RGB, rgb_hi as RGB);
      expect(lut.rev, `reramp(${lo},${hi}) rev`).toBe(rev);
      expectTable(lut.table, table, `reramp(${lo},${hi})`);
    });
  }
});

describe("palette: LiveLUT.reramp_band length sweep n=1..40 (float32 linspace)", () => {
  for (const { lo, hi, n, rows, rev } of vec.reramp_lengths) {
    it(`n=${n}: ${n} ramp rows + rev match (float32 bit-exact)`, () => {
      const lut = new LiveLUT(build_palette());
      lut.reramp_band(lo, hi, [255, 8, 1], [1, 8, 255]);
      expect(lut.rev, `reramp n=${n} rev`).toBe(rev);
      for (let k = 0; k < n; k++) {
        for (let ch = 0; ch < 3; ch++) {
          expect(lut.table[lo + k][ch], `n=${n} row ${k} ch ${ch}`).toBe(rows[k][ch]);
        }
      }
    });
  }
});

describe("palette: LiveLUT.set_band (overlong rows truncate, full table + rev)", () => {
  for (const { lo, hi, rows, table, rev } of vec.setband) {
    it(`set_band(0x${lo.toString(16)},0x${hi.toString(16)}): table + rev match`, () => {
      const lut = new LiveLUT(build_palette());
      lut.set_band(
        lo,
        hi,
        rows.map((r) => [r[0], r[1], r[2]] as RGB),
      );
      expect(lut.rev, `set_band(${lo},${hi}) rev`).toBe(rev);
      expectTable(lut.table, table, `set_band(${lo},${hi})`);
    });
  }
});

describe("palette: LiveLUT.set_index (single entry + rev)", () => {
  for (const { idx, rgb, row, rev } of vec.setindex) {
    it(`set_index(0x${idx.toString(16)},${JSON.stringify(rgb)}): row + rev match`, () => {
      const lut = new LiveLUT(build_palette());
      lut.set_index(idx, rgb as RGB);
      expect(lut.rev, `set_index(${idx}) rev`).toBe(rev);
      for (let ch = 0; ch < 3; ch++) {
        expect(lut.table[idx][ch], `set_index(${idx}) ch ${ch}`).toBe(row[ch]);
      }
    });
  }
});

describe("palette: LiveLUT default init + copy_table + get", () => {
  it("default constructor reproduces build_palette() with rev 0", () => {
    const lut = new LiveLUT();
    expect(lut.rev).toBe(vec.init_default.rev);
    expectTable(lut.table, vec.init_default.table, "init_default.table");
  });
  it("copy_table returns a detached equal table", () => {
    const lut = new LiveLUT();
    const copy = lut.copy_table();
    expectTable(copy, vec.init_default.copy, "init_default.copy");
    // Detached: mutating the copy must not move the live table.
    copy[0][0] = (copy[0][0] + 1) & 0xff;
    expect(lut.table[0][0]).toBe(vec.init_default.table[0][0]);
  });
  it("get(idx) samples match", () => {
    const lut = new LiveLUT();
    for (const [i, rgb] of vec.init_default.get_samples) {
      const got = lut.get(i);
      for (let ch = 0; ch < 3; ch++) {
        expect(got[ch], `get(${i}) ch ${ch}`).toBe(rgb[ch]);
      }
    }
  });
});

describe("palette: LiveLUT mixed mutation sequence (integration, step-by-step)", () => {
  it("nine-step interface sequence matches the oracle after every step", () => {
    const lut = new LiveLUT();
    for (let i = 0; i < vec.seq.length; i++) {
      const step = vec.seq[i];
      const args = step.args as unknown[];
      switch (step.op) {
        case "rotate":
          lut.rotate_band(args[0] as number, args[1] as number, args[2] as number);
          break;
        case "firewall":
          firewall_apply(lut, args[0] as number);
          break;
        case "set_index":
          lut.set_index(args[0] as number, args[1] as RGB);
          break;
        case "reramp":
          lut.reramp_band(args[0] as number, args[1] as number, args[2] as RGB, args[3] as RGB);
          break;
        case "set_band": {
          const rows = (args[2] as number[][]).map((r) => [r[0], r[1], r[2]] as RGB);
          lut.set_band(args[0] as number, args[1] as number, rows);
          break;
        }
        default:
          throw new Error(`unknown seq op ${step.op}`);
      }
      expect(lut.rev, `seq[${i}] op=${step.op} rev`).toBe(step.rev);
      expectTable(lut.table, step.table, `seq[${i}] op=${step.op}`);
    }
  });
});

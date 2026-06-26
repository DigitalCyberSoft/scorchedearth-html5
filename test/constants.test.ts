/**
 * Differential gate: src/constants.ts == scorch-py/scorch/constants.py, exact.
 *
 * Golden vectors are produced by oracle/dump_constants.py from the Python port
 * (the fidelity oracle) and written to oracle/vectors/constants.json. Every value
 * in this module is an integer, an exactly-representable float, or a boolean --
 * there is NO transcendental math (no sin/cos/pow/sqrt/atan2) -- so EVERY
 * assertion here is exact equality (.toBe). The one computed float,
 * PHYSICS_DT = DT / PHYSICS_SUBSTEPS = (1/60)/32, equals 1/1920 bit-for-bit in
 * IEEE754 (the oracle verifies PHYSICS_DT === 1/1920), so it is asserted exactly
 * too. The toBeCloseTo epsilon path the brief allows for transcendental-derived
 * floats is therefore UNUSED in this module by design.
 *
 * It also asserts the no-op sfx surface in src/sound.ts exposes exactly the
 * public methods/attrs of the Python sfx singleton (so logic modules can import
 * sfx without audio).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as C from "../src/constants";
import { sfx } from "../src/sound";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "constants.json");

type ConstantsVectors = {
  module: string;
  scalars: { [name: string]: number | null };
  wall_coef: { [k: string]: number };
  ai_names: { [k: string]: string };
  is_dirt: boolean[];
  is_solid: boolean[];
  sfx_methods: string[];
  sfx_attrs: { [k: string]: unknown };
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as ConstantsVectors;

// The TS namespace, indexable by the exported name for the by-name comparison.
const NS = C as unknown as Record<string, unknown>;

describe("constants: scalar exports match the Python port exactly", () => {
  const names = Object.keys(vec.scalars);

  it("the vector battery is non-trivial (>=80 scalars)", () => {
    // Guards against an empty/partial dump silently passing.
    expect(names.length).toBeGreaterThanOrEqual(80);
  });

  for (const name of names) {
    it(`${name} === ${JSON.stringify(vec.scalars[name])}`, () => {
      const expected = vec.scalars[name];
      // Every value (incl. null for SHIELD_FAILURE_CHANCE) is exact.
      expect(NS[name]).toBe(expected as unknown);
    });
  }
});

describe("constants: WALL_COEF dict matches exactly", () => {
  const keys = Object.keys(vec.wall_coef);

  it("WALL_COEF has the expected key count", () => {
    expect(Object.keys(C.WALL_COEF).length).toBe(keys.length);
  });

  for (const k of keys) {
    it(`WALL_COEF[${k}] === ${vec.wall_coef[k]}`, () => {
      expect(C.WALL_COEF[k]).toBe(vec.wall_coef[k]);
    });
  }
});

describe("constants: AI_NAMES dict matches exactly", () => {
  const keys = Object.keys(vec.ai_names); // JSON string keys "1".."8"

  it("AI_NAMES has the expected key count", () => {
    expect(Object.keys(C.AI_NAMES).length).toBe(keys.length);
  });

  for (const k of keys) {
    const idx = Number(k); // TS dict is keyed by number
    it(`AI_NAMES[${k}] === "${vec.ai_names[k]}"`, () => {
      expect(C.AI_NAMES[idx]).toBe(vec.ai_names[k]);
    });
  }
});

describe("constants: is_dirt(idx) matches over idx 0..255", () => {
  it("covers the full 256-entry palette index range", () => {
    expect(vec.is_dirt.length).toBe(256);
  });

  for (let i = 0; i < vec.is_dirt.length; i++) {
    it(`is_dirt(${i}) === ${vec.is_dirt[i]}`, () => {
      expect(C.is_dirt(i)).toBe(vec.is_dirt[i]);
    });
  }
});

describe("constants: is_solid(idx) matches over idx 0..255", () => {
  it("covers the full 256-entry palette index range", () => {
    expect(vec.is_solid.length).toBe(256);
  });

  for (let i = 0; i < vec.is_solid.length; i++) {
    it(`is_solid(${i}) === ${vec.is_solid[i]}`, () => {
      expect(C.is_solid(i)).toBe(vec.is_solid[i]);
    });
  }
});

describe("sound: sfx no-op surface matches the Python sfx singleton", () => {
  for (const name of vec.sfx_methods) {
    it(`sfx.${name} is a function`, () => {
      expect(typeof (sfx as unknown as Record<string, unknown>)[name]).toBe("function");
    });
  }

  for (const [name, value] of Object.entries(vec.sfx_attrs)) {
    it(`sfx.${name} default === ${JSON.stringify(value)}`, () => {
      expect((sfx as unknown as Record<string, unknown>)[name]).toBe(value as unknown);
    });
  }

  it("sfx methods are no-ops returning undefined (must not affect numeric state)", () => {
    expect(sfx.init()).toBe(false); // init reports 'no audio' in Phase 1
    expect(sfx.beep(440, 50)).toBeUndefined();
    expect(sfx.play("ui_beep")).toBeUndefined();
    expect(sfx.set_launch_y(100)).toBeUndefined();
    expect(sfx.start_fly("VEL")).toBeUndefined();
    expect(sfx.fly_tone("VEL", {})).toBeUndefined();
    expect(sfx.stop_fly()).toBeUndefined();
  });
});

/**
 * Differential gate: TS config == Python scorch/config.py, exactly.
 *
 * Golden vectors are produced by oracle/dump_config.py from the Python port and written
 * to oracle/vectors/config.json. config has NO transcendental math: every output is an
 * integer, an exactly-representable float, a boolean, or a string, so EVERY assertion
 * here is exact (toBe / toEqual). No epsilon is used anywhere in this file -- there is
 * no sin/cos/pow/sqrt/atan2 in the module, and viscosity_mult = 1 - V/10000 is exact in
 * IEEE754 for the integer V battery (verified: Python and JS produce identical doubles,
 * e.g. V=12345 -> -0.23449999999999993 on both). Float string-rendering (save) and
 * float parsing (_coerce/load) are matched as exact strings/doubles.
 *
 * inf/-inf/nan are not representable in JSON; the oracle encodes them as the tagged
 * strings "Infinity"/"-Infinity"/"NaN", decoded back to the same JS numbers by decNum().
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  Config,
  SCORING,
  TEAM_MODE,
  PLAY_MODE,
  PLAY_ORDER,
  ELASTIC,
  EXPLOSION_SCALE,
  CONFIG_FIELDS,
  _coerce,
} from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "config.json");

type JsonNum = number | "Infinity" | "-Infinity" | "NaN";

type ConfigVectors = {
  defaults: { [k: string]: JsonNum | string };
  field_order: string[];
  field_types: { [k: string]: string };
  post_init: { wind: number; live_elastic: number };
  enum_maps: { [name: string]: { [k: string]: number } };
  prop_cases: { field: string; prop: string; token: string; value: number }[];
  is_on_cases: { field: string; value: JsonNum | string; out: boolean }[];
  res_cases: { GRAPHICS_MODE: string; out: [number, number] }[];
  visc_cases: { AIR_VISCOSITY: number; out: JsonNum }[];
  coerce_cases: { type: "int" | "float" | "str"; in: string; out: JsonNum | string }[];
  load_cases: {
    label: string;
    text: string;
    parsed: { [k: string]: JsonNum | string };
    post_init: { wind: number; live_elastic: number };
    derived: {
      scoring: number;
      team_mode: number;
      play_mode: number;
      play_order: number;
      elastic: number;
      explosion_scale: number;
      resolution: [number, number];
      viscosity_mult: JsonNum;
    };
  }[];
  save_cases: { label: string; body: string }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as ConfigVectors;

/** Decode the oracle's JSON-safe numeric encoding back to a JS number. */
function decNum(x: JsonNum): number {
  if (x === "Infinity") return Infinity;
  if (x === "-Infinity") return -Infinity;
  if (x === "NaN") return NaN;
  return x;
}

/** Assert a JS number equals an oracle-encoded expected number, NaN-aware, exact. */
function expectNumEq(actual: number, expected: JsonNum, msg: string): void {
  if (expected === "NaN") {
    expect(Number.isNaN(actual), msg).toBe(true);
  } else {
    expect(actual, msg).toBe(decNum(expected));
  }
}

/**
 * Assert a Config field equals its expected value, disambiguating by the field's
 * DECLARED type (vec.field_types), not by the runtime JS type of the expected value.
 * This matters because a float field can legitimately hold inf/-inf/nan, which the
 * oracle encodes as the tagged strings "Infinity"/"-Infinity"/"NaN"; those must decode
 * to JS numbers for a float/int field, while a string field comparing the literal text
 * "Infinity" must stay a string compare.
 */
function expectFieldEq(
  name: string,
  actual: number | string,
  expected: JsonNum | string,
  msg: string,
): void {
  const ftype = vec.field_types[name];
  if (ftype === "str") {
    expect(actual, msg).toBe(expected as string);
  } else {
    expectNumEq(actual as number, expected as JsonNum, msg);
  }
}

// ---------------------------------------------------------------------------
// 1. Enum maps -- exact ordering and membership.
// ---------------------------------------------------------------------------
describe("config: enum string->index maps", () => {
  const TS_MAPS: { [name: string]: { [k: string]: number } } = {
    SCORING,
    TEAM_MODE,
    PLAY_MODE,
    PLAY_ORDER,
    ELASTIC,
    EXPLOSION_SCALE,
  };
  for (const name of Object.keys(vec.enum_maps)) {
    it(`${name} matches the Python enum map exactly`, () => {
      expect(TS_MAPS[name]).toEqual(vec.enum_maps[name]);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Default field values + field order + __post_init__ live globals.
// ---------------------------------------------------------------------------
describe("config: dataclass defaults, field order, post_init", () => {
  it("field declaration order matches (save/iteration order)", () => {
    expect(CONFIG_FIELDS.map((f) => f.name)).toEqual(vec.field_order);
  });

  it("field type tags match the Python annotations", () => {
    const tsTypes: { [k: string]: string } = {};
    for (const f of CONFIG_FIELDS) tsTypes[f.name] = f.type;
    expect(tsTypes).toEqual(vec.field_types);
  });

  it("every default field value matches exactly", () => {
    const c = new Config();
    for (const name of vec.field_order) {
      const expected = vec.defaults[name];
      const actual = (c as unknown as { [k: string]: number | string })[name];
      expectFieldEq(name, actual, expected, `default ${name}`);
    }
  });

  it("__post_init__ live globals (wind, live_elastic) match", () => {
    const c = new Config();
    expect(c.wind, "wind").toBe(vec.post_init.wind);
    expect(c.live_elastic, "live_elastic").toBe(vec.post_init.live_elastic);
  });
});

// ---------------------------------------------------------------------------
// 3. Derived enum-index properties (incl. case-folding + unknown-token fallback).
// ---------------------------------------------------------------------------
describe("config: derived enum-index properties", () => {
  for (const { field, prop, token, value } of vec.prop_cases) {
    it(`${prop}: ${field}=${JSON.stringify(token)} -> ${value}`, () => {
      const c = new Config();
      (c as unknown as { [k: string]: string })[field] = token;
      const actual = (c as unknown as { [k: string]: number })[prop];
      expect(actual, `${prop} for ${field}=${JSON.stringify(token)}`).toBe(value);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. is_on(key).
// ---------------------------------------------------------------------------
describe("config: is_on", () => {
  for (let i = 0; i < vec.is_on_cases.length; i++) {
    const { field, value, out } = vec.is_on_cases[i];
    it(`is_on(${field}) with ${JSON.stringify(value)} -> ${out}`, () => {
      const c = new Config();
      (c as unknown as { [k: string]: number | string })[field] =
        typeof value === "string" ? value : decNum(value);
      expect(c.is_on(field), `is_on(${field})=${JSON.stringify(value)}`).toBe(out);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. resolution parsing.
// ---------------------------------------------------------------------------
describe("config: resolution", () => {
  for (const { GRAPHICS_MODE, out } of vec.res_cases) {
    it(`resolution for ${JSON.stringify(GRAPHICS_MODE)} -> [${out[0]},${out[1]}]`, () => {
      const c = new Config();
      c.GRAPHICS_MODE = GRAPHICS_MODE;
      expect(c.resolution, `resolution(${JSON.stringify(GRAPHICS_MODE)})`).toEqual(out);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. viscosity_mult over the AIR_VISCOSITY range (exact double; no transcendental).
// ---------------------------------------------------------------------------
describe("config: viscosity_mult", () => {
  for (const { AIR_VISCOSITY, out } of vec.visc_cases) {
    it(`viscosity_mult(AIR_VISCOSITY=${AIR_VISCOSITY})`, () => {
      const c = new Config();
      c.AIR_VISCOSITY = AIR_VISCOSITY;
      expectNumEq(c.viscosity_mult, out, `viscosity_mult(${AIR_VISCOSITY})`);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. _coerce: Python int()/float() string grammar reproduction + str passthrough.
//    This is the core fidelity surface where JS coercion would diverge.
// ---------------------------------------------------------------------------
describe("config: _coerce (Python int/float parsing)", () => {
  for (let i = 0; i < vec.coerce_cases.length; i++) {
    const { type, in: input, out } = vec.coerce_cases[i];
    it(`_coerce(${type}, ${JSON.stringify(input)}) -> ${JSON.stringify(out)}`, () => {
      const actual = _coerce(type, input);
      if (type === "str") {
        expect(actual, `_coerce(str, ${JSON.stringify(input)})`).toBe(out);
      } else {
        expectNumEq(actual as number, out as JsonNum, `_coerce(${type}, ${JSON.stringify(input)})`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 8. load(cfg body): parsed fields + post_init + derived props.
// ---------------------------------------------------------------------------
describe("config: load", () => {
  for (const lc of vec.load_cases) {
    describe(`load: ${lc.label}`, () => {
      it("parses every field to the Python value", () => {
        const c = Config.load(lc.text);
        for (const name of vec.field_order) {
          const expected = lc.parsed[name];
          const actual = (c as unknown as { [k: string]: number | string })[name];
          expectFieldEq(name, actual, expected, `${lc.label}.${name}`);
        }
      });

      it("post_init globals match", () => {
        const c = Config.load(lc.text);
        expect(c.wind, `${lc.label}.wind`).toBe(lc.post_init.wind);
        expect(c.live_elastic, `${lc.label}.live_elastic`).toBe(lc.post_init.live_elastic);
      });

      it("derived properties match", () => {
        const c = Config.load(lc.text);
        const d = lc.derived;
        expect(c.scoring, `${lc.label}.scoring`).toBe(d.scoring);
        expect(c.team_mode, `${lc.label}.team_mode`).toBe(d.team_mode);
        expect(c.play_mode, `${lc.label}.play_mode`).toBe(d.play_mode);
        expect(c.play_order, `${lc.label}.play_order`).toBe(d.play_order);
        expect(c.elastic, `${lc.label}.elastic`).toBe(d.elastic);
        expect(c.explosion_scale, `${lc.label}.explosion_scale`).toBe(d.explosion_scale);
        expect(c.resolution, `${lc.label}.resolution`).toEqual(d.resolution);
        expectNumEq(c.viscosity_mult, d.viscosity_mult, `${lc.label}.viscosity_mult`);
      });
    });
  }

  it("load(null) returns built-in defaults (OSError branch)", () => {
    const c = Config.load(null);
    const def = new Config();
    for (const name of vec.field_order) {
      const a = (c as unknown as { [k: string]: number | string })[name];
      const b = (def as unknown as { [k: string]: number | string })[name];
      expect(a, `load(null).${name}`).toBe(b);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. save(): exact byte body. Mirrors the oracle mutators.
// ---------------------------------------------------------------------------
describe("config: save", () => {
  // Mutators identical to dump_config.py's add_save battery, keyed by label.
  const MUTATORS: { [label: string]: (c: Config) => void } = {
    defaults: () => {},
    mutated: (c) => {
      c.MAXPLAYERS = 8;
      c.MTN_PERCENT = 33.0;
      c.INTEREST_RATE = 0.125;
      c.GRAVITY = 5.5;
      c.LAND1 = 99;
      c.SOUND = "OFF";
      c.GRAPHICS_MODE = "640x480";
      c.MOUSE_RATE = 0.25;
    },
    save_float_20: (c) => floatMut(c, 20.0),
    save_float_p05: (c) => floatMut(c, 0.05),
    save_float_third: (c) => floatMut(c, 1.0 / 3.0),
    save_float_big: (c) => floatMut(c, 123456.789),
    save_float_tiny: (c) => floatMut(c, 0.0001),
  };
  function floatMut(c: Config, fv: number): void {
    c.MTN_PERCENT = fv;
    c.INTEREST_RATE = fv;
    c.GRAVITY = fv;
    c.MOUSE_RATE = fv;
  }

  for (const sc of vec.save_cases) {
    it(`save: ${sc.label} produces the exact cfg body`, () => {
      if (sc.label === "roundtrip_real") {
        // Built by loading the real shipped scorch.cfg then saving. Reconstruct by
        // loading the same body the oracle loaded for the "real_scorch.cfg" case.
        const realLoad = vec.load_cases.find((l) => l.label === "real_scorch.cfg");
        expect(realLoad, "real_scorch.cfg load fixture present").toBeTruthy();
        const c = Config.load(realLoad!.text);
        expect(c.save(), "roundtrip_real save body").toBe(sc.body);
        return;
      }
      const mut = MUTATORS[sc.label];
      expect(mut, `mutator for ${sc.label}`).toBeTruthy();
      const c = new Config();
      mut(c);
      expect(c.save(), `save body ${sc.label}`).toBe(sc.body);
    });
  }
});

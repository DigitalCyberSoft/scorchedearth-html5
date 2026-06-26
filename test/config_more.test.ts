/**
 * Coverage mop-up (differential): the float/int/str token rendering that save()
 * uses (fieldToCfgToken + pyStr), including the SCIENTIFIC-notation path
 * (e < -4 or e >= 16) that the existing save battery never reached. Expected
 * strings are CPython str(value) from oracle/dump_more.py -- this is the whole
 * point of pyFloatRepr: reproduce CPython's repr exactly. EXACT string equality.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { fieldToCfgToken, pyStr } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "config_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

/** Decode the oracle's JSON-safe float encoding back to a JS number. */
function dec(e: number | string): number {
  if (e === "NaN") return NaN;
  if (e === "Infinity") return Infinity;
  if (e === "-Infinity") return -Infinity;
  if (e === "-0.0") return -0;
  if (e === "-0") return -0;
  return e as number;
}

describe("config(more): fieldToCfgToken('float',v) == CPython str(float)", () => {
  for (const c of vec.float_cases) {
    it(`float ${JSON.stringify(c.enc)} -> ${JSON.stringify(c.str)}`, () => {
      expect(fieldToCfgToken("float", dec(c.enc))).toBe(c.str);
    });
  }
});

describe("config(more): fieldToCfgToken('int'/'str',v) == CPython str", () => {
  for (const c of vec.int_cases) {
    it(`int ${c.v} -> ${JSON.stringify(c.str)}`, () => {
      expect(fieldToCfgToken("int", c.v)).toBe(c.str);
    });
  }
  it(`int -0 renders "0" (signed-zero guard)`, () => {
    expect(fieldToCfgToken("int", dec(vec.int_neg0.v_enc))).toBe(vec.int_neg0.str);
  });
  for (const s of vec.str_cases) {
    it(`str ${JSON.stringify(s)} passes through`, () => {
      expect(fieldToCfgToken("str", s)).toBe(s);
    });
  }
});

describe("config(more): pyStr infers int/float/str like CPython str", () => {
  for (const c of vec.pystr_cases) {
    it(`pyStr(${JSON.stringify(c.enc)}) [${c.kind}] -> ${JSON.stringify(c.str)}`, () => {
      const v = c.kind === "str" ? (c.enc as string) : dec(c.enc);
      expect(pyStr(v)).toBe(c.str);
    });
  }
});

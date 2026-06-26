/**
 * Coverage mop-up for savegame: the paths the main byte/round-trip battery never
 * reaches.
 *
 *  - pyFloatRepr SCIENTIFIC branch (e < -4 or e >= 16): asserted DIFFERENTIALLY
 *    against CPython json.dumps(v) from oracle/dump_more.py (savegame.py serializes
 *    its body with json.dumps, so that IS the reference for a float leaf). EXACT
 *    string equality -- the whole point of pyFloatRepr is to reproduce it.
 *  - the defensive THROW guards (DTM 6.x: surface corruption, never emit silent
 *    garbage). These are TS-internal contracts with NO Python diff partner: the
 *    Python base64 decoder is lenient and Python json permits nan/inf, whereas the
 *    port deliberately REJECTS. Each is asserted as a real SaveError throw so the
 *    guard is locked, not skipped.
 *
 * The non-empty sim_keys restore path is covered by the main battery
 * (savegame.test.ts round-trip) via the SIMULTANEOUS case in dump_savegame.py.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  pyFloatRepr,
  encodeJson,
  b64decode,
  gridFromDict,
  load,
  apply,
  SaveError,
  MAGIC_BYTES,
  type SaveData,
  type SaveGameState,
  type JsonValue,
} from "../src/savegame";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "savegame_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

/** Decode the oracle's JSON-safe float encoding back to a JS number. */
function dec(e: number | string): number {
  if (e === "-0.0") return -0;
  return e as number;
}

describe("savegame(more): pyFloatRepr scientific branch == CPython json.dumps", () => {
  for (const c of vec.float_sci) {
    it(`pyFloatRepr(${JSON.stringify(c.enc)}) -> ${JSON.stringify(c.str)}`, () => {
      expect(pyFloatRepr(dec(c.enc))).toBe(c.str);
    });
  }
});

describe("savegame(more): defensive throw guards (corruption surfaced, never masked)", () => {
  it("encodeInt non-finite -> SaveError (Infinity in an int position)", () => {
    // encodeJson routes a bare number through encodeInt; a non-finite int is a port
    // bug, not faithful state, so it must throw rather than emit silent garbage.
    expect(() => encodeJson(Infinity as unknown as JsonValue)).toThrow(SaveError);
    expect(() => encodeJson(-Infinity as unknown as JsonValue)).toThrow(SaveError);
    expect(() => encodeJson(NaN as unknown as JsonValue)).toThrow(SaveError);
  });

  it("b64decode rejects a non-alphabet character -> SaveError", () => {
    // '@' is outside the standard base64 alphabet (A-Za-z0-9+/); the strict decoder
    // surfaces it as a corrupt terrain payload.
    expect(() => b64decode("@@@@")).toThrow(SaveError);
    expect(() => b64decode("AAA@")).toThrow(SaveError);
  });

  it("gridFromDict rejects a payload whose length != w*h -> SaveError", () => {
    // "AAAA" decodes to 3 bytes; a 1x1 grid expects 1 -> corrupt save.
    expect(() => gridFromDict({ w: 1, h: 1, b64: "AAAA" })).toThrow(SaveError);
    expect(() => gridFromDict({ w: 2, h: 3, b64: "AAAA" })).toThrow(SaveError);
  });

  it("load() with a valid header but unreadable JSON body -> SaveError corrupt", () => {
    // 6-byte magic + u16 LE version(1), then a valid-UTF8 but non-JSON body. The
    // header guards pass; JSON.parse throws; load() reports a corrupt save.
    const header = Uint8Array.from([...MAGIC_BYTES, 0x01, 0x00]);
    const body = new TextEncoder().encode("not valid json {");
    const blob = new Uint8Array(header.length + body.length);
    blob.set(header, 0);
    blob.set(body, header.length);
    expect(() => load(blob)).toThrow(SaveError);
    try {
      load(blob);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).message).toContain("corrupt saved game");
    }
  });

  it("apply() with a roster size != the saved tank count -> SaveError", () => {
    // The integrator must rebuild the roster to the saved shape first; a mismatch is
    // surfaced rather than silently mis-restored. The guard fires before any cfg /
    // economy / tank field is read, so minimal stand-ins reach it.
    const data = { w: 4, h: 4, tanks: [{}, {}] } as unknown as SaveData;
    const host = { tanks: [{}] } as unknown as SaveGameState;
    expect(() => apply(data, host)).toThrow(SaveError);
    try {
      apply(data, host);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SaveError);
      expect((e as SaveError).message).toContain("roster size");
    }
  });
});

/**
 * Coverage mop-up (differential): Rng.getrandbits(k) for k > 32 (the multi-word
 * little-endian assembly loop) and the k <= 0 error guard, neither exercised by
 * rng.test.ts (which only uses the getrandbits(32) raw-word path via pick/chance).
 *
 * Golden vectors come from oracle/dump_more.py, which records
 * CPython random.Random(seed).getrandbits(k) directly. All k <= 53 so every value
 * is < 2**53 and JS reproduces the exact integer -> EXACT assertion (toBe). k > 53
 * would need BigInt and is intentionally out of scope (the game never requests it).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Rng } from "../src/rng";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "rng_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

describe("rng(more): getrandbits(k) for 32 < k <= 53 matches CPython exactly", () => {
  for (const run of vec.getrandbits) {
    it(`seed ${run.seed} k=${run.k}: ${run.out.length} words match`, () => {
      const r = new Rng(run.seed);
      for (let i = 0; i < run.out.length; i++) {
        expect(r.getrandbits(run.k), `seed ${run.seed} k=${run.k} #${i}`).toBe(
          run.out[i],
        );
      }
    });
  }
});

describe("rng(more): getrandbits(k<=0) rejects, mirroring CPython's ValueError", () => {
  it("getrandbits(0) and getrandbits(-1) throw", () => {
    const r = new Rng(0);
    expect(() => r.getrandbits(0)).toThrow();
    expect(() => r.getrandbits(-1)).toThrow();
  });
});

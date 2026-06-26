/**
 * Differential gate: TS Rng == CPython MT19937 (the Python port's RNG), bit-exact.
 *
 * Golden vectors are produced by oracle/dump_vectors.py from the Python port and
 * written to oracle/vectors/rng.json. This is the linchpin test: if the raw MT
 * stream or seeding diverges by one bit, every downstream stochastic differential
 * test (terrain, ai, talk, weapon spread) would fail. So this must be green
 * before Phase 1 fans out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Rng } from "../src/rng";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "rng.json");

type RngVectors = {
  raw: { seed: number; words: number[] }[];
  pick: { seed: number; ns: number[]; out: number[] }[];
  chance: { seed: number; calls: [number, number][]; out: boolean[] }[];
  uniform: { seed: number; calls: [number, number][]; out: number[] }[];
  roulette: { seed: number; calls: number[][]; out: number[] }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as RngVectors;

describe("rng: raw MT19937 stream + seeding", () => {
  for (const { seed, words } of vec.raw) {
    it(`seed ${seed}: ${words.length} tempered words match CPython`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < words.length; i++) {
        expect(r.genrandUint32(), `word ${i} for seed ${seed}`).toBe(words[i]);
      }
    });
  }
});

describe("rng: pick (randrange rejection loop)", () => {
  for (const { seed, ns, out } of vec.pick) {
    it(`seed ${seed}: ${ns.length} pick() draws match`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < ns.length; i++) {
        expect(r.pick(ns[i]), `pick(${ns[i]}) #${i} seed ${seed}`).toBe(out[i]);
      }
    });
  }
});

describe("rng: chance (randrange(den) < num)", () => {
  for (const { seed, calls, out } of vec.chance) {
    it(`seed ${seed}: ${calls.length} chance() draws match`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < calls.length; i++) {
        const [num, den] = calls[i];
        expect(r.chance(num, den), `chance(${num},${den}) #${i} seed ${seed}`).toBe(out[i]);
      }
    });
  }
});

describe("rng: uniform (53-bit random(), exact double)", () => {
  for (const { seed, calls, out } of vec.uniform) {
    it(`seed ${seed}: ${calls.length} uniform() draws match bit-exact`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < calls.length; i++) {
        const [a, b] = calls[i];
        expect(r.uniform(a, b), `uniform(${a},${b}) #${i} seed ${seed}`).toBe(out[i]);
      }
    });
  }
});

describe("rng: roulette (uniform-driven weighted pick)", () => {
  for (const { seed, calls, out } of vec.roulette) {
    it(`seed ${seed}: ${calls.length} roulette() draws match`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < calls.length; i++) {
        expect(r.roulette(calls[i].slice()), `roulette #${i} seed ${seed}`).toBe(out[i]);
      }
    });
  }
});

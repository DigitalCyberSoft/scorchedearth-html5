/**
 * Coverage mop-up (differential): ai._solve_power's reject paths -- the v2<=0
 * branch (reachable only when gravity is 0, so the numerator a*x*x vanishes) that
 * the existing ai battery never drove, plus the reachable arc and the denom<=0
 * reject as anchors. Golden values from oracle/dump_more.py (scorch.ai._solve_power).
 *
 * EPSILON: a solved power is sqrt-derived -> toBeCloseTo(.,12); None/null is exact.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as ai from "../src/ai";
import { Config } from "../src/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "ai_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

function mkCfg(gravity: number): Config {
  const cfg = new Config();
  cfg.GRAVITY = gravity;
  cfg.AIR_VISCOSITY = 0;
  cfg.live_elastic = cfg.elastic;
  cfg.wind = 0;
  return cfg;
}

describe("ai(more): _solve_power closed-form rejects (v2<=0, denom<=0)", () => {
  for (const c of vec.solve_power) {
    it(`${c.label} (g=${c.g}) -> ${c.power === null ? "null" : c.power.toFixed(3)}`, () => {
      const r = ai._solve_power(mkCfg(c.g), c.sx, c.sy, c.tx, c.ty, c.elev);
      if (c.power === null) {
        expect(r, `${c.label} must be null`).toBeNull();
      } else {
        expect(r, `${c.label} solved power present`).not.toBeNull();
        expect(r as number).toBeCloseTo(c.power, 12);
      }
    });
  }

  it("zero-gravity makes the closed form unsolvable (v2<=0 -> null)", () => {
    // Pin the specific branch: with gravity 0 the numerator a*x*x is 0, so v2==0
    // and _solve_power returns null even for an otherwise-reachable target.
    expect(ai._solve_power(mkCfg(0), 200, 600, 700, 590, 45)).toBeNull();
    // sanity: the same geometry IS solvable under real gravity.
    expect(ai._solve_power(mkCfg(0.2), 200, 600, 700, 590, 45)).not.toBeNull();
  });
});

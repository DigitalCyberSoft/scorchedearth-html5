/**
 * Coverage mop-up: the getattr-style DEFAULT branches death.test.ts never hit --
 * _blast_radius's explosion_scale fallback (state lacking the attr) and the
 * color=15 fallback in _debris_fountain / _spawn_throe when the dying tank has no
 * `color`. _blast_radius defaults are differential vs oracle/dump_more.py
 * (Python int(FALLBACK*scale)); the color sentinel is the Python getattr default.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as death from "../src/death";
import type { DState, DTank } from "../src/death";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "death_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

describe("death(more): _blast_radius explosion_scale default", () => {
  it("state without explosion_scale falls back to scale 1.0", () => {
    const r = death._blast_radius({} as unknown as DState, null);
    expect(r).toBe(vec.blast_radius_default); // int(FALLBACK * 1.0)
    expect(r).toBe(vec.fallback);
  });
  it("state.explosion_scale present is used (2.0 -> 2x fallback)", () => {
    const r = death._blast_radius(
      { explosion_scale: 2.0 } as unknown as DState,
      null,
    );
    expect(r).toBe(vec.blast_radius_scaled);
  });
});

describe("death(more): color=15 default when the tank has no `color`", () => {
  it("_debris_fountain hands color 15 to the fountain emitter", () => {
    let got: { color?: number } | null = null;
    const state = {
      w: 360,
      add_explosion: () => {},
      add_death_fountain: (
        _x: number,
        _y: number,
        _top: number,
        kw?: { color?: number; stride?: number; scatter?: number },
      ) => {
        got = kw ?? null;
      },
    } as unknown as DState;
    const tank = { x: 200, y: 300 } as unknown as DTank; // no `color`
    death._debris_fountain(state, tank, false);
    expect(got).not.toBeNull();
    expect(got!.color).toBe(vec.default_color);
  });

  it("_spawn_throe hands color 15 to add_throe", () => {
    let gotCol: number | null = null;
    const state = {
      add_explosion: () => {},
      add_throe: (_kind: string, _x: number, _y: number, color: number) => {
        gotCol = color;
      },
    } as unknown as DState;
    const tank = { x: 200, y: 300 } as unknown as DTank; // no `color`
    death._spawn_throe(state, tank, 5, 18); // throe 5 = spiral -> add_throe
    expect(gotCol).toBe(vec.default_color);
  });
});

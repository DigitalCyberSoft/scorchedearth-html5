/**
 * Differential gate: TS death == Python scorch.death (the byte-verified oracle).
 *
 * Golden vectors are produced by oracle/dump_death.py from the Python port and
 * written to oracle/vectors/death.json.  The Python dumper drives the REAL
 * scorch.death functions over lightweight mock Tank/Cfg/Terrain/Rng/State
 * objects; this test builds STRUCTURALLY IDENTICAL mocks (same fields, same
 * callback logging, same add_throe/add_death_fountain emitters, same state.w)
 * and asserts src/death.ts reproduces every result.
 *
 * EPSILON POLICY:
 *   death.py is integer-only itself: _blast_radius is int(abs(blast)*scale) /
 *   int(FALLBACK*scale) (Python int() == truncation toward zero == Math.trunc),
 *   the throe roulette is rng.pick(11) (an exact MT-driven integer, already a
 *   green gate), and every throe/fountain/explosion parameter is integer
 *   arithmetic.  The ONE transcendental dependency is inside damage.explode (the
 *   radial-damage law round((R-d)*100/R) using math.hypot), but the blast
 *   distance is measured between INTEGER pixel coordinates, so dx*dx+dy*dy is an
 *   exact integer and damage.ts's Math.sqrt of the squared sum reproduces
 *   CPython math.hypot bit-for-bit (the damage.ts NUMERIC NOTES result).  Hence
 *   EVERY value here -- the returned throe, the ordered explosion/throe/fountain/
 *   carve/destroyed logs, and every tank's post-state (health/shield/alive/score/
 *   cash) -- is asserted EXACT (.toBe / .toEqual).  There is no float that needs
 *   an epsilon in this module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as death from "../src/death";
import type { DState, DTank } from "../src/death";
import { Rng } from "../src/rng";
import * as C from "../src/constants";
import { ITEMS, Item } from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "death.json");

// ===========================================================================
// Mocks -- mirror oracle/dump_death.py exactly (same field order, same logs).
// ===========================================================================
interface MockTank extends DTank {
  id: string;
}
function mkTank(id: string, o: Partial<MockTank> = {}): MockTank {
  return {
    id,
    x: o.x ?? 200,
    y: o.y ?? 300,
    color: o.color ?? 15,
    half_width: o.half_width ?? 7,
    health: o.health ?? 100,
    shield_hp: o.shield_hp ?? 0,
    shield_item: o.shield_item ?? 0,
    alive: o.alive ?? true,
    player_index: o.player_index ?? 0,
    team_id: o.team_id ?? 0,
    score: o.score ?? 0,
    cash: o.cash ?? 0,
    win_counter: o.win_counter ?? 0,
    inventory: o.inventory ? o.inventory.slice() : [],
    hits_this_round: {},
    hits_career: {},
    // damage.Tank fields the explode path may touch but death never sets:
    parachute_deployed: false,
    parachutes: 0,
    parachute_threshold: 5,
  } as MockTank;
}

class MockCfg {
  scoring = C.SCORING_STANDARD;
  team_mode = C.TEAM_NONE;
  private _sound: boolean;
  constructor(sound = true) {
    this._sound = sound;
  }
  is_on(key: string): boolean {
    if (key === "SOUND") return this._sound;
    return false;
  }
}

class MockTerrain {
  w: number;
  h: number;
  carve_circles: number[][] = [];
  constructor(w = 360, h = 480) {
    this.w = w;
    this.h = h;
  }
  carve_circle(cx: number, cy: number, r: number): void {
    this.carve_circles.push([Math.trunc(cx), Math.trunc(cy), Math.trunc(r)]);
  }
  is_supported(_x: number, _y: number, _half_width: number): boolean {
    return false;
  }
}

class MockState implements DState {
  cfg: MockCfg;
  tanks: MockTank[];
  terrain: MockTerrain;
  rng: Rng;
  explosion_scale: number;
  current_shooter: MockTank | null;
  current_weapon: unknown;
  economy = { unit_price: (slot: number) => slot };
  w: number;
  explosions: Array<[number, number, number, boolean, boolean]> = [];
  throes: Array<[string, number, number, number]> = [];
  fountains: Array<[number, number, number, number, number, number]> = [];
  destroyed: Array<[string, boolean]> = [];
  // bound only when withFountain (so the typeof check is undefined otherwise,
  // exactly like a GameState stub lacking the emitter)
  add_death_fountain?: (
    x: number,
    y: number,
    top: number,
    kw?: { color?: number; stride?: number; scatter?: number }
  ) => void;
  constructor(
    o: {
      cfg?: MockCfg;
      tanks?: MockTank[];
      terrain?: MockTerrain;
      rng?: Rng;
      explosion_scale?: number;
      current_shooter?: MockTank | null;
      current_weapon?: unknown;
      w?: number;
      withFountain?: boolean;
    } = {}
  ) {
    const w = o.w ?? 360;
    this.w = w;
    this.cfg = o.cfg ?? new MockCfg();
    this.tanks = o.tanks ?? [];
    this.terrain = o.terrain ?? new MockTerrain(w);
    this.rng = o.rng ?? new Rng(0);
    this.explosion_scale = o.explosion_scale ?? 1.0;
    this.current_shooter = o.current_shooter ?? null;
    this.current_weapon = o.current_weapon ?? null;
    if (o.withFountain ?? true) {
      this.add_death_fountain = (x, y, top, kw) => {
        // Python signature add_death_fountain(x, y, top, color=15, stride=6,
        // scatter=1): log the resolved [x, y, top, color, stride, scatter].
        const color = kw?.color ?? 15;
        const stride = kw?.stride ?? 6;
        const scatter = kw?.scatter ?? 1;
        this.fountains.push([x, y, top, color, stride, scatter]);
      };
    }
  }
  add_explosion(x: number, y: number, r: number, kw?: { [k: string]: unknown }): void {
    const dirt_only = Boolean(kw?.["dirt_only"]);
    const nuke = Boolean(kw?.["nuke"]);
    this.explosions.push([Math.trunc(x), Math.trunc(y), Math.trunc(r), dirt_only, nuke]);
  }
  add_throe(kind: string, x: number, y: number, color: number): void {
    this.throes.push([kind, x, y, color]);
  }
  on_tank_destroyed(victim: DTank, weapon: unknown): void {
    this.destroyed.push([
      (victim as MockTank).id,
      weapon !== null && weapon !== undefined,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers -- mirror the oracle's _tank_snap / _state_snap exactly.
// ---------------------------------------------------------------------------
type TSnap = [number, number, number, boolean, number, number, number];
function tsnap(t: MockTank): TSnap {
  return [t.health, t.shield_hp, t.shield_item, t.alive, t.score, t.cash, t.win_counter];
}
function expectTSnap(got: TSnap, want: TSnap, label: string): void {
  expect(got[0], `${label} health`).toBe(want[0]);
  expect(got[1], `${label} shield_hp`).toBe(want[1]);
  expect(got[2], `${label} shield_item`).toBe(want[2]);
  expect(got[3], `${label} alive`).toBe(want[3]);
  expect(got[4], `${label} score`).toBe(want[4]);
  expect(got[5], `${label} cash`).toBe(want[5]);
  expect(got[6], `${label} win_counter`).toBe(want[6]);
}

type StateSnap = {
  explosions: Array<[number, number, number, boolean, boolean]>;
  throes: Array<[string, number, number, number]>;
  fountains: Array<[number, number, number, number, number, number]>;
  destroyed: Array<[string, boolean]>;
  carve_circles: number[][];
  current_weapon_name: string | null;
};
function expectState(st: MockState, want: StateSnap, label: string): void {
  expect(st.explosions, `${label} explosions`).toEqual(want.explosions);
  expect(st.throes, `${label} throes`).toEqual(want.throes);
  expect(st.fountains, `${label} fountains`).toEqual(want.fountains);
  expect(st.destroyed, `${label} destroyed`).toEqual(want.destroyed);
  expect(st.terrain.carve_circles, `${label} carve_circles`).toEqual(want.carve_circles);
  const cwName =
    st.current_weapon === null || st.current_weapon === undefined
      ? null
      : (st.current_weapon as Item).name;
  expect(cwName, `${label} current_weapon_name`).toBe(want.current_weapon_name);
}

// ===========================================================================
// Vector types
// ===========================================================================
type Vec = {
  consts: Array<{
    DEBRIS_PUFF_RADIUS: number;
    DEBRIS_ROW_STRIDE: number;
    DEBRIS_TOP_MARGIN: number;
    DEATH_BLAST_FALLBACK: number;
    PLAYFIELD_TOP: number;
    STANDARD: number;
  }>;
  blast_radius: Array<{ idx: number; name: string; blast: number; scale: number; out: number }>;
  throe_pick: Array<{ seed: number; out: number[] }>;
  spawn_throe: Array<{
    throe: number;
    tank: string;
    x: number;
    y: number;
    col: number;
    radius: number;
    explosions: Array<[number, number, number, boolean, boolean]>;
    throes: Array<[string, number, number, number]>;
  }>;
  debris_fountain: Array<{
    tank: string;
    x: number;
    y: number;
    col: number;
    scatter: boolean;
    fountains: Array<[number, number, number, number, number, number]>;
    explosions: Array<[number, number, number, boolean, boolean]>;
  }>;
  debris_fountain_fallback: Array<{
    w: number;
    x: number;
    explosions: Array<[number, number, number, boolean, boolean]>;
    fountains: Array<[number, number, number, number, number, number]>;
  }>;
  final_blast: Array<{
    radius: number;
    victim: TSnap;
    n1: TSnap;
    n2: TSnap;
    n3: TSnap;
    far: TSnap;
    shooter: TSnap;
    state: StateSnap;
  }>;
  effect_standard: Array<{
    radius: number;
    with_fountain: boolean;
    victim: TSnap;
    state: StateSnap;
  }>;
  death_sequence: Array<{
    seed: number;
    widx: number;
    wname: string;
    scale: number;
    victim_alive: boolean;
    with_fountain: boolean;
    throe: number;
    victim: TSnap;
    near: TSnap;
    shielded: TSnap;
    far: TSnap;
    shooter: TSnap;
    state: StateSnap;
  }>;
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as Vec;

// ===========================================================================
// Tests
// ===========================================================================
describe("death: module constants", () => {
  it("byte-pinned + reconstructed tunables match", () => {
    const c = vec.consts[0];
    expect(death.DEBRIS_PUFF_RADIUS).toBe(c.DEBRIS_PUFF_RADIUS);
    expect(death.DEBRIS_ROW_STRIDE).toBe(c.DEBRIS_ROW_STRIDE);
    expect(death.DEBRIS_TOP_MARGIN).toBe(c.DEBRIS_TOP_MARGIN);
    expect(death.DEATH_BLAST_FALLBACK).toBe(c.DEATH_BLAST_FALLBACK);
    expect(death.PLAYFIELD_TOP).toBe(c.PLAYFIELD_TOP);
    expect(death.STANDARD).toBe(c.STANDARD);
  });
});

describe("death: _blast_radius (int(abs(blast)*scale) / int(FALLBACK*scale))", () => {
  it(`all ${vec.blast_radius.length} radius computations match exactly`, () => {
    for (const r of vec.blast_radius) {
      const st = new MockState({ explosion_scale: r.scale });
      // idx -1 == the no-weapon fallback path; otherwise the weapon at ITEMS[idx]
      // (matched by name to guard against any index drift).
      let weapon: Item | null = null;
      if (r.idx >= 0) {
        weapon = ITEMS[r.idx];
        expect(weapon.name, `ITEMS[${r.idx}] name`).toBe(r.name);
        expect(weapon.blast, `ITEMS[${r.idx}] blast`).toBe(r.blast);
      }
      expect(
        death._blast_radius(st, weapon),
        `blast_radius idx=${r.idx} (${r.name}) scale=${r.scale}`
      ).toBe(r.out);
    }
  });
});

describe("death: rand(11) throe roulette stream (the seeded selection)", () => {
  for (const { seed, out } of vec.throe_pick) {
    it(`seed ${seed}: ${out.length} throe picks (rng.pick(11)) match`, () => {
      const r = new Rng(seed);
      for (let i = 0; i < out.length; i++) {
        const got = r.pick(11);
        expect(got, `pick(11) #${i} seed ${seed}`).toBe(out[i]);
        // it is genuinely a throe index in [0, 11)
        expect(got >= 0 && got < 11, `pick(11) #${i} range`).toBe(true);
      }
    });
  }
});

describe("death: _spawn_throe (each of 11 cases x radii x positions)", () => {
  it(`all ${vec.spawn_throe.length} throe dispatches match exactly`, () => {
    for (const r of vec.spawn_throe) {
      const st = new MockState();
      const tk = mkTank("t", { x: r.x, y: r.y, color: r.col });
      death._spawn_throe(st, tk, r.throe, r.radius);
      expect(
        st.explosions,
        `spawn_throe throe=${r.throe} ${r.tank} radius=${r.radius} explosions`
      ).toEqual(r.explosions);
      expect(
        st.throes,
        `spawn_throe throe=${r.throe} ${r.tank} radius=${r.radius} throes`
      ).toEqual(r.throes);
    }
  });
});

describe("death: _debris_fountain (emitter present)", () => {
  it(`all ${vec.debris_fountain.length} fountain registrations match exactly`, () => {
    for (const r of vec.debris_fountain) {
      const st = new MockState({ withFountain: true });
      const tk = mkTank("t", { x: r.x, y: r.y, color: r.col });
      death._debris_fountain(st, tk, r.scatter);
      expect(
        st.fountains,
        `debris_fountain ${r.tank} scatter=${r.scatter} fountains`
      ).toEqual(r.fountains);
      expect(
        st.explosions,
        `debris_fountain ${r.tank} scatter=${r.scatter} explosions`
      ).toEqual(r.explosions);
    }
  });
});

describe("death: _debris_fountain FALLBACK (no emitter -> clamped dirt puff)", () => {
  it(`all ${vec.debris_fountain_fallback.length} fallback puffs match exactly`, () => {
    for (const r of vec.debris_fountain_fallback) {
      const st = new MockState({ w: r.w, withFountain: false });
      const tk = mkTank("t", { x: r.x, y: 250, color: 9 });
      death._debris_fountain(st, tk, false);
      expect(
        st.explosions,
        `fallback w=${r.w} x=${r.x} explosions (clamped)`
      ).toEqual(r.explosions);
      expect(st.fountains, `fallback w=${r.w} x=${r.x} fountains (empty)`).toEqual(r.fountains);
    }
  });
});

describe("death: _final_blast (damage.explode -> radial damage + kills + scoring)", () => {
  for (const r of vec.final_blast) {
    it(`radius ${r.radius}: blast damage/kills/scoring match exactly`, () => {
      const victim = mkTank("v", { x: 200, y: 300, color: 7, team_id: 2, player_index: 0, health: 100 });
      const n1 = mkTank("n1", { x: 205, y: 300, team_id: 2, player_index: 1, health: 100 });
      const n2 = mkTank("n2", { x: 215, y: 300, team_id: 2, player_index: 2, health: 100 });
      const n3 = mkTank("n3", { x: 200, y: 312, team_id: 2, player_index: 3, health: 100, shield_hp: 40, shield_item: 1 });
      const far = mkTank("far", { x: 20, y: 300, team_id: 2, player_index: 4, health: 100 });
      const shooter = mkTank("s", { x: 100, y: 300, team_id: 1, player_index: 5 });
      const st = new MockState({
        tanks: [victim, n1, n2, n3, far],
        rng: new Rng(1),
        explosion_scale: 1.0,
        current_shooter: shooter,
      });
      death._final_blast(st, victim, r.radius);
      expectTSnap(tsnap(victim), r.victim, `final_blast r=${r.radius} victim`);
      expectTSnap(tsnap(n1), r.n1, `final_blast r=${r.radius} n1`);
      expectTSnap(tsnap(n2), r.n2, `final_blast r=${r.radius} n2`);
      expectTSnap(tsnap(n3), r.n3, `final_blast r=${r.radius} n3`);
      expectTSnap(tsnap(far), r.far, `final_blast r=${r.radius} far`);
      expectTSnap(tsnap(shooter), r.shooter, `final_blast r=${r.radius} shooter`);
      expectState(st, r.state, `final_blast r=${r.radius}`);
    });
  }
});

describe("death: _effect_standard (fountain + blast, ordered)", () => {
  for (let i = 0; i < vec.effect_standard.length; i++) {
    const r = vec.effect_standard[i];
    it(`radius ${r.radius} fountain=${r.with_fountain}: ordered effect matches`, () => {
      const victim = mkTank("v", { x: 200, y: 300, color: 5, team_id: 2, player_index: 0, health: 100 });
      const shooter = mkTank("s", { x: 100, y: 300, team_id: 1, player_index: 5 });
      const st = new MockState({
        tanks: [victim],
        rng: new Rng(2),
        explosion_scale: 1.0,
        current_shooter: shooter,
        withFountain: r.with_fountain,
      });
      death._effect_standard(st, victim, r.radius);
      expectTSnap(tsnap(victim), r.victim, `effect_standard r=${r.radius} victim`);
      expectState(st, r.state, `effect_standard r=${r.radius} f=${r.with_fountain}`);
    });
  }
});

describe("death: death_sequence (full entry point: throe + chain + scoring)", () => {
  it(`all ${vec.death_sequence.length} full death sequences match exactly`, () => {
    for (const r of vec.death_sequence) {
      // Reconstruct the exact mock the oracle built. The three special
      // batteries (noshooter / notanks) are distinguished by wname suffix.
      const isNoShooter = r.wname.endsWith("_noshooter");
      const isNoTanks = r.wname.endsWith("_notanks");

      const weapon: Item | null = r.widx >= 0 ? ITEMS[r.widx] : null;

      const victim = mkTank("v", {
        x: isNoTanks ? 180 : 200,
        y: isNoTanks ? 260 : 300,
        color: isNoShooter ? 4 : isNoTanks ? 11 : 7,
        team_id: isNoShooter || isNoTanks ? 0 : 2,
        player_index: 0,
        health: 100,
        alive: r.victim_alive,
      });

      let tanks: MockTank[];
      let near: MockTank;
      let shielded: MockTank;
      let far: MockTank;
      let shooter: MockTank | null;

      if (isNoTanks) {
        // empty tank list; the blast loop iterates nothing.
        tanks = [];
        near = shielded = far = mkTank("_", {});
        shooter = null;
      } else if (isNoShooter) {
        near = mkTank("near", { x: 204, y: 300, team_id: 0, player_index: 1, health: 100 });
        tanks = [victim, near];
        shielded = far = near;
        shooter = null;
      } else {
        near = mkTank("near", { x: 206, y: 300, team_id: 2, player_index: 1, health: 100 });
        shielded = mkTank("shield", { x: 200, y: 314, team_id: 2, player_index: 2, health: 100, shield_hp: 60, shield_item: 1 });
        far = mkTank("far", { x: 20, y: 300, team_id: 2, player_index: 3, health: 100 });
        shooter = mkTank("s", { x: 100, y: 300, team_id: 1, player_index: 5 });
        tanks = [victim, near, shielded, far];
      }

      const st = new MockState({
        tanks,
        rng: new Rng(r.seed),
        explosion_scale: r.scale,
        current_shooter: shooter,
        withFountain: r.with_fountain,
      });
      const label = `death_sequence seed=${r.seed} w=${r.wname} sc=${r.scale} alive=${r.victim_alive} f=${r.with_fountain}`;
      const throe = death.death_sequence(st, victim, weapon);
      expect(throe, `${label} throe`).toBe(r.throe);

      expectTSnap(tsnap(victim), r.victim, `${label} victim`);
      if (!isNoTanks) {
        expectTSnap(tsnap(near), r.near, `${label} near`);
      }
      if (!isNoTanks && !isNoShooter) {
        expectTSnap(tsnap(shielded), r.shielded, `${label} shielded`);
        expectTSnap(tsnap(far), r.far, `${label} far`);
        if (shooter) expectTSnap(tsnap(shooter), r.shooter, `${label} shooter`);
      }
      expectState(st, r.state, label);
    }
  });
});

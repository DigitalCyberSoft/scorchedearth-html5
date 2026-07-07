/**
 * Differential gate: TS death == Python scorch.death (the byte-verified oracle:
 * the FUN_271b_0005 kill roulette + the FUN_3ef5_029a ascension,
 * scorch-re/notes_death_throe_roulette.md).
 *
 * Golden vectors are produced by oracle/dump_death.py from the Python port and
 * written to oracle/vectors/death.json.  The Python dumper drives the REAL
 * scorch.death functions over lightweight mock Tank/Cfg/Terrain/Rng/State
 * objects; this test builds STRUCTURALLY IDENTICAL mocks (same fields, same
 * callback logging, same queue surface, same _ForcedPicks scripted-roll rng,
 * same tick driver) and asserts src/death.ts reproduces every result.
 *
 * EPSILON POLICY:
 *   death.py is integer-only itself: _blast_radius is int(abs(blast)*scale) /
 *   int(FALLBACK*scale) (Python int() == truncation toward zero == Math.trunc),
 *   the roulette is rng.pick(11) with the byte-decoded case-8 reroll (exact
 *   MT-driven integers, already a green gate), and every signal / stage-tick /
 *   depth / ladder radius is integer arithmetic.  The one transcendental
 *   dependency lives in the callee: damage.explode's radial law
 *   round((R-d)*100/R) measures INTEGER pixel coordinates, so Math.sqrt of the
 *   exact-integer squared sum reproduces CPython math.hypot bit-for-bit (the
 *   damage.ts NUMERIC NOTES result).  No roulette case spawns a projectile or
 *   consumes ammo (byte-verified); the flight-hold vector injects a mock
 *   flight from the DRIVER, mirroring the dump exactly.  Hence EVERY
 *   value here -- the signal streams, per-tick list lengths, the ordered
 *   explosion/throe/fountain/carve/destroyed logs, and every tank's post-state
 *   (health/shield/alive/score/cash/y) -- is asserted EXACT (.toBe/.toEqual).
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

/** Delegate rng wrapper: the first forced.length pick(11) calls return the
 *  scripted rolls in order; everything else delegates to the seeded Rng.
 *  Mirrors the dump's _ForcedPicks 1:1. */
class ForcedPicks {
  private _rng: Rng;
  private _forced: number[];
  constructor(rng: Rng, forced: number[]) {
    this._rng = rng;
    this._forced = forced.slice();
  }
  pick(n: number): number {
    if (n === 11 && this._forced.length > 0) {
      return this._forced.shift() as number;
    }
    return this._rng.pick(n);
  }
}

interface MockTank extends DTank {
  id: string;
}
function mkTank(
  id: string,
  o: Partial<Omit<MockTank, "has_ammo">> & { ammo?: number } = {}
): MockTank {
  const selected = o.selected_weapon ?? 0;
  const inventory = new Array<number>(80).fill(0);
  inventory[selected] = o.ammo ?? 0;
  const t: MockTank = {
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
    // case-10 predicate surface: armed weapon + a flat per-slot ammo store.
    // Same simplified has_ammo as the oracle mock (no slot-0 infinite special
    // case) so the predicate outcome is pinned by `ammo` alone.  Nothing is
    // consumed (the decoded cook-off is a visual hull scatter).
    selected_weapon: selected,
    inventory,
    hits_this_round: {},
    hits_career: {},
    // damage.Tank fields the explode path may touch but death never sets:
    parachute_deployed: false,
    parachutes: 0,
    parachute_threshold: 5,
    has_ammo(slot: number): boolean {
      return this.inventory[slot] > 0;
    },
  } as MockTank;
  return t;
}

class MockCfg {
  scoring = C.SCORING_STANDARD;
  team_mode = C.TEAM_NONE;
  SUSPEND_DIRT: number;
  private _sound: boolean;
  private _icon_bar: boolean;
  constructor(o: { sound?: boolean; icon_bar?: boolean; suspend_dirt?: number } = {}) {
    this._sound = o.sound ?? true;
    this._icon_bar = o.icon_bar ?? false;
    this.SUSPEND_DIRT = o.suspend_dirt ?? 0;
  }
  is_on(key: string): boolean {
    if (key === "SOUND") return this._sound;
    if (key === "ICON_BAR") return this._icon_bar;
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

const THROE_TTL = 3; // mock throe lifetime in ticks (aged by the driver)
const FOUNTAIN_TTL = 2; // mock fountain (0x60c3 climb) lifetime in ticks

class MockState implements DState {
  cfg: MockCfg;
  tanks: MockTank[];
  terrain: MockTerrain;
  rng: { pick(n: number): number };
  explosion_scale: number;
  current_shooter: MockTank | null;
  current_weapon: unknown;
  economy = { unit_price: (slot: number) => slot };
  w: number;
  h: number;
  explosions: Array<[number, number, number, boolean, boolean]> = [];
  throes: Array<[string, number, number, number, number | null]> = [];
  fountains: Array<[number, number, number, number, number, number]> = [];
  destroyed: Array<[string, boolean]> = [];
  // bound only when withFountain (so the undefined check fails otherwise,
  // exactly like a GameState stub lacking the emitter)
  add_death_fountain?: (
    x: number,
    y: number,
    top: number,
    kw?: { color?: number; stride?: number; scatter?: number }
  ) => void;
  // bound only when withQueue (the staged surface; absent = the stub paths)
  death_queue?: death.DeathEntry[];
  throe_fx?: Array<{ ttl: number }>;
  death_fountains?: Array<{ ttl: number }>;
  projectiles?: unknown[];
  private _withQueue: boolean;
  constructor(
    o: {
      cfg?: MockCfg;
      tanks?: MockTank[];
      terrain?: MockTerrain;
      rng?: { pick(n: number): number };
      explosion_scale?: number;
      current_shooter?: MockTank | null;
      current_weapon?: unknown;
      w?: number;
      h?: number;
      withFountain?: boolean;
      withQueue?: boolean;
    } = {}
  ) {
    const w = o.w ?? 360;
    const h = o.h ?? 480;
    this.w = w;
    this.h = h;
    this.cfg = o.cfg ?? new MockCfg();
    this.tanks = o.tanks ?? [];
    this.terrain = o.terrain ?? new MockTerrain(w, h);
    this.rng = o.rng ?? new Rng(0);
    this.explosion_scale = o.explosion_scale ?? 1.0;
    this.current_shooter = o.current_shooter ?? null;
    this.current_weapon = o.current_weapon ?? null;
    this._withQueue = o.withQueue ?? false;
    if (o.withFountain ?? true) {
      this.add_death_fountain = (x, y, top, kw) => {
        // Python signature add_death_fountain(x, y, top, color=15, stride=6,
        // scatter=1): log the resolved [x, y, top, color, stride, scatter].
        const color = kw?.color ?? 15;
        const stride = kw?.stride ?? 6;
        const scatter = kw?.scatter ?? 1;
        this.fountains.push([x, y, top, color, stride, scatter]);
        if (this._withQueue) {
          (this.death_fountains as Array<{ ttl: number }>).push({ ttl: FOUNTAIN_TTL });
        }
      };
    }
    if (this._withQueue) {
      this.death_queue = [];
      this.throe_fx = [];
      this.death_fountains = [];
      this.projectiles = [];
    }
  }
  add_explosion(x: number, y: number, r: number, kw?: { [k: string]: unknown }): void {
    const dirt_only = Boolean(kw?.["dirt_only"]);
    const nuke = Boolean(kw?.["nuke"]);
    this.explosions.push([Math.trunc(x), Math.trunc(y), Math.trunc(r), dirt_only, nuke]);
  }
  add_throe(kind: string, x: number, y: number, color: number, life?: number | null): void {
    this.throes.push([kind, x, y, color, life ?? null]);
    if (this._withQueue) {
      (this.throe_fx as Array<{ ttl: number }>).push({ ttl: THROE_TTL });
    }
  }
  on_tank_destroyed(victim: DTank, weapon: unknown): void {
    this.destroyed.push([
      (victim as unknown as MockTank).id,
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
  throes: Array<[string, number, number, number, number | null]>;
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
type TickRec = {
  sig: Array<[string, unknown]>;
  q: number;
  throe: number;
  fount: number;
  proj: number;
};
type Vec = {
  consts: Array<{
    THROE_FRONT_TICKS: number;
    THROE_DELAY_TICKS: number;
    RADIUS_SMALL: number;
    RADIUS_LARGE: number;
    RADIUS_CAP: number;
    SINK_DEPTH_MIN: number;
    SINK_DEPTH_RAND: number;
    BALL_STEP_FRAMES: number;
    DEBRIS_PUFF_RADIUS: number;
    DEBRIS_ROW_STRIDE: number;
    DEBRIS_TOP_MARGIN: number;
    DEATH_BLAST_FALLBACK: number;
    PLAYFIELD_TOP: number;
    STATUS_BAR_H: number;
  }>;
  blast_radius: Array<{ idx: number; name: string; blast: number; scale: number; out: number }>;
  roll_throe: Array<{ seed: number; suspend: number; out: number[] }>;
  sequence_immediate: Array<{
    roll: number;
    tank: string;
    x: number;
    y: number;
    col: number;
    scale: number;
    ammo: number;
    ret: number;
    victim: TSnap;
    o1: TSnap;
    o2: TSnap;
    o3: TSnap;
    shooter: TSnap;
    state: StateSnap;
  }>;
  retreat_stub: Array<{
    widx: number;
    wname: string;
    scale: number;
    icon_bar: boolean;
    with_fountain: boolean;
    victim: TSnap;
    o1: TSnap;
    o3: TSnap;
    state: StateSnap;
  }>;
  debris_fountain: Array<{
    tank: string;
    x: number;
    y: number;
    col: number;
    scatter: boolean;
    icon_bar: boolean;
    fountains: Array<[number, number, number, number, number, number]>;
    explosions: Array<[number, number, number, boolean, boolean]>;
  }>;
  debris_fountain_fallback: Array<{
    w: number;
    x: number;
    explosions: Array<[number, number, number, boolean, boolean]>;
    fountains: Array<[number, number, number, number, number, number]>;
  }>;
  staged: Array<{
    case: string;
    seed: number;
    forced: number[];
    victims: number;
    ammo: number;
    selected: number;
    hold_flight: boolean;
    ascension: boolean;
    n_ticks: number;
    ticks: TickRec[];
    v1: TSnap;
    v1_y: number;
    o1: TSnap;
    o2: TSnap;
    v2: TSnap | null;
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
    expect(death.THROE_FRONT_TICKS).toBe(c.THROE_FRONT_TICKS);
    expect(death.THROE_DELAY_TICKS).toBe(c.THROE_DELAY_TICKS);
    expect(death.RADIUS_SMALL).toBe(c.RADIUS_SMALL);
    expect(death.RADIUS_LARGE).toBe(c.RADIUS_LARGE);
    expect(death.RADIUS_CAP).toBe(c.RADIUS_CAP);
    expect(death.SINK_DEPTH_MIN).toBe(c.SINK_DEPTH_MIN);
    expect(death.SINK_DEPTH_RAND).toBe(c.SINK_DEPTH_RAND);
    expect(death.BALL_STEP_FRAMES).toBe(c.BALL_STEP_FRAMES);
    expect(death.DEBRIS_PUFF_RADIUS).toBe(c.DEBRIS_PUFF_RADIUS);
    expect(death.DEBRIS_ROW_STRIDE).toBe(c.DEBRIS_ROW_STRIDE);
    expect(death.DEBRIS_TOP_MARGIN).toBe(c.DEBRIS_TOP_MARGIN);
    expect(death.DEATH_BLAST_FALLBACK).toBe(c.DEATH_BLAST_FALLBACK);
    expect(death.PLAYFIELD_TOP).toBe(c.PLAYFIELD_TOP);
    expect(death.STATUS_BAR_H).toBe(c.STATUS_BAR_H);
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

describe("death: _roll_throe (rand(11) + the Suspend-Dirt case-8 reroll)", () => {
  for (const { seed, suspend, out } of vec.roll_throe) {
    it(`seed ${seed} suspend=${suspend}: ${out.length} rolls match`, () => {
      const st = new MockState({
        cfg: new MockCfg({ suspend_dirt: suspend }),
        rng: new Rng(seed),
      });
      for (let i = 0; i < out.length; i++) {
        const got = death._roll_throe(st);
        expect(got, `roll #${i} seed ${seed} suspend ${suspend}`).toBe(out[i]);
        // it is genuinely a roulette index in [0, 11); 8 is rerolled away
        // while Suspend-Dirt is nonzero (FUN_271b_0005 offsets 00f4..010a).
        expect(got >= 0 && got < 11, `roll #${i} range`).toBe(true);
        if (suspend !== 0) {
          expect(got, `roll #${i} suspend excludes sink`).not.toBe(8);
        }
      }
    });
  }
});

describe("death: death_sequence STUB path (immediate case bodies, forced rolls)", () => {
  it(`all ${vec.sequence_immediate.length} immediate sequences match exactly`, () => {
    for (const r of vec.sequence_immediate) {
      const victim = mkTank("v", {
        x: r.x, y: r.y, color: r.col, team_id: 2, player_index: 0,
        health: 0, alive: false, ammo: r.ammo,
      });
      const o1 = mkTank("o1", { x: r.x + 6, y: r.y, team_id: 2, player_index: 1, health: 100 });
      const o2 = mkTank("o2", { x: r.x + 9, y: r.y, team_id: 2, player_index: 2, health: 0, alive: false });
      const o3 = mkTank("o3", { x: r.x + 150, y: r.y, team_id: 2, player_index: 3, health: 100 });
      const shooter = mkTank("s", { x: r.x - 100, y: r.y, team_id: 1, player_index: 5 });
      const st = new MockState({
        tanks: [victim, o1, o2, o3],
        rng: new ForcedPicks(new Rng(1000 + r.roll), [r.roll]),
        explosion_scale: r.scale,
        current_shooter: shooter,
      });
      const label = `sequence_immediate roll=${r.roll} ${r.tank} sc=${r.scale}`;
      const ret = death.death_sequence(st, victim, null);
      expect(ret, `${label} ret`).toBe(r.ret);
      expectTSnap(tsnap(victim), r.victim, `${label} victim`);
      expectTSnap(tsnap(o1), r.o1, `${label} o1`);
      expectTSnap(tsnap(o2), r.o2, `${label} o2`);
      expectTSnap(tsnap(o3), r.o3, `${label} o3`);
      expectTSnap(tsnap(shooter), r.shooter, `${label} shooter`);
      expectState(st, r.state, label);
    }
  });
});

describe("death: retreat_sequence STUB path (fountain + weapon-radius grave blast)", () => {
  it(`all ${vec.retreat_stub.length} immediate retreats match exactly`, () => {
    for (const r of vec.retreat_stub) {
      const weapon: Item | null = r.widx >= 0 ? ITEMS[r.widx] : null;
      const victim = mkTank("v", {
        x: 200, y: 300, color: 7, team_id: 2, player_index: 0,
        health: 0, alive: false,
      });
      const o1 = mkTank("o1", { x: 206, y: 300, team_id: 2, player_index: 1, health: 100 });
      const o3 = mkTank("o3", { x: 20, y: 300, team_id: 2, player_index: 3, health: 100 });
      const st = new MockState({
        cfg: new MockCfg({ icon_bar: r.icon_bar }),
        tanks: [victim, o1, o3],
        rng: new Rng(3),
        explosion_scale: r.scale,
        current_shooter: null,
        withFountain: r.with_fountain,
      });
      const label = `retreat_stub w=${r.wname} sc=${r.scale} bar=${r.icon_bar} f=${r.with_fountain}`;
      death.retreat_sequence(st, victim, weapon);
      expectTSnap(tsnap(victim), r.victim, `${label} victim`);
      expectTSnap(tsnap(o1), r.o1, `${label} o1`);
      expectTSnap(tsnap(o3), r.o3, `${label} o3`);
      expectState(st, r.state, label);
    }
  });
});

describe("death: _debris_fountain (emitter present; ICON_BAR top clip)", () => {
  it(`all ${vec.debris_fountain.length} fountain registrations match exactly`, () => {
    for (const r of vec.debris_fountain) {
      const st = new MockState({
        cfg: new MockCfg({ icon_bar: r.icon_bar }),
        withFountain: true,
      });
      const tk = mkTank("t", { x: r.x, y: r.y, color: r.col });
      death._debris_fountain(st, tk, r.scatter);
      expect(
        st.fountains,
        `debris_fountain ${r.tank} scatter=${r.scatter} bar=${r.icon_bar} fountains`
      ).toEqual(r.fountains);
      expect(
        st.explosions,
        `debris_fountain ${r.tank} scatter=${r.scatter} bar=${r.icon_bar} explosions`
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

describe("death: STAGED step_queue (signals, waits, chains, flight blocking)", () => {
  for (const r of vec.staged) {
    it(`case ${r.case}: ${r.n_ticks} ticks, signal stream + FX lengths match`, () => {
      // Rebuild the exact staged mock the oracle built.
      const v1 = mkTank("v1", {
        x: 200,
        y: r.case === "roll8_deep" ? 470 : 300,
        color: 7, team_id: 2, player_index: 0, health: 0, alive: false,
        selected_weapon: r.selected, ammo: r.ammo,
      });
      const o1 = mkTank("o1", { x: 206, y: 300, team_id: 2, player_index: 1, health: 100 });
      const o2 = mkTank("o2", { x: 215, y: 300, team_id: 2, player_index: 2, health: 0, alive: false });
      const tanks = [v1, o1, o2];
      let v2: MockTank | null = null;
      if (r.victims > 1) {
        v2 = mkTank("v2", { x: 100, y: 280, color: 4, team_id: 2, player_index: 4, health: 0, alive: false });
        tanks.push(v2);
      }
      const shooter = mkTank("s", { x: 50, y: 300, team_id: 1, player_index: 5 });
      const st = new MockState({
        tanks,
        rng: new ForcedPicks(new Rng(r.seed), r.forced),
        explosion_scale: 1.0,
        current_shooter: shooter,
        withQueue: true,
      });
      if (r.ascension) {
        death.retreat_sequence(st, v1, null);
      } else {
        death.death_sequence(st, v1, null);
        if (v2 !== null) {
          death.death_sequence(st, v2, null);
        }
      }
      if (r.hold_flight) {
        // no roulette case spawns a flight (byte-verified), so inject one:
        // the killing shot still airborne when a settle-path kill enqueued.
        (st.projectiles as unknown[]).push({ mock: true });
      }
      // Tick driver: identical to the oracle's -- (1) age the mock FX/flight
      // lists (throe ttl 3, fountain ttl 2, projectile drains 2 ticks after
      // spawn; in-place, the Python slice-assignment semantics), (2)
      // step_queue, (3) record.
      const age = (list: Array<{ ttl: number }>): void => {
        for (const e of list) e.ttl -= 1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].ttl <= 0) list.splice(i, 1);
        }
      };
      const ticks: TickRec[] = [];
      let projCountdown: number | null = null;
      const q = st.death_queue as death.DeathEntry[];
      const throeFx = st.throe_fx as Array<{ ttl: number }>;
      const fountains = st.death_fountains as Array<{ ttl: number }>;
      const projectiles = st.projectiles as unknown[];
      for (let k = 0; k < 200; k++) {
        age(throeFx);
        age(fountains);
        if (projectiles.length > 0) {
          if (projCountdown === null) {
            projCountdown = 2;
          } else {
            projCountdown -= 1;
            if (projCountdown <= 0) {
              projectiles.length = 0;
              projCountdown = null;
            }
          }
        }
        const sigs = death.step_queue(st);
        ticks.push({
          sig: sigs.map(([s, p]) => [
            s,
            p !== null && typeof p === "object" && "id" in (p as object)
              ? (p as MockTank).id
              : p,
          ]),
          q: q.length,
          throe: throeFx.length,
          fount: fountains.length,
          proj: projectiles.length,
        });
        if (
          q.length === 0 &&
          throeFx.length === 0 &&
          fountains.length === 0 &&
          projectiles.length === 0
        ) {
          break;
        }
      }
      const label = `staged ${r.case}`;
      expect(ticks.length, `${label} tick count`).toBe(r.n_ticks);
      for (let i = 0; i < r.ticks.length; i++) {
        expect(ticks[i].sig, `${label} tick ${i} signals`).toEqual(r.ticks[i].sig);
        expect(ticks[i].q, `${label} tick ${i} queue_n`).toBe(r.ticks[i].q);
        expect(ticks[i].throe, `${label} tick ${i} throe_n`).toBe(r.ticks[i].throe);
        expect(ticks[i].fount, `${label} tick ${i} fountain_n`).toBe(r.ticks[i].fount);
        expect(ticks[i].proj, `${label} tick ${i} proj_n`).toBe(r.ticks[i].proj);
      }
      expectTSnap(tsnap(v1), r.v1, `${label} v1`);
      expect(v1.y, `${label} v1_y (sink descent + floor clamp)`).toBe(r.v1_y);
      expectTSnap(tsnap(o1), r.o1, `${label} o1`);
      expectTSnap(tsnap(o2), r.o2, `${label} o2`);
      if (v2 !== null) {
        expectTSnap(tsnap(v2), r.v2 as TSnap, `${label} v2`);
      } else {
        expect(r.v2, `${label} v2 null`).toBeNull();
      }
      expectTSnap(tsnap(shooter), r.shooter, `${label} shooter`);
      expectState(st, r.state, label);
    });
  }
});

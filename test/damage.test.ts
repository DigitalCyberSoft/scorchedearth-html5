/**
 * Differential gate: TS damage == Python scorch.damage (the byte-verified oracle).
 *
 * Golden vectors are produced by oracle/dump_damage.py from the Python port and
 * written to oracle/vectors/damage.json. The Python dumper drives the REAL
 * scorch.damage functions over lightweight mock Tank/Cfg/Terrain/State objects;
 * this test builds STRUCTURALLY IDENTICAL mocks (same fields, same is_supported
 * model, same callback logging) and asserts src/damage.ts reproduces every result.
 *
 * EPSILON POLICY:
 *   Every damage/health/shield/score/cash/hit-counter/boolean/index output is an
 *   INTEGER or boolean and is asserted EXACT (.toBe). The ONLY transcendental on
 *   the path is the blast distance d = hypot(dx, dy) inside explode(); the port
 *   computes it as Math.sqrt(dx*dx + dy*dy). Because the engine only measures
 *   distance between INTEGER pixel coordinates, dx,dy are integers, dx*dx+dy*dy is
 *   an exact integer, and a single correctly-rounded sqrt reproduces CPython's
 *   math.hypot BIT-FOR-BIT (measured 0/441 integer-grid mismatches; V8's
 *   Math.hypot, by contrast, splits by 1 ULP and is deliberately NOT used). So the
 *   recorded float d is asserted within a tight epsilon (.toBeCloseTo(d, 12)) per
 *   the brief's rule for sqrt-derived floats, AND every dependent damage integer
 *   is asserted EXACT -- the exactness holds because the integer-grid sqrt is
 *   bit-exact and pyRound matches CPython's banker's rounding (measured 0/1109).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as damage from "../src/damage";
import type { Tank, Cfg, Terrain, State } from "../src/damage";
import * as C from "../src/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "damage.json");

// ---------------------------------------------------------------------------
// Mocks -- mirror oracle/dump_damage.py exactly (same fields, same support model,
// same callback logs). `id` is carried for the destroyed-log comparison.
// ---------------------------------------------------------------------------
interface MockTank extends Tank {
  id: string;
}

function mkTank(
  id: string,
  o: Partial<MockTank> = {}
): MockTank {
  return {
    id,
    x: o.x ?? 100,
    y: o.y ?? 100,
    half_width: o.half_width ?? 8,
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
    parachute_deployed: o.parachute_deployed ?? false,
    parachutes: o.parachutes ?? 0,
    parachute_threshold: o.parachute_threshold ?? 5,
  };
}

class MockCfg implements Cfg {
  scoring: number;
  team_mode: number;
  private _sound: boolean;
  constructor(scoring: number, team_mode: number, sound = true) {
    this.scoring = scoring;
    this.team_mode = team_mode;
    this._sound = sound;
  }
  is_on(key: string): boolean {
    if (key === "SOUND") return this._sound;
    return false;
  }
}

class MockTerrain implements Terrain {
  h: number;
  support_y: number | null;
  carves: number[][] = [];
  constructor(h = 480, support_y: number | null = null) {
    this.h = h;
    this.support_y = support_y;
  }
  carve_circle(cx: number, cy: number, radius: number): void {
    this.carves.push([cx, cy, radius]);
  }
  is_supported(_x: number, y: number, _half_width: number): boolean {
    if (this.support_y === null) return false;
    return y >= this.support_y;
  }
}

class MockState implements State {
  cfg: Cfg;
  tanks: MockTank[];
  terrain: MockTerrain;
  current_shooter: MockTank | null;
  current_weapon: unknown;
  economy = { unit_price: (slot: number) => slot };
  explosions: number[][] = [];
  destroyed: Array<[string, boolean]> = [];
  constructor(opts: {
    cfg?: Cfg;
    tanks?: MockTank[];
    terrain?: MockTerrain;
    current_shooter?: MockTank | null;
    current_weapon?: unknown;
  } = {}) {
    this.cfg = opts.cfg ?? new MockCfg(C.SCORING_STANDARD, C.TEAM_NONE);
    this.tanks = opts.tanks ?? [];
    this.terrain = opts.terrain ?? new MockTerrain();
    this.current_shooter = opts.current_shooter ?? null;
    this.current_weapon = opts.current_weapon ?? null;
  }
  add_explosion(cx: number, cy: number, radius: number): void {
    this.explosions.push([cx, cy, radius]);
  }
  on_tank_destroyed(victim: Tank, weapon: unknown): void {
    this.destroyed.push([(victim as MockTank).id, weapon !== null && weapon !== undefined]);
  }
}

/** Snapshot order MUST match dump_damage._snap. */
type Snap = [number, number, number, boolean, number, number, number];
function snap(t: MockTank): Snap {
  return [t.health, t.shield_hp, t.shield_item, t.alive, t.score, t.cash, t.win_counter];
}
function expectSnap(got: Snap, want: Snap, label: string): void {
  expect(got[0], `${label} health`).toBe(want[0]);
  expect(got[1], `${label} shield_hp`).toBe(want[1]);
  expect(got[2], `${label} shield_item`).toBe(want[2]);
  expect(got[3], `${label} alive`).toBe(want[3]);
  expect(got[4], `${label} score`).toBe(want[4]);
  expect(got[5], `${label} cash`).toBe(want[5]);
  expect(got[6], `${label} win_counter`).toBe(want[6]);
}

type HitSnap = { round: [number, number][]; career: [number, number][] };
function hitsnap(t: MockTank): HitSnap {
  const sortPairs = (m: { [k: number]: number }): [number, number][] =>
    Object.keys(m)
      .map((k) => Number(k))
      .sort((a, b) => a - b)
      .map((k) => [k, m[k]] as [number, number]);
  return { round: sortPairs(t.hits_this_round), career: sortPairs(t.hits_career) };
}
function expectHits(got: HitSnap, want: HitSnap, label: string): void {
  expect(got.round, `${label} hits_round`).toEqual(want.round);
  expect(got.career, `${label} hits_career`).toEqual(want.career);
}

function expectDestroyed(
  got: Array<[string, boolean]>,
  want: Array<[string | unknown, boolean]>,
  label: string
): void {
  expect(got.length, `${label} destroyed count`).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(got[i][0], `${label} destroyed[${i}].id`).toBe(want[i][0]);
    expect(got[i][1], `${label} destroyed[${i}].weapon`).toBe(want[i][1]);
  }
}

// ---------------------------------------------------------------------------
// Vector types
// ---------------------------------------------------------------------------
type ConstCase = { fn: "const"; SHIELD_CHIP_FULL: number; FALLOFF_NUM: number; FALL_DMG_PER_PIXEL: number };
type PyRoundCase = { fn: "pyround"; x: number; out: number };
type ShieldGateCase = {
  fn: "shield_gate"; amount: number; shield_hp_in: number;
  overflow: number; absorbed: number; shield_hp_out: number; shield_item_out: number;
};
type ApplyTankCase = {
  fn: "apply_tank_damage"; scoring: number; sound: boolean; has_shooter: boolean;
  friendly: boolean; amount: number; shield_hp_in: number; health_in: number;
  victim: Snap; victim_hits: HitSnap; destroyed: Array<[string, boolean]>;
  shooter?: Snap;
};
type HealthDirectCase = {
  fn: "health_direct"; scoring: number; count_hit: boolean; amount: number;
  health_in: number; alive_in: boolean; victim: Snap; shooter: Snap;
  destroyed: Array<[string, boolean]>;
};
type DirectHitCase = {
  fn: "direct_hit"; scoring: number; health_in: number; alive_in: boolean;
  victim: Snap; shooter: Snap; destroyed: Array<[string, boolean]>;
};
type FallDamageCase = {
  fn: "fall_damage"; scoring: number; amount: number; health_in: number;
  shield_hp_in: number; victim: Snap; shooter: Snap; victim_hits: HitSnap;
  destroyed: Array<[string, boolean]>;
};
type KillTankCase = {
  fn: "kill_tank"; scoring: number; alive_in: boolean; warg: boolean;
  wstate: boolean; rel: string; victim: Snap; destroyed: Array<[string, boolean]>;
  shooter?: Snap;
};
type ShieldChipCase = {
  fn: "shield_chip"; damage: number | null; used: number; shield_hp_in: number;
  shield_hp_out: number; shield_item_out: number;
};
type ExplodeCase = {
  fn: "explode"; R: number; dx: number; dy: number; cx: number; cy: number;
  d: number; in_range: boolean; expected_dmg: number | null;
  victim: Snap; shooter: Snap; victim_hits: HitSnap;
  carves: number[][]; explosions: number[][]; destroyed: Array<[string, boolean]>;
};
type ExplodeEdgeCase =
  | {
      fn: "explode_edge"; case: "radius0" | "radius_neg" | "no_carve";
      victim: Snap; carves: number[][]; explosions: number[][];
      destroyed: Array<[string, boolean]>;
    }
  | {
      fn: "explode_edge"; case: "multi";
      tanks: { [id: string]: Snap }; shooter: Snap;
      carves: number[][]; explosions: number[][]; destroyed: Array<[string, boolean]>;
    };
type PredictedFallCase = {
  fn: "predicted_fall"; h: number; start_y: number; support_y: number;
  out: number; tank_y_after: number;
};
type ChuteCase = {
  fn: "chute_deploy"; deployed: boolean; chutes: number; threshold: number;
  support_y: number; predicted: number; out: boolean;
};

type DamageVectors = {
  module: string;
  consts: ConstCase[];
  pyround: PyRoundCase[];
  shield_gate: ShieldGateCase[];
  apply_tank_damage: ApplyTankCase[];
  health_direct: HealthDirectCase[];
  direct_hit: DirectHitCase[];
  fall_damage: FallDamageCase[];
  kill_tank: KillTankCase[];
  shield_chip: ShieldChipCase[];
  explode: (ExplodeCase | ExplodeEdgeCase)[];
  predicted_fall: PredictedFallCase[];
  chute_deploy: ChuteCase[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as DamageVectors;

// Cast helpers for the mock<->scoring/state structural bridges.
const asState = (s: MockState): State => s;

describe("damage: oracle/mock invariants", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("damage");
  });
  it("vector battery is non-trivial", () => {
    const n =
      vec.pyround.length +
      vec.shield_gate.length +
      vec.apply_tank_damage.length +
      vec.health_direct.length +
      vec.direct_hit.length +
      vec.fall_damage.length +
      vec.kill_tank.length +
      vec.shield_chip.length +
      vec.explode.length +
      vec.predicted_fall.length +
      vec.chute_deploy.length;
    expect(n).toBeGreaterThan(2000);
  });
});

describe("damage: module constants", () => {
  for (const c of vec.consts) {
    it("SHIELD_CHIP_FULL / FALLOFF_NUM / FALL_DMG_PER_PIXEL", () => {
      expect(damage.SHIELD_CHIP_FULL).toBe(c.SHIELD_CHIP_FULL);
      expect(C.FALLOFF_NUM).toBe(c.FALLOFF_NUM);
      expect(C.FALL_DMG_PER_PIXEL).toBe(c.FALL_DMG_PER_PIXEL);
    });
  }
});

describe("damage: pyRound (banker's rounding == CPython round)", () => {
  it(`${vec.pyround.length} round() samples (incl. all exact half-integers) match`, () => {
    for (let i = 0; i < vec.pyround.length; i++) {
      const c = vec.pyround[i];
      expect(damage.pyRound(c.x), `pyRound(${c.x}) #${i}`).toBe(c.out);
    }
  });
});

describe("damage: shield_gate (absorb / destroy / overflow)", () => {
  for (let i = 0; i < vec.shield_gate.length; i++) {
    const c = vec.shield_gate[i];
    it(`#${i} amount=${c.amount} S=${c.shield_hp_in}`, () => {
      const t = mkTank("t", { shield_hp: c.shield_hp_in, shield_item: c.shield_hp_in ? 1 : 0 });
      const [ov, ab] = damage.shield_gate(t, c.amount);
      expect(ov, `${i} overflow`).toBe(c.overflow);
      expect(ab, `${i} absorbed`).toBe(c.absorbed);
      expect(t.shield_hp, `${i} shield_hp_out`).toBe(c.shield_hp_out);
      expect(t.shield_item, `${i} shield_item_out`).toBe(c.shield_item_out);
    });
  }
});

describe("damage: apply_tank_damage (shield gate + health + scoring + hit counters)", () => {
  for (let i = 0; i < vec.apply_tank_damage.length; i++) {
    const c = vec.apply_tank_damage[i];
    const label = `#${i} sc=${c.scoring} snd=${c.sound} shooter=${c.has_shooter} fr=${c.friendly} amt=${c.amount} S=${c.shield_hp_in} hp=${c.health_in}`;
    it(label, () => {
      const cfg = new MockCfg(c.scoring, C.TEAM_STANDARD, c.sound);
      const victim = mkTank("v", {
        team_id: 1, health: c.health_in, shield_hp: c.shield_hp_in,
        shield_item: c.shield_hp_in ? 1 : 0, player_index: 0,
      });
      let shooter: MockTank | null = null;
      let tanks: MockTank[] = [victim];
      if (c.has_shooter) {
        shooter = mkTank("s", { team_id: c.friendly ? 1 : 2, player_index: 3 });
        tanks = [shooter, victim];
      }
      const st = new MockState({ cfg, tanks, current_shooter: shooter });
      damage.apply_tank_damage(asState(st), victim, c.amount);
      expectSnap(snap(victim), c.victim, `${label} victim`);
      expectHits(hitsnap(victim), c.victim_hits, label);
      expectDestroyed(st.destroyed, c.destroyed, label);
      if (c.shooter !== undefined && shooter !== null) {
        expectSnap(snap(shooter), c.shooter, `${label} shooter`);
      }
    });
  }
});

describe("damage: _apply_health_direct (count_hit toggle, kill, guards)", () => {
  for (let i = 0; i < vec.health_direct.length; i++) {
    const c = vec.health_direct[i];
    const label = `#${i} sc=${c.scoring} count=${c.count_hit} amt=${c.amount} hp=${c.health_in} alive=${c.alive_in}`;
    it(label, () => {
      const cfg = new MockCfg(c.scoring, C.TEAM_STANDARD);
      const victim = mkTank("v", { team_id: 1, health: c.health_in, alive: c.alive_in, player_index: 0 });
      const shooter = mkTank("s", { team_id: 2, player_index: 2 });
      const st = new MockState({ cfg, tanks: [shooter, victim], current_shooter: shooter });
      damage._apply_health_direct(asState(st), victim, c.amount, c.count_hit);
      expectSnap(snap(victim), c.victim, `${label} victim`);
      expectSnap(snap(shooter), c.shooter, `${label} shooter`);
      expectDestroyed(st.destroyed, c.destroyed, label);
    });
  }
});

describe("damage: direct_hit (full-health kill via health-direct)", () => {
  for (let i = 0; i < vec.direct_hit.length; i++) {
    const c = vec.direct_hit[i];
    const label = `#${i} sc=${c.scoring} hp=${c.health_in} alive=${c.alive_in}`;
    it(label, () => {
      const cfg = new MockCfg(c.scoring, C.TEAM_STANDARD);
      const victim = mkTank("v", { team_id: 1, health: c.health_in, alive: c.alive_in, player_index: 0 });
      const shooter = mkTank("s", { team_id: 2, player_index: 1 });
      const st = new MockState({ cfg, tanks: [shooter, victim], current_shooter: shooter, current_weapon: "W" });
      damage.direct_hit(asState(st), victim);
      expectSnap(snap(victim), c.victim, `${label} victim`);
      expectSnap(snap(shooter), c.shooter, `${label} shooter`);
      expectDestroyed(st.destroyed, c.destroyed, label);
    });
  }
});

describe("damage: apply_fall_damage (health-direct, no shield, no counter, no shooter credit)", () => {
  for (let i = 0; i < vec.fall_damage.length; i++) {
    const c = vec.fall_damage[i];
    const label = `#${i} sc=${c.scoring} amt=${c.amount} hp=${c.health_in} S=${c.shield_hp_in}`;
    it(label, () => {
      const cfg = new MockCfg(c.scoring, C.TEAM_STANDARD);
      const shooter = mkTank("s", { team_id: 2, player_index: 4 });
      const victim = mkTank("v", {
        team_id: 1, health: c.health_in, shield_hp: c.shield_hp_in,
        shield_item: c.shield_hp_in ? 1 : 0, player_index: 0,
      });
      const st = new MockState({ cfg, tanks: [shooter, victim], current_shooter: shooter });
      damage.apply_fall_damage(asState(st), victim, c.amount);
      expectSnap(snap(victim), c.victim, `${label} victim`);
      expectSnap(snap(shooter), c.shooter, `${label} shooter`);
      expectHits(hitsnap(victim), c.victim_hits, label);
      expectDestroyed(st.destroyed, c.destroyed, label);
    });
  }
});

describe("damage: kill_tank (alive gate, weapon fallback, award_kill)", () => {
  for (let i = 0; i < vec.kill_tank.length; i++) {
    const c = vec.kill_tank[i];
    const label = `#${i} sc=${c.scoring} alive=${c.alive_in} warg=${c.warg} wstate=${c.wstate} rel=${c.rel}`;
    it(label, () => {
      const cfg = new MockCfg(c.scoring, C.TEAM_STANDARD);
      const victim = mkTank("v", { team_id: 1, alive: c.alive_in, health: 50, player_index: 0 });
      let shooter: MockTank | null = null;
      let tanks: MockTank[] = [victim];
      if (c.rel === "self") {
        shooter = victim;
      } else if (c.rel === "teammate") {
        shooter = mkTank("s", { team_id: 1, player_index: 5 });
        tanks = [shooter, victim];
      } else if (c.rel === "enemy") {
        shooter = mkTank("s", { team_id: 2, player_index: 5 });
        tanks = [shooter, victim];
      }
      const st = new MockState({
        cfg, tanks, current_shooter: shooter,
        current_weapon: c.wstate ? "SW" : null,
      });
      const weapon = c.warg ? "AW" : null;
      damage.kill_tank(asState(st), victim, weapon);
      expectSnap(snap(victim), c.victim, `${label} victim`);
      expectDestroyed(st.destroyed, c.destroyed, label);
      if (c.shooter !== undefined && shooter !== null && shooter !== victim) {
        expectSnap(snap(shooter), c.shooter, `${label} shooter`);
      }
    });
  }
});

describe("damage: shield_chip (absorb / destroy / clamp / default 100)", () => {
  for (let i = 0; i < vec.shield_chip.length; i++) {
    const c = vec.shield_chip[i];
    const label = `#${i} dmg=${c.damage} S=${c.shield_hp_in}`;
    it(label, () => {
      const t = mkTank("t", { shield_hp: c.shield_hp_in, shield_item: c.shield_hp_in ? 1 : 0 });
      if (c.damage === null) {
        damage.shield_chip(t);
      } else {
        damage.shield_chip(t, c.damage);
      }
      expect(t.shield_hp, `${label} shield_hp_out`).toBe(c.shield_hp_out);
      expect(t.shield_item, `${label} shield_item_out`).toBe(c.shield_item_out);
    });
  }
});

describe("damage: explode (radial linear law, exact-distance placements)", () => {
  // d is sqrt-derived: asserted within 1e-12 (it is in fact bit-exact for these
  // integer-grid offsets, which is why every dependent damage integer is exact).
  for (let i = 0; i < vec.explode.length; i++) {
    const raw = vec.explode[i];
    if (raw.fn !== "explode") continue;
    const c = raw as ExplodeCase;
    const label = `#${i} R=${c.R} d=(${c.dx},${c.dy})`;
    it(label, () => {
      const cfg = new MockCfg(C.SCORING_STANDARD, C.TEAM_STANDARD, true);
      const victim = mkTank("v", { x: c.cx + c.dx, y: c.cy + c.dy, team_id: 1, health: 100, player_index: 0 });
      const shooter = mkTank("s", { x: 10, y: 10, team_id: 2, player_index: 7 });
      const st = new MockState({ cfg, tanks: [shooter, victim], current_shooter: shooter, current_weapon: "EXPL" });
      // Confirm the TS distance matches the oracle's recorded float (sqrt-derived).
      const dTs = Math.sqrt(c.dx * c.dx + c.dy * c.dy);
      expect(dTs, `${label} d`).toBeCloseTo(c.d, 12);
      damage.explode(asState(st), c.cx, c.cy, c.R, true);
      expectSnap(snap(victim), c.victim, `${label} victim`);
      expectSnap(snap(shooter), c.shooter, `${label} shooter`);
      expectHits(hitsnap(victim), c.victim_hits, label);
      expect(st.terrain.carves, `${label} carves`).toEqual(c.carves);
      expect(st.explosions, `${label} explosions`).toEqual(c.explosions);
      expectDestroyed(st.destroyed, c.destroyed, label);
    });
  }
});

describe("damage: explode edge cases (radius<=0, carve=false, multi-tank rings)", () => {
  for (let i = 0; i < vec.explode.length; i++) {
    const raw = vec.explode[i];
    if (raw.fn !== "explode_edge") continue;
    const c = raw as ExplodeEdgeCase;
    const cx = 300;
    const cy = 300;
    if (c.case === "radius0" || c.case === "radius_neg" || c.case === "no_carve") {
      it(`edge ${c.case}`, () => {
        const cfg = new MockCfg(C.SCORING_STANDARD, C.TEAM_STANDARD);
        const v = mkTank("v", { x: cx, y: cy, team_id: 1, health: 100, player_index: 0 });
        const s = mkTank("s", { team_id: 2, player_index: 1 });
        const st = new MockState({
          cfg, tanks: [s, v], current_shooter: s,
          current_weapon: c.case === "no_carve" ? "W" : null,
        });
        const R = c.case === "radius0" ? 0 : c.case === "radius_neg" ? -5 : 50;
        const carve = c.case !== "no_carve";
        damage.explode(asState(st), cx, cy, R, carve);
        expectSnap(snap(v), c.victim, `edge ${c.case} victim`);
        expect(st.terrain.carves, `edge ${c.case} carves`).toEqual(c.carves);
        expect(st.explosions, `edge ${c.case} explosions`).toEqual(c.explosions);
        expectDestroyed(st.destroyed, c.destroyed, `edge ${c.case}`);
      });
    } else {
      // Only the "multi" edge arm remains here; alias c at that discriminant so
      // the multi-only fields (tanks, shooter) narrow without a type error.
      const cm = c as Extract<ExplodeEdgeCase, { case: "multi" }>;
      it("edge multi-tank rings + dead-skip + shield", () => {
        const cfg = new MockCfg(C.SCORING_STANDARD, C.TEAM_STANDARD);
        const tCenter = mkTank("c", { x: cx, y: cy, team_id: 1, health: 100, player_index: 0 });
        const tRing = mkTank("r", { x: cx + 30, y: cy + 40, team_id: 1, health: 100, player_index: 0 });
        const tFar = mkTank("f", { x: cx + 300, y: cy, team_id: 1, health: 100, player_index: 0 });
        const tDead = mkTank("d", { x: cx, y: cy, team_id: 1, health: 100, alive: false, player_index: 0 });
        const tShield = mkTank("h", { x: cx + 6, y: cy + 8, team_id: 1, health: 100, shield_hp: 40, shield_item: 1, player_index: 0 });
        const s = mkTank("s", { x: 5, y: 5, team_id: 2, player_index: 2 });
        const tanks = [s, tCenter, tRing, tFar, tDead, tShield];
        const st = new MockState({ cfg, tanks, current_shooter: s, current_weapon: "BIG" });
        damage.explode(asState(st), cx, cy, 100, true);
        const byId: { [id: string]: MockTank } = { c: tCenter, r: tRing, f: tFar, d: tDead, h: tShield };
        for (const id of Object.keys(cm.tanks)) {
          expectSnap(snap(byId[id]), cm.tanks[id], `multi tank ${id}`);
        }
        expectSnap(snap(s), cm.shooter, "multi shooter");
        expect(st.terrain.carves, "multi carves").toEqual(c.carves);
        expect(st.explosions, "multi explosions").toEqual(c.explosions);
        expectDestroyed(st.destroyed, c.destroyed, "multi");
      });
    }
  }
});

describe("damage: predicted_fall_damage (2*pixels, support depth, floor clamp)", () => {
  for (let i = 0; i < vec.predicted_fall.length; i++) {
    const c = vec.predicted_fall[i];
    const label = `#${i} h=${c.h} y=${c.start_y} support=${c.support_y}`;
    it(label, () => {
      const t = mkTank("t", { x: 100, y: c.start_y, half_width: 8 });
      const terr = new MockTerrain(c.h, c.support_y === -1 ? null : c.support_y);
      const got = damage.predicted_fall_damage(terr, t);
      expect(got, `${label} out`).toBe(c.out);
      expect(t.y, `${label} tank not moved`).toBe(c.tank_y_after);
    });
  }
});

describe("damage: chute_should_deploy (deployed/chutes/threshold branches)", () => {
  for (let i = 0; i < vec.chute_deploy.length; i++) {
    const c = vec.chute_deploy[i];
    const label = `#${i} dep=${c.deployed} chutes=${c.chutes} thr=${c.threshold} support=${c.support_y}`;
    it(label, () => {
      const t = mkTank("t", {
        x: 100, y: 0, half_width: 8,
        parachute_deployed: c.deployed, parachutes: c.chutes, parachute_threshold: c.threshold,
      });
      const terr = new MockTerrain(480, c.support_y === -1 ? null : c.support_y);
      // predicted matches the oracle (sanity-lock the support model)
      expect(damage.predicted_fall_damage(terr, t), `${label} predicted`).toBe(c.predicted);
      expect(damage.chute_should_deploy(terr, t), `${label} out`).toBe(c.out);
    });
  }
});

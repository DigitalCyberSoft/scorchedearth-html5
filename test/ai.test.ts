/**
 * Differential gate: TS src/ai.ts == scorch/ai.py (the byte-verified oracle),
 * driven by oracle/dump_ai_cluster.py -> oracle/vectors/ai.json.
 *
 * EPSILON POLICY (per task + module docstring):
 *   - Every TURN function returns INTEGER (angle, power, weapon_slot) via
 *     pyRound + clamp, and the angle search walks integer degrees, so those are
 *     asserted EXACT (toBe). Target-pick player indices, weapon slots, buy
 *     inventories/cash, take_turn class re-roll, ai_tries, booleans, and the
 *     Unknown reveal flag are all INTEGER/BOOL -> EXACT.
 *   - The closed-form oracle _solve_power and the _scan/_search_aim/_seed_angle/
 *     _wind_seed_angle/aim helpers expose raw transcendental-derived floats
 *     (Math.cos/tan/sin/sqrt/atan2). Where a vector records such a raw float
 *     (solve_power power, aim/scan/search_aim power that did not pass through the
 *     integer clamp, wind_seed_angle), it is asserted toBeCloseTo(.,12). Angles
 *     and powers that the port returns as integers are EXACT.
 *   - _simulate_landing returns proj.px at the floor/target crossing: a
 *     transcendental-accumulated float -> toBeCloseTo(.,12).
 *
 * The RNG is `new Rng(seed)` -- CPython MT19937, proven bit-equivalent to the
 * Python rng.Rng by test/rng.test.ts. So every rng-driven draw order reproduces.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as ai from "../src/ai";
import * as weapons from "../src/weapons";
import { Tank } from "../src/objects";
import { Rng } from "../src/rng";
import { Config } from "../src/config";
import * as C from "../src/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "ai.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

const EPS = 12;
const INVENTORY_CAP = 99; // C.INVENTORY_CAP (mirrors economy law)

/**
 * Relative-epsilon comparison for RAW transcendental oracle floats whose
 * magnitude can exceed ~1e4. WHY relative, not toBeCloseTo(.,12): _solve_power /
 * _oracle return sqrt(a*x^2 / (2*cos^2*(x*tan - dy))). For low-gravity/far-target
 * or high-gravity inputs this raw value reaches 1e4..1e5, where one ULP
 * (e.g. ULP(17001.76) = 3.64e-12) is LARGER than toBeCloseTo(.,12)'s absolute
 * 5e-13 tolerance. CPython's libm and V8's libm differ by a few ULP on the
 * cos/tan/sqrt chain, so an absolute 12-decimal check is below machine precision
 * at that magnitude and cannot pass. A relative 1e-9 bound is far tighter than
 * the 0.5 quantum any consumer applies (every caller feeds this through pyRound /
 * clamp to an integer angle/power), yet above the libm split. The magnitude-
 * bounded trajectory/velocity values stay small and use the strict
 * toBeCloseTo(.,12) (physics/guidance tests + the integer turn outputs here).
 */
const REL_EPS = 1e-9;
function expectCloseRel(actual: number, expected: number, msg: string): void {
  const tol = REL_EPS * Math.max(1, Math.abs(expected));
  expect(
    Math.abs(actual - expected),
    `${msg}: |${actual} - ${expected}| = ${Math.abs(actual - expected)} > ${tol}`,
  ).toBeLessThanOrEqual(tol);
}

// ---------------------------------------------------------------------------
// Mock state mirroring oracle/dump_ai_cluster.py's MockState/MockEconomy/
// MockTerrain STRUCTURALLY, so only ai's own arithmetic is under differential
// test. Uses the real Config (so viscosity_mult/team_mode/is_on/live_elastic
// match) and the real Rng (CPython MT, proven equivalent).
// ---------------------------------------------------------------------------
class MockTerrain implements ai.AITerrain {
  dirt_rect: [number, number, number] | null;
  constructor(dirt_rect: [number, number, number] | null = null) {
    this.dirt_rect = dirt_rect;
  }
  is_dirt(x: number, y: number): boolean {
    if (this.dirt_rect === null) return false;
    const [x0, y0, x1] = this.dirt_rect;
    return x0 <= x && x < x1 && y >= y0;
  }
}

class MockEconomy implements ai.AIEconomy {
  available: boolean[];
  price: number[];
  constructor(available?: boolean[], price?: number[]) {
    this.price = price
      ? price.slice()
      : weapons.ITEMS.map((it) => it.cost);
    this.available = available
      ? available.slice()
      : new Array<boolean>(weapons.NUM_ITEMS).fill(true);
  }
  buy(tank: Tank, slot: number): boolean {
    if (!this.available[slot]) return false;
    if (tank.inventory[slot] >= INVENTORY_CAP) return false;
    const cost = this.price[slot];
    if (tank.cash < cost) return false;
    tank.cash -= cost;
    tank.inventory[slot] += weapons.ITEMS[slot].bundle;
    if (tank.inventory[slot] > INVENTORY_CAP)
      tank.inventory[slot] = INVENTORY_CAP;
    return true;
  }
}

class MockState implements ai.AIState {
  cfg: Config;
  tanks: Tank[];
  rng: Rng;
  economy: ai.AIEconomy;
  terrain: ai.AITerrain;
  w: number;
  h: number;
  round_index: number;
  last_landing: [number, number] | null;
  live_sky: string;
  constructor(
    cfg: Config,
    tanks: Tank[],
    opts: {
      w?: number;
      h?: number;
      seed?: number;
      last_landing?: [number, number] | null;
      round_index?: number;
      live_sky?: string;
      terrain?: ai.AITerrain;
      economy?: ai.AIEconomy;
    } = {},
  ) {
    this.cfg = cfg;
    this.tanks = tanks;
    this.w = opts.w ?? 1024;
    this.h = opts.h ?? 768;
    this.rng = new Rng(opts.seed ?? 0);
    this.economy = opts.economy ?? new MockEconomy();
    this.terrain = opts.terrain ?? new MockTerrain();
    this.round_index = opts.round_index ?? 0;
    this.last_landing = opts.last_landing ?? null;
    this.live_sky = opts.live_sky ?? "";
  }
}

function mkCfg(
  gravity = 0.2,
  visc = 0,
  wind = 0,
  elastic = "NONE",
  team = "NONE",
  computers_buy = true,
): Config {
  const cfg = new Config();
  cfg.GRAVITY = gravity;
  cfg.AIR_VISCOSITY = visc;
  cfg.ELASTIC = elastic;
  cfg.TEAM_MODE = team;
  cfg.COMPUTERS_BUY = computers_buy ? "ON" : "OFF";
  cfg.live_elastic = cfg.elastic; // mirror __post_init__ after mutating ELASTIC
  cfg.wind = wind;
  return cfg;
}

function mkTank(
  pi: number,
  x: number,
  y: number,
  ai_class = 0,
  team_id = 0,
  health = 100,
  angle = 45,
  power = 500,
): Tank {
  const t = new Tank(pi, `P${pi}`, ai_class, team_id);
  t.x = x;
  t.y = y;
  t.health = health;
  t.angle = angle;
  t.power = power;
  return t;
}

// ---------------------------------------------------------------------------
describe("ai: _solve_power (closed-form oracle)", () => {
  for (const r of vec.solve_power) {
    it(`g=${r.gravity} (${r.sx},${r.sy})->(${r.tx},${r.ty}) elev=${r.elev}`, () => {
      const cfg = mkCfg(r.gravity);
      const pw = ai._solve_power(cfg, r.sx, r.sy, r.tx, r.ty, r.elev);
      expect(pw === null).toBe(!r.reachable);
      if (r.power !== null) {
        // raw transcendental oracle float (sqrt of a cos/tan chain), magnitude
        // up to ~1e5 -> relative epsilon (see expectCloseRel note above).
        expectCloseRel(pw as number, r.power, `solve_power elev=${r.elev}`);
      }
    });
  }
});

describe("ai: nearest_enemy (team filter + nearest |dx|)", () => {
  for (const r of vec.nearest_enemy) {
    it(`team=${r.team}`, () => {
      const cfg = mkCfg(0.2, 0, 0, "NONE", r.team);
      const a = mkTank(0, 500, 400, 0, 1);
      const b = mkTank(1, 300, 400, 0, 1);
      const c = mkTank(2, 700, 400, 0, 2);
      const d = mkTank(3, 520, 400, 0, 2);
      const eDead = mkTank(4, 505, 400, 0, 2);
      eDead.alive = false;
      const st = new MockState(cfg, [a, b, c, d, eDead]);
      const tgt = ai.nearest_enemy(st, a);
      expect(tgt === null ? -1 : tgt.player_index).toBe(r.target_pi);
    });
  }
});

describe("ai: cyborg_target (weighted scorer, rng-driven)", () => {
  for (const r of vec.cyborg_target) {
    it(`seed=${r.seed} team=${r.team}`, () => {
      const cfg = mkCfg(0.2, 0, 0, "NONE", r.team);
      const tank = mkTank(0, 400, 400, C.AI_CYBORG, 1);
      tank.shield_hp = 0;
      tank.score = 100;
      const e1 = mkTank(1, 700, 400, 0, 2);
      e1.score = 50;
      e1.shield_hp = 0;
      const e2 = mkTank(2, 300, 400, 0, 2);
      e2.score = 200;
      e2.shield_hp = 30;
      const e3 = mkTank(3, 900, 400, 0, 2);
      e3.score = 10;
      e3.shield_hp = 0;
      tank.hits_this_round = { 1: 2, 3: 1 };
      tank.hits_career = { 1: 5, 2: 3 };
      const st = new MockState(cfg, [tank, e1, e2, e3], {
        seed: r.seed,
        round_index: 2,
      });
      const tgt = ai.cyborg_target(st, tank);
      expect(tgt === null ? -1 : tgt.player_index).toBe(r.target_pi);
    });
  }
});

describe("ai: pick_weapon (missile / baby / random)", () => {
  for (const r of vec.pick_weapon) {
    it(`seed=${r.seed}`, () => {
      const cfg = mkCfg();
      const t = mkTank(0, 200, 400);
      const st = new MockState(cfg, [t], { seed: r.seed });
      st.rng.seed(r.seed);
      const det = ai.pick_weapon(st, t, false);
      st.rng.seed(r.seed);
      const rnd = ai.pick_weapon(st, t, true);
      t.inventory[weapons.SLOT_MISSILE] = 5;
      t.inventory[6] = 3;
      t.inventory[2] = 2;
      st.rng.seed(r.seed);
      const det2 = ai.pick_weapon(st, t, false);
      st.rng.seed(r.seed);
      const rnd2 = ai.pick_weapon(st, t, true);
      expect(det).toBe(r.det_babyonly);
      expect(rnd).toBe(r.rnd_babyonly);
      expect(det2).toBe(r.det_withmissile);
      expect(rnd2).toBe(r.rnd_withmissile);
    });
  }
});

describe("ai: _seed_angle (atan2 geometry seed)", () => {
  for (const r of vec.seed_angle) {
    it(`target (${r.tx},${r.ty})`, () => {
      const tank = mkTank(0, 400, 400);
      const target = mkTank(1, r.tx, r.ty);
      expect(ai._seed_angle(tank, target)).toBe(r.angle);
    });
  }
});

describe("ai: _scan (lob/flat preference)", () => {
  for (const r of vec.scan) {
    it(`${r.prefer} g=${r.gravity} (${r.sx},${r.sy})->(${r.tx},${r.ty})`, () => {
      const cfg = mkCfg(r.gravity);
      const sol = ai._scan(cfg, r.sx, r.sy, r.tx, r.ty, r.prefer);
      if (r.angle === null) {
        expect(sol).toBe(null);
      } else {
        expect((sol as [number, number])[0]).toBe(r.angle);
        expect((sol as [number, number])[1]).toBe(r.power);
      }
    });
  }
});

describe("ai: aim (closed-form + sim-refine)", () => {
  for (const r of vec.aim) {
    it(`g=${r.gravity} wind=${r.wind} ${r.prefer} ->(${r.tx},${r.ty})`, () => {
      const cfg = mkCfg(r.gravity, 0, r.wind);
      const st = new MockState(cfg, [], { w: 1024, h: 768 });
      const tank = mkTank(0, 200, 600);
      const [ang, pw] = ai.aim(st, tank, r.tx, r.ty, r.prefer);
      expect(ang).toBe(r.angle); // integer game angle
      expect(pw).toBe(r.power); // pyRound(power) -> integer
    });
  }
});

describe("ai: _simulate_landing (real integrator)", () => {
  for (const r of vec.simulate_landing) {
    it(`g=${r.gravity} wind=${r.wind} ang=${r.angle} pw=${r.power}`, () => {
      const cfg = mkCfg(r.gravity, 0, r.wind);
      const st = { cfg, w: 1024, h: 768 };
      const tank = mkTank(0, 200, 600);
      const lx = ai._simulate_landing(st, tank, r.angle, r.power, r.ty);
      if (r.land_x === null) {
        expect(lx).toBe(null);
      } else {
        expect(lx as number).toBeCloseTo(r.land_x, EPS);
      }
    });
  }
});

describe("ai: _simulate_landing loop-exhaust (zero-g bouncing shot -> null)", () => {
  const r = vec.simulate_landing_exhaust;
  it(`g=${r.gravity} ${r.elastic} ang=${r.angle} never lands -> null`, () => {
    // The off-world early-out (handle_walls false) is the OTHER null path; bouncy
    // walls keep the shell in-world, so this exercises the flight-horizon tail.
    const cfg = mkCfg(r.gravity, 0, 0, r.elastic);
    const st = { cfg, w: 1024, h: 768 };
    const tank = mkTank(0, 200, 600);
    const lx = ai._simulate_landing(st, tank, r.angle, r.power, r.ty);
    expect(lx).toBe(r.land_x === null ? null : r.land_x);
  });
});

describe("ai: _wind_seed_angle (Spoiler/Cyborg seed)", () => {
  for (const r of vec.wind_seed_angle) {
    it(`wind=${r.wind} visc=${r.visc} right=${r.right}`, () => {
      const cfg = mkCfg(0.2, r.visc, r.wind);
      const st = new MockState(cfg, []);
      // wind blend: |3*wind/10| + visc/2 (clamp 70); 85-w or 95+w. The /10 and
      // /2 are exact for the integer inputs, so this is EXACT, but assert
      // close-to(.,12) to be robust to any float ordering.
      expect(ai._wind_seed_angle(st, r.right)).toBeCloseTo(r.angle, EPS);
    });
  }
});

describe("ai: _tosser_steepen_gate (cavern gate)", () => {
  for (const r of vec.steepen_gate) {
    it(`sky=${r.sky} ly=${r.ly}`, () => {
      const cfg = mkCfg();
      const st = new MockState(cfg, [], { h: 768, live_sky: r.sky });
      expect(ai._tosser_steepen_gate(st, r.ly)).toBe(r.out);
    });
  }
});

describe("ai: _search_aim (two-sided angle bracket)", () => {
  for (const r of vec.search_aim) {
    it(`g=${r.gravity} ${r.elastic} seed=${r.seed_angle} ->(${r.tx},${r.ty})`, () => {
      const cfg = mkCfg(r.gravity, 0, 0, r.elastic);
      const st = new MockState(cfg, []);
      const tank = mkTank(0, 200, 600, 0, 0, 100, r.seed_angle);
      const [a, p] = ai._search_aim(st, tank, r.tx, r.ty);
      expect(a).toBe(r.angle); // integer game angle
      expect(p).toBe(r.power); // integer clamped power
    });
  }
});

// ---------------------------------------------------------------------------
// The 7 turn functions. Each returns [angle, power, weapon] integers + mutates
// tank.angle / tank.ai_tries -- all EXACT.
// ---------------------------------------------------------------------------
function runTurnBattery(
  key: string,
  aiClass: number,
  fn: (s: ai.AIState, t: Tank) => [number, number, number],
): void {
  describe(`ai: ${key}`, () => {
    for (const r of vec[key]) {
      it(`seed=${r.seed} landing=${r.with_landing} elastic=${r.elastic} hp=${r.health}`, () => {
        const cfg = mkCfg(0.2, 0, 0, r.elastic);
        const me = mkTank(0, 200, 400, aiClass, 0, r.health, 45, 500);
        const enemy = mkTank(1, 800, 400);
        const roster = [me, enemy];
        const last: [number, number] | null = r.with_landing
          ? [600, 380]
          : null;
        const st = new MockState(cfg, roster, {
          seed: r.seed,
          last_landing: last,
        });
        st.rng.seed(r.seed);
        const [ang, pw, wp] = fn(st, me);
        expect(ang).toBe(r.angle);
        expect(pw).toBe(r.power);
        expect(wp).toBe(r.weapon);
        expect(me.angle).toBe(r.tank_angle_after);
        expect(me.ai_tries).toBe(r.tank_ai_tries_after);
      });
    }
  });
}

// take_turn dispatch is exported; the per-class _turn_* are module-private, so
// drive them through take_turn with the matching ai_class (no Unknown re-roll
// for concrete classes; the dispatch table routes by ai_class). The battery
// vectors set ai_class via mkTank, and take_turn calls _resolve_unknown first
// (a no-op for non-Unknown classes), then dispatches -- identical to calling
// _turn_* directly for these classes.
runTurnBattery("turn_moron", C.AI_MORON, (s, t) => ai.take_turn(s, t));
runTurnBattery("turn_tosser", C.AI_TOSSER, (s, t) => ai.take_turn(s, t));
runTurnBattery("turn_shooter", C.AI_SHOOTER, (s, t) => ai.take_turn(s, t));
runTurnBattery("turn_poolshark", C.AI_POOLSHARK, (s, t) => ai.take_turn(s, t));
runTurnBattery("turn_spoiler", C.AI_SPOILER, (s, t) => ai.take_turn(s, t));
runTurnBattery("turn_cyborg", C.AI_CYBORG, (s, t) => ai.take_turn(s, t));
runTurnBattery("turn_chooser", C.AI_CHOOSER, (s, t) => ai.take_turn(s, t));

describe("ai: turn_geo (varied geometry: bracket / recurse / wind-seed / flatten)", () => {
  for (const r of vec.turn_geo) {
    it(`${r.cls_name} roster${r.roster_idx} param${r.param_idx} seed=${r.seed} landing=${r.with_landing}`, () => {
      const cfg = mkCfg(r.gravity, r.visc, r.wind, r.elastic);
      const roster: Tank[] = [];
      for (const [pi, x, y] of r.roster as [number, number, number][]) {
        roster.push(mkTank(pi, x, y, pi === 0 ? r.ai_class : 0, 0, 100, 45, 500));
      }
      const last: [number, number] | null = r.with_landing ? [450, 380] : null;
      const st = new MockState(cfg, roster, {
        seed: r.seed,
        last_landing: last,
        round_index: 1,
      });
      st.rng.seed(r.seed);
      const [ang, pw, wp] = ai.take_turn(st, roster[0]);
      expect(ang).toBe(r.angle);
      expect(pw).toBe(r.power);
      expect(wp).toBe(r.weapon);
      expect(roster[0].angle).toBe(r.tank_angle_after);
      expect(roster[0].ai_tries).toBe(r.tank_ai_tries_after);
    });
  }
});

describe("ai: take_turn (dispatch + Unknown re-roll)", () => {
  for (const r of vec.take_turn) {
    if (r.ai_class_in !== undefined) {
      it(`concrete class ${r.ai_class_in} seed=${r.seed}`, () => {
        const cfg = mkCfg();
        const me = mkTank(0, 200, 400, r.ai_class_in, 0, 100);
        const enemy = mkTank(1, 800, 400);
        const st = new MockState(cfg, [me, enemy], { seed: r.seed });
        st.rng.seed(r.seed);
        const [ang, pw, wp] = ai.take_turn(st, me);
        expect(ang).toBe(r.angle);
        expect(pw).toBe(r.power);
        expect(wp).toBe(r.weapon);
        expect(me.ai_class).toBe(r.ai_class_after);
        expect(me.reveal_type).toBe(r.reveal_type_after);
      });
    } else {
      it(`Unknown re-roll seed=${r.seed}`, () => {
        const cfg = mkCfg();
        const me = mkTank(0, 200, 400, C.AI_UNKNOWN, 0, 100);
        const enemy = mkTank(1, 800, 400);
        const st = new MockState(cfg, [me, enemy], { seed: r.seed });
        st.rng.seed(r.seed);
        const [ang, pw, wp] = ai.take_turn(st, me);
        expect(ang).toBe(r.angle);
        expect(pw).toBe(r.power);
        expect(wp).toBe(r.weapon);
        expect(me.ai_class).toBe(r.ai_class_after);
        expect(me.reveal_type).toBe(r.reveal_type_after);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Branch battery: the per-turn GUARD / fall-through paths the geo sweep misses
// (no-enemy holds, Tosser bracket arms, Poolshark wall-tune give-up / angle-90
// drop / 8-try exhaust, Chooser blocked-line routing, Shooter sub-1 power break).
// Each row carries its full MockState spec; outputs are integers -> EXACT.
// ---------------------------------------------------------------------------
describe("ai: turn_branch (per-turn guard / fall-through paths)", () => {
  for (const r of vec.turn_branch) {
    it(`${r.label}`, () => {
      const cfg = mkCfg(0.2, 0, 0, r.elastic);
      const roster: Tank[] = [];
      for (const entry of r.roster as [number, number, number, boolean][]) {
        const [pi, x, y, alive] = entry;
        const t = mkTank(pi, x, y, pi === 0 ? r.ai_class : 0);
        t.alive = alive;
        roster.push(t);
      }
      const t0 = roster[0];
      const ov = (r.tank0 ?? {}) as {
        angle?: number;
        power?: number;
        ai_tries?: number;
        health?: number;
      };
      if (ov.angle !== undefined) t0.angle = ov.angle;
      if (ov.power !== undefined) t0.power = ov.power;
      if (ov.ai_tries !== undefined) t0.ai_tries = ov.ai_tries;
      if (ov.health !== undefined) t0.health = ov.health;
      const terrain = new MockTerrain(
        r.dirt_rect ? (r.dirt_rect as [number, number, number]) : null,
      );
      const st = new MockState(cfg, roster, {
        seed: r.seed,
        last_landing: r.last_landing
          ? (r.last_landing as [number, number])
          : null,
        live_sky: r.live_sky ?? "",
        terrain,
      });
      st.rng.seed(r.seed);
      const [ang, pw, wp] = ai.take_turn(st, t0);
      expect(ang, `${r.label} angle`).toBe(r.angle);
      expect(pw, `${r.label} power`).toBe(r.power);
      expect(wp, `${r.label} weapon`).toBe(r.weapon);
      expect(t0.angle, `${r.label} tank_angle_after`).toBe(r.tank_angle_after);
      expect(t0.ai_tries, `${r.label} tank_ai_tries_after`).toBe(
        r.tank_ai_tries_after,
      );
    });
  }
});

describe("ai: _score_nearest_enemy (null-exclude wrapper, port fidelity)", () => {
  for (const r of vec.score_wrapper) {
    it(`team=${r.team} -> pi ${r.target_pi}`, () => {
      const a = mkTank(0, 500, 400, C.AI_SHOOTER, 1);
      let roster: Tank[];
      if (r.team === "alone") {
        roster = [a];
      } else {
        roster = [
          a,
          mkTank(1, 300, 400, 0, 1),
          mkTank(2, 700, 400, 0, 2),
          mkTank(3, 520, 400, 0, 2),
        ];
      }
      const team = r.team === "alone" ? "NONE" : r.team;
      const st = new MockState(mkCfg(0.2, 0, 0, "NONE", team), roster);
      const tgt = ai._score_nearest_enemy(st, a);
      expect(tgt === null ? -1 : tgt.player_index).toBe(r.target_pi);
    });
  }
});

describe("ai: elastic fallback (predicates on a cfg without live_elastic)", () => {
  // _wall_flatten_active / _poolshark_bouncy_walls read live_elastic, then fall
  // back to .elastic, then 0. The real Config always derives live_elastic, so the
  // fallback only runs for a cfg shaped with .elastic alone (or neither attr).
  for (const r of vec.elastic_fallback) {
    it(`${r.shape} elastic=${r.elastic}`, () => {
      const cfg = r.shape === "neither" ? {} : { elastic: r.elastic };
      const st = { cfg } as unknown as ai.AIState;
      expect(ai._wall_flatten_active(st), `${r.shape} wall_flatten`).toBe(
        r.wall_flatten,
      );
      expect(ai._poolshark_bouncy_walls(st), `${r.shape} bouncy`).toBe(r.bouncy);
    });
  }
});

// ---------------------------------------------------------------------------
// Buying.
// ---------------------------------------------------------------------------
describe("ai: buy (shared deterministic ladder)", () => {
  for (const r of vec.buy_shared) {
    it(`cash=${r.cash_in} computers_buy=${r.computers_buy ?? true}`, () => {
      const cfg = mkCfg(0.2, 0, 0, "NONE", "NONE", r.computers_buy ?? true);
      const me = mkTank(0, 200, 400, C.AI_SHOOTER);
      me.cash = r.cash_in;
      const st = new MockState(cfg, [me]);
      ai.buy(st, me);
      expect(me.cash).toBe(r.cash_out);
      expect(me.inventory).toEqual(r.inventory);
      expect(me.parachute_deployed).toBe(r.parachute_deployed);
    });
  }
});

describe("ai: buy (moron weighted-random)", () => {
  for (const r of vec.buy_moron) {
    it(`seed=${r.seed} cash=${r.cash_in}`, () => {
      const cfg = mkCfg(0.2, 0, 0, "NONE", "NONE", true);
      const me = mkTank(0, 200, 400, C.AI_MORON);
      me.cash = r.cash_in;
      const st = new MockState(cfg, [me], { seed: r.seed });
      st.rng.seed(r.seed);
      ai.buy(st, me);
      expect(me.cash).toBe(r.cash_out);
      expect(me.inventory).toEqual(r.inventory);
    });
  }
});

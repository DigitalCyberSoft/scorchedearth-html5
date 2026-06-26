/**
 * Differential gate: TS movement == Python scorch.movement (the fidelity oracle,
 * itself byte-verified against 1.5/SCORCH.EXE).
 *
 * Golden vectors are produced by oracle/dump_movement.py and written to
 * oracle/vectors/movement.json. EVERY movement output is an integer (position /
 * fuel count / cost) or a boolean, so there is NO transcendental math in this
 * module and NO epsilon anywhere here: every assertion is exact (toBe). The task's
 * "tight epsilon for transcendental-derived floats" clause does not apply -- this
 * module computes none.
 *
 * The mocks below are STRUCTURALLY IDENTICAL to dump_movement.py's MockTerrain /
 * MockTank / MockState: a column_top lookup over the dumped profile heights, a tank
 * exposing exactly the fields movement reads (alive, fuel_remainder, half_width,
 * inventory, mobile, x, y), and a state whose _settle_tank performs the
 * deterministic NON-FALLING settle (`y = max(2, column_top(x) - 1)`, game.py:1510)
 * and RECORDS each call. See dump_movement.py's docstring for why that settle is
 * the correct isolation boundary (the real game._settle_tank's falling / damage /
 * parachute internals are an external dependency owned by other agents, not part of
 * the movement module under test). SLOT_FUEL is imported from the real port so the
 * inventory index matches the oracle's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  fuel_units,
  can_move,
  _consume_fuel,
  _surface_y,
  _move_cost,
  move_tank,
  UNITS_PER_TANK,
  type MovementTerrain,
  type MovementTank,
  type MovementState,
} from "../src/movement";
import { SLOT_FUEL } from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "movement.json");

// --- vector shapes (mirror the dumper's per-case dicts) ---
interface CaseBase {
  fn: string;
  label?: string;
}
type FuelUnitsCase = CaseBase & { fuel_tanks: number; rem: number; fuel_units: number };
type CanMoveCase = CaseBase & {
  mobile: boolean;
  fuel_tanks: number;
  rem: number;
  can_move: boolean;
};
type ConsumeCase = CaseBase & {
  fuel_tanks: number;
  rem: number;
  cost: number;
  fuel_remainder: number;
  fuel_tanks_after: number;
};
type SurfaceCase = CaseBase & { x: number; surface_y: number };
type MoveCostCase = CaseBase & { old_y: number; new_y: number; cost: number };
type MoveTankCase = CaseBase & {
  in: { x: number; y: number; half_width: number; mobile?: boolean; alive?: boolean; fuel_tanks?: number; fuel_remainder?: number; direction: number; w: number };
  ret: boolean;
  x: number;
  y: number;
  fuel_remainder: number;
  fuel_tanks: number;
  settle_count: number;
  settle_x: number | null;
  settle_y: number | null;
};
type SeqStep = {
  ret: boolean;
  x: number;
  y: number;
  fuel_remainder: number;
  fuel_tanks: number;
  settle_count: number;
};
type MoveSeqCase = CaseBase & {
  start: { x: number; y: number; half_width: number; fuel_tanks: number; fuel_remainder: number; w: number };
  direction: number;
  steps: SeqStep[];
};

interface MovementVectors {
  module: string;
  slot_fuel: number;
  units_per_tank: number;
  profile_heights: number[];
  profile_h: number;
  cases: CaseBase[];
}

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as MovementVectors;

// --- mocks: structurally identical to dump_movement.py ---

/** terrain.column_top(x) over an explicit heights array; out-of-range -> h
 * (mirrors MockTerrain in the dumper and the real Terrain.column_top fall-through). */
class MockTerrain implements MovementTerrain {
  constructor(private heights: number[], private h: number) {}
  column_top(x: number): number {
    if (x >= 0 && x < this.heights.length) return this.heights[x];
    return this.h;
  }
}

interface TankKw {
  x?: number;
  y?: number;
  half_width?: number;
  mobile?: boolean;
  alive?: boolean;
  fuel_tanks?: number;
  fuel_remainder?: number;
}

/** The duck-typed tank movement reads/mutates; inventory sized 48 with the FUEL
 * slot set, exactly like MockTank in the dumper. */
function makeTank(kw: TankKw): MovementTank {
  const inv = new Array<number>(48).fill(0);
  inv[SLOT_FUEL] = kw.fuel_tanks ?? 2;
  return {
    x: kw.x ?? 100,
    y: kw.y ?? 50,
    half_width: kw.half_width ?? 7,
    mobile: kw.mobile ?? true,
    alive: kw.alive ?? true,
    fuel_remainder: kw.fuel_remainder ?? 0,
    inventory: inv,
  };
}

/** state.terrain / state.w / state._settle_tank; the settle is the deterministic
 * NON-FALLING settle and records each call's committed (x, y) -- identical to
 * MockState in the dumper. */
class MockState implements MovementState {
  settle_calls: [number, number][] = [];
  constructor(public terrain: MovementTerrain, public w: number) {}
  _settle_tank(t: MovementTank): void {
    this.settle_calls.push([t.x, t.y]);
    t.y = Math.max(2, this.terrain.column_top(t.x) - 1);
  }
}

// ---------------------------------------------------------------------------

describe("movement: module constants match the oracle", () => {
  it("SLOT_FUEL and UNITS_PER_TANK agree with the Python port", () => {
    expect(SLOT_FUEL).toBe(vec.slot_fuel);
    expect(UNITS_PER_TANK).toBe(vec.units_per_tank);
  });
});

const byFn = (fn: string) => vec.cases.filter((c) => c.fn === fn);

describe("movement: fuel_units (inventory[FUEL]*10 + remainder)", () => {
  for (const c of byFn("fuel_units") as FuelUnitsCase[]) {
    it(`fuel_units(tanks=${c.fuel_tanks}, rem=${c.rem}) == ${c.fuel_units}`, () => {
      const t = makeTank({ fuel_tanks: c.fuel_tanks, fuel_remainder: c.rem });
      expect(fuel_units(t)).toBe(c.fuel_units);
    });
  }
});

describe("movement: can_move (mobile AND fuel_units > 0)", () => {
  for (const c of byFn("can_move") as CanMoveCase[]) {
    it(`can_move(mobile=${c.mobile}, tanks=${c.fuel_tanks}, rem=${c.rem}) == ${c.can_move}`, () => {
      const t = makeTank({ mobile: c.mobile, fuel_tanks: c.fuel_tanks, fuel_remainder: c.rem });
      expect(can_move(t)).toBe(c.can_move);
    });
  }
});

describe("movement: _consume_fuel (borrow loop + floor at 0)", () => {
  for (const c of byFn("_consume_fuel") as ConsumeCase[]) {
    it(`_consume_fuel(tanks=${c.fuel_tanks}, rem=${c.rem}, cost=${c.cost}) -> rem=${c.fuel_remainder}, tanks=${c.fuel_tanks_after}`, () => {
      const t = makeTank({ fuel_tanks: c.fuel_tanks, fuel_remainder: c.rem });
      _consume_fuel(t, c.cost);
      expect(t.fuel_remainder).toBe(c.fuel_remainder);
      expect(t.inventory[SLOT_FUEL]).toBe(c.fuel_tanks_after);
    });
  }
});

describe("movement: _surface_y (max(2, column_top(x) - 1))", () => {
  const terrain = new MockTerrain(vec.profile_heights, vec.profile_h);
  for (const c of byFn("_surface_y") as SurfaceCase[]) {
    it(`_surface_y(x=${c.x}) == ${c.surface_y}`, () => {
      expect(_surface_y(terrain, c.x)).toBe(c.surface_y);
    });
  }
});

describe("movement: _move_cost (flat/down=1, uphill=1+min(rise,3))", () => {
  const terrain = new MockTerrain([200], vec.profile_h); // terrain arg is unused by _move_cost
  for (const c of byFn("_move_cost") as MoveCostCase[]) {
    it(`_move_cost(old_y=${c.old_y}, new_y=${c.new_y}) == ${c.cost}`, () => {
      expect(_move_cost(terrain, c.old_y, c.new_y)).toBe(c.cost);
    });
  }
});

describe("movement: move_tank (full control flow, fuel, edge clamp, alive-gated settle)", () => {
  for (const c of byFn("move_tank") as MoveTankCase[]) {
    it(`move_tank [${c.label}] dir=${c.in.direction} -> ret=${c.ret} x=${c.x} y=${c.y}`, () => {
      const terrain = new MockTerrain(vec.profile_heights, vec.profile_h);
      const st = new MockState(terrain, c.in.w);
      const t = makeTank({
        x: c.in.x,
        y: c.in.y,
        half_width: c.in.half_width,
        mobile: c.in.mobile,
        alive: c.in.alive,
        fuel_tanks: c.in.fuel_tanks,
        fuel_remainder: c.in.fuel_remainder,
      });
      const ret = move_tank(st, t, c.in.direction);
      expect(ret).toBe(c.ret);
      expect(t.x).toBe(c.x);
      expect(t.y).toBe(c.y);
      expect(t.fuel_remainder).toBe(c.fuel_remainder);
      expect(t.inventory[SLOT_FUEL]).toBe(c.fuel_tanks);
      expect(st.settle_calls.length).toBe(c.settle_count);
      if (c.settle_count > 0) {
        expect(st.settle_calls[0][0]).toBe(c.settle_x);
        expect(st.settle_calls[0][1]).toBe(c.settle_y);
      } else {
        expect(c.settle_x).toBeNull();
        expect(c.settle_y).toBeNull();
      }
    });
  }
});

describe("movement: move_tank trajectory (drain-walk, multi-call gate)", () => {
  for (const c of byFn("move_tank_seq") as MoveSeqCase[]) {
    it(`move_tank_seq [${c.label}] reproduces all ${c.steps.length} steps`, () => {
      const terrain = new MockTerrain(vec.profile_heights, vec.profile_h);
      const st = new MockState(terrain, c.start.w);
      const t = makeTank({
        x: c.start.x,
        y: c.start.y,
        half_width: c.start.half_width,
        fuel_tanks: c.start.fuel_tanks,
        fuel_remainder: c.start.fuel_remainder,
      });
      for (let i = 0; i < c.steps.length; i++) {
        const r = move_tank(st, t, c.direction);
        const step = c.steps[i];
        expect(r, `step ${i} ret`).toBe(step.ret);
        expect(t.x, `step ${i} x`).toBe(step.x);
        expect(t.y, `step ${i} y`).toBe(step.y);
        expect(t.fuel_remainder, `step ${i} rem`).toBe(step.fuel_remainder);
        expect(t.inventory[SLOT_FUEL], `step ${i} tanks`).toBe(step.fuel_tanks);
        expect(st.settle_calls.length, `step ${i} settle_count`).toBe(step.settle_count);
      }
    });
  }
});

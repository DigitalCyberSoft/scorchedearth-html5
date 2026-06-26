/**
 * Tank movement via fuel -- a faithful TypeScript port of
 * scorch-py/scorch/movement.py (the fidelity oracle, itself byte-verified
 * against 1.5/SCORCH.EXE). Identical control flow and integer behavior. Function
 * names mirror the Python module 1:1 (snake_case; leading `_` on the private
 * helpers) so the FUN_<seg>_<off> lineage survives.
 *
 * Ground truth (all preserved from movement.py, cited there):
 *
 *   Manual (1.5/SCORCH.DOC L1430, catalog 02_defenses.md:127-128): each fuel tank
 *     gives 10 units; each unit moves 1 pixel, less if uphill; choose `f` from the
 *     Tank Control Panel. A wheelless icon (DOC L335-340) is immobile for the round.
 *
 *   Decompile FUN_3667_0443.c (the fuel-move function): param_1 = signed direction
 *     step (+1 right / -1 left). Probes the leading-edge column for the new resting
 *     row, counting the climb/drop (each capped at 4 => a 1..3-pixel probe), deducts
 *     that step count as fuel via FUN_3a16_0718(tank, cost), commits the new x/y,
 *     and re-runs the tank-settle driver FUN_2975_0008 so the moved tank settles
 *     exactly like a post-blast tank.
 *
 *   Decompile FUN_3a16_0718.c (the fuel deduct; catalog 20_inventory_ab.md:87,141):
 *     tank+0xaa -= cost; while (tank+0xaa < 0 && inventory[FUEL] > 0): tank+0xaa +=
 *     10; inventory[FUEL] -= 1; if (tank+0xaa < 0) tank+0xaa = 0. Net worth
 *     FUN_3a16_06e9 = inventory[FUEL]*10 + (tank+0xaa): +0xaa is the tenths-of-a-tank
 *     REMAINDER, the inventory holds the bulk, total units = inventory[FUEL]*10 +
 *     remainder (catalog 20_inventory_ab.md:141).
 *
 *   FUN_27a8_00f2 (catalog 20_inventory_aa.md:94): control-panel predicate
 *     "movement allowed (has fuel and is mobile)" -- exposed here as `can_move`.
 *
 * FUEL MODEL (faithful): tank.fuel units == inventory[SLOT_FUEL]*10 +
 *   fuel_remainder, exactly FUN_3a16_06e9's net-worth form. fuel_remainder is the
 *   live +0xaa counter, seeded at 0, so a fresh inventory of N Fuel Tanks yields
 *   N*10 units; consuming fuel mutates the remainder and borrows whole tanks from
 *   the inventory precisely as FUN_3a16_0718 does.
 *
 * COST CURVE (uphill costs more): flat or downhill 1 unit/px (manual; FUN_3667_0443
 *   flat branch deducts 1). Uphill 1 + rise units, where `rise` is the surface climb
 *   at the new column, clamped to the engine's 1..3-pixel probe span (FUN_3667_0443
 *   caps local_8/local_14 at 4 => max 3 climb steps charged). The per-pixel curve's
 *   exact 16-bit branch arithmetic is RECONSTRUCTED from that cap; the manual fact
 *   ("more, less if uphill") and the cap are FACT.
 *
 * NUMERIC NOTE: this module has no transcendental math and no rng. Every value is
 * an integer (positions, fuel counts, costs) or a boolean, so the differential gate
 * (test/movement.test.ts) asserts all of them with exact equality (no epsilon).
 */
import { SLOT_FUEL } from "./weapons";

// Engine probe span: FUN_3667_0443 walks at most 3 rows (local_8/local_14 run 1..3
// before the `!= 4` terminal), so a single 1px move is charged at most 3+1 fuel
// units (1 base + up to 3 climb). Matching that cap keeps a steep wall from
// draining an absurd amount per pixel.
const _MAX_CLIMB_CHARGE = 3;
export const UNITS_PER_TANK = 10; // FUN_3a16_0718.c:21 (`tank+0xaa += 10`)

/** Terrain surface oracle: the column-top probe movement reads (terrain.column_top
 * in the Python port). Returns the column's topmost dirt row (Y grows DOWN). */
export interface MovementTerrain {
  column_top(x: number): number;
}

/** The duck-typed tank fields movement reads/mutates (mirrors the Python Tank
 * attributes: alive, fuel_remainder, half_width, inventory, mobile, x, y). */
export interface MovementTank {
  alive: boolean;
  fuel_remainder: number;
  half_width: number;
  inventory: number[];
  mobile: boolean;
  x: number;
  y: number;
}

/** The duck-typed state fields movement reads (mirrors state.terrain, state.w, and
 * the state._settle_tank single-tank settle driver reused by move_tank). */
export interface MovementState {
  terrain: MovementTerrain;
  w: number;
  _settle_tank(tank: MovementTank): void;
}

/** FUN_27a8_00f2: movement is allowed iff the tank is mobile (has wheels/treads)
 * AND it has at least one fuel unit left. Fixed emplacements never move (manual
 * DOC L335-340). */
export function can_move(tank: MovementTank): boolean {
  return Boolean(tank.mobile) && fuel_units(tank) > 0;
}

/** Total fuel units available = inventory[FUEL]*10 + remainder, the net-worth form
 * of FUN_3a16_06e9 (catalog 20_inventory_ab.md:141). */
export function fuel_units(tank: MovementTank): number {
  return tank.inventory[SLOT_FUEL] * UNITS_PER_TANK + tank.fuel_remainder;
}

/** Deduct `cost` fuel units, faithful to FUN_3a16_0718.c:18-26: spend from the
 * remainder, borrowing whole 10-unit tanks from the inventory when it underflows;
 * floor the remainder at 0 when fuel runs out. */
export function _consume_fuel(tank: MovementTank, cost: number): void {
  tank.fuel_remainder -= cost;
  while (tank.fuel_remainder < 0 && tank.inventory[SLOT_FUEL] > 0) {
    tank.fuel_remainder += UNITS_PER_TANK;
    tank.inventory[SLOT_FUEL] -= 1;
  }
  if (tank.fuel_remainder < 0) {
    tank.fuel_remainder = 0;
  }
}

/** Resting base-row Y for a tank centred at column x: one pixel above the column's
 * topmost dirt (the same formula game._place_tanks / _settle_tank use,
 * `column_top(x) - 1`), floored at 2. */
export function _surface_y(terrain: MovementTerrain, x: number): number {
  return Math.max(2, terrain.column_top(x) - 1);
}

/** Fuel cost of one 1px horizontal step. Y grows DOWN (catalog 11:412), so a
 * SMALLER new_y means the surface rose = uphill. Flat/downhill: 1 unit. Uphill:
 * 1 + climb, clamped to the engine's probe span (_MAX_CLIMB_CHARGE). */
export function _move_cost(_terrain: MovementTerrain, old_y: number, new_y: number): number {
  const rise = old_y - new_y; // >0 = surface climbed (uphill)
  if (rise <= 0) {
    return 1; // flat or downhill: 1 unit/px (manual)
  }
  return 1 + Math.min(rise, _MAX_CLIMB_CHARGE);
}

/** Move `tank` one pixel horizontally in `direction` (-1 left / +1 right),
 * consuming fuel, and re-settle it onto the new surface. Faithful to
 * FUN_3667_0443.
 *
 * Returns true if the tank moved, false if it could not (immobile, out of fuel, or
 * blocked at the field edge). A false return is the original's beep/no-op
 * (FUN_3667_0443 returns 0 when no commit happens; the caller MAY beep). */
export function move_tank(state: MovementState, tank: MovementTank, direction: number): boolean {
  if (direction !== -1 && direction !== 1) {
    return false;
  }
  if (!can_move(tank)) {
    // FUN_27a8_00f2 gate
    return false;
  }

  const terrain = state.terrain;
  // Field edge clamp: tanks live in [half_width .. w-1-half_width] so the body
  // stays on-screen (mirrors the X clamp in the settle walk, catalog 11:415).
  const new_x = tank.x + direction;
  if (new_x < tank.half_width || new_x > state.w - 1 - tank.half_width) {
    return false; // at the edge: no move (beep)
  }

  const new_y = _surface_y(terrain, new_x);
  const cost = _move_cost(terrain, tank.y, new_y);
  // Can't afford this step? No partial move (the original commits the whole 1px
  // step then deducts; with fuel >= 1 guaranteed by can_move, an uphill step still
  // spends what fuel remains and floors at 0 -- matching FUN_3a16_0718's floor --
  // so a move with any fuel left always proceeds).
  _consume_fuel(tank, cost);
  tank.x = new_x;
  tank.y = new_y;

  // FUN_3667_0443.c:100 -> FUN_2975_0008: re-settle the moved tank exactly like a
  // post-blast tank (fall onto the new column, apply fall damage if it drops).
  // game._settle_tank is the port's faithful single-tank settle; it is the
  // READ-ONLY surface/fall authority and is reused here (no game.py edit).
  if (tank.alive) {
    state._settle_tank(tank);
  }
  return true;
}

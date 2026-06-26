/**
 * Scoring: kill/hit/survival awards and ranking -- a faithful TypeScript port of
 * scorch-py/scorch/scoring.py (the fidelity oracle, itself byte-verified against
 * 1.5/SCORCH.EXE). Catalog 13 section 2 (FACT).
 *
 * SCORING enum 0=BASIC,1=STANDARD,2=GREEDY. Amounts are byte-exact (imported from
 * ./constants): kill +4000 BASIC / +500 else; self -1500; teammate -2000; survival
 * pool players*1000 (BASIC) / 5000 flat (else); enemy shield hit = 2*damage points;
 * normal enemy hit = 30*damage (HIT_POINT_MULT, FUN_4098_0308 +0x51 immediate).
 *
 * Provenance comments (FUN_<seg>_<off> / VERIFY_FIXES.md refs) are preserved from
 * the Python source so the disassembly lineage survives the language port.
 *
 * NUMERIC NOTE: this module has no transcendental math (no sin/cos/pow/sqrt/atan2).
 * Every quantity is an integer award/penalty, an integer floor-division share, an
 * int()-truncated net-worth, or a stable sort permutation, so the differential gate
 * (test/scoring.test.ts) asserts all of them with EXACT equality. The one float op
 * is unit_price's `price/bundle` inside net_worth, but the result is fed through
 * int() (truncation toward zero), so the asserted output is an exact integer.
 *
 * Python -> TS semantics that are load-bearing here:
 *  - `int(x)` truncates toward zero  -> Math.trunc(x).
 *  - `a // b` is floor division      -> a floordiv helper (Math.floor for the
 *    non-negative operands scoring uses; a true Python-floor helper for safety).
 *  - `sorted(..., reverse=True)` is STABLE: equal keys keep their original relative
 *    order, only unequal keys are reversed -> a descending comparator that returns 0
 *    on ties (JS Array.sort is stable since ES2019), NOT an ascending-sort-then-
 *    .reverse() (which would flip tie order).
 *  - `a is b` (identity)             -> reference equality (===) on the tank objects.
 */
import {
  TEAM_NONE,
  SCORING_BASIC,
  SCORING_GREEDY,
  SCORE_KILL_BASIC,
  SCORE_KILL_STD,
  SCORE_SELF_KILL,
  SCORE_TEAMMATE_KILL,
  SCORE_SURVIVAL_BASIC_PER,
  SCORE_SURVIVAL_STD,
  SCORE_SHIELD_HIT_MULT,
  SELLBACK_MULT_NORMAL,
} from "./constants";

export const HIT_POINT_MULT = 30; // FACT (VERIFY_FIXES.md 1c): a normal enemy-tank hit awards
//   30 * damage. Disassembled FUN_4098_0308: the enemy branch loads mov ax,0x1e
//   (=30) and __lmul's it by damage. The catalog tag "BLOCKED / in the BCD wrapper"
//   was wrong - it is a plain immediate at fn offset 0x51. (The shield branch is
//   the separate 2x, SCORE_SHIELD_HIT_MULT.) Prior port used 1.0 -> 30x too low.

/**
 * Minimal structural shapes scoring touches. The TS port is duck-typed exactly like
 * the Python (which reads only these fields), so the differential test can drive it
 * with the same lightweight mocks the oracle dumper builds.
 */
export interface Tank {
  score: number;
  cash: number;
  team_id: number;
  alive: boolean;
  win_counter: number;
  inventory: number[];
}

export interface Economy {
  unit_price(slot: number): number;
}

export interface Cfg {
  team_mode: number;
  scoring: number;
}

export interface State {
  cfg: Cfg;
  tanks: Tank[];
  economy: Economy;
}

/** Python floor division (`//`): rounds toward negative infinity. */
function floordiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function _award(tank: Tank, amount: number): void {
  /* Credit an award to spendable cash (tank.cash, the binary's +0xbe) AND, as a
     PORT RECONSTRUCTION, the ranking total (tank.score). The binary's award path
     writes ONLY +0xbe (FUN_2089_0166; VERIFY_FIXES.md 1f - there is no +0xba store
     in the award path, so the earlier "credits both money objects" note was wrong).
     The port also bumps tank.score so non-GREEDY ranking reflects total-earned
     rather than earned-minus-shopping - a defensible reconstruction of intent, not
     the binary's literal behaviour. Cash floors at 0; no upward ceiling. (The
     prior port routed awards to score ONLY, so cash never grew -> the "earn $0"
     bug.) */
  tank.score += amount;
  tank.cash = Math.max(0, tank.cash + amount);
}

/** FUN_3a16_198d contract: same team / self = friendly (returns 0). */
export function friendly(state: State, a: Tank, b: Tank): boolean {
  if (a === b) {
    return true;
  }
  if (state.cfg.team_mode !== TEAM_NONE && a.team_id === b.team_id) {
    return true;
  }
  return false;
}

/** FUN_4098_0263. */
export function award_kill(state: State, killer: Tank | null, victim: Tank): void {
  if (killer === null) {
    return;
  }
  if (friendly(state, killer, victim)) {
    _award(killer, killer === victim ? SCORE_SELF_KILL : SCORE_TEAMMATE_KILL);
  } else {
    const bonus = state.cfg.scoring === SCORING_BASIC ? SCORE_KILL_BASIC : SCORE_KILL_STD;
    _award(killer, bonus);
  }
}

/** FUN_4098_0308. BASIC awards nothing per hit. */
export function award_hit(
  state: State,
  attacker: Tank | null,
  victim: Tank,
  damage: number,
  shield_hit: boolean
): void {
  if (attacker === null || damage <= 0) {
    return;
  }
  if (state.cfg.scoring === SCORING_BASIC) {
    return;
  }
  if (friendly(state, attacker, victim)) {
    // Friendly-fire penalty = -15*damage, IDENTICAL for normal and shield hits.
    // Byte-verified in SCORCH_FP.EXE FUN_4098_0308 (file 0x37688): the friendly
    // branch at +0x85 does `mov dx,0xffff; mov ax,0xffe2` (dx:ax = -30) ->
    // __lmul(0:17a6) by the damage in cx:bx -> __ldiv(0:1816) by the pushed 2
    // = -30*damage/2 = -15*damage. The normal-hit friendly branch (+0x6b,
    // param_7==0) and the shield-hit friendly branch (param_7==1, decompile
    // FUN_4098_0308.c:41-47) execute the SAME code -> NO normal-vs-shield split.
    // The prior -1*damage shield case came from VERIFY_FIXES.md offsets that did
    // not reproduce (a cmp sequence, not the immediates); it was a bug.
    _award(attacker, -15 * Math.trunc(damage));
  } else if (shield_hit) {
    _award(attacker, SCORE_SHIELD_HIT_MULT * Math.trunc(damage));
  } else {
    _award(attacker, Math.trunc(damage * HIT_POINT_MULT));
  }
}

/** FUN_4098_00f3: end-of-round survival pool. */
export function survival_award(state: State): void {
  const alive = state.tanks.filter((t) => t.alive);
  if (alive.length === 0) {
    return;
  }
  let pool: number;
  if (state.cfg.scoring === SCORING_BASIC) {
    pool = state.tanks.length * SCORE_SURVIVAL_BASIC_PER;
  } else {
    pool = SCORE_SURVIVAL_STD;
  }

  if (state.cfg.team_mode === TEAM_NONE) {
    for (const t of alive) {
      t.win_counter += 1;
      _award(t, pool);
    }
  } else {
    const team = alive[0].team_id;
    const members = state.tanks.filter((t) => t.team_id === team);
    const aliveMembers = members.filter((t) => t.alive).length;
    const share = floordiv(pool, Math.max(1, aliveMembers));
    for (const t of members) {
      if (t.alive) {
        t.win_counter += 1;
        _award(t, share);
      } else {
        _award(t, floordiv(share, 2)); // dead teammate gets half
      }
    }
  }
}

/**
 * GREEDY ranking key (FUN_3a16_0819): cash + sum(held stock value).
 * Stock value uses the sell-back depreciation (0.80 * live per-unit price).
 */
export function net_worth(state: State, tank: Tank): number {
  let total = tank.cash;
  for (let slot = 0; slot < tank.inventory.length; slot++) {
    const qty = tank.inventory[slot];
    if (qty > 0) {
      const per_unit = state.economy.unit_price(slot) * SELLBACK_MULT_NORMAL;
      total += Math.trunc(qty * per_unit);
    }
  }
  return total;
}

/**
 * FUN_3a16_0c71: non-GREEDY by score; GREEDY by net worth (desc).
 *
 * Mirrors Python `sorted(state.tanks, key=key, reverse=True)`: a STABLE descending
 * sort. JS Array.prototype.sort is stable (ES2019+), so a comparator that orders by
 * descending key and returns 0 for equal keys keeps tie order == input order, which
 * is what Python's reverse=True does (it does NOT reverse equal-key runs). Keys are
 * precomputed once per tank to match Python evaluating `key(t)` per element (and to
 * avoid recomputing net_worth inside the comparator).
 */
export function rank(state: State): Tank[] {
  const key =
    state.cfg.scoring === SCORING_GREEDY
      ? (t: Tank) => net_worth(state, t)
      : (t: Tank) => t.score;
  const decorated = state.tanks.map((t) => ({ t, k: key(t) }));
  // Stable descending: compare by key descending; equal keys preserve input order.
  decorated.sort((p, q) => (p.k < q.k ? 1 : p.k > q.k ? -1 : 0));
  return decorated.map((d) => d.t);
}

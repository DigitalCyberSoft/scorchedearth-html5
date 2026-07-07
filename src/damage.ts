/**
 * Detonation -> damage -> shield -> health, plus fall damage. A faithful
 * TypeScript port of scorch-py/scorch/damage.py (the fidelity oracle, itself
 * byte-verified against 1.5/SCORCH.EXE). Catalog 11 sections 1/3/5.
 *
 * Damage law (catalog 11 s.1) is LINEAR: damage% = (R - d)*100/R, zero beyond R,
 * rounded to int.  Byte-verified: all three explosion engines use the same
 * multiplier 100.0 -- standard FUN_4d1e_015a:107 (DAT_5f38_683c=100.0f), nuke
 * FUN_3770_041d:83 (DAT_5f38_5692=100.0f), dirt FUN_35d5_0009:97
 * (DAT_5f38_52aa=100.0f).  The catalog tagged the main-engine multiplier BLOCKED;
 * direct byte reads (file_off 0x55d80+offset) promote it to FACT.
 *
 * Two distinct damage paths in the engine:
 *   FUN_4912_04b2 (apply_tank_damage): hit-counters -> shield gate FUN_4191_0034
 *     -> overflow to health FUN_3a16_0fe8.  Used by every radial/charge/laser hit.
 *   FUN_3a16_0fe8 (apply_health_direct): subtract from health, NO shield, NO
 *     hit-counter.  Used by the direct-hit instakill (FUN_4d1e_0021:24) and by
 *     tank-fall damage (FUN_2975_048c:222 and the faller half of the squash) --
 *     so a shield does NOT absorb fall damage or a direct hit.
 *
 * Shield gate (FUN_4191_0034, s.3): D<S absorbed (S-=D), D>=S destroys shield and
 * overflows D-S to health.  Fall damage = 2*pixels (s.5.2, DAT_5f38_5164=2);
 * parachute deploys iff threshold < predicted damage and negates it.
 *
 * ============================================================================
 * NUMERIC NOTES (load-bearing for the differential gate, test/damage.test.ts):
 *
 *  - Python `int(x)` truncates TOWARD ZERO  -> Math.trunc(x).
 *
 *  - Python `round(x)` is BANKER'S ROUNDING (round-half-to-even), NOT JS
 *    Math.round (which rounds .5 toward +Infinity).  The radial damage law
 *    round((R - d)*100/R) lands on exact half-integers for many (R, d) pairs
 *    (e.g. R=8,d=3 -> 62.5; Python round=62, Math.round would give 63).  So this
 *    module implements pyRound() = round-half-to-even and uses it where the
 *    Python uses round().  Getting this wrong flips the dealt damage by 1 on
 *    every half-integer falloff sample.
 *
 *  - Python `math.hypot(dx, dy)` -> Math.sqrt(dx*dx + dy*dy), NOT Math.hypot.
 *    V8's Math.hypot and CPython's math.hypot disagree by 1 ULP on irrational
 *    results (the multi-arg scaling path differs; MEASURED: 92/441 integer-grid
 *    inputs differ).  But the engine only ever measures blast distance between
 *    INTEGER pixel coordinates (_tank_center returns the tank's stored integer
 *    (x, y); explode() is called with integer impact pixels), so dx,dy are
 *    integers, dx*dx+dy*dy is an exact integer, and a single correctly-rounded
 *    Math.sqrt reproduces CPython's math.hypot BIT-FOR-BIT (MEASURED: 0/441
 *    integer-grid mismatches).  Using Math.sqrt of the exact squared sum is both
 *    faithful to the oracle's value and free of the libm hypot divergence.
 * ============================================================================
 */
import * as C from "./constants";
import * as scoring from "./scoring";
import { sfx } from "./sound";

/**
 * Python round() == round-half-to-even (banker's rounding).  Used where the
 * Python source calls round().  JS Math.round rounds .5 toward +Infinity, which
 * is WRONG for this port; this helper matches CPython's float.__round__ for the
 * non-negative finite magnitudes the damage law produces (and is symmetric for
 * negatives via the round-to-even rule, matching CPython).
 */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly halfway: round to the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

// ---------------------------------------------------------------------------
// Duck-typed structural shapes the damage module reads/mutates. Mirrors exactly
// the fields scorch/damage.py touches, so the differential dumper/test can drive
// it with the same lightweight mocks the oracle builds. (Kept as interfaces, not
// classes: the port is duck-typed exactly like the Python.)
// ---------------------------------------------------------------------------

/** The blast-distance reference + damage/shield/health accumulators on a tank. */
export interface Tank {
  // identity / state
  alive: boolean;
  player_index: number;
  // position (stored integer coordinate; the explosion loop's distance ref)
  x: number;
  y: number;
  half_width: number;
  // health / shield accumulators
  health: number;
  shield_hp: number;
  shield_item: number;
  // hit counters (catalog 14 s.4.2); keyed by shooter player_index
  hits_this_round: { [k: number]: number };
  hits_career: { [k: number]: number };
  // parachute fields (catalog 11 s.5)
  parachute_deployed: boolean;
  parachutes: number;
  parachute_threshold: number;
  // scoring-mutated fields (scoring.Tank); present because award_* writes them
  score: number;
  cash: number;
  team_id: number;
  win_counter: number;
  inventory: number[];
}

/** Config gate read on the damage path: cfg.is_on("SOUND") + scoring fields. */
export interface Cfg {
  team_mode: number;
  scoring: number;
  is_on(key: string): boolean;
}

/** Terrain surface the fall/explosion paths query. */
export interface Terrain {
  h: number;
  carve_circle(cx: number, cy: number, radius: number): void;
  is_supported(x: number, y: number, half_width: number): boolean;
}

/** Game-state surface damage threads through. Mirrors the duck-typed reads. */
export interface State {
  cfg: Cfg;
  tanks: Tank[];
  terrain: Terrain;
  current_shooter: Tank | null;
  current_weapon?: unknown;
  economy: scoring.Economy;
  add_explosion(cx: number, cy: number, radius: number): void;
  on_tank_destroyed(victim: Tank, weapon: unknown): void;
}

// Direct-hit shield "chip": there is NO separate chip constant in v1.5.  When a
// shell is intercepted by a shield on the no-detonate path, the shield absorbs the
// projectile's OWN damage via tank+0x96 -= D (FUN_4191_0034.c:16-17; the absorb
// gate `if (param_2 < HP) HP -= param_2`).  RECOVERED_SHIELDS.md T3c: "the chip ==
// the projectile's damage, absorbed."  At a point-blank intercept the impact
// distance d -> 0, so the linear law round((R-d)*100/R) (FALLOFF_NUM=100) yields the
// weapon's full damage regardless of radius.  The prior flat 15 was fabricated.
export const SHIELD_CHIP_FULL = C.FALLOFF_NUM; // FACT: point-blank projectile damage = 100 (d=0)

/**
 * Blast-distance reference for a tank: the tank's stored integer coordinate
 * (+0x0e, +0x10) = (x, y), the SAME struct fields the explosion loop reads.
 *
 * The standard-explosion per-tank loop (FUN_4d1e_015a.c:95-97) computes the
 * distance from the impact center to each living tank via FUN_4c70_002b, which
 * reads the tank's stored coordinate pair.  The struct holds exactly ONE
 * coordinate (+0x0e/+0x10, catalog 11 s.0 field map); +0x10 is the settle-time
 * integer Y written by the fall loop (FUN_2975_048c.c:172) and equals the
 * ground-top under the tank -- the BASE row, which the port stores as t.y.
 * There is no separate "body-center" field, and no decompiled code applies a
 * vertical offset before the distance compute (the offset slot inside
 * FUN_4c70_002b is FP-mangled/Blocked, but the input it reads is the base
 * coordinate; INTERPRETATION: the engine measures to the base).
 *
 * A prior `t.y - 4` here injected a spurious 4px vertical displacement, so a
 * ground-level blast beside a tank measured d = hypot(h, 4) instead of h.  That
 * overstated d and systematically UNDER-applied falloff -- worst for small
 * radii: a Baby Missile (R=10) point-blank ground blast dealt 60 instead of
 * 100, and the outer ring of partial hits dropped below the strict d < R gate
 * and registered 0 (the reported "partial hits that aren't registering").
 * Measuring to the base (no offset) restores round((R-d)*100/R).
 */
export function _tank_center(t: Tank): [number, number] {
  return [t.x, t.y];
}

/** FUN_4191_0034.  Returns [overflow_to_health, absorbed_by_shield]. */
export function shield_gate(tank: Tank, amount: number): [number, number] {
  if (tank.shield_hp !== 0 && amount !== 0) {
    if (amount < tank.shield_hp) {
      tank.shield_hp -= amount;
      return [0, amount];
    }
    const overflow = amount - tank.shield_hp;
    const absorbed = tank.shield_hp;
    tank.shield_hp = 0;
    tank.shield_item = 0;
    return [overflow, absorbed];
  }
  return [amount, 0];
}

/**
 * No-op: v1.5 has NO stochastic shield failure (RECOVERED_SHIELDS.md T2,
 * byte-exact negative result).  Every writer of the shield-HP field tank+0x96
 * was enumerated and classified deterministic (arm / absorb / recharge /
 * overflow-destroy / swap / teleport); no RNG (FUN_3bf9_0099/048b) call exists
 * on any shields.cpp path.  The manual's "shield failures" are the deterministic
 * HP-overflow collapse in shield_gate (FUN_4191_0034:48), not a random drop.
 * Kept as a no-op so the call site in apply_tank_damage is unchanged.
 */
export function shield_failure_check(_state: State, _tank: Tank): boolean {
  return false;
}

/** FUN_4912_04b2 -> shield gate -> FUN_3a16_0fe8 (health) + scoring. */
export function apply_tank_damage(state: State, tank: Tank | null, amount: number): void {
  amount = Math.trunc(amount);
  if (tank === null || amount <= 0 || !tank.alive) {
    return;
  }
  const shooter = state.current_shooter;
  if (shooter !== null) {
    // hit counters (catalog 14 s.4.2)
    const i = shooter.player_index;
    tank.hits_this_round[i] = (tank.hits_this_round[i] ?? 0) + 1;
    tank.hits_career[i] = (tank.hits_career[i] ?? 0) + 1;
  }

  const [overflow, absorbed] = shield_gate(tank, amount);
  if (absorbed > 0 && tank.shield_hp === 0) {
    // shield destroyed by this hit
    sfx.play("shield_collapse", state.cfg.is_on("SOUND"));
  }
  if (absorbed > 0) {
    scoring.award_hit(state as unknown as scoring.State, shooter, tank, absorbed, true);
    // A non-failproof shield that just took a hit may spontaneously fail
    // (catalog 02 s.9).  Only meaningful while the shield survived the hit
    // (D < S); a hit that already destroyed the shield (overflow > 0) has
    // nothing left to fail.
    if (tank.shield_hp > 0) {
      shield_failure_check(state, tank);
    }
  }
  if (overflow > 0) {
    _apply_health_direct(state, tank, overflow, false);
  }
}

/**
 * FUN_3a16_0fe8: subtract from the health accumulator, bypassing the shield.
 *
 * Awards the per-hit score (FUN_4098_0308 at FUN_3a16_0fe8:60) when count_hit;
 * when called as the overflow tail of FUN_4912_04b2, the score was already
 * awarded by the shield gate so count_hit is False.  Kills when health crosses
 * zero (the DAT_5f38_dd5c burial branch routes a buried tank to FUN_3a16_0f44;
 * here every zero-crossing kills).
 */
export function _apply_health_direct(
  state: State,
  tank: Tank,
  amount: number,
  count_hit = true
): void {
  amount = Math.trunc(amount);
  if (amount <= 0 || !tank.alive) {
    return;
  }
  if (count_hit) {
    scoring.award_hit(
      state as unknown as scoring.State,
      state.current_shooter,
      tank,
      amount,
      false
    );
  }
  tank.health -= amount;
  if (tank.health <= 0) {
    tank.health = 0;
    kill_tank(state, tank);
  }
}

/**
 * Tank-fall damage path (FUN_2975_048c:222 / squash faller :71): health
 * direct, no shield, no hit-counter, attributed to no shooter.
 */
export function apply_fall_damage(state: State, tank: Tank, amount: number): void {
  _apply_health_direct(state, tank, amount, false);
}

/**
 * Mark `victim` dead and run the death FX.
 *
 * `weapon` is the KILLING weapon Item (the detonating weapon whose blast did
 * the lethal damage), threaded through to the death blast so its crater uses
 * that weapon's effective radius.  The binary reads this as the global
 * `DAT_5f38_120e[DAT_5f38_e344]` at FUN_3ef5_029a.c:96 -- the CURRENT
 * projectile's per-weapon radius word (catalog 11 s.1.1:101; e344 =
 * "current projectile's weapon-type id", catalog 12 s.40).  The port latches
 * that current weapon in `state.current_weapon` at detonation (explode /
 * direct_hit) and falls back to it when no explicit `weapon` is passed, so a
 * radial-blast kill (which never threads a weapon argument through the radial
 * loop) still recovers the killing weapon's radius -- exactly the binary's
 * global-current-weapon model.  A non-weapon kill (fall/burial/squash) leaves
 * both None and the death FX uses its fallback radius (death.py:71).
 */
export function kill_tank(state: State, victim: Tank, weapon: unknown = null): void {
  if (!victim.alive) {
    return;
  }
  victim.alive = false;
  victim.health = 0;
  // NO award here: the binary awards inside the kill roulette (FUN_271b_0005
  // offset 006d -> FUN_4098_0263) when the dead-tank sweep PROCESSES the
  // corpse, not when health crosses zero.  The port's death queue fires the
  // ["award", tank] signal at that processing point (death.step_queue), where
  // game runs scoring.award_kill + the die taunt.  A stub state without the
  // queue (dump mocks) gets FX only, matching the old caller-owns-scoring
  // split.  See scorch-re/notes_death_throe_roulette.md s.2.1.
  if (weapon === null) {
    weapon = state.current_weapon ?? null;
  }
  state.on_tank_destroyed(victim, weapon);
}

/**
 * Standard explosion FUN_4d1e_015a: carve crater + linear radial damage.
 *
 * Per-tank loop (:87-126): for each living tank, d = dist(center); if d < R,
 * dmg = ROUND((R - d) * 100 / R) -> FUN_4912_04b2.  Strict d < R gate (:106).
 *
 * `state.current_weapon` is the weapon whose blast this is (set by the caller
 * in weapon_behaviors.detonate, the latch site mirroring DAT_5f38_e344); a
 * kill triggered inside the radial loop reads it for the death-blast radius.
 */
export function explode(
  state: State,
  cx: number,
  cy: number,
  radius: number,
  carve = true
): void {
  radius = Math.trunc(radius);
  if (radius <= 0) {
    return;
  }
  if (carve) {
    state.terrain.carve_circle(cx, cy, radius);
    state.add_explosion(cx, cy, radius);
  }
  for (const tank of state.tanks.slice()) {
    if (!tank.alive) {
      continue;
    }
    const [tx, ty] = _tank_center(tank);
    // math.hypot(tx-cx, ty-cy) for integer operands == Math.sqrt of the exact
    // squared sum (see NUMERIC NOTES); avoids the V8/CPython hypot 1-ULP split.
    const dx = tx - cx;
    const dy = ty - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < radius) {
      const dmg = pyRound(((radius - d) * C.FALLOFF_NUM) / radius);
      apply_tank_damage(state, tank, dmg);
    }
  }
}

/**
 * FUN_4d1e_0021:24 direct-hit path: FUN_3a16_0fe8(tank, tank+0xa2, 1) --
 * removes the tank's full remaining health via the health-direct path, so it
 * bypasses the shield (a shielded tank never reaches here; it intercepts the
 * shell and only chips, s.3.2).  The lethal kill's death blast reads the
 * detonating weapon from state.current_weapon (latched in detonate()).
 */
export function direct_hit(state: State, tank: Tank): void {
  if (tank.alive) {
    _apply_health_direct(state, tank, tank.health, true);
  }
}

/**
 * Direct hit on a shielded tank: chip the shield, no detonation (s.3.2).
 *
 * The chip is the projectile's OWN damage absorbed by the shield -- there is no
 * separate chip constant (RECOVERED_SHIELDS.md T3c; FUN_4191_0034.c:16-17 does
 * `if (D < HP) HP -= D` else destroy).  `damage` defaults to the point-blank
 * impact value (FALLOFF_NUM=100): at the intercept the distance d -> 0 and the
 * linear law round((R-d)*100/R) gives the full damage for any radius.  Mirrors
 * the gate's absorb-or-destroy on tank+0x96.
 */
export function shield_chip(tank: Tank, damage: number = SHIELD_CHIP_FULL): void {
  if (tank.shield_hp > 0) {
    tank.shield_hp = Math.max(0, tank.shield_hp - Math.trunc(damage));
    if (tank.shield_hp === 0) {
      tank.shield_item = 0;
    }
  }
}

// ---- fall damage (catalog 11 section 5) ----

/**
 * FUN_2975_01a6: simulate the drop on a LOCAL copy of x/y (the tank is not
 * moved); accumulate DAT_5f38_5164 (=2) per pixel until the footprint is
 * supported (is_supported) or the floor (terrain.h-2) is reached.  Returns
 * 2 * pixels_it_would_fall -- the manual's 'onboard computer estimate'.
 */
export function predicted_fall_damage(terrain: Terrain, tank: Tank): number {
  const x = tank.x;
  let y = tank.y;
  const floor = terrain.h - 2;
  let pixels = 0;
  while (y < floor) {
    if (terrain.is_supported(x, y, tank.half_width)) {
      break;
    }
    y += 1;
    pixels += 1;
  }
  return pixels * C.FALL_DMG_PER_PIXEL;
}

/**
 * FUN_2975_048c:157-168 deploy decision: only if the chute is DEPLOYED
 * (+0x28) and chutes remain; then deploy iff threshold (+0x2c) == 0 OR
 * threshold < predicted_fall_damage.
 */
export function chute_should_deploy(terrain: Terrain, tank: Tank): boolean {
  if (!tank.parachute_deployed || tank.parachutes < 1) {
    return false;
  }
  if (tank.parachute_threshold === 0) {
    return true;
  }
  return tank.parachute_threshold < predicted_fall_damage(terrain, tank);
}

/**
 * Per-weapon detonation and special flight behaviors -- a faithful TypeScript
 * port of scorch-py/scorch/weapon_behaviors.py (the fidelity oracle, itself
 * byte-verified against 1.5/SCORCH.EXE).
 *
 * Dispatch mirrors the weapon table at 5f38:1200 (per-type handler at +0x00,
 * behavior-class branch in FUN_2a4a_1349).  Effects follow MECHANICS "Weapon
 * behaviors" and catalog 11/12.  Where the exact geometry is FP-BLOCKED (riot
 * wedge trig, plasma battery multiplier) the documented effect is reconstructed
 * and flagged.  Every FUN_<seg>_<off> / DAT_ provenance comment from the Python
 * source is preserved verbatim so the lineage survives.
 *
 * ============================================================================
 * NUMERIC NOTES (load-bearing for the differential gate, test/weapon_behaviors.test.ts):
 *
 *  - Python `int(x)` truncates TOWARD ZERO -> Math.trunc(x).  Every `int(...)`
 *    cast in the source is rendered as Math.trunc here (positions, radii, spans).
 *
 *  - Python `//` (floor division) on the non-negative integer operands this
 *    module uses (bore_half = r // 2, budget // 5, span offsets) -> Math.floor.
 *
 *  - Python `round(...)` is BANKER'S rounding (round-half-to-even).  The two
 *    round() sites here are the napalm heat amount round(coeff*(1 - d/pool_r))
 *    and the sandhog charge round((depth - tank_depth)*100/depth).  Both are
 *    rendered with pyRound() (imported from ./damage), NOT Math.round, which
 *    rounds .5 toward +Inf and would diverge on every half-integer sample.
 *
 *  - TRANSCENDENTAL sites (asserted within a tight epsilon, see the test):
 *      * _det_dirt_wedge: math.tan(radians(35)) for the wedge spread.
 *      * fire_laser / fire_plasma_laser: math.atan2(vy,vx), cos(ang), -sin(ang)
 *        for the beam direction; the per-pixel marching x += cos, y += -sin
 *        accumulates these floats, so the visited integer pixels (int(x),int(y))
 *        depend on the transcendental stream.  V8 Math.{atan2,cos,sin} and
 *        CPython math.{atan2,cos,sin} agree to <=1 ULP for these inputs, and the
 *        int() truncation of the marched position is stable across that ULP for
 *        the angles in the battery (MEASURED 0 pixel-path mismatches); the test
 *        asserts the raw direction floats within 1e-12 AND the integer pixel
 *        paths exactly.
 *      * math.hypot(dx,dy) (in _det_funky / _det_napalm / _nearest_tank): the
 *        engine measures between INTEGER pixel/tank coordinates, so dx,dy are
 *        integers and Math.sqrt(dx*dx+dy*dy) reproduces CPython math.hypot
 *        bit-for-bit (the damage.ts NUMERIC NOTES result; Math.hypot is NOT used).
 * ============================================================================
 */
import * as C from "./constants";
import * as damage from "./damage";
import { pyRound } from "./damage";
import * as _pal from "./palette";
import { Projectile } from "./objects";
import { sfx } from "./sound";
import type { Item } from "./weapons";

// ---------------------------------------------------------------------------
// Duck-typed structural shapes weapon_behaviors reads/mutates.  These mirror
// exactly the fields scorch/weapon_behaviors.py touches, so the differential
// dumper/test can drive the port with the same lightweight mocks the oracle
// builds.  (Kept as interfaces, not classes: the port is duck-typed like the
// Python.)
// ---------------------------------------------------------------------------

/** The blast-distance reference + life/shield/health fields a tank exposes to
 *  these behaviors (a superset of damage.Tank: also carries angle for riot aim,
 *  the laserproof shield flag fire_laser reads, and -- via damage.Tank -- the
 *  health/shield/score accumulators the blast paths mutate). */
export interface BTank extends damage.Tank {
  angle?: number; // turret aim (deg) -- riot wedge default 90
  shield_laserproof: boolean; // Super Mag: stops the laser beam (fire_laser)
}

/** The pixel-framebuffer surface the behaviors read/carve.  Read methods
 *  (column_top/is_solid/is_dirt) MUST reflect prior write() calls (the digger
 *  trail stamp + dirt tower/wedge read back cells they just wrote); the bulk
 *  ops (carve_circle/deposit_circle/carve_wedge/settle) are the terminal
 *  destructive primitives.  Extends damage.Terrain (carve_circle/is_supported/h)
 *  so a BState is a valid damage.State for the explode path. */
export interface BTerrain extends damage.Terrain {
  w: number;
  column_top(x: number): number;
  is_solid(x: number, y: number): boolean;
  is_dirt(x: number, y: number): boolean;
  write(x: number, y: number, color: number): void;
  deposit_circle(cx: number, cy: number, r: number): void;
  carve_wedge(cx: number, cy: number, r: number, half_angle_deg: number, aim_deg: number): void;
  settle(cfg: unknown, rng: unknown, x_lo?: number, x_hi?: number): void;
}

/** The seeded generator interface (scorch.rng.Rng); only pick() is used here. */
export interface BRng {
  pick(n: number): number;
}

/** The projectile-loop scratch the steppers/spawners read/mutate.  A superset
 *  of objects.Projectile's used fields. */
export interface BProjectile {
  weapon: Item;
  owner: BTank | null;
  px: number;
  py: number;
  vx: number;
  vy: number;
  sx: number;
  sy: number;
  active: boolean;
  split_done: boolean;
  warheads_left: number;
  state: { [k: string]: unknown };
  trail: unknown[];
}

/** The game-state surface the behaviors thread through.  Superset of
 *  damage.State (the behaviors call damage.explode/apply_tank_damage).  Narrows
 *  tanks/terrain to the wider BTank[]/BTerrain shapes (legal: both are subtypes
 *  of the damage.State fields they override). */
export interface BState extends damage.State {
  tanks: BTank[];
  terrain: BTerrain;
  explosion_scale: number;
  rng: BRng;
  projectiles: BProjectile[];
  add_explosion(cx: number, cy: number, radius: number, kw?: { [k: string]: unknown }): void;
  add_plasma_ring(x: number, y: number, max_r: number): void;
  add_beam(pts: Array<[number, number]>): void;
  start_digger_cycle?: () => void;
}

/** Python math.hypot for INTEGER (or float) operands -- Math.sqrt of the squared
 *  sum (NOT Math.hypot; see damage.ts NUMERIC NOTES: V8/CPython hypot split by
 *  1 ULP, but the squared-sum sqrt is bit-exact on the integer grid the engine
 *  measures). */
function hypot(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

/** Python math.radians. */
function radians(deg: number): number {
  return (deg * Math.PI) / 180.0;
}

export function eff_radius(state: BState, weapon: Item): number {
  // Base blast radius * EXPLOSION_SCALE resolution scalar (catalog 09 s.1.5).
  return Math.abs(weapon.blast) * state.explosion_scale;
}

// ---------------------------------------------------------------------------
// Detonation dispatch (called when a projectile resolves at (x, y)).
// ---------------------------------------------------------------------------
export function detonate(state: BState, proj: BProjectile, x: number, y: number): void {
  const w = proj.weapon;
  // Latch the CURRENT detonating weapon (the binary's DAT_5f38_e344, set from
  // the projectile's +0x26 weapon-type id at FUN_2a4a_0b1f.c:36; catalog 12
  // s.40).  A tank killed by this blast reads it in damage.kill_tank so the
  // death crater uses this weapon's effective radius (FUN_3ef5_029a.c:96 reads
  // DAT_5f38_120e[DAT_5f38_e344]).
  state.current_weapon = w;
  // Plasma and nuclear detonations have their OWN event tones (the plasma
  // siren FUN_3f76_03bd / the nuke engine FUN_3770_041d); the generic
  // "explosion" rumble (FUN_4d1e_03e3) is the standard-blast voice and would
  // double up on those two, so skip it for them and let their handler speak.
  const cat = (w as Item & { category?: string }).category ?? "";
  if (w.behavior !== "tracer" && w.behavior !== "plasma" && cat !== "nuclear") {
    sfx.play("explosion", state.cfg.is_on("SOUND"));
  }
  // Nuclear weapons (Baby Nuke / Nuke, category "nuclear") share behavior
  // "explosive" in the table but detonate through the NUKE engine FUN_3770_041d,
  // not the standard FUN_4d1e_015a: a big bright solid fireball, a long (129-frame)
  // white-hot flash, then a palette shrink-sweep -- distinct shape AND colour from
  // an ordinary missile (RECOVERED_ANIMATIONS.md s.2; bug C).  MIRV/Death's-Head
  // children are category "multi", so they correctly stay on the standard path.
  if (((w as Item & { category?: string }).category ?? "") === "nuclear") {
    _det_nuclear(state, proj, x, y);
    return;
  }
  const fn = _DETONATORS[w.behavior] ?? _det_explosive;
  fn(state, proj, x, y);
}

function _det_explosive(state: BState, proj: BProjectile, x: number, y: number): void {
  damage.explode(state, x, y, eff_radius(state, proj.weapon));
}

function _det_nuclear(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Nuke / Baby Nuke detonation -- port of FUN_3770_041d.
   *
   * Differs from the standard explosion (FUN_4d1e_015a) on three byte-confirmed
   * points, all in FUN_3770_041d.c:
   *   * EXPAND draws a FLAT-colour-200 filled disk at every radius (a solid bright
   *     fireball, NOT the standard's 0xDD - r*20/R thin ring ramp).
   *   * FLASH runs 129 frames (vs the standard's 49) -- a much longer hold.
   *   * SHRINK sweeps the DAC band 200..241.
   *   * The radius is clamped to DAT_5f38_12aa -- the nuke is the largest blast.
   * Damage is the same linear (R-d)*100/R law (multiplier DAT_5f38_5692=100.0,
   * identical to the standard); the visual is overridden to the nuke style. */
  // NUKE engine tone (FUN_3770_041d.c:39,48,51 -> a281 100/200 alternation).
  sfx.play("nuke", state.cfg.is_on("SOUND"));
  const r = eff_radius(state, proj.weapon);
  damage.explode(state, x, y, r, false); // damage only (no fireball)
  state.terrain.carve_circle(Math.trunc(x), Math.trunc(y), Math.trunc(r)); // the crater
  state.add_explosion(Math.trunc(x), Math.trunc(y), Math.trunc(r), { nuke: true }); // the nuke fireball
}

function _det_funky(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Funky Bomb (FUN_3319_0516 + chain FUN_3319_01fe).
   *
   * Energy budget = blast*10 (FUN_3319_0516:14, DAT_5f38_d506).  15 random
   * scatter offsets are precomputed (FUN_3319_0016, DAT_5f38_d508/d526) and
   * cycled 0..14.  The bounded chain spawns multi-colour flame sub-explosions
   * and applies damage min(local_6,10) per step, where local_6 = budget/5 steps
   * down by 0x32 (FUN_3319_01fe:59,75-83).  Confined to the scatter box. */
  const r = eff_radius(state, proj.weapon);
  const budget = Math.trunc(Math.abs(proj.weapon.blast)) * 10; // d506 = blast*10 (FUN_3319_0516:14)
  // 15 random scatter offsets (cycled 0..14), within the blast box (d508/d526)
  const n = (proj.weapon.params["scatter"] as number | undefined) ?? 15;
  const offsets: Array<[number, number]> = [];
  for (let _i = 0; _i < n; _i++) {
    offsets.push([
      state.rng.pick(Math.trunc(2 * r) + 1) - Math.trunc(r),
      state.rng.pick(Math.trunc(2 * r) + 1) - Math.trunc(r),
    ]);
  }
  // NO central blast: FUN_3319_0516 goes straight to the scatter chain.  All
  // damage comes from the bounded flame chain.  The chain SEEDS at the bomb's
  // own impact point (DAT_5f38_e1e4/e1e6) then cycles the scatter offsets, so
  // the first flame lands where the bomb hit and subsequent flames scatter.
  const flame_r = Math.max(8, r * 0.3);
  const chain: Array<[number, number]> = [[0, 0], ...offsets];
  let i = 0;
  let local_6 = Math.floor(budget / 5); // FUN_3319_01fe:59
  while (local_6 > 0) {
    const [ox, oy] = chain[((i % chain.length) + chain.length) % chain.length];
    const sx = Math.trunc(x + ox);
    const sy = Math.trunc(y + oy);
    // multi-colour flame sub-explosion (carves crater + radial damage)
    damage.explode(state, sx, sy, flame_r);
    // plus the per-step flat charge dmg = min(local_6, 10) applied AT the
    // flame point (FUN_4912_04b2 at DAT_5f38_e1e4/e1e6 = the sub-explosion
    // coordinate, :82), gated to a tank standing on that flame cell -- not
    // the global nearest, which would reach across the map.
    const tk = _nearest_tank(state, sx, sy);
    if (tk !== null && hypot(tk.x - sx, tk.y - sy) <= flame_r) {
      const dmg = local_6 <= 10 ? local_6 : 10; // min(local_6, 10)
      damage.apply_tank_damage(state, tk, dmg);
    }
    local_6 -= 0x32; // :75 step -50
    i += 1;
  }
}

export function _nearest_tank(state: BState, x: number, y: number): BTank | null {
  // Distance to the tank's stored base coordinate (t.x, t.y) -- the same
  // reference damage._tank_center uses, matching the binary's single
  // (+0x0e,+0x10) struct coord (no -4 body offset; see damage._tank_center).
  let best: BTank | null = null;
  let bd = 1e9;
  for (const t of state.tanks) {
    if (t.alive) {
      const d = hypot(t.x - x, t.y - y);
      if (d < bd) {
        best = t;
        bd = d;
      }
    }
  }
  return best;
}

export function _pool_depth(state: BState, x: number, y: number, r: number): number {
  /* How deep the flame can pool at (x, y), in [0, 1].
   *
   * RECONSTRUCTED proxy for the BLOCKED 100-slot blob solver (catalog 12 s.7,
   * FUN_36e6_000b / flow probe FUN_36e6_076c).  The decompiled flow probe reads
   * pixels left/right/below: napalm stacks UPWARD only when walls on BOTH sides
   * hold it (the `2 = stuck-between-walls` return); otherwise it drains down a
   * slope.  A basin has terrain RISING ABOVE the landing on both flanks; flat
   * open ground has no rise and drains.  Returns min(left_rise, right_rise)
   * normalised by the blast radius -- the depth the pool can stack to before it
   * overspills the lower rim.  Flat ground -> 0 (shallow splash); a deep pit ->
   * ~1 (deep pool). */
  const t = state.terrain;
  r = Math.max(1, Math.trunc(r));
  const floor_y = t.column_top(x); // the pool floor (surface under impact)

  const rise = (direction: number): number => {
    let best = 0;
    for (let step = 1; step <= r; step++) {
      const top = t.column_top(x + direction * step);
      best = Math.max(best, floor_y - top); // how far the wall rises above the floor
    }
    return best;
  };

  const left = rise(-1);
  const right = rise(1);
  const enclosed = Math.min(left, right); // a pool only holds to the LOWER rim
  return Math.max(0.0, Math.min(1.0, enclosed / r));
}

function _det_napalm(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Napalm / Hot Napalm: pooling flame; deeper pools do more heat.
   *
   * Heat coefficient pair is byte-confirmed (catalog 12 s.7, 5f38:5682-568e):
   * Napalm (25, 30), Hot Napalm (40, 50).  The handler selects within the pair
   * by pool depth -- a shallow splash uses the low coeff, a deep pool the high
   * coeff.  weapon.heat carries the low coeff; weapon.params['deep_heat'] the
   * high one.  Per-tank burn is linear falloff over the pool. */
  const r = eff_radius(state, proj.weapon);
  const low = proj.weapon.heat;
  const high = (proj.weapon.params["deep_heat"] as number | undefined) ?? low;
  const depth = _pool_depth(state, Math.trunc(x), Math.trunc(y), r); // 0 shallow .. 1 deep basin
  const coeff = low + (high - low) * depth; // deeper pool -> high coeff
  const pool_r = r * (1.0 + 0.5 * depth); // a deep pool also spreads wider
  damage.explode(state, x, y, r, false);
  state.add_explosion(Math.trunc(x), Math.trunc(y), Math.trunc(pool_r));
  // heat damage to tanks in the pool, scaled by the depth-selected coefficient
  for (const t of state.tanks) {
    if (!t.alive) {
      continue;
    }
    const d = hypot(t.x - x, t.y - y); // base coord (see damage._tank_center)
    if (d < pool_r) {
      damage.apply_tank_damage(state, t, pyRound(coeff * (1 - d / pool_r)));
    }
  }
}

function _dirt_settle_sfx(state: BState): void {
  // Dirt gravity-drop tone (FUN_3667_06d1.c:39,52 -> 0007 30 Hz per drop, 20 Hz
  // settle).  Fired by the dirt-moving detonators, the deliberate settle events.
  sfx.play("dirt_settle", state.cfg.is_on("SOUND"));
}

function _det_dirt_sphere(state: BState, proj: BProjectile, x: number, y: number): void {
  state.terrain.deposit_circle(x, y, eff_radius(state, proj.weapon));
  state.terrain.settle(state.cfg, state.rng, x - 60, x + 60);
  _dirt_settle_sfx(state);
}

function _det_dirt_slump(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Liquid Dirt (record 28): deposit dirt, then slump/settle to fill holes.
   *
   * Handler is FUN_37d2_004a (FACT, catalog 12 s.10 / summary table line 432);
   * a slump-until-stable particle solver: stamps the dirt particles, then loops
   * up to 0x32 = 50 passes; each particle falls one cell when the cell below is
   * solid (> 0x69) or slides one cell sideways into a hole; the loop ends early
   * when a full pass moves nothing.  "Oozes, fills holes, smooths terrain."
   *
   * REFUTES the audit's claim that Liquid Dirt shares napalm's handler: napalm
   * is FUN_36e6_01a0 (seg 0x36e6, body un-decompiled); Liquid Dirt is
   * FUN_37d2_004a (seg 0x37d2, body PRESENT).  Different segment, offset,
   * mechanic (deposit-and-settle vs burn).  Liquid Dirt is NOT routed through
   * _det_napalm.
   *
   * The port keeps deposit_circle + settle (the right family).  The exact slump
   * cadence is APPROXIMATED: the binary runs up to 50 stability-bounded passes
   * over individual particles; the port uses the bulk terrain.settle with a
   * fixed pass count (RECONSTRUCTED iteration count). */
  state.terrain.deposit_circle(x, y, eff_radius(state, proj.weapon));
  for (let _i = 0; _i < 3; _i++) {
    state.terrain.settle(state.cfg, state.rng, x - 80, x + 80);
  }
  _dirt_settle_sfx(state);
}

function _det_dirt_wedge(state: BState, proj: BProjectile, x: number, y: number): void {
  // Dirt Charge: expels a wedge of dirt upward (reconstructed).
  const r = Math.trunc(eff_radius(state, proj.weapon));
  const ha = radians(35);
  for (let dy = 0; dy <= r; dy++) {
    const spread = Math.trunc(dy * Math.tan(ha)) + 2;
    const yy = y - dy;
    for (let dx = -spread; dx <= spread; dx++) {
      if (!state.terrain.is_solid(x + dx, yy)) {
        state.terrain.write(x + dx, yy, C.DIRT_SHADE_LO + 4);
      }
    }
  }
  _dirt_settle_sfx(state);
}

function _det_dirt_settle(state: BState, proj: BProjectile, x: number, y: number): void {
  // Earth Disrupter: force all suspended dirt to settle (FUN_3667_06d1).
  state.terrain.settle(state.cfg, state.rng, 0, state.terrain.w);
  _dirt_settle_sfx(state);
}

function _det_riot_sphere(state: BState, proj: BProjectile, x: number, y: number): void {
  // Riot Bomb: removes a dirt sphere, no tank damage.
  state.terrain.carve_circle(x, y, eff_radius(state, proj.weapon));
  state.add_explosion(x, y, Math.trunc(eff_radius(state, proj.weapon)), { dirt_only: true });
}

export const RIOT_WEDGE_HALF: { [name: string]: number } = {
  // half-angle (deg), byte-exact 5f38:60fc/60fe
  "Riot Charge": 45, // RECOVERED_FP.md T1 (FUN_3f76_000d)
  "Riot Blast": 60,
};

function _det_riot_wedge(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Riot Charge/Blast: clear a TURRET-CENTERED wedge of dirt, no tank damage.
   * Byte-exact (RECOVERED_FP.md T1, FUN_3f76_000d): half-angle 45deg (Charge) /
   * 60deg (Blast) from 5f38:60fc/60fe, centered on the firing tank's turret aim;
   * radial extent = eff_radius (the weapon's blast 36/60 x EXPLOSION_SCALE).
   * The old version carved a fixed 35deg wedge straight up, ignoring the turret. */
  const half = RIOT_WEDGE_HALF[proj.weapon.name] ?? 45;
  const aim = proj.owner?.angle ?? 90;
  state.terrain.carve_wedge(x, y, eff_radius(state, proj.weapon), half, aim);
}

function _det_tracer(_state: BState, _proj: BProjectile, _x: number, _y: number): void {
  // no destructive capability
}

function _det_plasma(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Plasma Blast: a 360deg turret-independent blast (charge-and-fire energy).
   *
   * CORRECTED (RECOVERED_BATTERY.md): the real Plasma is record 31, handler
   * FUN_3770_0009.  The 30/45 radii in RECOVERED_FP.md T2 belong to Riot Bomb /
   * Heavy Riot Bomb (records 17/18) - a wrong-weapon mixup.  Plasma's radius
   * interpolates between BSS endpoints 5f38:1242/12aa (both uninitialised on
   * disk) by tier, and it consumes its OWN ammo, NOT batteries.  No byte-exact
   * radius is recoverable, so weapons.py keeps blast=40 (a flagged placeholder);
   * we render a radial blast via eff_radius.  Turret direction is ignored.
   *
   * Animation (FUN_3f76_03bd.c:16-23): the real Plasma sweeps a 360deg ring that
   * GROWS from radius 1 to R, then SHRINKS (erases) back -- not the generic grow
   * fireball.  damage.explode carves + damages + queues that generic fireball; we
   * suppress its fireball (carve=False, explicit carve_circle) and overlay the
   * recovered grow->shrink ring via state.add_plasma_ring. */
  // Plasma siren (FUN_3f76_03bd.c:18,22 -> 0007 1000..9000..1000 Hz sweep).
  // Plasma fires synchronously from game.fire (not via detonate()), so latch
  // the current weapon here too and play the plasma voice.
  state.current_weapon = proj.weapon;
  sfx.play("plasma", state.cfg.is_on("SOUND"));
  const r = eff_radius(state, proj.weapon);
  // damage + crater without the generic GROW fireball (the ring replaces it)
  damage.explode(state, x, y, r, false);
  state.terrain.carve_circle(Math.trunc(x), Math.trunc(y), Math.trunc(r));
  state.add_plasma_ring(x, y, r);
}

function _det_dud(_state: BState, _proj: BProjectile, _x: number, _y: number): void {
  // diggers/sandhogs handle their own
}

// ---------------------------------------------------------------------------
// Binary-only items (catalog 01 section B): present in the EXE master item
// block, ABSENT from SCORCH.DOC.  No stats, no prose, no decompiled handler
// (the name->handler binding is linker-fixed data, catalog 12 s.14).  Behaviors
// below are RECONSTRUCTED from the name + EXE block position and FLAGGED.
// ---------------------------------------------------------------------------
function _det_popcorn(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Popcorn Bomb [RECONSTRUCTED]: a small cluster of popping sub-explosions.
   *
   * Name + position (immediately before Baby Missile in the EXE block) read as a
   * cheap cluster bomblet.  Modeled as a funky-style scatter chain but smaller
   * and WITHOUT the toxic-flame budget: a fixed handful of bomblets scattered in
   * the blast box, each a baby-missile blast.  Undocumented in the manual. */
  const r = eff_radius(state, proj.weapon);
  const pops = (proj.weapon.params["pops"] as number | undefined) ?? 8;
  const bomblet_r = Math.max(4, r * 0.35);
  damage.explode(state, x, y, bomblet_r); // the kernel pop
  for (let _i = 0; _i < pops; _i++) {
    const ox = state.rng.pick(Math.trunc(2 * r) + 1) - Math.trunc(r);
    const oy = state.rng.pick(Math.trunc(r) + 1); // scatter mostly upward
    damage.explode(state, Math.trunc(x + ox), Math.trunc(y - oy), bomblet_r);
  }
}

function _det_dirt_tower(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Dirt Tower [RECONSTRUCTED]: raise a tall vertical pillar of dirt.
   *
   * No weapon routine builds a vertical dirt column in the .c set (catalog 10
   * s.10, 12 s.13: BLOCKED).  Name read literally: deposit a narrow, tall dirt
   * column up from the impact.  Width ~ blast/4, height ~ blast*2.
   * Undocumented in the manual. */
  const r = Math.trunc(eff_radius(state, proj.weapon));
  const half_w = Math.max(2, Math.trunc(r / 4)); // Python r // 4 (floor; r>=0)
  const height = Math.max(r, r * 2);
  const top = Math.max(0, y - height);
  for (let xx = x - half_w; xx <= x + half_w; xx++) {
    for (let yy = top; yy <= y; yy++) {
      if (!state.terrain.is_solid(xx, yy)) {
        state.terrain.write(xx, yy, C.DIRT_SHADE_LO + 8);
      }
    }
  }
  state.terrain.settle(state.cfg, state.rng, x - half_w - 4, x + half_w + 4);
  _dirt_settle_sfx(state);
}

function _det_plasma_laser(state: BState, proj: BProjectile, x: number, y: number): void {
  /* Plasma Laser detonation fallback [RECONSTRUCTED].
   *
   * Flight is handled synchronously by fire_plasma_laser (a laser-style beam);
   * this radial form is only reached if it is ever dispatched as a ballistic
   * detonation.  Treated as a plasma burst at the impact. */
  _det_plasma(state, proj, x, y);
}

type Detonator = (state: BState, proj: BProjectile, x: number, y: number) => void;

const _DETONATORS: { [behavior: string]: Detonator } = {
  explosive: _det_explosive,
  funky: _det_funky,
  napalm: _det_napalm,
  dirt_sphere: _det_dirt_sphere,
  dirt_slump: _det_dirt_slump,
  dirt_wedge: _det_dirt_wedge,
  dirt_settle: _det_dirt_settle,
  riot_sphere: _det_riot_sphere,
  riot_wedge: _det_riot_wedge,
  tracer: _det_tracer,
  plasma: _det_plasma,
  roller: _det_explosive, // roller detonates as an explosive at its valley
  leapfrog: _det_explosive,
  mirv: _det_explosive, // each warhead is an explosive
  digger: _det_dud,
  sandhog: _det_dud,
  // binary-only, reconstructed (catalog 01 section B)
  popcorn: _det_popcorn,
  dirt_tower: _det_dirt_tower,
  plasma_laser: _det_plasma_laser,
};

// ---------------------------------------------------------------------------
// Special flight behaviors (driven per-step by the game projectile loop).
// Each returns True if the projectile is still live, False if resolved.
// ---------------------------------------------------------------------------
export function on_apogee(state: BState, proj: BProjectile): void {
  /* MIRV / Death's Head apogee split (FUN_35d5_041b).
   *
   * Byte-confirmed table at 5f38:529e {20,35,5,9,50,20}: MIRV (120e=0) ->
   * count=5, fan-step=50, child blast=20; Death's Head (120e=1) -> count=9,
   * fan-step=20, child blast=35.  The spawner loops i in [0, count); the
   * per-child X-velocity offset is the INTEGER `fan * (i - (count+1)//2)`, and a
   * child is spawned only when that offset != 0 (FUN_35d5_041b:33).  So the
   * center (zero-offset) warhead is skipped -- count=5 spawns 4 children, count=9
   * spawns 8 -- and the fan is asymmetric (more children to one side).  No
   * randomness (contrast Funky Bomb).  Children inherit the parent's apogee
   * position and Y-velocity; only X-velocity is fanned. */
  if (proj.weapon.behavior !== "mirv" || proj.split_done) {
    return;
  }
  // Cluster-split tick (FUN_35d5_041b.c:29 -> 0007 one blip; freq arg BLOCKED,
  // the port "mirv" voice is a flagged placeholder, sound.py:439).
  sfx.play("mirv", state.cfg.is_on("SOUND"));
  proj.split_done = true;
  proj.active = false;
  const n = proj.weapon.warheads;
  const fan = proj.weapon.fan;
  const center = Math.floor((n + 1) / 2); // (count+1)/2, integer (n>=0)
  for (let i = 0; i < n; i++) {
    const offset = fan * (i - center);
    if (offset === 0) {
      // zero-offset child skipped
      continue;
    }
    // The Projectile ctor reads only owner.player_index (objects.ts:107); a
    // BTank carries it, so cast across the nominal BTank/objects.Tank gap (the
    // child result is likewise cast back to BProjectile -- the loop only touches
    // the BProjectile-shaped fields it sets below).
    const child = new Projectile(
      proj.owner as unknown as ConstructorParameters<typeof Projectile>[0],
      _single_warhead(proj.weapon),
      proj.px,
      proj.py,
      proj.vx + offset,
      proj.vy
    ) as unknown as BProjectile;
    child.warheads_left = 1;
    child.split_done = true;
    state.projectiles.push(child);
  }
}

export function _single_warhead(weapon: Item): Item {
  /* A split MIRV child explodes as a plain explosive of the child blast
   * (the child carries the spawn-table blast radius already on weapon.blast). */
  // copy(weapon): shallow copy of the Item, then override behavior/warheads.
  // Object.assign onto a blank-prototype Item clone reproduces copy.copy's
  // shallow-field copy (params reference is shared, as in Python's copy.copy).
  const w = Object.assign(Object.create(Object.getPrototypeOf(weapon)), weapon) as Item;
  w.behavior = "explosive";
  w.warheads = 1;
  return w;
}

export function start_roller(state: BState, proj: BProjectile, x: number, y: number): void {
  // Roller hits ground -> roll downhill until a valley/tank, then detonate.
  proj.state["rolling"] = true;
  proj.vx = proj.vy = 0.0;
  // initial roll direction: downhill (toward the lower neighbor surface)
  const left = state.terrain.column_top(x - 3);
  const right = state.terrain.column_top(x + 3);
  proj.state["dir"] = right > left ? 1 : -1;
  proj.px = x;
  proj.py = state.terrain.column_top(x) - 1;
}

export function step_roller(state: BState, proj: BProjectile): boolean {
  const t = state.terrain;
  const d = proj.state["dir"] as number;
  const nx = Math.trunc(proj.px) + d;
  if (nx <= 1 || nx >= t.w - 1) {
    return _resolve_roller(state, proj);
  }
  const surf = t.column_top(nx);
  const here = t.column_top(Math.trunc(proj.px));
  // tank in the way?
  for (const tk of state.tanks) {
    if (tk.alive && Math.abs(tk.x - nx) <= tk.half_width) {
      return _resolve_roller(state, proj);
    }
  }
  if (surf > here + 6) {
    // steep drop ahead -> keep rolling (falls)
    proj.px = nx;
    proj.py = surf - 1;
  } else if (surf < here - 1) {
    // uphill ahead -> this is a valley
    return _resolve_roller(state, proj);
  } else {
    proj.px = nx;
    proj.py = surf - 1;
  }
  proj.sx = Math.trunc(proj.px);
  proj.sy = Math.trunc(proj.py);
  return true;
}

function _resolve_roller(state: BState, proj: BProjectile): boolean {
  detonate(state, proj, Math.trunc(proj.px), Math.trunc(proj.py));
  proj.active = false;
  return false;
}

export function start_digger(state: BState, proj: BProjectile, x: number, y: number): void {
  proj.state["tunneling"] = true;
  proj.state["depth"] = 0;
  proj.state["max_depth"] = Math.abs(proj.weapon.blast); // tier depth (10/20/35)
  // Bore half-width.  RECONSTRUCTED: the real bore geometry lives in the
  // un-decompiled 0x99c stepper (BLOCKED -- see _stamp_digger_trail), so the
  // width is not byte-sourced.  The prior FIXED 7px channel (half=3) removed too
  // little dirt (user-reported); scale the width with the tier's effective radius
  // (abs(blast)) so Baby < Digger < Heavy and the tunnel is tier-appropriate.
  const r = Math.abs(proj.weapon.blast);
  proj.state["bore_half"] = Math.max(5, Math.trunc(r / 2)); // Baby 5 / Digger 10 / Heavy 17
  proj.px = x;
  proj.py = y;
  proj.vx = proj.vy = 0.0;
}

function _stamp_digger_trail(state: BState, x: number, y: number, half: number): void {
  /* Carve the bore span and stamp a glowing trail band the digger cycles.
   *
   * The real digger path is the dispatch at FUN_2a4a_1349.c:200-219 (which arms
   * the data-bound stepper at code offset 0x99c, set into the projectile's +0x4c)
   * plus the span-clear support FUN_262c_0078.c (string s_Teleport_Shield; clears
   * the bored column via FUN_262c_0104).  The bore depth = abs(blast) = 10/20/35
   * is byte-correct.
   *
   * CITATION FIX + the 0xAF band is now RECONSTRUCTED, not sourced.  The prior
   * code cited FUN_352c_00c9.c:103-128 for the 0xAF..0xB8 glow.  That function
   * is a WINNER/fanfare render routine: 0 callers, takes a TANK-RECORD pointer,
   * programs a full DAC palette, sprays a 200-frame rising-siren particle column
   * and reaps pixels > 0xa9.  It is the ONLY corpus site that writes iVar2+0xaf
   * or arms the (*ef00/ef04)(0xaf,10) cycle -- so the 0xAF..0xB8 trail band
   * CANNOT be confirmed from the real digger path.  The actual 0x99c stepper body
   * is BLOCKED (un-decompiled), and neither FUN_2a4a_1349 nor FUN_262c_0078
   * writes a glow band.  The 0xAF glow + 200-frame cycle below is therefore a
   * RECONSTRUCTED trail effect (a plausible match to the fanfare's palette idiom),
   * NOT a byte-sourced digger property.  We clear the bore to sky, edge the channel
   * walls with the reconstructed 0xAF glow, then arm the trail cycle. */
  const t = state.terrain;
  const lo = _pal.DIGGER_BAND_LO;
  const span = _pal.DIGGER_BAND_HI - lo; // 0xAF..0xB8 -> 9 offsets max
  for (let dx = -half; dx <= half; dx++) {
    t.write(x + dx, y, C.COL_SKY); // bore the channel to sky
  }
  // edge glow: stamp the trail band on the rim cells just outside the bore and
  // one row below, where the binary's >0x69 test catches wall/debris pixels.
  {
    let k = 0;
    for (let dx = half; dx <= half + 2; dx++, k++) {
      const gi = Math.min(_pal.DIGGER_BAND_HI, lo + k);
      if (t.is_solid(x + dx, y)) {
        t.write(x + dx, y, gi);
      }
      if (t.is_solid(x - dx, y)) {
        t.write(x - dx, y, gi);
      }
    }
  }
  {
    // Python: for k, dx in enumerate(range(0, min(half + 1, span + 1)))
    const hi = Math.min(half + 1, span + 1);
    let k = 0;
    for (let dx = 0; dx < hi; dx++, k++) {
      const gi = Math.min(_pal.DIGGER_BAND_HI, lo + k);
      if (t.is_solid(x + dx, y + 1)) {
        t.write(x + dx, y + 1, gi);
      }
      if (t.is_solid(x - dx, y + 1)) {
        t.write(x - dx, y + 1, gi);
      }
    }
  }
  if (state.start_digger_cycle !== undefined) {
    state.start_digger_cycle();
  }
}

export function step_digger(state: BState, proj: BProjectile): boolean {
  const t = state.terrain;
  const x = Math.trunc(proj.px);
  const y = Math.trunc(proj.py);
  // clear a span at this depth + stamp/arm the 0xAF trail glow cycle.  The bore
  // half-width is tier-scaled (start_digger; was a fixed 3 that removed too little).
  _stamp_digger_trail(state, x, y, (proj.state["bore_half"] as number | undefined) ?? 3);
  proj.state["depth"] = (proj.state["depth"] as number) + 1;
  proj.py += 1;
  proj.sx = Math.trunc(proj.px);
  proj.sy = Math.trunc(proj.py);
  if ((proj.state["depth"] as number) >= (proj.state["max_depth"] as number) || proj.py >= t.h - 2) {
    proj.active = false; // fizzles, no damage
    return false;
  }
  return true;
}

export function start_sandhog(state: BState, proj: BProjectile, x: number, y: number): void {
  proj.state["tunneling"] = true;
  proj.state["depth"] = 0;
  proj.state["start_y"] = y;
  proj.state["warheads"] = proj.weapon.warheads;
  // Homing target = the FIRST alive enemy in ARRAY (tank-index) order, not the
  // nearest.  FUN_2e50_0001.c:14-28 walks iVar3 = 0.. upward over the tank
  // array and `break`s on the first record that is (a) not the firing tank's
  // own coord (the +0x2a/+0x2c self guard, :22), (b) alive (d580[iVar3*0x65]
  // != 0, :23), and (c) within range (FUN_2fa0_000f(...d576,d578) <
  // DAT_5f38_5186, :24-25).  It does NOT minimise distance.  The range
  // threshold DAT_5f38_5186 is BSS/unrecovered in the corpus, so the port
  // cannot gate on it byte-faithfully; it takes the first alive enemy in
  // index order (RECONSTRUCTED range gate -- the binary additionally requires
  // the in-range test).  No live enemy -> tunnel straight down (target = x).
  const target = _first_enemy_in_order(state, proj.owner);
  proj.state["target_x"] = target ? target.x : x;
  proj.px = x;
  proj.py = y;
  proj.vx = proj.vy = 0.0;
}

export function step_sandhog(state: BState, proj: BProjectile): boolean {
  const t = state.terrain;
  const x = Math.trunc(proj.px);
  const y = Math.trunc(proj.py);
  _stamp_digger_trail(state, x, y, 2); // bore + 0xAF trail glow cycle
  const tgt = proj.state["target_x"] as number;
  proj.px += tgt > x ? 1 : tgt < x ? -1 : 0;
  proj.py += 1;
  proj.state["depth"] = (proj.state["depth"] as number) + 1;
  proj.sx = Math.trunc(proj.px);
  proj.sy = Math.trunc(proj.py);
  // under a tank? fire the under-tank charge (FUN_35d5_0009): linear in
  // remaining depth, dmg = (tunnel_depth - tank_depth)*100/tunnel_depth,
  // through the standard applier (shield gate applies).  No floor.
  for (const tk of state.tanks) {
    if (tk.alive && Math.abs(tk.x - Math.trunc(proj.px)) <= tk.half_width && proj.py >= tk.y) {
      const depth = Math.max(1, proj.state["depth"] as number);
      const tank_depth = Math.max(0, tk.y - (proj.state["start_y"] as number));
      if (tank_depth < depth) {
        // latch the sandhog as the current weapon so a lethal under-tank
        // charge sizes its death blast by the sandhog's radius
        state.current_weapon = proj.weapon;
        const dmg = pyRound(((depth - tank_depth) * C.FALLOFF_NUM) / depth);
        damage.apply_tank_damage(state, tk, dmg);
      }
      proj.state["warheads"] = (proj.state["warheads"] as number) - 1;
      if ((proj.state["warheads"] as number) <= 0) {
        proj.active = false;
        return false;
      }
    }
  }
  if (proj.py >= t.h - 2 || (proj.state["depth"] as number) > 200) {
    proj.active = false;
    return false;
  }
  return true;
}

export const LASER_BLEED = 0x28; // FUN_3319_01fe:96 energy bleed per beam pixel (40)

export function fire_laser(state: BState, proj: BProjectile): void {
  /* Laser (FUN_3319_0516 -> FUN_271b_0733 -> FUN_3319_01fe).
   *
   * Straight Bresenham beam from the muzzle along the turret direction.  Energy
   * d506 = battery-field * 10 (FUN_3319_0516:14).  Per pixel: cut dirt to sky
   * and bleed energy by 0x28 (FUN_3319_01fe:53,96); on a tank apply damage
   * local_6 = d506/5 through the standard applier (so a shield ABSORBS the hit
   * but does NOT stop the beam -- it keeps cutting through terrain, shields and
   * tanks); write beam colour 0xe6.  The beam stops ONLY when energy < 1
   * (FUN_3319_01fe:97), never on a hit.  Range ~= energy/0x28 pixels minus
   * per-hit bleed.  Super Mag laserproof shields are the one stop case. */
  // Laser fire tone (FUN_3581_00d4.c:67-72 -> a281 rising chirp 1000->cap).
  // The laser fires synchronously from game.fire (not via detonate()), so
  // latch the current weapon here for any laser kill's death-blast radius.
  state.current_weapon = proj.weapon;
  sfx.play("laser", state.cfg.is_on("SOUND"));
  let energy = (proj.state["energy"] as number | undefined) ?? 50;
  const ang = Math.atan2(proj.vy, proj.vx);
  const dx = Math.cos(ang);
  const dy = -Math.sin(ang);
  let x = proj.px;
  let y = proj.py;
  const pts: Array<[number, number]> = [];
  const hit = new Set<BTank>();
  while (energy >= 1 && 0 <= x && x < state.terrain.w && 0 <= y && y < state.terrain.h) {
    const ix = Math.trunc(x);
    const iy = Math.trunc(y);
    pts.push([ix, iy]);
    if (state.terrain.is_dirt(ix, iy)) {
      state.terrain.write(ix, iy, C.COL_SKY); // cut dirt
    }
    for (const tk of state.tanks) {
      if (
        tk.alive &&
        !hit.has(tk) &&
        Math.abs(tk.x - ix) <= tk.half_width &&
        Math.abs(tk.y - 4 - iy) <= 6
      ) {
        if (tk.shield_laserproof && tk.shield_hp > 0) {
          energy = 0; // Super Mag stops the beam
          break;
        }
        damage.apply_tank_damage(state, tk, Math.max(1, Math.floor(energy / 5))); // d506/5
        hit.add(tk);
      }
    }
    x += dx;
    y += dy;
    energy -= LASER_BLEED; // bleed 0x28 per pixel
  }
  proj.trail = pts;
  state.add_beam(pts);
  proj.active = false;
}

export function fire_plasma_laser(state: BState, proj: BProjectile): void {
  /* Plasma Laser [RECONSTRUCTED]: a battery-powered beam that bursts into a
   * plasma sweep at its terminal point.
   *
   * Binary-only, undocumented (catalog 01 section B).  Name = Laser + Plasma:
   * modeled as the laser beam (cuts dirt + damages everything per pixel, energy
   * = field*10) followed by a battery-scaled plasma burst where the beam
   * terminates.  Reuses fire_laser for the beam, then a plasma blast at the last
   * beam pixel.  FLAGGED reconstructed. */
  fire_laser(state, proj);
  let ex: number;
  let ey: number;
  if (proj.trail.length > 0) {
    const last = proj.trail[proj.trail.length - 1] as [number, number];
    ex = last[0];
    ey = last[1];
  } else {
    ex = Math.trunc(proj.px);
    ey = Math.trunc(proj.py);
  }
  _det_plasma(state, proj, ex, ey);
}

export function _first_enemy_in_order(state: BState, owner: BTank | null): BTank | null {
  /* First alive enemy in tank-array (index) order -- the sandhog homing pick.
   *
   * FUN_2e50_0001.c:14-28 iterates the tank array by index and returns the FIRST
   * record that is alive (:23) and is not the firing tank (:22); it does not pick
   * the nearest.  state.tanks is in tank-record order, so the first qualifying
   * element here matches the binary's `break`.  The binary's additional in-range
   * gate (`< DAT_5f38_5186`, :24-25) is omitted -- that threshold is unrecovered
   * (BSS, not in the corpus); see start_sandhog. */
  for (const t of state.tanks) {
    if (t.alive && t !== owner) {
      return t;
    }
  }
  return null;
}

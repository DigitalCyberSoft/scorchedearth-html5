/**
 * Projectile physics integrator -- a faithful TypeScript port of
 * scorch-py/scorch/physics.py (the fidelity oracle, itself byte-verified against
 * 1.5/SCORCH.EXE). Control flow and numeric behavior are identical to the Python;
 * the differential gate (test/physics.test.ts) asserts every result against the
 * Python-dumped vectors.
 *
 * Ground truth (READ-ONLY RE, binary never executed):
 *   FUN_2a4a_02f2  shot driver / fixed-step loop (decompiles/FUN_2a4a_02f2.c)
 *   FUN_2a4a_0763  spawn: seeds pos/vel, +0x4c guidance cb (FUN_2a4a_0763.c)
 *   FUN_2a4a_01c4  per-shot dt/grav/wind scalar setup (FUN_2a4a_01c4.c)
 *   FUN_2a4a_0b1f  per-step integrator + bounce apply (FUN_2a4a_0b1f.c)
 *   FUN_2a4a_1349  projectile-vs-boundary handler (FUN_2a4a_1349.c)
 *   FUN_2a4a_1f5a  reposition/redraw at boundary (FUN_2a4a_1f5a.c)
 *   FUN_2a4a_2228  DETONATION dispatch (FUN_2a4a_2228.c) -> "die" in this port
 *
 * Per-step force model (forward (explicit) Euler in this exact order,
 * FUN_2a4a_0b1f.c:44-82):
 *
 *     clamp:   if vx*vx + vy*vy > 1e6:  rescale (vx,vy) to |v| = 1000   (:47-55)
 *     move:    px += vx*dt ;  py -= vy*dt                               (:62-68)
 *     drag:    if mode != 1 and visc_mult != 1: vx,vy *= visc_mult      (:72-78)
 *     gravity: vy -= G_step                                            (:79-80)
 *     wind:    vx += W_step                                            (:81-82)
 *
 *     a_gravity = 2500 * GRAVITY  (= 50^2, DAT_5f38_1cf2^2)   vy -= a_gravity*dt
 *     a_wind    = 1.25 * WIND     (= 50/40, 1cf2/1cf6)        vx += a_wind*dt
 *
 * Screen Y grows downward; py -= vy*dt means vy > 0 is "up".
 *
 * Launch decomposition (FUN_2a4a_02f2.c:28-68):
 *     rad = angle_deg * DEG2RAD ; vx = power*cos(rad) ; vy = power*sin(rad).
 *
 * NUMERIC NOTE: this module's trajectory is trig-derived (Math.cos/sin/sqrt), so
 * positions and velocities are asserted within a TIGHT epsilon (toBeCloseTo(.,12))
 * in the differential gate; any integer/pixel (sx,sy via pyRound), boolean, or
 * collision-index output is asserted EXACT. See test/physics.test.ts for the
 * libm-vs-V8 note.
 *
 * IMPORT CYCLE: physics -> guidance -> ai -> physics. To keep ES module init from
 * touching half-initialized bindings, guidance is imported as a namespace and
 * only its functions are called at RUNTIME (launch/step), never at module load.
 */
import * as C from "./constants";
import * as guidance from "./guidance";
import { Projectile, pyRound } from "./objects";
import type { Tank } from "./objects";
import type { Item } from "./weapons";

// deg->rad, DAT_5f38_1d08 on the firing path / DAT_5f38_6100 = 0.017453293 on the
// arc-preview path (byte-confirmed, catalogs/fp_constant_table.log:144).
export const DEG2RAD = 0.017453293;

export const TURRET_LEN = 12.0;

// Boundary-handler return codes (mirror of FUN_2a4a_1349's effect on the
// integrator's DAT_5f38_ce98 / DAT_5f38_ce9a state machine).
const _NONE = 0; // no boundary crossed this step (ce9a == 0, ce98 == 0)
const _WALL_X = 1; // reflected off a side wall (sets ce9a = 1)  -> vx *= coef
const _WALL_Y = 2; // reflected off ceiling/floor (sets ce9a = 2) -> vy *= coef

/**
 * The subset of Config the physics integrator reads. The full Config lives in
 * src/config.ts (owned elsewhere); physics only ever touches these
 * fields/methods, so it depends on this minimal shape.
 */
export interface PhysicsCfg {
  GRAVITY: number;
  wind: number;
  viscosity_mult: number;
  EDGES_EXTEND: number;
  // wall sub-mode: cfg.live_elastic preferred, else cfg.elastic.
  live_elastic?: number;
  elastic?: number;
}

/** Build the projectile leaving `tank`'s muzzle (spawn FUN_2a4a_0763).
 *
 * Velocity decomposition per FUN_2a4a_02f2.c:28-68: rad = angle_deg * DEG2RAD;
 * vx = v*cos(rad), vy = v*sin(rad), with vy > 0 = up. v = power * POWER_SCALE.
 *
 * FUN_2a4a_0763.c:46-47 seeds px/py from the integer launch coords; obj+0x32
 * bounce energy seeded 0.8 (line 86); obj+0x30 bounce counter zeroed (line 87).
 */
export function launch(
  tank: Tank,
  cfg: PhysicsCfg,
  weapon: Item,
  power: number | null = null,
  angle: number | null = null,
): Projectile {
  if (angle === null) {
    angle = tank.angle;
  }
  // Ballistic guidance acts at LAUNCH: keep the angle, solve the POWER for the
  // chosen target (DOC L1300). Only when the caller did not already supply an
  // explicit power. The in-launch solve is drag/wind-free (launch has no world
  // dims); the game hook supplies the wind-corrected refinement.
  if (
    power === null &&
    (tank as { selected_guidance?: unknown }).selected_guidance === 34 &&
    !guidance._IGNORES_GUIDANCE.has(weapon.behavior)
  ) {
    const solved = guidance.solve_ballistic_power_launch(cfg, tank, weapon);
    if (solved !== null) {
      power = solved;
    }
  }
  if (power === null) {
    power = tank.power;
  }
  const rad = angle * DEG2RAD; // FUN_2a4a_02f2.c:28 angle*DAT_5f38_1d08
  const cos_a = Math.cos(rad);
  const sin_a = Math.sin(rad);
  const pivot_x = tank.x;
  const pivot_y = tank.y - 4;
  const px = pivot_x + cos_a * TURRET_LEN;
  const py = pivot_y - sin_a * TURRET_LEN;
  const v = power * C.POWER_SCALE;
  const vx = v * cos_a; // FUN_2a4a_02f2.c:68 power*cos -> vx (+0x04)
  const vy = v * sin_a; // FUN_2a4a_02f2.c:63 power*sin -> vy (+0x0c)
  const proj = new Projectile(tank, weapon, px, py, vx, vy);
  // Install the +0x4c guidance predicate (FUN_2a4a_0763.c:99-110 analog).
  guidance.attach(tank, cfg, weapon, proj);
  return proj;
}

/** One forward-Euler step, listing-order from FUN_2a4a_0b1f.c:44-82.
 *
 * Order is load-bearing (catalog 10 s.3): position uses the velocity carried
 * from the previous step (explicit Euler), then drag, then gravity/wind update
 * velocity for the next step.
 *
 * `tanks` (optional) is the live tank list forwarded to the guidance predicate
 * so Heat can scan for the nearest enemy in range.
 */
export function step(
  proj: Projectile,
  cfg: PhysicsCfg,
  dt: number = C.PHYSICS_DT,
  tanks: Tank[] | null = null,
): void {
  proj.prev_px = proj.px;
  proj.prev_py = proj.py;

  // Step 0: guidance predicate (+0x4c). FUN_2a4a_0b1f.c:40-46 fires it BEFORE
  // the clamp/move; it steers vx/vy in place and returns nonzero to stay live.
  if (proj.guidance !== null && proj.guidance !== undefined) {
    guidance.apply(proj, cfg, tanks);
  }

  // Step A: velocity-magnitude clamp. FUN_2a4a_0b1f.c:44-55.
  const sp2 = proj.vx * proj.vx + proj.vy * proj.vy;
  if (sp2 > C.SPEED_CLAMP_SQ) {
    const sp = Math.sqrt(sp2);
    proj.vx = proj.vx / (sp / C.SPEED_CLAMP);
    proj.vy = proj.vy / (sp / C.SPEED_CLAMP);
  }

  // Step B: position integration. FUN_2a4a_0b1f.c:62-68.
  proj.px += proj.vx * dt;
  proj.py -= proj.vy * dt;
  proj.saved_vx = proj.vx; // DAT_5f38_e4dc (FUN_2a4a_0b1f.c:70)
  proj.saved_vy = proj.vy; // DAT_5f38_e4e4 (FUN_2a4a_0b1f.c:71)

  // Step C: air viscosity (multiplicative drag). FUN_2a4a_0b1f.c:72-78.
  const vm = cfg.viscosity_mult;
  if (proj.mode !== 1 && vm !== 1.0) {
    proj.vx *= vm;
    proj.vy *= vm;
  }

  // Step D: gravity then wind, applied to velocity. FUN_2a4a_0b1f.c:79-82.
  if (proj.mode !== 1) {
    const a_grav = C.EFF_GRAVITY_FACTOR * cfg.GRAVITY;
    proj.vy -= a_grav * dt;
    if (cfg.wind) {
      const a_wind = C.EFF_WIND_FACTOR * cfg.wind;
      proj.vx += a_wind * dt;
    }
  }

  // round px,py -> integer screen coords (FUN_1000_14df ROUND). FUN_2a4a_0b1f.c:86-91.
  proj.sx = pyRound(proj.px);
  proj.sy = pyRound(proj.py);
}

/** Y-velocity at/over apogee (vy <= 0). MIRV/Death's Head split trigger.
 *
 * game.py latches the crossing with `prev_vy > 0 >= proj.vy`; this predicate is
 * kept for callers that test the post-step sign directly.
 */
export function apogee_reached(proj: Projectile): boolean {
  return proj.vy <= 0.0;
}

/** Reflect / wrap / absorb at the field edges -- port of FUN_2a4a_1349
 * (boundary detect + reposition) composed with FUN_2a4a_0b1f.c:107-160
 * (restitution-coefficient selection and application).
 *
 * Returns false when the projectile leaves the tracked field or detonates
 * against a boundary; true when it stays in flight (possibly after a bounce that
 * mutated px/py/vx/vy in place).
 */
export function handle_walls(
  proj: Projectile,
  cfg: PhysicsCfg,
  w: number,
  h: number,
): boolean {
  const mode =
    cfg.live_elastic !== undefined ? cfg.live_elastic : (cfg.elastic ?? 0);
  const ext = cfg.EDGES_EXTEND;
  const x = proj.px;
  const y = proj.py;

  // --- boundary detection (FUN_2a4a_1349.c:19-88) --------------------------
  const left = 0.0;
  const right = w - 1;
  const ceil_y = 0.0;
  const floor_y = h - 1;
  let code = _NONE;
  let reflect_to: number | null = null; // snapped screen coord for the reflected axis

  // Side walls. FUN_2a4a_1349.c:19-50.
  if (x < left || x > right) {
    if (mode === 0) {
      // NONE: only die once past EDGES_EXTEND (FUN_2a4a_1349.c:44).
      if (x < left - ext || x > right + ext) {
        return false; // NONE = fly off, tracked to ext
      }
      return true;
    }
    if (mode === 5) {
      // WRAP: side wall -> DETONATE (FUN_2a4a_1349.c:21-26).
      return false;
    }
    // CONCRETE/PADDED/RUBBER/SPRING (1..4): reflect off the side wall.
    code = _WALL_X;
    if (mode === 1) {
      // CONCRETE snaps to the OPPOSITE edge column (FUN_2a4a_1349.c:27-33):
      // left-exit -> RIGHT, right-exit -> LEFT.
      reflect_to = x < left ? right : left;
    } else {
      // PADDED/RUBBER/SPRING snap to the SAME edge column (FUN_2a4a_1349.c:34-40):
      // left-exit -> left, right-exit -> right.
      reflect_to = x < left ? left : right;
    }
  } else if (y < ceil_y) {
    // Ceiling. FUN_2a4a_1349.c:51-68. Only modes != 0 and != 1 bounce.
    if (mode === 0 || mode === 1) {
      // NONE/CONCRETE: ceiling is not a reflector here. Keep it in flight.
      return true;
    }
    if (mode === 5) {
      // WRAP ceiling -> detonate (1349:53-58).
      return false;
    }
    code = _WALL_Y;
    reflect_to = ceil_y;
  } else if (y >= floor_y) {
    // Floor. FUN_2a4a_1349.c:69-88. Only RUBBER (3) and SPRING (4) bounce.
    if (mode === 3 || mode === 4) {
      // Slow-bounce floor STOP (FUN_2a4a_1349:148f-14b9): pre-bounce vertical
      // velocity in the band -50 < vy < 50 STOPS (detonates). Band is symmetric.
      if (-50.0 < proj.vy && proj.vy < 50.0) {
        return false; // detonate: too slow to keep bouncing
      }
      code = _WALL_Y;
      reflect_to = floor_y;
    } else {
      return false; // detonate on floor (FUN_2a4a_2228)
    }
  }

  if (code === _NONE) {
    return true;
  }

  // --- restitution coefficient + apply (FUN_2a4a_0b1f.c:120-159) -----------
  proj.bounce_count += 1; // obj+0x30 ++ (FUN_2a4a_0b1f.c:121-122)

  // Coefficient by live wall mode, FUN_2a4a_0b1f.c:123-132.
  let coef: number;
  if (mode === 3) {
    coef = C.WALL_COEF["RUBBER"]; // DAT_5f38_1d34 = -1.0
  } else if (mode === 2) {
    coef = C.WALL_COEF["PADDED"]; // DAT_5f38_1d3c = -0.5
  } else {
    coef = C.WALL_COEF["DEFAULT"]; // DAT_5f38_1d44 = -2.0
  }

  // Bounce-energy decay after the 6th bounce. FUN_2a4a_0b1f.c:141-145.
  if (proj.bounce_count > 6) {
    coef *= proj.bounce_energy;
    proj.bounce_energy *= C.BOUNCE_ENERGY;
  }

  // Reposition to the wall, then scale the struck-axis velocity by coef.
  if (code === _WALL_X) {
    proj.px = reflect_to as number;
    proj.vx *= coef;
  } else {
    // _WALL_Y
    proj.py = reflect_to as number;
    proj.vy *= coef;
  }

  proj.sx = pyRound(proj.px);
  proj.sy = pyRound(proj.py);
  return true;
}

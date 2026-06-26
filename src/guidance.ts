/**
 * In-flight weapon guidance -- the projectile's +0x4c per-step predicate.
 * Faithful TypeScript port of scorch-py/scorch/guidance.py (the fidelity oracle,
 * itself byte-verified against 1.5/SCORCH.EXE). The differential gate
 * (test/guidance.test.ts) asserts every result against the Python-dumped vectors.
 *
 * Ground truth (READ-ONLY RE, binary never executed):
 *   FUN_2a4a_0763.c:99-110  spawn seeds the +0x4a/+0x4c slots; only the guidance
 *                           weapon class installs a +0x4c callback.
 *   FUN_2a4a_0b1f.c:40-46   the integrator calls that callback BEFORE the
 *                           magnitude clamp / move step: the predicate steers
 *                           (mutates vx/vy in place) and returns nonzero to keep
 *                           the shell live; the step then proceeds.
 *
 * Guidance TYPES (catalog 02 section A, slots 33-37; DOC L1289-L1330):
 *   Heat        - within range of ANY enemy tank, steer in a STRAIGHT LINE to it.
 *   Ballistic   - keep the firing angle; auto-solve the POWER (acts at LAUNCH).
 *   Horizontal  - once EVEN WITH the target (same y), fly horizontally at it.
 *   Vertical    - once OVER the target (same x), drop straight DOWN onto it.
 *   Lazy Boy    - fly to the exact clicked point and detonate there.
 *
 * Weapons that ignore ALL guidance (DOC L1286): MIRVs, Death's Heads, Riot
 * Charges, Riot Blasts, Plasma Blasts. attach() returns null for those.
 *
 * NUMERIC NOTE: the steering math uses Math.hypot/atan-free unit-vector blends
 * (hypot, division), so steered vx/vy are asserted within a TIGHT epsilon
 * (toBeCloseTo(.,12)); arming booleans / armed-latch / axis snaps are exact.
 * The Ballistic power solve returns an INTEGER (asserted exact). See
 * test/guidance.test.ts.
 *
 * IMPORT CYCLE: guidance -> ai -> physics -> guidance. ai is imported as a
 * namespace and its functions are only called at RUNTIME (apply/solve), never at
 * module-load time, so ES module init never reads a half-initialized binding.
 */
import * as ai from "./ai";
import { pyRound } from "./objects";
import type { Projectile } from "./objects";
import type { Tank } from "./objects";
import type { Item } from "./weapons";

/** Minimal Config shape guidance reads (forwarded to ai._solve_power /
 * ai._simulate_landing, which need the same fields physics.PhysicsCfg has). */
export interface GuidanceCfg {
  GRAVITY: number;
  wind: number;
  viscosity_mult: number;
  EDGES_EXTEND: number;
  live_elastic?: number;
  elastic?: number;
}

/** A state with world dims, used by the wind-correcting solve (not by attach). */
export interface GuidanceState {
  cfg: GuidanceCfg;
  w: number;
  h: number;
}

/** proj.guidance shape (or null when unguided). Mirrors the Python dict. */
export interface Guidance {
  type: "heat" | "ballistic" | "horizontal" | "vertical" | "lazyboy";
  target: Tank | null;
  point: [number, number] | null;
  tanks: Tank[] | null;
  armed: boolean;
  _last_x: number | null;
  _last_y: number | null;
}

// Item-index -> guidance type. Slots 33-37 (weapons.ITEMS), catalog 02 A.
const _SLOT_TYPE: { [k: number]: Guidance["type"] } = {
  33: "heat",
  34: "ballistic",
  35: "horizontal",
  36: "vertical",
  37: "lazyboy",
};

// Behaviors that ignore ALL guidance (DOC L1286). Keyed by weapons.Item.behavior.
export const _IGNORES_GUIDANCE: ReadonlySet<string> = new Set([
  "mirv",
  "riot_wedge",
  "riot_sphere",
  "plasma",
]);

// Heat acquisition range (px). DOC L1289; concrete range scalar BLOCKED in RE.
// RECONSTRUCTED: a generous fixed radius.
export const HEAT_RANGE = 80.0;

// Per-step turn aggression for the straight-line steers (port choice; the RE
// callback body that would pin them is BLOCKED behind the +0x4c indirect call).
const _HEAT_TURN = 0.35; // fraction of speed redirected toward the tank per step

/** Build and install proj.guidance from the firing tank's selection.
 *
 * Called from physics.launch after the projectile exists. Returns the guidance
 * dict it installed (also stored on proj.guidance), or null when unguided.
 */
export function attach(
  tank: Tank,
  cfg: GuidanceCfg,
  weapon: Item,
  proj: Projectile,
): Guidance | null {
  const slot = (tank as { selected_guidance?: unknown }).selected_guidance;
  if (slot === null || slot === undefined) {
    proj.guidance = null;
    return null;
  }
  const gtype = _SLOT_TYPE[slot as number];
  if (gtype === undefined) {
    proj.guidance = null;
    return null;
  }
  if (_IGNORES_GUIDANCE.has(weapon.behavior)) {
    // DOC L1286: these ignore guidance; no callback is installed.
    proj.guidance = null;
    return null;
  }

  const g: Guidance = {
    type: gtype,
    target: ((tank as { guidance_target?: unknown }).guidance_target ??
      null) as Tank | null,
    point: ((tank as { guidance_target_pt?: unknown }).guidance_target_pt ??
      null) as [number, number] | null,
    tanks: null, // populated by the game hook
    armed: false,
    _last_x: null, // px/py seen on the previous apply() (crossing test)
    _last_y: null,
  };
  proj.guidance = g;
  return g;
}

/** The +0x4c predicate: steer proj in place for one physics step.
 *
 * Mirrors FUN_2a4a_0b1f.c:40-46 ordering -- runs BEFORE the magnitude clamp and
 * the position/velocity integration.
 *
 * Returns true to keep the shell live; no guidance type self-terminates.
 */
export function apply(
  proj: Projectile,
  _cfg: GuidanceCfg,
  tanks: Tank[] | null = null,
): boolean {
  const g = proj.guidance as Guidance | null;
  if (!g) {
    return true;
  }
  if (tanks !== null && tanks !== undefined) {
    g.tanks = tanks;
  }

  // apply() runs BEFORE the move, so proj.prev_px == proj.px; track the position
  // seen on the PREVIOUS apply() call here for the crossing test.
  const last_x = g._last_x;
  const last_y = g._last_y;

  const gtype = g.type;
  if (gtype === "heat") {
    _steer_heat(proj, g);
  } else if (gtype === "horizontal") {
    _steer_horizontal(proj, g, last_x, last_y);
  } else if (gtype === "vertical") {
    _steer_vertical(proj, g, last_x, last_y);
  } else if (gtype === "lazyboy") {
    _steer_lazyboy(proj, g);
  }
  // "ballistic": no in-flight steering (solved at launch).

  g._last_x = proj.px;
  g._last_y = proj.py;
  return true;
}

// ---------------------------------------------------------------------------
// Per-type steering. Each mutates proj.vx / proj.vy in place.
// Screen Y grows downward; vy > 0 means "up" (physics.step: py -= vy*dt).
// ---------------------------------------------------------------------------
function _speed(proj: Projectile): number {
  return Math.hypot(proj.vx, proj.vy);
}

/** Nearest LIVE enemy tank within HEAT_RANGE of the shell, else null. */
function _heat_target(proj: Projectile, g: Guidance): Tank | null {
  const tanks = g.tanks;
  if (!tanks || tanks.length === 0) {
    return null;
  }
  const owner = proj.owner;
  const own_team = (owner as { team_id?: unknown } | null)?.team_id ?? null;
  let best: Tank | null = null;
  let bd = HEAT_RANGE;
  for (const t of tanks) {
    if (!t.alive || t === owner) {
      continue;
    }
    if (
      own_team !== null &&
      ((t as { team_id?: unknown }).team_id ?? null) === own_team &&
      team_mode_active(t, owner)
    ) {
      continue;
    }
    const d = Math.hypot(t.x - proj.px, t.y - 4 - proj.py);
    if (d <= bd) {
      best = t;
      bd = d;
    }
  }
  return best;
}

/** True when a and b are on the same NON-zero team (teams enabled). */
export function team_mode_active(a: unknown, b: unknown): boolean {
  const ta = (a as { team_id?: number } | null)?.team_id ?? 0;
  const tb = (b as { team_id?: number } | null)?.team_id ?? 0;
  return ta !== 0 && ta === tb;
}

function _steer_heat(proj: Projectile, g: Guidance): void {
  const tgt = _heat_target(proj, g);
  if (tgt === null) {
    return; // out of range: fly ballistic
  }
  const sp = _speed(proj);
  if (sp < 1e-6) {
    return;
  }
  const dx = tgt.x - proj.px;
  const dy = tgt.y - 4 - proj.py; // toward the tank body
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    return;
  }
  const ux = dx / d;
  const uy = -dy / d; // screen-down dy -> vy-down
  const nx = proj.vx + (ux * sp - proj.vx) * _HEAT_TURN;
  const ny = proj.vy + (uy * sp - proj.vy) * _HEAT_TURN;
  const nsp = Math.hypot(nx, ny);
  if (nsp < 1e-6) {
    return;
  }
  proj.vx = (nx / nsp) * sp;
  proj.vy = (ny / nsp) * sp;
}

function _steer_horizontal(
  proj: Projectile,
  g: Guidance,
  _last_x: number | null,
  last_y: number | null,
): void {
  const tgt = g.target;
  const pt = g.point;
  const ty = tgt !== null ? tgt.y - 4 : pt ? pt[1] : null;
  const tx = tgt !== null ? tgt.x : pt ? pt[0] : null;
  if (ty === null || tx === null) {
    return;
  }
  if (!g.armed) {
    // arm once the shell crossed the target altitude over the last step, or is
    // already at/below it on the descending leg.
    if (last_y !== null && (last_y - ty) * (proj.py - ty) <= 0) {
      g.armed = true;
    }
  }
  if (!g.armed) {
    return;
  }
  // horizontal flight toward tx: redirect the whole speed onto the x axis and
  // zero vy so the shell flies level (DOC L1311).
  const sp = _speed(proj);
  const dirx = tx >= proj.px ? 1.0 : -1.0;
  proj.vx = dirx * sp;
  proj.vy = 0.0;
}

function _steer_vertical(
  proj: Projectile,
  g: Guidance,
  last_x: number | null,
  _last_y: number | null,
): void {
  const tgt = g.target;
  const pt = g.point;
  const tx = tgt !== null ? tgt.x : pt ? pt[0] : null;
  if (tx === null) {
    return;
  }
  if (!g.armed) {
    // arm when the shell crossed the target column over the last step.
    if (last_x !== null && (last_x - tx) * (proj.px - tx) <= 0) {
      g.armed = true;
      proj.px = tx; // snap onto the column (over it)
    }
  }
  if (!g.armed) {
    return;
  }
  // straight down: zero horizontal, redirect the whole speed downward (vy<0 =
  // down on screen), and hold the target column (DOC L1316).
  const sp = _speed(proj);
  proj.vx = 0.0;
  proj.vy = -sp;
  proj.px = tx;
}

function _steer_lazyboy(proj: Projectile, g: Guidance): void {
  let pt = g.point;
  if (pt === null) {
    // no click point: fall back to the chosen tank if one was stored.
    const tgt = g.target;
    if (tgt === null) {
      return;
    }
    pt = [tgt.x, tgt.y - 4];
  }
  const sp = _speed(proj);
  if (sp < 1e-6) {
    return;
  }
  const dx = pt[0] - proj.px;
  const dy = pt[1] - proj.py;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    return;
  }
  const ux = dx / d;
  const uy = -dy / d;
  // tighter blend than Heat: Lazy Boy is the "ultimate" guidance (DOC L1324).
  const blend = 0.6;
  const nx = proj.vx + (ux * sp - proj.vx) * blend;
  const ny = proj.vy + (uy * sp - proj.vy) * blend;
  const nsp = Math.hypot(nx, ny);
  if (nsp < 1e-6) {
    return;
  }
  proj.vx = (nx / nsp) * sp;
  proj.vy = (ny / nsp) * sp;
}

// ---------------------------------------------------------------------------
// Ballistic: solved at LAUNCH (not in flight).
// ---------------------------------------------------------------------------
/** Power to land on the chosen target at the tank's CURRENT angle, with full
 * wind correction (DOC L1300). Returns an int power (0..1000), or null if no
 * target is selected. */
export function solve_ballistic_power(
  state: GuidanceState,
  tank: Tank,
  _weapon: Item,
): number | null {
  const tgt = ((tank as { guidance_target?: unknown }).guidance_target ??
    null) as Tank | null;
  const pt = ((tank as { guidance_target_pt?: unknown }).guidance_target_pt ??
    null) as [number, number] | null;
  let tx: number;
  let ty: number;
  if (tgt !== null) {
    tx = tgt.x;
    ty = tgt.y - 4;
  } else if (pt !== null) {
    tx = pt[0];
    ty = pt[1];
  } else {
    return null;
  }
  const angle = tank.angle;
  const elev = angle <= 90 ? angle : 180 - angle;
  const base = ai._solve_power(state.cfg, tank.x, tank.y, tx, ty, elev);
  if (base === null) {
    return 1000; // "confused": fire at full power
  }
  // wind-correcting refinement: range ~ power^2, refine against the real
  // integrator (which includes wind), reusing ai._simulate_landing.
  let power = base;
  const target_range = Math.max(1.0, Math.abs(tx - tank.x));
  for (let i = 0; i < 8; i++) {
    const land_x = ai._simulate_landing(state, tank, angle, power, ty);
    if (land_x === null) {
      power = Math.min(1000.0, power * 1.15);
      continue;
    }
    const cur_range = Math.max(1.0, Math.abs(land_x - tank.x));
    if (Math.abs(land_x - tx) < 3.0) {
      break;
    }
    power *= Math.sqrt(target_range / cur_range);
    power = Math.max(30.0, Math.min(1000.0, power));
  }
  return pyRound(power);
}

/** Self-contained Ballistic power for use INSIDE physics.launch (cfg only, no
 * world dims): the drag/wind-free closed form at the fixed angle. Returns int
 * power (0..1000), or null if no target. */
export function solve_ballistic_power_launch(
  cfg: GuidanceCfg,
  tank: Tank,
  _weapon: Item,
): number | null {
  const tgt = ((tank as { guidance_target?: unknown }).guidance_target ??
    null) as Tank | null;
  const pt = ((tank as { guidance_target_pt?: unknown }).guidance_target_pt ??
    null) as [number, number] | null;
  let tx: number;
  let ty: number;
  if (tgt !== null) {
    tx = tgt.x;
    ty = tgt.y - 4;
  } else if (pt !== null) {
    tx = pt[0];
    ty = pt[1];
  } else {
    return null;
  }
  const angle = tank.angle;
  const elev = angle <= 90 ? angle : 180 - angle;
  const base = ai._solve_power(cfg, tank.x, tank.y, tx, ty, elev);
  if (base === null) {
    return 1000;
  }
  return pyRound(Math.max(30.0, Math.min(1000.0, base)));
}

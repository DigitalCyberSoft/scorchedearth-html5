/**
 * Computer players -- a faithful TypeScript port of scorch-py/scorch/ai.py (the
 * fidelity oracle, itself byte-verified against 1.5/SCORCH.EXE). Control flow,
 * RNG draw order, and numeric behavior are identical to the Python; the
 * differential gate (test/ai.test.ts) asserts every result against the
 * Python-dumped vectors.
 *
 * class_id = menu_index + 1 (human = 0). The Shooter/Poolshark/Spoiler/Cyborg aim
 * by an in-turn ANGLE bracket (_search_aim = FUN_44b2_000a) wrapped around the
 * CLOSED-FORM power oracle (_oracle = FUN_2e50_05e9):
 *     v = sqrt( a * x^2 / (2*cos^2(theta) * (x*tan(theta) - y)) )
 * adapted to a = 2500*GRAVITY and power = v/POWER_SCALE. Per-tactic angle SEED:
 * Shooter = geometry (atan2); Spoiler = fixed 65/115; Cyborg = 85-w wind blend;
 * the bracket then walks +-1 deg. Targets: Shooter nearest-by-DISTANCE enemy,
 * Spoiler a RANDOM enemy, Tosser the enemy nearest the last landing. Two buyers:
 * the shared deterministic list (classes 2-7) and Moron's weighted-random.
 *
 * NUMERIC NOTE: the aim oracle uses Math.cos/tan/sin/sqrt/atan2; intermediate
 * powers are trig-derived. But every TURN function returns INTEGER (angle, power,
 * slot) via pyRound + clamp, and the angle search walks integer degrees, so the
 * differential gate asserts the integer turn outputs EXACT. Where a dumped value
 * is a raw transcendental-derived float (e.g. _solve_power / _oracle direct
 * results), the test uses toBeCloseTo(.,12). See test/ai.test.ts.
 *
 * IMPORT CYCLE: ai -> physics -> guidance -> ai. physics is imported as a
 * namespace and its functions are only called at RUNTIME (_simulate_landing),
 * never at module-load time, so ES module init never reads a half-init binding.
 */
import * as C from "./constants";
import * as weapons from "./weapons";
import * as physics from "./physics";
import { pyRound } from "./objects";
import type { Tank } from "./objects";
import type { Item } from "./weapons";

// ---------------------------------------------------------------------------
// Duck-typed state interfaces. The Python AI takes a GameState exposing exactly
// these fields/methods; the dumper + test build STRUCTURALLY IDENTICAL mocks so
// the only thing under differential test is ai's own arithmetic / control flow.
// ---------------------------------------------------------------------------
export interface AICfg {
  GRAVITY: number;
  wind: number;
  AIR_VISCOSITY: number;
  viscosity_mult: number;
  EDGES_EXTEND: number;
  team_mode: number;
  live_elastic?: number;
  elastic?: number;
  is_on(key: string): boolean;
}

export interface AIRng {
  pick(n: number): number;
  chance(num: number, den: number): boolean;
  uniform(a: number, b: number): number;
  roulette(weights: number[]): number;
}

export interface AIEconomy {
  available: boolean[];
  price: number[];
  buy(tank: Tank, slot: number): boolean;
}

export interface AITerrain {
  is_dirt(x: number, y: number): boolean;
}

export interface AIState {
  cfg: AICfg;
  tanks: Tank[];
  rng: AIRng;
  economy: AIEconomy;
  terrain: AITerrain;
  w: number;
  h: number;
  round_index: number;
  last_landing: [number, number] | null;
  live_sky?: string;
}

/** Python floor division `a // b` (floors toward -inf), used for the integer
 * midpoint math in the Tosser opener. */
function floordiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// ---------------------------------------------------------------------------
// Closed-form aim oracle
// ---------------------------------------------------------------------------
/** Power to hit (tx,ty) from (sx,sy) at the given elevation (0..90). Returns
 * power, or null if unreachable (apex below target). */
export function _solve_power(
  cfg: { GRAVITY: number },
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  elevation_deg: number,
): number | null {
  const a = C.EFF_GRAVITY_FACTOR * cfg.GRAVITY;
  let x = Math.abs(tx - sx);
  const dy_up = sy - ty; // +ve: target higher on screen
  if (x < 1) {
    x = 1;
  }
  const th = radians(elevation_deg);
  const ct = Math.cos(th);
  const denom = ct * ct * (x * Math.tan(th) - dy_up);
  if (denom <= 0) {
    // can't reach: arc tops out below target
    return null;
  }
  const v2 = (a * x * x) / (2.0 * denom);
  if (v2 <= 0) {
    return null;
  }
  const v = Math.sqrt(v2);
  return v / C.POWER_SCALE;
}

// FUN_2e50_05e9 return sentinels (port mirror).
const _ORACLE_UNREACHABLE = -1; // 0xFFFF
const _ORACLE_DEGENERATE = -2; // 0xFFFE

/** FUN_2e50_05e9: closed-form power for (tx,ty) at the tank's CURRENT game
 * angle. Returns power (>=0), or, when strict, the -1/-2 sentinel telling the
 * search which way to rotate. */
function _oracle(
  cfg: AICfg,
  tank: Tank,
  game_angle: number,
  tx: number,
  ty: number,
  strict: boolean,
): number {
  let elev = game_angle <= 90 ? game_angle : 180 - game_angle;
  elev = Math.max(0, Math.min(90, elev));
  const a = C.EFF_GRAVITY_FACTOR * cfg.GRAVITY;
  const x = Math.max(1.0, Math.abs(tx - tank.x));
  const dy_up = tank.y - ty;
  const th = radians(elev);
  const ct = Math.cos(th);
  const denom = ct * ct * (x * Math.tan(th) - dy_up);
  if (denom === 0.0) {
    // D == 0 -> 0xFFFE
    return strict ? _ORACLE_DEGENERATE : 0.0;
  }
  let v2 = (a * x * x) / (2.0 * denom);
  if (v2 < 0.0) {
    // no real solution -> 0xFFFF
    if (strict) {
      return _ORACLE_UNREACHABLE;
    }
    v2 = -v2; // flag==0: solve anyway (bounded)
  }
  const power = Math.sqrt(v2) / C.POWER_SCALE;
  const cap = 10 * Math.max(1, tank.health); // 10 * health
  if (strict && power > cap) {
    // power over cap -> 0xFFFF (cap reject)
    return _ORACLE_UNREACHABLE;
  }
  return power;
}

/** FUN_44b2_000a.c:17-22: the ceiling-clear flatten is armed for every wall
 * sub-mode EXCEPT NONE(0)/CONCRETE(1). Reads cfg.live_elastic. Exported for the
 * differential gate (the live-vs-derived elastic fallback). */
export function _wall_flatten_active(state: AIState): boolean {
  const mode =
    state.cfg.live_elastic !== undefined
      ? state.cfg.live_elastic
      : (state.cfg.elastic ?? 0);
  return mode !== 0 && mode !== 1;
}

/** FUN_2a4a_06fc + FUN_44b2_000a.c:50-51 apex test. Returns true if the
 * predicted apex is at/under the ceiling+2 (=> flatten). */
function _apex_clears_ceiling(
  _state: AIState,
  tank: Tank,
  game_angle: number,
  power: number,
): boolean {
  const elev = game_angle <= 90 ? game_angle : 180 - game_angle;
  const rise = pyRound(power * Math.sin(radians(elev)));
  const apex_y = tank.y - rise; // +0x14 - round(power*sin); Y grows down
  return apex_y < 0.0 + 2; // ef40(=0) + 2
}

/** FUN_44b2_000a: from the tank's seeded angle, bracket the ANGLE by re-solving
 * the oracle and stepping +-1 deg toward/away from vertical per the -1/-2
 * sentinel, until a real power is found or the angle leaves [0,180]. Under
 * reflective walls a ceiling-clear flatten (-2 deg) is applied when the apex
 * predictor says the arc tops out above the ceiling+2. Returns [game_angle,
 * power]. Exported for the differential gate (test/ai.test.ts). */
export function _search_aim(
  state: AIState,
  tank: Tank,
  tx: number,
  ty: number,
): [number, number] {
  const cfg = state.cfg;
  let angle = Math.trunc(tank.angle);
  let seen = 0; // uVar6: bit0 = hit -1, bit1 = hit -2
  const wall = _wall_flatten_active(state); // bVar1
  let power: number | null = null;
  for (let i = 0; i < 200; i++) {
    // bound; binary exits on seen==3 or angle OOB
    const r = _oracle(cfg, tank, angle, tx, ty, true);
    if (r === _ORACLE_UNREACHABLE) {
      // FUN_44b2_000a.c:29-37
      seen |= 1;
      angle += angle < 90 ? -1 : 1; // rotate AWAY from vertical
    } else if (r === _ORACLE_DEGENERATE) {
      // FUN_44b2_000a.c:38-46
      seen |= 2;
      angle += angle < 90 ? 1 : -1; // rotate TOWARD vertical
    } else {
      // real solution (FUN_44b2_000a.c:47-61)
      if (wall && _apex_clears_ceiling(state, tank, angle, r)) {
        // :49-51 apex over ceiling
        seen |= 1; // :53 uVar6 |= 1
        angle += angle < 90 ? -2 : 2; // :54-59 flatten 2deg AWAY from vertical
      } else {
        power = r; // :61 accept
        break;
      }
    }
    if (seen === 3 || angle < 0 || angle > 180) {
      // L63 loop guard: bracketed or off-field
      break;
    }
  }
  if (power === null) {
    // L66-69: fall back to a bounded power
    const r = _oracle(
      cfg,
      tank,
      Math.max(0, Math.min(180, angle)),
      tx,
      ty,
      false,
    );
    power = r || 800.0;
  }
  return [_clamp_ang(angle), _clamp_pow(power)];
}

/** Return [game_angle, power]. Analytic closed-form gives the initial
 * angle+power; then power is refined by SIMULATING the shot with the real
 * integrator (deterministic, no flight RNG), so the predicted landing equals the
 * actual landing. Spoiler/Ballistic behaviour. */
export function aim(
  state: AIState,
  tank: Tank,
  tx: number,
  ty: number,
  prefer: string = "lob",
): [number, number] {
  const cfg = state.cfg;
  let sol = _scan(cfg, tank.x, tank.y, tx, ty, prefer);
  if (!sol) {
    sol = [tx >= tank.x ? 45 : 135, 800]; // give up: lob hard
  }
  let angle = sol[0];
  let power = sol[1];
  const target_range = Math.max(1.0, Math.abs(tx - tank.x));
  for (let i = 0; i < 8; i++) {
    // range refinement loop
    const land_x = _simulate_landing(state, tank, angle, power, ty);
    if (land_x === null) {
      power = Math.min(1000.0, power * 1.15); // fell short of target height
      continue;
    }
    const cur_range = Math.max(1.0, Math.abs(land_x - tank.x));
    if (Math.abs(land_x - tx) < 3.0) {
      break;
    }
    // range ~ power^2 => power *= sqrt(target_range / cur_range)
    power *= Math.sqrt(target_range / cur_range);
    power = Math.max(30.0, Math.min(1000.0, power));
  }
  return [angle, pyRound(power)];
}

/** Step a throwaway projectile with the real integrator; return its x when it
 * descends through the target height ty. null if it never gets there. */
export function _simulate_landing(
  state: { cfg: physics.PhysicsCfg; w: number; h: number },
  tank: Tank,
  angle: number,
  power: number,
  ty: number,
): number | null {
  const proj = physics.launch(tank, state.cfg, _DUMMY_WEAPON, power, angle);
  proj.guidance = null; // measure the UNGUIDED arc
  // The loop bound is a max FLIGHT-TIME horizon, scaled by the substep count.
  const bound = 4000 * C.PHYSICS_SUBSTEPS;
  for (let i = 0; i < bound; i++) {
    const prev_y = proj.py;
    physics.step(proj, state.cfg);
    if (!physics.handle_walls(proj, state.cfg, state.w, state.h)) {
      return null;
    }
    if (proj.vy < 0 && prev_y <= ty && ty <= proj.py) {
      // descending through ty
      return proj.px;
    }
    if (proj.py >= state.h - 1) {
      // hit the floor
      return proj.px;
    }
  }
  return null;
}

class _DummyWeaponClass {
  idx = 0;
  warheads = 1;
  behavior = "explosive";
  blast = 10;
}

const _DUMMY_WEAPON = new _DummyWeaponClass() as unknown as Item;

/** Exported for the differential gate (test/ai.test.ts). */
export function _scan(
  cfg: AICfg,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  prefer: string,
): [number, number] | null {
  const right = tx >= sx;
  // Python: range(70, 20, -1) for lob (70..21 inclusive), else range(25, 80).
  const order: number[] = [];
  if (prefer === "lob") {
    for (let e = 70; e > 20; e--) order.push(e);
  } else {
    for (let e = 25; e < 80; e++) order.push(e);
  }
  for (const elev of order) {
    const pw = _solve_power(cfg, sx, sy, tx, ty, elev);
    if (pw === null || pw < 30 || pw > 1000) {
      continue;
    }
    const game_angle = right ? elev : 180 - elev;
    return [game_angle, pyRound(pw)];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------
export function nearest_enemy(state: AIState, tank: Tank): Tank | null {
  let best: Tank | null = null;
  let bd = 1e18;
  for (const t of state.tanks) {
    if (t.alive && t !== tank && !_friendly(state, tank, t)) {
      const d = Math.abs(t.x - tank.x);
      if (d < bd) {
        best = t;
        bd = d;
      }
    }
  }
  return best;
}

function _friendly(state: AIState, a: Tank, b: Tank): boolean {
  return (
    a !== b && state.cfg.team_mode !== C.TEAM_NONE && a.team_id === b.team_id
  );
}

/** FUN_24c8_018a weighted scorer; pick the max (catalog 14 s.4.1). */
export function cyborg_target(state: AIState, tank: Tank): Tank | null {
  // ranking = tanks sorted ascending by score (Python sorted is STABLE).
  const ranking = state.tanks.slice().sort((p, q) => p.score - q.score);
  const rank_of = new Map<Tank, number>();
  ranking.forEach((t, i) => rank_of.set(t, i));
  const turns = state.round_index + 1;
  let best: Tank | null = null;
  let best_w = -1e18;
  for (const e of state.tanks) {
    if (!e.alive || e === tank || _friendly(state, tank, e)) {
      continue;
    }
    const recent = tank.hits_this_round[e.player_index] ?? 0;
    const career = tank.hits_career[e.player_index] ?? 0;
    const retaliation = career * (tank.shield_hp > 0 ? 3 : 5);
    let w = state.rng.pick(32000) / 2000.0 + recent / turns + retaliation;
    if (e.shield_hp > 0) {
      w -= e.shield_hp / 10 + 1;
    }
    const between =
      Math.abs((rank_of.get(tank) as number) - (rank_of.get(e) as number)) - 1;
    w -= 3 * Math.max(0, between);
    if (w > best_w) {
      best = e;
      best_w = w;
    }
  }
  return best || nearest_enemy(state, tank);
}

// ---------------------------------------------------------------------------
// Weapon selection
// ---------------------------------------------------------------------------
export function pick_weapon(
  state: AIState,
  tank: Tank,
  random: boolean = false,
): number {
  const owned: number[] = [];
  for (let i = 0; i < weapons.NUM_ITEMS; i++) {
    if (weapons.ITEMS[i].offensive && tank.has_ammo(i)) {
      owned.push(i);
    }
  }
  if (random && owned.length > 0) {
    return owned[state.rng.pick(owned.length)];
  }
  // prefer a real Missile, else Baby Missile (always available)
  if (tank.has_ammo(weapons.SLOT_MISSILE)) {
    return weapons.SLOT_MISSILE;
  }
  return weapons.SLOT_BABY_MISSILE;
}

// ---------------------------------------------------------------------------
// Per-type take-turn -> [angle, power, weapon_slot]
// ---------------------------------------------------------------------------
/** FUN_3014_10bd.c:69-75: an 'Unknown' tank re-rolls its class to a random 1..7
 * ONCE and records that the real type is hidden from the player. */
function _resolve_unknown(state: AIState, tank: Tank): void {
  if (tank.ai_class === C.AI_UNKNOWN && tank.reveal_type !== -2) {
    tank.ai_class = state.rng.pick(7) + 1; // rand[0,7) + 1 => class 1..7
    tank.reveal_type = -2; // tank+0x24 = -2 (type hidden)
  }
}

export function take_turn(state: AIState, tank: Tank): [number, number, number] {
  _resolve_unknown(state, tank); // FUN_3014_10bd Unknown re-roll
  const cls = tank.ai_class;
  const fn = _TURN[cls] ?? _turn_shooter;
  return fn(state, tank);
}

/** Spoiler/Cyborg seed: w = |3*WIND/10| + VISCOSITY/2 (clamp 70); angle = 85-w
 * (right) or 95+w (left). Exported for the differential gate (test/ai.test.ts). */
export function _wind_seed_angle(state: AIState, right: boolean): number {
  let w = Math.abs((3 * state.cfg.wind) / 10) + state.cfg.AIR_VISCOSITY / 2;
  w = Math.min(70, w);
  return right ? 85 - w : 95 + w;
}

/** FUN_362c_0241 (fully random). */
function _turn_moron(state: AIState, tank: Tank): [number, number, number] {
  const power = (state.rng.pick(Math.max(1, tank.health)) + 1) * 10; // (rng(health)+1)*10
  let left = 0;
  let right = 0;
  for (const t of state.tanks) {
    if (t.alive && t !== tank && !_friendly(state, tank, t)) {
      if (t.x < tank.x) left += 1;
      if (t.x >= tank.x) right += 1;
    }
  }
  let angle = state.rng.pick(181); // rng(0xb5) => [0,180]
  if (left || right) {
    // else: no enemies, take first roll
    for (let i = 0; i < 64; i++) {
      // bounded re-roll
      const aims_left = angle > 90; // >0x5a, mirror of L26/L29 split at 90
      if ((aims_left && left) || (!aims_left && right)) {
        break;
      }
      angle = state.rng.pick(181);
    }
  }
  return [
    _clamp_ang(angle),
    _clamp_pow(power),
    pick_weapon(state, tank, true),
  ];
}

/** FUN_420d_007e.c:72-77 target pick: the live enemy nearest by HORIZONTAL
 * DISTANCE. The null-exclude wrapper retained for port fidelity (the live dispatch
 * only calls the _ex form); exported for the differential gate. */
export function _score_nearest_enemy(state: AIState, tank: Tank): Tank | null {
  return _score_nearest_enemy_ex(state, tank, null);
}

/** FUN_420d_007e.c:72-77 with the inline-refine give-up exclusion: skip any
 * target in `exclude`. */
function _score_nearest_enemy_ex(
  state: AIState,
  tank: Tank,
  exclude: Set<Tank> | null,
): Tank | null {
  let best: Tank | null = null;
  let bd = 1 << 30;
  for (const t of state.tanks) {
    if (exclude && exclude.has(t)) {
      continue;
    }
    if (t.alive && t !== tank && !_friendly(state, tank, t)) {
      const d = Math.abs(t.x - tank.x); // |d576[cand]-(+0xe)|
      if (d < bd) {
        best = t;
        bd = d;
      }
    }
  }
  return best;
}

/** FUN_420d_007e.c:86-91 seeds the angle from a 2-arg arctangent of the target
 * geometry, with NO steepening: the binary passes the raw atan2 seed. Exported
 * for the differential gate (test/ai.test.ts). */
export function _seed_angle(tank: Tank, target: Tank): number {
  const dy_up = tank.y - target.y + 2; // arg1: +ve = target higher on screen
  const dx = target.x - tank.x; // arg2: X delta
  const los = degrees(Math.atan2(dy_up, Math.abs(dx))); // raw line-of-sight elevation seed
  const elev = Math.max(1, Math.min(89, los)); // raw seed, no steepen
  return pyRound(dx >= 0 ? elev : 180 - elev);
}

/** FUN_420d_007e.c:92-108: the Shooter's OWN one-sided inline refine. From the
 * seeded angle, re-solve the strict oracle; on ANY negative sentinel step the
 * angle TOWARD vertical; loop while no real power. At exactly 90 it marks the
 * target resolved and RECURSES (port: returns null to exclude + re-pick).
 * Returns [game_angle, power] or null to recurse. */
function _shooter_refine(
  state: AIState,
  tank: Tank,
  target: Tank,
): [number, number] | null {
  const cfg = state.cfg;
  let angle = Math.trunc(tank.angle);
  let power: number | null = null;
  for (let i = 0; i < 200; i++) {
    // bound; binary exits on power or angle==90
    const r = _oracle(cfg, tank, angle, target.x, target.y, true); // :93
    if (r < 0) {
      // :94 either sentinel -> step toward 90
      angle += angle < 90 ? 1 : -1; // :95-100
    } else if (r >= 1) {
      // :108 loop exits only on local_10 >= 1
      power = r; // real power -> done
      break;
    } else {
      // 0 <= r < 1: neither steer nor exit -- break to bounded fallback.
      break;
    }
    if (angle === 90) {
      // :102 hit vertical -> drop target, recurse
      return null; // :103-106 (port: exclude + re-pick)
    }
  }
  return [_clamp_ang(angle), _clamp_pow(power !== null ? power : 0)];
}

/** FUN_420d_007e */
function _turn_shooter(
  state: AIState,
  tank: Tank,
  _exclude?: Set<Tank>,
): [number, number, number] {
  const exclude = _exclude !== undefined ? _exclude : new Set<Tank>();
  const target = _score_nearest_enemy_ex(state, tank, exclude);
  if (!target) {
    // FUN_420d_007e.c:56-60: no candidate -> fall back to the Tosser opener.
    return _tosser_opener(state, tank, pick_weapon(state, tank));
  }
  tank.angle = _clamp_ang(_seed_angle(tank, target)); // store to +0x32
  const res = _shooter_refine(state, tank, target); // one-sided refine
  if (res === null) {
    // recurse with this target resolved
    const ex2 = new Set<Tank>(exclude);
    ex2.add(target);
    return _turn_shooter(state, tank, ex2);
  }
  const [angle, power] = res;
  return [angle, power, pick_weapon(state, tank)];
}

/** FUN_415d_000c (Shooter) + _0241 wall fine-tune. */
function _turn_poolshark(state: AIState, tank: Tank): [number, number, number] {
  const exclude = new Set<Tank>();
  for (let i = 0; i < 8; i++) {
    // bound the give-up/re-pick recursion
    const target = _score_nearest_enemy_ex(state, tank, exclude);
    if (!target) {
      // shared Shooter entry: no candidate -> Tosser opener.
      return _tosser_opener(state, tank, pick_weapon(state, tank));
    }
    const adj = _poolshark_walltune(state, tank, target);
    if (adj !== null) {
      // FUN_415d_0241 (wall-gated ranging)
      return [adj[0], adj[1], pick_weapon(state, tank)];
    }
    tank.angle = _clamp_ang(_seed_angle(tank, target));
    const res = _shooter_refine(state, tank, target); // shared one-sided refine
    if (res === null) {
      // drop this target, re-pick
      exclude.add(target);
      continue;
    }
    const [angle, power] = res;
    return [angle, power, pick_weapon(state, tank)];
  }
  return [tank.angle, tank.power, pick_weapon(state, tank)];
}

/** DAT_5f38_5154 in {3,4} gates FUN_415d_0241 (RUBBER/SPRING). Exported for the
 * differential gate (the live-vs-derived elastic fallback). */
export function _poolshark_bouncy_walls(state: AIState): boolean {
  const mode =
    state.cfg.live_elastic !== undefined
      ? state.cfg.live_elastic
      : (state.cfg.elastic ?? 0);
  return mode === 3 || mode === 4;
}

/** FUN_415d_0241: only under bouncy walls, and only once a shot has landed, do a
 * +-1 deg micro-adjust off the GLOBAL last-landing x capped at 4 tries. Returns
 * [angle,power] or null to fall through to the Shooter aim. */
function _poolshark_walltune(
  state: AIState,
  tank: Tank,
  target: Tank,
): [number, number] | null {
  const last = state.last_landing;
  if (last === null || !_poolshark_bouncy_walls(state)) {
    return null;
  }
  const lx = last[0];
  const ly = last[1];
  tank.ai_tries += 1; // tank+0x38 += 1
  if (tank.ai_tries > 4) {
    // L30-34: give up after 4
    tank.ai_tries = 0;
    return null;
  }
  let angle = Math.trunc(tank.angle);
  if (Math.abs(tank.x - target.x) < Math.abs(tank.x - lx)) {
    // L36 landed FARTHER than target
    angle += 1; // L37 +1 deg
    if (angle === 90) {
      // L38-42 hit vertical -> drop target
      tank.ai_tries = 0;
      return null;
    }
  } else if (ly >= target.y && angle !== 0) {
    // L45/48-53 landed not-higher: -1 deg
    angle -= 1;
  }
  return [_clamp_ang(angle), _clamp_pow(tank.power)];
}

/** FUN_4b6b_0007: the ranging lob into OPEN SPACE toward the tank<->screen-edge
 * midpoint at half screen height (NOT aimed at the enemy). */
function _tosser_opener(
  state: AIState,
  tank: Tank,
  weapon: number,
): [number, number, number] {
  const target = nearest_enemy(state, tank); // only to choose a side
  const right = target ? target.x >= tank.x : true;
  let angle = state.rng.pick(70) + 10; // rng(0x46)+10 => 10..79
  let aim_x: number;
  if (!right) {
    angle = 180 - angle; // 0xb4 - angle => 101..170
    aim_x = floordiv(tank.x, 2); // midpoint self<->left edge
  } else {
    aim_x = tank.x + floordiv(state.w - 1 - tank.x, 2); // midpoint self<->right edge
  }
  const aim_y = floordiv(state.h - 1, 2); // ef3a/2 = half screen height
  const elev = Math.min(89, angle <= 90 ? angle : 180 - angle);
  let power = _solve_power(state.cfg, tank.x, tank.y, aim_x, aim_y, elev);
  if (power === null) {
    power = 600.0; // opener oracle never -1's; bounded fallback
  }
  return [_clamp_ang(angle), _clamp_pow(power), weapon];
}

/** FUN_4b6b_0007 / _00fe / _033c. Artillery ranging. */
function _turn_tosser(state: AIState, tank: Tank): [number, number, number] {
  const last = state.last_landing;
  const weapon = pick_weapon(state, tank);

  if (last === null) {
    // FUN_4b6b_0007 opener
    return _tosser_opener(state, tank, weapon);
  }

  const lx = last[0];
  const ly = last[1]; // FUN_4b6b_00fe: enemy nearest the landing x
  const target = _enemy_nearest_x(state, tank, lx);
  if (target === null) {
    return [_clamp_ang(tank.angle), _clamp_pow(tank.power), weapon];
  }

  let angle = tank.angle;
  let power = tank.power; // FUN_4b6b_033c: one bracket step
  if (Math.abs(tank.x - target.x) < Math.abs(tank.x - lx)) {
    // shell fell FARTHER => overshoot
    power -= 10;
  } else if (ly < target.y) {
    // shell landed HIGHER on screen (short + high)
    if (_tosser_steepen_gate(state, ly)) {
      if (angle < 85) {
        angle += 2; // toward vertical (85)
      } else if (angle > 95) {
        angle -= 2; // (95); [85,95] frozen
      }
    }
    power += 10;
  } else {
    // short + low: just add power
    power += 10;
  }
  return [_clamp_ang(angle), _clamp_pow(power), weapon];
}

/** FUN_4b6b_00fe core */
function _enemy_nearest_x(state: AIState, tank: Tank, x: number): Tank | null {
  let best: Tank | null = null;
  let bd = 1 << 30;
  for (const t of state.tanks) {
    if (t.alive && t !== tank && !_friendly(state, tank, t)) {
      const d = Math.abs(t.x - x);
      if (d < bd) {
        best = t;
        bd = d;
      }
    }
  }
  return best;
}

/** FUN_4b6b_033c.c:28: not a cavern -> always steepen; in a cavern only steepen
 * if the shell landed in the LOWER half. Exported for the differential gate
 * (test/ai.test.ts). */
export function _tosser_steepen_gate(state: AIState, landing_y: number): boolean {
  const sky = (state.live_sky ?? "").toUpperCase();
  if (sky !== "CAVERN") {
    return true;
  }
  return floordiv(state.h, 2) < landing_y;
}

function _clamp_ang(a: number): number {
  return Math.trunc(Math.max(0, Math.min(180, a)));
}

function _clamp_pow(p: number): number {
  return Math.trunc(Math.max(0, Math.min(1000, p)));
}

/** FUN_44b2_0163.c:23-35: pick a live, not-yet-resolved enemy at RANDOM. */
function _spoiler_target(state: AIState, tank: Tank): Tank | null {
  const cands: Tank[] = [];
  for (const t of state.tanks) {
    if (t.alive && t !== tank && !_friendly(state, tank, t)) {
      cands.push(t);
    }
  }
  if (cands.length === 0) {
    return null;
  }
  return cands[state.rng.pick(cands.length)];
}

/** FUN_44b2_0163 (random target + angle search). */
function _turn_spoiler(state: AIState, tank: Tank): [number, number, number] {
  const target = _spoiler_target(state, tank);
  if (!target) {
    return [tank.angle, tank.power, pick_weapon(state, tank)];
  }
  // FUN_44b2_0163.c:38-43: fixed steep seed -- 65 aiming right, 115 aiming left.
  tank.angle = tank.x < target.x ? 65 : 115;
  const [angle, power] = _search_aim(state, tank, target.x, target.y);
  return [angle, power, pick_weapon(state, tank)];
}

/** FUN_24c8_03e3 (scorer + wind-seeded search). */
function _turn_cyborg(state: AIState, tank: Tank): [number, number, number] {
  const target = cyborg_target(state, tank);
  if (!target) {
    return [tank.angle, tank.power, pick_weapon(state, tank)];
  }
  // FUN_24c8_03e3.c:33-46: w = |3*wind/10| + visc/2, clamp 70; angle = 85-w
  // aiming right, 95+w aiming left; then FUN_44b2_000a.
  tank.angle = _clamp_ang(_wind_seed_angle(state, tank.x < target.x));
  const [angle, power] = _search_aim(state, tank, target.x, target.y);
  return [angle, power, pick_weapon(state, tank)];
}

/** FUN_2132_000f (byte-exact 2026-06-25). Three-way selector. */
function _turn_chooser(state: AIState, tank: Tank): [number, number, number] {
  const target = nearest_enemy(state, tank);
  if (target && _clear_shot(state, tank, target)) {
    // ec88==1: clear line of fire -> Shooter
    return _turn_shooter(state, tank); // commit Shooter (already fired)
  }
  if (_poolshark_bouncy_walls(state)) {
    // 5154==3||4 (RUBBER/SPRING)
    return _turn_poolshark(state, tank); // Poolshark
  }
  return _turn_spoiler(state, tank); // Spoiler (NOT Tosser/Moron)
}

/** Crude line-of-fire test: sample the straight line for terrain. */
function _clear_shot(state: AIState, tank: Tank, target: Tank): boolean {
  const x0 = tank.x;
  const y0 = tank.y - 6;
  const x1 = target.x;
  const y1 = target.y - 6;
  const steps = Math.max(1, Math.trunc(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 1; i < steps; i++) {
    const x = Math.trunc(x0 + ((x1 - x0) * i) / steps);
    const y = Math.trunc(y0 + ((y1 - y0) * i) / steps);
    if (state.terrain.is_dirt(x, y)) {
      return false;
    }
  }
  return true;
}

const _TURN: { [k: number]: (s: AIState, t: Tank) => [number, number, number] } =
  {
    [C.AI_MORON]: _turn_moron,
    [C.AI_SHOOTER]: _turn_shooter,
    [C.AI_POOLSHARK]: _turn_poolshark,
    [C.AI_TOSSER]: _turn_tosser,
    [C.AI_CHOOSER]: _turn_chooser,
    [C.AI_SPOILER]: _turn_spoiler,
    [C.AI_CYBORG]: _turn_cyborg,
  };

// ---------------------------------------------------------------------------
// Buying (catalog 14 section 6)
// ---------------------------------------------------------------------------
export function buy(state: AIState, tank: Tank): void {
  if (!state.cfg.is_on("COMPUTERS_BUY")) {
    return;
  }
  if (tank.ai_class === C.AI_MORON) {
    _buy_moron(state, tank);
  } else {
    _buy_shared(state, tank);
  }
}

function _owns(tank: Tank, slot: number): boolean {
  return tank.inventory[slot] > 0;
}

/** FUN_21b5_05f7 (classes 2-7): best shield, parachute, missiles to 5, batteries
 * to 8 -- deterministic. */
function _buy_shared(state: AIState, tank: Tank): void {
  const econ = state.economy;
  for (const shield of [
    weapons.SLOT_HEAVY_SHIELD,
    weapons.SLOT_FORCE_SHIELD,
    weapons.SLOT_SHIELD,
  ]) {
    if (!weapons.SHIELD_SLOTS.some((s) => _owns(tank, s))) {
      econ.buy(tank, shield);
    }
  }
  if (!_owns(tank, weapons.SLOT_PARACHUTE)) {
    if (econ.buy(tank, weapons.SLOT_PARACHUTE)) {
      tank.parachute_deployed = true;
    }
  }
  for (const slot of [weapons.SLOT_MISSILE, weapons.SLOT_BABY_MISSILE]) {
    let guard = 0;
    while (tank.inventory[slot] < 5 && econ.available[slot] && guard < 20) {
      if (!econ.buy(tank, slot)) {
        break;
      }
      guard += 1;
    }
  }
  let guard = 0;
  while (tank.inventory[weapons.SLOT_BATTERY] < 8 && guard < 20) {
    if (!econ.buy(tank, weapons.SLOT_BATTERY)) {
      break;
    }
    guard += 1;
  }
}

/** FUN_362c_004e: weighted-random over the desirability table. */
function _buy_moron(state: AIState, tank: Tank): void {
  const econ = state.economy;
  for (let i = 0; i < 10; i++) {
    // up to 10 roulette picks
    const cands: number[] = [];
    const wts: number[] = [];
    // Iterate MORON_WEIGHTS in the Python dict's insertion order (the object
    // literal preserves it: 0,1,2,3,6,7,8,9,12,13,17,25,31,32).
    for (const key of Object.keys(weapons.MORON_WEIGHTS)) {
      const slot = Number(key);
      const wt = weapons.MORON_WEIGHTS[slot];
      if (econ.available[slot] && tank.cash >= econ.price[slot] && wt > 0) {
        cands.push(slot);
        wts.push(wt);
      }
    }
    if (cands.length === 0) {
      break;
    }
    const pick = cands[state.rng.roulette(wts)];
    if (!econ.buy(tank, pick)) {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Angle/degree helpers matching Python math.radians / math.degrees exactly.
// CPython: radians(x) = x * (pi/180); degrees(x) = x * (180/pi). These are the
// libm/Python conversion constants (not multiply-by-DEG2RAD), so the oracle math
// matches the Python bit-for-bit modulo the final transcendental rounding.
// ---------------------------------------------------------------------------
function radians(deg: number): number {
  return (deg * Math.PI) / 180.0;
}

function degrees(rad: number): number {
  return (rad * 180.0) / Math.PI;
}

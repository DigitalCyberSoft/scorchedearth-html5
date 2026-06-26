/**
 * Hostile-sky hazards: the recursive fractal LIGHTNING bolt and the per-turn
 * strike hook (segment 480f; sky weather tick FUN_42c2_1789 / FUN_42c2_1733).
 *
 * A faithful TypeScript port of scorch-py/scorch/hazard.py (the fidelity oracle,
 * itself verified against 1.5/SCORCH.EXE). Every FUN_<seg>_<off> / DAT_ provenance
 * comment from the Python source is preserved so the lineage survives.
 *
 * Ground truth (primary-source decompiles + catalog 06 section 2.2):
 *   - SKY enum (catalog 03 / 06 s.2.1): PLAIN STORMY STARS SHADED SUNSET CAVERN
 *     BLACK RANDOM.  RANDOM picks any type EXCEPT BLACK at round start
 *     (06_messages_world.md:93, SCORCH.DOC:L1968-1974).
 *   - The ONLY documented hostile-sky attack in v1.5 is LIGHTNING, emitted by the
 *     STORMY sky (06_messages_world.md:104,131; SCORCH.DOC:L1972-1974).  There are
 *     NO meteor showers in v1.5 (06_messages_world.md:133 flags the task term as
 *     having zero binary/manual evidence); this module implements lightning only.
 *   - HOSTILE_ENVIRONMENT=OFF neutralises the damage but keeps the visual
 *     (06_messages_world.md:131, SCORCH.DOC:L1985-1990).
 *
 * Lightning generator (FUN_480f_0390, FACT):
 *   Recursive bolt from a start point down to the ground row DAT_5f38_ef38 (the
 *   bottom clip extent; 16_video.md:49).  Each call (decompile lines cited):
 *     - draw one segment via the laser tracer FUN_271b_0733 from (x, y) to
 *       (x + rng(dy+1) - dy//2, target_y), where dy = target_y - y     (:14-18)
 *     - terminate when y == target_y                                    (:13)
 *     - branch gate: rng(10) > 7  (values {8,9} -> 2/10 = 20%) AND
 *       depth DAT_5f38_ee42 < 0xd (13).  TWO nested branch chances per node,
 *       each incrementing the depth counter.                            (:21-30)
 *
 * Strike cadence (FUN_42c2_1789.c:15-19, FUN_42c2_1733.c:13-17, FACT):
 *   The weather tick acts only when the sky style is STORMY (DAT_5f38_5110 == 3).
 *   On a tick: rng(4) == 1  -> spawn lightning (FUN_480f_0219, the 1-in-4 gate);
 *   else rng(2) == 0 -> spawn the thunder/cloud SFX (FUN_480f_0148).  This module
 *   fires lightning on the 1-in-4 gate.
 *
 * RECONSTRUCTED (flagged): the lightning STRIKE DAMAGE.  The decompiled strike
 * path (FUN_480f_0219 -> FUN_480f_0390) traces and flashes the bolt; the
 * tank-damage application from a lightning hit is not byte-pinned in the recovered
 * code (the strike's damage call site was not isolated), and the manual gives no
 * number.  LIGHTNING_DAMAGE below is reconstructed; it is applied through the
 * documented radial-damage hook (damage.apply_tank_damage), so a shield absorbs it
 * exactly as it would a shell hit (catalog 11 s.3).
 *
 * ============================================================================
 * NUMERIC NOTES (load-bearing for the differential gate, test/hazard.test.ts):
 *
 *  - Python `int(x)` truncates TOWARD ZERO -> Math.trunc(x).  Used for the bolt's
 *    (int(x), int(y)) point coercion.
 *
 *  - Python `a // b` is FLOOR division (rounds toward NEGATIVE infinity), NOT JS
 *    `Math.trunc(a/b)`.  The bolt's horizontal damping `(jit * step) // max(1,
 *    span)` has a NEGATIVE numerator whenever the jitter pushes left, and floor vs
 *    truncate disagree by 1 on every non-exact negative quotient (e.g. -12 // 10
 *    == -2 in Python, Math.trunc(-12/10) == -1).  So this module implements
 *    pyFloorDiv() and uses it where the Python uses `//`.  `span >> 1` is on a
 *    non-negative span (abs), so the JS `>>` matches Python `>>` there.
 *
 *  - lightning_bolt / bolt_segments / maybe_strike / _thunder_flicker draw from
 *    rng via pick/chance ONLY (integer draws), so every coordinate, branch
 *    decision, target index, and flicker count is an EXACT integer/boolean.  The
 *    differential test asserts them with toBe(); there is no transcendental math
 *    anywhere in this module.
 * ============================================================================
 */
import * as C from "./constants";
import * as damage from "./damage";
import { sfx } from "./sound";

/**
 * Python floor division a // b (rounds toward -Infinity).  JS `/` then Math.trunc
 * truncates toward zero, which disagrees with Python on negative non-exact
 * quotients.  b is always > 0 at the call sites here (max(1, span)).
 */
export function pyFloorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

// ---------------------------------------------------------------------------
// Duck-typed structural shapes this module reads/mutates.  Mirrors exactly the
// fields scorch/hazard.py touches, so the differential dumper/test can drive it
// with the same lightweight mocks the oracle builds.
// ---------------------------------------------------------------------------

/** The RNG interface (scorch/rng.py Rng): integer draws + boolean cadence. */
export interface RngLike {
  pick(n: number): number;
  chance(num: number, den: number): boolean;
  uniform(a: number, b: number): number;
}

/** cfg surface read on the hazard path: cfg.SKY + cfg.is_on(...). */
export interface Cfg {
  SKY?: string | null;
  is_on(key: string): boolean;
}

/** Tank fields the strike/damage paths read. */
export interface Tank {
  alive: boolean;
  x: number;
  y: number;
  half_width: number;
  [k: string]: unknown;
}

/** One short-lived bolt visual queued on state.active_bolts. */
export interface BoltVisual {
  pts: Array<[number, number]>;
  frame: number;
}

/** Terrain surface install_cavern_ceiling writes its ceiling band into.  The real
 *  scorch.terrain.Terrain (terrain.ts) satisfies this: a flat column-major
 *  Uint8Array framebuffer addressed via read/write, NOT an array-of-columns.  (The
 *  earlier `grid: {cols}` shape was a test-mock fiction that crashed the real game
 *  on a CAVERN sky -- the real grid has no `.cols`.) */
export interface Terrain {
  w: number;
  h: number;
  read(x: number, y: number): number;
  write(x: number, y: number, color: number): void;
}

/** Game-state surface the hazard hooks thread through. */
export interface State {
  w: number;
  rng: RngLike;
  cfg: Cfg;
  tanks: Tank[];
  terrain: Terrain;
  live_sky?: string | null;
  active_bolts?: BoltVisual[];
  // damage.apply_tank_damage needs the full damage State; hazard only forwards.
  add_flash?: (up: number, down: number, rgb: [number, number, number], delay?: number) => void;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
export const BRANCH_DEPTH_CAP = 13; // FACT: DAT_5f38_ee42 < 0xd (FUN_480f_0390:22)
export const BRANCH_RNG_N = 10; // FACT: rng(10)        (FUN_480f_0390:23,26)
export const BRANCH_RNG_GT = 7; // FACT: > 7 -> branch  (FUN_480f_0390:23,27)
export const STRIKE_CADENCE: [number, number] = [1, 4]; // FACT: rng(4)==1 -> strike (FUN_42c2_1789:16-17)
export const FLICKER_CADENCE: [number, number] = [1, 2]; // FACT: else rng(2)==0 -> thunder flicker (FUN_42c2_1789:18)

// Ground-strike full-screen flash (FUN_480f_0219.c:18,25-49): the strike sets the
// hot DAC colour FUN_556b_0005(0xff,0x3f,0x3f,...) -- 0x3f is the max 6-bit value,
// so the registered colour is white (255,255,255).  The flash ramps brightness up
// over ~30 frames (`for iVar1=0;iVar1<10` + `for iVar1=10;iVar1<0x1e`) then back
// down ~30 (the mirror loops at :43-49).  FACT.
export const STRIKE_FLASH_UP = 30;
export const STRIKE_FLASH_DOWN = 30;
export const STRIKE_FLASH_RGB: [number, number, number] = [255, 255, 255];

// Thunder flicker (FUN_480f_0148.c): rng(4)+2 = 2..5 sky flashes, no bolt; each
// ramps a palette register up then down, with a random PIT hold between flashes
// (FUN_1000_9af6(rng(200))).  FACT.  Modeled as 2..5 staggered full-screen flashes.
export const FLICKER_MIN = 2; // FUN_480f_0148.c:12-13  rng(4)+2 lower bound
export const FLICKER_RAND = 4; // FUN_480f_0148.c:12      rng(4)
export const FLICKER_UP = 8;
export const FLICKER_DOWN = 8;
export const FLICKER_GAP = 6; // frames between flickers (the random 9af6 hold)
export const FLICKER_RGB: [number, number, number] = [230, 230, 235];

export const LIGHTNING_DAMAGE = 10; // FACT (RECOVERED_MISC.md T1): push 0x0a at
//   FUN_480f_000c (480f:008b, bytes 6a 0a) = param_2 of FUN_4912_04b2(tank,10,1),
//   gated on HOSTILE_ENVIRONMENT (DAT_5f38_513c, 480f:0082).  Applied per struck
//   tank through the shield resolver FUN_4191_0034 -> FUN_3a16_0fe8, so a shield
//   absorbs it exactly as a shell hit.  Routed here via damage.apply_tank_damage.
export const STRIKE_HALF_WIDTH = 6; // px: horizontal reach of a strike around its aim x.

// RANDOM excludes BLACK (06_messages_world.md:93).
export const _RANDOM_SKY_POOL: readonly string[] = ["PLAIN", "STORMY", "STARS", "SHADED", "SUNSET", "CAVERN"];
export const HOSTILE_SKIES: readonly string[] = ["STORMY"]; // the documented hostile sky (06 s.2.2)

// ---------------------------------------------------------------------------
// Per-round sky resolution (the single site both render.py and hazard.py read)
// ---------------------------------------------------------------------------
/**
 * Resolve cfg.SKY to a concrete sky for this round.  RANDOM picks any type except
 * BLACK (06_messages_world.md:93).
 */
export function resolve_round_sky(cfg: Cfg, rng: RngLike): string {
  const m = (cfg.SKY || "PLAIN").toUpperCase();
  if (m === "RANDOM") {
    return _RANDOM_SKY_POOL[rng.pick(_RANDOM_SKY_POOL.length)];
  }
  return m;
}

/** True if the resolved sky launches its own attacks (STORMY; 06 s.2.2). */
export function is_hostile(sky_mode: string | null | undefined): boolean {
  return HOSTILE_SKIES.indexOf((sky_mode || "").toUpperCase()) !== -1;
}

// ---------------------------------------------------------------------------
// Recursive fractal lightning bolt (FUN_480f_0390)
// ---------------------------------------------------------------------------
/**
 * Generate a branching lightning bolt from (x, y) down to target_y.
 *
 * Faithful to FUN_480f_0390: each step draws one jittered segment toward
 * target_y, then recurses with a 20% branch chance (rng(10) > 7) capped at
 * depth 13 (DAT_5f38_ee42 < 0xd).  Returns a list of polylines (each a list of
 * (x, y) points) for the renderer to stroke -- the main trunk first, then any
 * branch polylines.  A shared mutable depth counter mirrors the binary's single
 * global DAT_5f38_ee42 (incremented per taken branch, never reset mid-bolt).
 *
 * `_depth` mirrors the single global DAT_5f38_ee42: a one-element array passed by
 * reference so every recursive call (trunk + branches) shares the same counter,
 * exactly as the Python `_depth=[0]` mutable list does.
 */
export function lightning_bolt(
  x: number,
  y: number,
  target_y: number,
  rng: RngLike,
  _depth: number[] | null = null
): Array<Array<[number, number]>> {
  if (_depth === null) {
    _depth = [0]; // mirrors the single global DAT_5f38_ee42
  }
  const polylines: Array<Array<[number, number]>> = [];
  const trunk: Array<[number, number]> = [[Math.trunc(x), Math.trunc(y)]];
  let cx = x;
  let cy = y;
  // Walk the trunk segment-by-segment to the ground, jittering x each step
  // (FUN_480f_0390 recurses one segment per call; the iterative trunk here is
  // the unrolled tail-recursion on the y!=target_y termination at :13).
  let guard = 0;
  while (cy !== target_y && guard < 4096) {
    guard += 1;
    const dy = target_y - cy;
    const step = Math.abs(dy) <= 12 ? dy : dy > 0 ? 12 : -12; // seg granularity
    const ny = cy + step;
    // horizontal jitter (FUN_480f_0390:15-18): rng(|dy|+1) - |dy|//2
    const span = Math.abs(dy);
    const jit = rng.pick(span + 1) - (span >> 1);
    // damp the jitter to the remaining distance so the bolt converges
    const nx = cx + pyFloorDiv(jit * step, Math.max(1, span));
    trunk.push([Math.trunc(nx), Math.trunc(ny)]);
    // branch off this node (two nested chances, FUN_480f_0390:21-30)
    if (_depth[0] < BRANCH_DEPTH_CAP && rng.pick(BRANCH_RNG_N) > BRANCH_RNG_GT) {
      _depth[0] += 1;
      for (const p of lightning_bolt(nx, ny, target_y, rng, _depth)) {
        polylines.push(p);
      }
      if (_depth[0] < BRANCH_DEPTH_CAP && rng.pick(BRANCH_RNG_N) > BRANCH_RNG_GT) {
        _depth[0] += 1;
        for (const p of lightning_bolt(nx, ny, target_y, rng, _depth)) {
          polylines.push(p);
        }
      }
    }
    cx = nx;
    cy = ny;
  }
  return [trunk, ...polylines];
}

/**
 * Build a bolt aimed from the top of the sky down to (target_x, target_y).
 *
 * The origin mirrors FUN_480f_0219:23: a near-top start jittered horizontally
 * around the aim x.  Returns the polyline list for the renderer.
 */
export function bolt_segments(state: State, target_x: number, target_y: number): Array<Array<[number, number]>> {
  const span = Math.max(2, pyFloorDiv(state.w, 16));
  let x0 = target_x + state.rng.pick(2 * span + 1) - span;
  x0 = Math.max(0, Math.min(state.w - 1, x0));
  return lightning_bolt(x0, 0, Math.trunc(target_y), state.rng);
}

// ---------------------------------------------------------------------------
// Per-turn strike hook (sky weather tick: FUN_42c2_1789 / FUN_42c2_1733)
// ---------------------------------------------------------------------------
/**
 * One sky weather tick.  Call at turn start (game.py hook).
 *
 * When the round's sky is hostile (STORMY) and the 1-in-4 cadence gate fires
 * (FUN_42c2_1789:16), spawn a lightning bolt at a random living tank.  The bolt
 * polylines are stored on state.active_bolts for the renderer to draw.  Damage
 * is applied via damage.apply_tank_damage ONLY when HOSTILE_ENVIRONMENT is ON;
 * OFF keeps the visual but does no damage (06_messages_world.md:131).
 *
 * Returns the spawned bolt's polyline list, or null when nothing struck (sky not
 * hostile, the cadence gate did not fire, or no living target).  A thunder
 * flicker on the else-branch returns null (no bolt) but does queue its flashes.
 */
export function maybe_strike(state: State): Array<Array<[number, number]>> | null {
  let sky = state.live_sky ?? null;
  if (sky === null || sky === undefined) {
    // round-sky not resolved yet (e.g. a unit test set cfg.SKY directly):
    // resolve it now so the hook is self-contained.
    sky = resolve_round_sky(state.cfg, state.rng);
    state.live_sky = sky;
  }
  if (!is_hostile(sky)) {
    return null;
  }
  // FUN_42c2_1789.c:15-19: rng(4)==1 -> ground strike; else rng(2)==0 -> thunder
  // flicker (no bolt).  The two are mutually exclusive on a tick.
  const [num, den] = STRIKE_CADENCE;
  if (!state.rng.chance(num, den)) {
    // FUN_42c2_1789:16 (rng(4)==1)
    const [fnum, fden] = FLICKER_CADENCE;
    if (state.rng.chance(fnum, fden)) {
      // FUN_42c2_1789:18 (else rng(2)==0)
      _thunder_flicker(state); // FUN_480f_0148: 2..5 flashes, no bolt
    }
    return null;
  }

  const targets = state.tanks.filter((t) => t.alive);
  if (targets.length === 0) {
    return null;
  }
  const target = targets[state.rng.pick(targets.length)];
  const aim_x = target.x;
  const aim_y = target.y - 4;

  const bolt = bolt_segments(state, aim_x, aim_y);
  _register_bolt(state, bolt);
  // FUN_480f_0219.c:20 -- a281(2000): the ground-strike emits a steady 2000 Hz
  // tone (the "lightning" event).  Fired on the strike, gated on SOUND.
  sfx.play("lightning", state.cfg.is_on("SOUND"));
  // FUN_480f_0219.c:18,25-49: the strike flashes the whole screen white-hot,
  // ramping up ~30 frames then down ~30.  Queued for the renderer to overlay.
  if (typeof state.add_flash === "function") {
    state.add_flash(STRIKE_FLASH_UP, STRIKE_FLASH_DOWN, STRIKE_FLASH_RGB);
  }

  // HOSTILE_ENVIRONMENT gate (catalog 03:170 / 06:131): OFF = visual only.
  if (state.cfg.is_on("HOSTILE_ENVIRONMENT")) {
    _strike_damage(state, aim_x, aim_y);
  }
  return bolt;
}

/**
 * Standalone thunder: 2..5 sky flashes with NO bolt (FUN_480f_0148.c:12-27).
 * Count = rng(4)+2; each flash ramps up then down, with a hold between flashes
 * (the binary's random FUN_1000_9af6 PIT delay).  Staggered via the flash delay
 * so they play in sequence rather than all at once.
 */
export function _thunder_flicker(state: State): void {
  if (typeof state.add_flash !== "function") {
    return;
  }
  // Thunder/heat-lightning SFX (FUN_480f_0148.c -> 0007 rand(100) low-tone
  // flicker burst): the else-branch of the weather tick voices thunder with no
  // bolt.  Fired once for the flicker burst, gated on SOUND.
  sfx.play("thunder", state.cfg.is_on("SOUND"));
  const count = state.rng.pick(FLICKER_RAND) + FLICKER_MIN; // rng(4)+2 -> 2..5
  const span = FLICKER_UP + FLICKER_DOWN + FLICKER_GAP;
  for (let i = 0; i < count; i++) {
    state.add_flash(FLICKER_UP, FLICKER_DOWN, FLICKER_RGB, i * span);
  }
}

/**
 * Apply the lightning strike's damage to any tank under the strike column.
 *
 * Uses the documented radial-damage hook (damage.apply_tank_damage), so the
 * strike respects shields exactly as a shell hit does.  Damage amount is
 * RECONSTRUCTED (LIGHTNING_DAMAGE); see module docstring.
 */
export function _strike_damage(state: State, aim_x: number, aim_y: number): void {
  for (const t of state.tanks.slice()) {
    if (!t.alive) {
      continue;
    }
    if (Math.abs(t.x - aim_x) <= t.half_width + STRIKE_HALF_WIDTH && t.y - 4 >= aim_y - 4) {
      damage.apply_tank_damage(state as unknown as damage.State, t as unknown as damage.Tank, LIGHTNING_DAMAGE);
    }
  }
}

/**
 * Push a bolt onto state.active_bolts as a short-lived visual {pts, frame}.
 *
 * Each entry is one polyline so the renderer can stroke the trunk and every
 * branch independently; the game's _animate_effects-style ageing (or the
 * renderer) expires them.
 */
export function _register_bolt(state: State, bolt: Array<Array<[number, number]>>): void {
  if (!Array.isArray(state.active_bolts)) {
    state.active_bolts = [];
  }
  for (const poly of bolt) {
    if (poly.length >= 2) {
      state.active_bolts.push({ pts: poly, frame: 0 });
    }
  }
}

/**
 * Advance and expire active lightning visuals.  Mirrors the beam/explosion frame
 * ageing in game._animate_effects; call it from the same place (or let the
 * renderer age them).  Safe to call when there are no bolts.
 */
export function age_bolts(state: State, max_frames = 6): void {
  const bolts = state.active_bolts ?? null;
  if (!bolts || bolts.length === 0) {
    return;
  }
  for (const b of bolts) {
    b.frame += 1;
  }
  state.active_bolts = bolts.filter((b) => b.frame <= max_frames);
}

// ---------------------------------------------------------------------------
// CAVERN ceiling (interacts with the terrain top)
// ---------------------------------------------------------------------------
export const CAVERN_CEILING_ROWS = 10; // px: thickness of the dirt ceiling at the top.

/**
 * Stamp a solid dirt ceiling across the top rows of the terrain for a CAVERN sky,
 * so shells bounce/explode against it like the ground.
 *
 * The CAVERN sky is "actually a landscape" (the README note quoted at
 * 06_messages_world.md:112): the top of the playfield is solid rock.  This writes
 * dirt-band pixels into the terrain plane's top rows; because the terrain
 * framebuffer is the single collision authority (terrain.is_dirt drives every
 * shell collision and crater carve in game._check_collision / weapon_behaviors), a
 * ceiling written here is automatically a surface that shells collide with and
 * craters can chew into.  Idempotent per round (called once from start_round after
 * terrain.generate).
 *
 * Returns the number of ceiling rows written.  No-op when the sky is not CAVERN.
 */
export function install_cavern_ceiling(state: State): number {
  const sky = state.live_sky || resolve_round_sky(state.cfg, state.rng);
  if (sky.toUpperCase() !== "CAVERN") {
    return 0;
  }
  const rows = Math.min(CAVERN_CEILING_ROWS, state.terrain.h);
  // solid mid-dirt band so it reads as dirt to is_dirt / is_solid and shades like
  // the ground crust (constants.DIRT_SHADE_*).
  const fill = C.DIRT_SHADE_LO + 8;
  const crust = C.DIRT_SHADE_HI;
  const t = state.terrain;
  // grid[:, 0:rows] = fill (all columns x, rows y in [0, rows)), then the crust row
  // at rows-1.  Goes through terrain.write() so it is correct against the real
  // column-major Uint8Array framebuffer, not a mock array-of-columns.
  for (let x = 0; x < t.w; x++) {
    for (let yy = 0; yy < rows; yy++) {
      t.write(x, yy, fill);
    }
    if (rows >= 1) {
      // grid[:, rows-1:rows] = crust  (a crust row at the cave-floor edge)
      t.write(x, rows - 1, crust);
    }
  }
  return rows;
}

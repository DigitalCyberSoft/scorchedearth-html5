/**
 * Byte-verified constants recovered from 1.5/SCORCH.EXE -- a faithful TypeScript
 * port of scorch-py/scorch/constants.py (the fidelity oracle, itself verified
 * against the DOS binary).
 *
 * Every value here was read from the binary's data segment (file base 0x55d80
 * for seg 5f38) or proven behaviorally, per scorch-re/catalogs/10,11,13. Where a
 * value is reconstructed (BLOCKED in RE), it is flagged RECONSTRUCTED with the
 * basis. Citations are FUN_<seg>_<off>.c:line or DAT_5f38_<off>.
 *
 * NUMERIC NOTE: this module has no transcendental math. Every export is an
 * integer, an exactly-representable float, or a boolean, so the differential
 * gate (test/constants.test.ts) asserts all of them with exact equality. The one
 * computed float, PHYSICS_DT = DT / PHYSICS_SUBSTEPS = (1/60)/32, equals 1/1920
 * bit-for-bit in IEEE754 (verified in the oracle), so it too is exact.
 */

// ---------------------------------------------------------------------------
// Struct strides (FACT)
// ---------------------------------------------------------------------------
export const PROJECTILE_STRIDE = 0x6c;     // 108 bytes; object array DAT_5f38_ceb8
export const TANK_STRIDE = 0xca;           // 202 bytes; ptr = index*0xca - 0x2a98
export const ITEM_STRIDE = 0x34;           // 52 bytes; weapon/equip table DAT_5f38_1200

// ---------------------------------------------------------------------------
// Physics force model (catalog 10 - RESOLVED)
// ---------------------------------------------------------------------------
// Per-step forward Euler (FUN_2a4a_0b1f): clamp -> move -> drag -> gravity -> wind.
// The CPU-speed normalizer `a` cancels out of the effective accelerations, so the
// continuous-time model below is machine-independent (catalog 10 section 4).
export const GRAVITY_DEFAULT = 0.2;        // DAT_5f38_512a (range .05-10)
export const GRAVITY_MIN = 0.05;           // dRam0005f73a floor (FUN_22a5_0005.c:260)
export const GRAVITY_SCALE = 50.0;         // DAT_5f38_1cf2 (gravity/dt scale)
export const WIND_SCALE_DIV = 40.0;        // DAT_5f38_1cf6 (wind divisor)
export const FIREDELAY_NORM = 100.0;       // DAT_5f38_1cc8 (the dt denominator's /100; NOT DAT_5f38_1c78)
// Effective accelerations (px / time-unit^2), dt cancelled:
export const EFF_GRAVITY_FACTOR = 2500.0;  // a_gravity = 2500 * GRAVITY  (= 50^2)
export const EFF_WIND_FACTOR = 1.25;       // a_wind    = 1.25 * WIND      (= 50/40)
export const SPEED_CLAMP = 1000.0;         // DAT_5f38_1d30 (rescale target)
export const SPEED_CLAMP_SQ = 1.0e6;       // DAT_5f38_1d2c (= 1000^2)
export const VISCOSITY_DIV = 10000.0;      // fRam0005f78c (visc_mult = 1 - VISCOSITY/10000)
export const BOUNCE_ENERGY = 0.8;          // DAT_5f38_1d24 (obj+0x32 seed)
// Wall-bounce restitution by live ELASTIC sub-mode (DAT_5f38_1d34/1d3c/1d44):
export const WALL_COEF: { [k: string]: number } = {
  RUBBER: -1.0,
  PADDED: -0.5,
  DEFAULT: -2.0,
};

export const MAX_WIND_DEFAULT = 200;       // DAT_5f38_515c

// ---------------------------------------------------------------------------
// Launch decomposition (FORM RESOLVED; absolute px/s scale is a port choice)
// ---------------------------------------------------------------------------
// FUN_2a4a_02f2.c:28,60-68 / caller FUN_38b5_1102.c:56-57:
//   rad = angle_deg * DAT_5f38_1d08 (deg->rad = pi/180); vy = power*sin(rad);
//   vx = power*cos(rad). The engine uses power RAW (POWER_SCALE_engine == 1.0).
// POWER_SCALE = 1.0: power's max (1000) is exactly the engine velocity clamp
// DAT_5f38_1d30 = SPEED_CLAMP = 1000, so power 1000 MUST launch at the clamp.
// The prior 0.80 under-powered every shot to 0.80^2 = 64% range.
export const POWER_SCALE = 1.0;            // launch speed (px/s) = power * POWER_SCALE (engine raw)

// ---------------------------------------------------------------------------
// Physics timestep -- the original's timing model (RESOLVED from bytes) and the
// port's fast-machine-limit realization of it.
// ---------------------------------------------------------------------------
// The v1.5 engine has NO fixed frame/step-rate target: dt is recomputed on every
// projectile birth/death (FUN_2a4a_01c4, callers=2) from a runtime BogoMIPS probe
// (FUN_2a4a_00c3) against the live in-flight count N, so absolute on-screen speed
// AND (forward Euler) the exact landing were machine-dependent. The continuous
// (dt->0) limit cancels N and MIPS (total dv = 50^2*g = 2500*g, L-independent);
// forward Euler leaves an O(dt) truncation that does not cancel. Every real
// original machine sat effectively at the fast (dt-converged) limit. The port
// realizes that limit with a FIXED fine PHYSICS_DT decoupled from the 60fps
// render: each frame advances PHYSICS_SUBSTEPS fine steps (N-independent by
// construction). PHYSICS_DT = 1/1920 (32 substeps) puts the port at the
// slow-real-machine L=40 point: within 0.39px of L->inf across the benign
// power/angle/gravity space (MEASURED). Full byte chain is in constants.py.
export const DT = 1.0 / 60.0;              // RENDER/frame period (s): wall-clock cadence
// the host loop, speech-bubble frame counter (talk.py: dt/DT), and continuous
// input (ui.py) run on. NOT the physics step -- see PHYSICS_DT. 1/60 is the
// host-frame port choice for display pacing; the original had no fixed rate.
export const PHYSICS_SUBSTEPS = 32;        // fine physics steps per rendered frame;
// puts the integration at the slow-real-machine L=40 point (within 0.39px of the
// L->inf fast limit across the benign space, MEASURED).
export const PHYSICS_DT = DT / PHYSICS_SUBSTEPS; // = 1/1920 s: fixed (N-independent)
// integration step realizing the fast-machine limit of the MIPS-adaptive original dt.

// ---------------------------------------------------------------------------
// Palette-cycle rate (catalog 16 / RECOVERED_INTERRUPT_ANIMATIONS.md)
// ---------------------------------------------------------------------------
// The DAC band uploads (FUN_4d9b_003b.c:35-42, FUN_4d9b_00db.c:11-15) are gated on
// the VGA vertical-retrace bit (IN 0x3da & 8), so a band advances at most once per
// CRT refresh. VGA mode 13h vertical refresh is the fixed IBM-VGA 70.086 Hz
// (25.175 MHz / (800*449)). The port advances cycling bands on a wall-clock
// accumulator at this rate (game._tick_palette), not 1 step/frame.
export const PALETTE_CYCLE_HZ = 70;        // VGA mode-13h vertical refresh (retrace-gated DAC upload ceiling)

// ---------------------------------------------------------------------------
// Damage / terrain (catalog 11 - RESOLVED unless noted)
// ---------------------------------------------------------------------------
export const FALLOFF_NUM = 100.0;          // DAT_5f38_52aa: damage% = (R - d)*100/R
export const FALL_DMG_PER_PIXEL = 2;       // DAT_5f38_5164: fall damage = 2*pixels
export const FALL_ON_ENEMY_VICTIM_BONUS = 50;  // victim takes accum + 50 (FUN_2975_048c.c:57)
export const FALL_ON_ENEMY_FALLER_BASE = 10;   // faller takes accum/2 + 10
export const PARACHUTE_THRESHOLD_DEFAULT = 5;  // tank+0x2c (FUN_3a16_0320.c:24)
export const TANK_FALL_SUPPORT_PIXELS = 3;     // falls when < 3 support pixels under footprint
export const DIRECT_HIT_MARKER_DAMAGE = 10;    // FUN_4d1e_0021.c marker-case 10 dmg

export const TANK_DEFAULT_HEALTH = 100;    // tank+0xa2 health accumulator

// ---------------------------------------------------------------------------
// Shield behaviour magnitudes -- RECOVERED byte-exact from the FP-patched image.
// MAG push (Mag/Super Mag, FUN_2a4a_28b4): per-step upward bump vy += 50.0/FireDelay
//   inside an overhead box (|round(px-tank_x)|<=15, 0<round(tank_y-py)<=(h-1)/4,
//   vx!=0). 50.0 = DAT_5f38_1cf2; FireDelay = DAT_5f38_5140 (cfg.FIRE_DELAY, dflt 100).
// FORCE-shield reflect (Force Shield, FUN_2a4a_2487): single mirror reflection on
//   contact with the ring; angle factor 2.0 = DAT_5f38_1d5c, then scale |v| by
//   0.7 = DAT_5f38_1d60. No fast-fall speed threshold exists on either path
//   (manual's "falls fast enough" is EMERGENT geometry, not a constant).
export const MAG_PUSH_VY_NUM = GRAVITY_SCALE;  // 50.0 (DAT_5f38_1cf2); per-step bump = this/FireDelay
export const MAG_PUSH_HALF_W = 15;         // |round(px - tank_x)| <= 15  (cmp di,0xfff1/0xf)
export const MAG_PUSH_HEIGHT_DIV = 4;      // 0 < round(tank_y - py) <= (screen_h-1)/4 (sar ax,2)
export const FORCE_REFLECT_ANGLE_K = 2.0;  // DAT_5f38_1d5c f32: mirror-reflection angle doubling
export const FORCE_REFLECT_RESTITUTION = 0.7;  // DAT_5f38_1d60 f64: post-reflect speed scale
// The reflect fires on contact with the drawn shield ring; render.py draws the
// Force ring at half_width+8, so the flight-loop reflect boundary uses the same.
export const FORCE_SHIELD_RING_PAD = 8;    // ring radius = tank.half_width + 8 (render.py:423)
// FACT (RECOVERED_SHIELDS.md T2): v1.5 has NO stochastic shield failure. Every
// writer of the shield-HP field is deterministic; no RNG call on any shields path.
// The prior (1,200) was fabricated; damage.shield_failure_check is now a no-op.
export const SHIELD_FAILURE_CHANCE: number | null = null;

// ---------------------------------------------------------------------------
// Palette index bands (catalog 11 section 2.2 / catalog 09). Dirt/explosion
// SEMANTICS are FACT; concrete RGB is BLOCKED/runtime-generated (RECONSTRUCTED in
// palette.py while preserving these index meanings).
// ---------------------------------------------------------------------------
export const COL_SKY = 0x00;               // background (index < 0x50 = empty/sky/gap)
export const COL_DIRT = 0x50;              // plain-mode single dirt color (80)
export const DIRT_SHADE_LO = 0x58;         // shaded-mode dirt band low (88)
export const DIRT_SHADE_HI = 0x68;         // shaded-mode dirt band high (104)
// dirt test: index == 0x50 OR 0x58 <= index <= 0x68
export const COL_TANK_BASE = 0x69;         // >= 0x69 = tank/object/non-dirt
export const EXPLOSION_LO = 0xc8;          // 200: explosion color band low
export const EXPLOSION_HI = 0xef;          // 239: band TOP (eefc(200,0x28)=40 entries 200..239,
                                           // FUN_4d1e_00ae); was 0xF0=240, one PAST the band.
export const EXPLOSION_RING_BASE = 0xdd;   // ring index = 0xDD - curR*20/maxR
export const COL_LASER = 0xe6;             // laser beam color
export const COL_TRACER = 0xe0;            // tracer/smoke

/** Dirt-band test used by every collision/carve/fill site (catalog 11 s.2.2). */
export function is_dirt(idx: number): boolean {
  return idx === COL_DIRT || (DIRT_SHADE_LO <= idx && idx <= DIRT_SHADE_HI);
}

/** Solid = dirt or any object pixel (>= 0x69); sky/gap is < 0x50. */
export function is_solid(idx: number): boolean {
  return idx === COL_DIRT || idx >= DIRT_SHADE_LO;
}

// ---------------------------------------------------------------------------
// Scoring amounts (catalog 13 section 2 - FACT)
// ---------------------------------------------------------------------------
export const SCORE_KILL_BASIC = 4000;      // enemy kill, BASIC
export const SCORE_KILL_STD = 500;         // enemy kill, STANDARD/GREEDY
export const SCORE_SELF_KILL = -1500;      // 0xfa24
export const SCORE_TEAMMATE_KILL = -2000;  // 0xf830
export const SCORE_SURVIVAL_BASIC_PER = 1000;  // BASIC survival pool = players*1000
export const SCORE_SURVIVAL_STD = 5000;    // STANDARD/GREEDY survival pool (flat)
export const SCORE_SHIELD_HIT_MULT = 2;    // enemy shield hit = 2*damage points

// ---------------------------------------------------------------------------
// Economy (catalog 08/13 - RESOLVED unless noted)
// ---------------------------------------------------------------------------
export const INVENTORY_CAP = 99;           // per-item hold cap (FUN_1dbc_0364.c:22)
export const FREE_MARKET_DEMAND_DECAY = 0.7;  // demand = 0.7*demand + 0.3*(buys/players)
export const FREE_MARKET_NEW = 0.3;
export const FREE_MARKET_PRICE_STEP = 0.05;   // price' = price*(1 + 0.05*(demand - ratio))
export const FREE_MARKET_ACC_RESET = 0.1;     // accumulators reset to 0.1
export const SELLBACK_MULT_NORMAL = 0.80;     // offer = round(live*qty*m/bundle)
export const SELLBACK_MULT_FREEMARKET = 0.65;
export const INTEREST_RATE_DEFAULT = 0.05;    // DAT_5f38_5190

// ---------------------------------------------------------------------------
// Enum orderings (catalog 13 section 0 - default-byte verified)
// ---------------------------------------------------------------------------
export const SCORING_BASIC = 0,
  SCORING_STANDARD = 1,
  SCORING_GREEDY = 2;
export const PLAYORDER_RANDOM = 0,
  PLAYORDER_LOSERS = 1,
  PLAYORDER_WINNERS = 2,
  PLAYORDER_ROBIN = 3;
export const TEAM_NONE = 0,
  TEAM_STANDARD = 1,
  TEAM_CORPORATE = 2,
  TEAM_VICIOUS = 3;
export const PLAYMODE_SEQUENTIAL = 0,
  PLAYMODE_SYNCHRONOUS = 1,
  PLAYMODE_SIMULTANEOUS = 2;

// AI class ids: class_id = menu_name_index + 1 (FUN_3014_10bd.c:67); human = 0
export const AI_HUMAN = 0;
export const AI_MORON = 1,
  AI_SHOOTER = 2,
  AI_POOLSHARK = 3,
  AI_TOSSER = 4;
export const AI_CHOOSER = 5,
  AI_SPOILER = 6,
  AI_CYBORG = 7,
  AI_UNKNOWN = 8;
export const AI_NAMES: { [k: number]: string } = {
  [AI_MORON]: "Moron",
  [AI_SHOOTER]: "Shooter",
  [AI_POOLSHARK]: "Poolshark",
  [AI_TOSSER]: "Tosser",
  [AI_CHOOSER]: "Chooser",
  [AI_SPOILER]: "Spoiler",
  [AI_CYBORG]: "Cyborg",
  [AI_UNKNOWN]: "Unknown",
};

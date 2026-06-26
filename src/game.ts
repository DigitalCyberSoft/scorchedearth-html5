/**
 * GameState: the round loop, turn loop, and fire/physics/settle pipeline.
 *
 * A faithful TypeScript port of scorch-py/scorch/game.py (the fidelity oracle,
 * itself byte-verified against 1.5/SCORCH.EXE).  This is the round/turn ENGINE:
 * the App in main.ts sequences a GameState through new_game -> SHOP/start_round ->
 * the turn/fire/settle pipeline -> _end_round -> proceed_after_round, and
 * render.ts / ingame.ts / screens.ts read this same object structurally.
 *
 * Mirrors FLOW.md sections 3-7 (provenance comments carried verbatim from game.py):
 *   round loop  FUN_33a1_05ee : terrain gen -> tank placement -> turn loop by
 *               PLAY_MODE -> survival award -> e342++ -> rankings + shop
 *   turn loop   FUN_33a1_06eb : advance firing order e4f6 (skip dead +0x18),
 *               human (caseD_1e) vs AI (FUN_21b5_0003) -> fire   (SEQUENTIAL)
 *   sync loop   FUN_4249_000f : every alive player picks power/angle/weapon, THEN
 *               all shots fire at once; the volley flies together; survivors
 *               re-aim each volley (catalog 04 s.6.1, 13 s.1.4)   (SYNCHRONOUS)
 *   sim loop    FUN_4855_000e : all players aim+fire in real time; a player may
 *               not re-fire until their own shell explodes, may re-aim mid-flight;
 *               control panel / mouse / i-t-r keys disabled; chutes auto-deploy
 *               unless an Auto-Defense System is owned                (SIMULTANEOUS)
 *   fire/impact FUN_2a4a_02f2 : "while in_motion > 0 step()" -> detonation ->
 *               per-weapon handler -> damage/terrain -> dirt settle / tank fall
 *   win test    FUN_33a1_0ff5 : NONE/VICIOUS last tank; teams last team
 *
 * RNG NOTE (the one structural subtlety): scorch.game uses TWO independent random
 * sources.  self.rng is the shared MT singleton (scorch.rng.rng / src/rng.ts's
 * `rng`); Python's MODULE-LEVEL `random` (a separate global random.Random) drives
 * `random.shuffle` at _place_tanks (game.py:365) and _build_firing_order's RANDOM
 * order (game.py:502).  main.py:476-479 seeds BOTH with the same boot seed:
 * `random.seed(seed); grng.seed(seed)`.  They are DISTINCT streams sharing a seed.
 * So createGameState seeds the shared `rng` and a private `Rng` (_pyrandom) with
 * the same value; _shuffle() reproduces CPython random.shuffle (Fisher-Yates with
 * j = _randbelow(i+1)) against _pyrandom, where _randbelow(i+1) == _pyrandom.pick(i+1).
 */
import * as C from "./constants";
import * as physics from "./physics";
import * as wb from "./weapon_behaviors";
import * as damage from "./damage";
import * as ai from "./ai";
import * as scoring from "./scoring";
import { Terrain, type MtnFile } from "./terrain";
import { Economy } from "./economy";
import { Tank, Projectile } from "./objects";
import * as weapons from "./weapons";
import {
  tank_color_index,
  LiveLUT,
  digger_glow_rgb,
} from "./palette";
import * as _pal from "./palette";
import { Rng, rng as global_rng } from "./rng";
import * as hazard from "./hazard";
import * as death from "./death";
import * as talk from "./talk";
import { sfx } from "./sound";
import { Config } from "./config";
import { tank_icon_mobile, TANK_ICON_CPU_ONLY } from "./screens";
import type { PaletteTable } from "./palette";

// palette.RGB is not exported; mirror it locally (the (256,3) table's row type).
type RGB = [number, number, number];

// phases
export const PLACE = "place";
export const TURN_START = "turn_start";
export const AIM = "aim";
export const FIRING = "firing";
export const SETTLE = "settle";
export const ROUND_END = "round_end";
export const SHOP = "shop";
export const GAME_OVER = "game_over";
// Synchronous (FUN_4249_000f): collect every alive player's locked aim, then fire
// the whole volley at once and fly it together; settle once; survivors re-aim.
export const SYNC_AIM = "sync_aim"; // collecting locked (angle,power,weapon) per player
export const SYNC_VOLLEY = "sync_volley"; // the volley is in flight (reuses _step_flight)
// Simultaneous (FUN_4855_000e): one real-time phase; every alive tank acts on its
// own clock, shells coexist, a tank re-fires only after its own shell explodes.
export const SIM_LIVE = "sim_live";

export const AI_TURN_DELAY = 0.6; // s, so AI turns are watchable
const SHOT_STEPS_PER_FRAME = C.PHYSICS_SUBSTEPS; // physics substeps per rendered frame:
//   _step_flight (integrate + collide + redraw, mirroring FUN_2a4a_0b1f's per-step
//   body) runs this many fine PHYSICS_DT steps per 60fps frame, decoupling
//   integration granularity from render pacing so the port realizes the original's
//   fast-machine limit (constants.PHYSICS_DT block) instead of the coarse 1-step/
//   frame dt=1/60 (L=1.2) it used before.

// Synchronous pacing: a brief watchable hold after the volley is locked before it
// launches, and a beat between AI lock-ins so the collection reads on screen.
export const SYNC_LOCK_DELAY = 0.25; // s, AI lock-in beat (RECONSTRUCTED pacing)
export const SYNC_VOLLEY_DELAY = 0.4; // s, hold after the full volley is locked (RECONSTRUCTED)

// Simultaneous AI cadence.  The per-tank "no re-fire until your own shell exploded"
// gate is the pinned rule (FUN_4855_000e / task spec).  SIM_AI_RECOCK_DELAY is the
// additional beat an AI waits, AFTER its shell has cleared, before re-aiming and
// firing again -- a runtime quantity tied to the unpinned MIPS-adaptive dt
// (catalog 10 s.4/s.7 BLOCKED #2), so it is RECONSTRUCTED here, not byte-derived.
export const SIM_AI_RECOCK_DELAY = 0.5; // s
export const SIM_AI_FIRST_DELAY_MAX = 0.6; // s, staggered first-shot delay ceiling per AI
export const SIM_AIM_RATE = 50.0; // deg/s, held-turret rotation for the local human (RECONSTRUCTED)
export const SIM_POWER_RATE = 250.0; // power/s, held power ramp for the local human (RECONSTRUCTED)
const CHUTE_DESCENT_PX_PER_FRAME = 2; // visual parachute-descent replay speed (slow drift)

// Triple-turret triple-shot (manual L347): the CPU-only triple-turret fires THREE
// Missiles / Baby Missiles at once, fanned a few degrees apart.
const TRIPLE_FAN_DEG = 5; // half-fan applied to the outer two barrels (RECONSTRUCTED)

// ---------------------------------------------------------------------------
// Small numeric helpers mirroring CPython builtins used on the path.
// ---------------------------------------------------------------------------

/** CPython round(x) (round half to even) -> int.  Same banker's rounding used in
 *  objects.ts / damage.ts; the deflect/mag-push gates use `round(...)`. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor + 0;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor + 0 : floor + 1;
}

/** Python int(x): truncate toward zero (used for the `int(...)` clamps). */
function pyInt(x: number): number {
  return Math.trunc(x);
}

/** Python floor-division a // b for non-negative b (the `(h-1)//div` band math). */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

type Speech = { text: string; tank: Tank; frame?: number } | null;

interface Hit {
  0: string;
  1: Tank | null;
  2: number;
  3: number;
}

/** Three-way sign (-1/0/+1), matching the binary's <0 / ==0 / >0 ladders
 *  in the FUN_2a4a_2487 deflect early-out (e.g. .c:27-37). */
function _sgn(v: number): number {
  return (v > 0 ? 1 : 0) - (v < 0 ? 1 : 0);
}

/** Integer line walk (the flight-path tracer FUN_271b_0733). */
export function _bresenham(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  let limit = dx - dy + 2;
  while (limit >= 0) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    limit -= 1;
  }
  return pts;
}

export class GameState {
  cfg: Config;
  w: number;
  h: number;
  rng: Rng;
  /** Python's module-level `random` (a SEPARATE global random.Random), seeded
   *  alongside the shared rng at boot; drives random.shuffle only (see header). */
  _pyrandom: Rng;
  terrain: Terrain;
  economy: Economy;
  tanks: Tank[];
  round_index: number; // DAT_5f38_e342
  current_shooter: Tank | null; // DAT_5f38_5182
  current_weapon: weapons.Item | null; // DAT_5f38_e344 analog (latched at detonation)
  projectiles: Projectile[];
  explosions: Array<{ [k: string]: unknown }>; // visual fireballs {x,y,maxr,frame,dirt}
  beams: Array<{ pts: Array<[number, number]>; frame: number }>; // laser beams {pts, frame}
  last_landing: [number, number] | null; // DAT_5f38_e346/e348 (Tosser)
  firing_order: number[]; // DAT_5f38_e4f6
  fire_index: number; // DAT_5f38_e4f4
  phase: string;
  timer: number;
  message: string;
  ranking: Tank[];
  winner: Tank | null;
  explosion_scale: number;
  mtn_ranges: unknown[];
  awaiting_human: boolean;
  active_bolts: unknown[]; // hostile-sky lightning (hazard)
  trace_marks: Array<[number, number, number]>;
  plasma_rings: Array<{ [k: string]: number }>;
  death_fountains: Array<{ [k: string]: number }>;
  throe_fx: Array<{ [k: string]: unknown }>;
  flashes: Array<{ [k: string]: unknown }>;
  shield_fades: { [playerIndex: number]: { dir: number; frame: number } };
  _prev_shield_hp: { [playerIndex: number]: number };
  speech: Speech;
  _speech_frame: number;
  live_sky: string;
  lut: LiveLUT;
  _lut_base: PaletteTable;
  _sky_step: number;
  _pal_accum: number;
  _digger_cycle: number;
  _digger_step: number;
  _explo_band_active: boolean;
  firewalls: Array<{ [k: string]: number }>;
  _firewall_counter: number;
  _firewall_band_active: boolean;
  sfx: typeof sfx;
  talk: talk.TalkConfig | null;
  _data_dir: string;

  // round/settle/sim scratch (created lazily in the Python via attribute set)
  _settle_done = false;
  _sync_locks: { [playerIndex: number]: [number, number, number] } = {};
  _sync_queue: number[] = [];
  _sim: { [playerIndex: number]: { timer: number; shots: number } } = {};
  _sim_human: Tank | null = null;
  _sim_keymap: { [label: string]: number } = {};

  // index signature so the structural GameState consumers (render/ingame/screens)
  // can read transient round flags (target_mode, move_mode, info_box, _hud_hitboxes,
  // _aim_hold, _info_box_rect ...) they create/clear on this same object.
  [extra: string]: unknown;

  constructor(cfg: Config, width: number, height: number) {
    this.cfg = cfg;
    this.w = width;
    this.h = height;
    this.rng = global_rng;
    this._pyrandom = new Rng();
    this.terrain = new Terrain(width, height);
    this.economy = new Economy(cfg);
    this.tanks = [];
    this.round_index = 0; // DAT_5f38_e342
    this.current_shooter = null; // DAT_5f38_5182
    this.current_weapon = null; // DAT_5f38_e344 analog: the weapon whose
    //   detonation is being resolved right now.  Latched in
    //   weapon_behaviors.detonate / _det_plasma / fire_laser at each
    //   detonation; read by damage.kill_tank so a kill's death blast uses the
    //   killing weapon's effective radius (FUN_3ef5_029a.c:96).
    this.projectiles = [];
    this.explosions = []; // visual fireballs {x,y,maxr,frame,dirt}
    this.beams = []; // laser beams {pts, frame}
    this.last_landing = null; // DAT_5f38_e346/e348 (Tosser)
    this.firing_order = []; // DAT_5f38_e4f6
    this.fire_index = 0; // DAT_5f38_e4f4
    this.phase = PLACE;
    this.timer = 0.0;
    this.message = "";
    this.ranking = [];
    this.winner = null;
    this.explosion_scale = this._scale_factor();
    // real scanned mountains live at the project root in Python; the browser/Node
    // port has no MTN file list here (terrain.generate tolerates an empty list).
    this.mtn_ranges = [];
    // human-input wiring (set by main): which tank is the local human
    this.awaiting_human = false;
    // --- integrated subsystems ---
    this._data_dir = ""; // talk*.cfg live here (Python loads from disk; port uses defaults)
    this.active_bolts = []; // hostile-sky lightning (hazard)
    // Persistent TRACE marks (FUN_2a4a_0763 persistent path): when TRACE is ON
    // the binary writes the trail into the framebuffer, so it survives the
    // projectile.  Empty when TRACE is OFF (no lasting mark).
    this.trace_marks = [];
    this.plasma_rings = []; // plasma grow->shrink rings (FUN_3f76_03bd)
    this.death_fountains = []; // rising tank-death debris (FUN_3ef5_029a:60-77)
    this.throe_fx = []; // death-throe animations (FUN_271b_0005 roulette, #21)
    this.flashes = []; // full-screen palette flashes (lightning)
    // 51-frame status-bar shield SWATCH fade (FUN_4191_0034 collapse / _0455
    // activate): {player_index: {"dir": +1 arm-in / -1 collapse-out, "frame"}}.
    this.shield_fades = {};
    this._prev_shield_hp = {}; // to detect a shield collapsing to 0
    this.speech = null; // active tank speech bubble (talk)
    this._speech_frame = 0;
    this.live_sky = (cfg.SKY || "PLAIN").toUpperCase(); // resolved per round (hazard)
    // MASTER ANIMATION PRIMITIVE: the live, mutable DAC palette LUT the binary
    // rotated/re-ramped from its IRQ0 timer ISR.  _tick_palette() advances the
    // cycling bands once per frame; render.Renderer composites THROUGH this same
    // instance (state.lut) so the rotation shows on screen.  See palette.LiveLUT.
    this.lut = new LiveLUT();
    // Seed the digger trail glow ramp (FUN_352c_00c9.c:21-27) into the 0xAF
    // band of BOTH the live LUT and the rotation base.
    const _dg = digger_glow_rgb();
    this.lut.set_band(_pal.DIGGER_BAND_LO, _pal.DIGGER_BAND_HI, _dg);
    this._lut_base = this.lut.copy_table(); // build_palette() snapshot
    {
      const n = _pal.DIGGER_BAND_HI - _pal.DIGGER_BAND_LO + 1;
      for (let k = 0; k < n; k++) {
        const r = _dg[k];
        this._lut_base[_pal.DIGGER_BAND_LO + k] = [r[0] & 0xff, r[1] & 0xff, r[2] & 0xff];
      }
    }
    this._sky_step = 0; // accumulated sky-band phase
    this._pal_accum = 0.0; // wall-clock accumulator -> 70 Hz band steps (C.PALETTE_CYCLE_HZ)
    this._digger_cycle = 0; // frames left of trail cycle
    this._digger_step = 0; // accumulated trail rotation
    this._explo_band_active = false; // red ramp currently loaded?
    this.firewalls = []; // active flame walls
    this._firewall_counter = 0; // DAT_5f38_00ec analog
    this._firewall_band_active = false; // firewall ramp loaded?
    this.sfx = sfx;
    sfx.enabled = cfg.is_on("SOUND");
    sfx.fly_mode = cfg.FLY_SOUND;
    sfx.field_height = height;
    this.talk = null; // talk pools, loaded in new_game
  }

  _scale_factor(): number {
    // EXPLOSION_SCALE resolution compensation (catalog 09): reconstructed for
    // the 640-wide port: NORMAL 1.0 / MEDIUM 1.5 / LARGE 2.0.
    return { 0: 1.0, 1: 1.5, 2: 2.0 }[this.cfg.explosion_scale as 0 | 1 | 2];
  }

  /** CPython random.shuffle(x) in place: Fisher-Yates with j = _randbelow(i+1),
   *  i from len-1 down to 1.  Uses _pyrandom (Python's module-level `random`).
   *  _pyrandom.pick(i+1) == _randbelow(i+1) for i+1 > 0. */
  _shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this._pyrandom.pick(i + 1);
      const tmp = x[i];
      x[i] = x[j];
      x[j] = tmp;
    }
  }

  // ------------------------------------------------------------------ setup
  add_player(name: string, ai_class = 0, team_id = 0, tank_icon = 0): Tank {
    const t = new Tank(this.tanks.length, name, ai_class, team_id, tank_icon);
    // icon mobility: a wheelless icon is a fixed emplacement (no fuel, immobile)
    // per SCORCH.DOC:L336-340.  screens.tank_icon_mobile is the authority.
    t.mobile = tank_icon_mobile(tank_icon);
    this.tanks.push(t);
    return t;
  }

  new_game(): void {
    // FUN_33a1_001d init: seed cash from INITIAL_CASH, reset round index.
    this.round_index = 0;
    const cash = this.cfg.INITIAL_CASH;
    for (const t of this.tanks) {
      t.cash = cash;
      t.cash_ceiling = cash;
      t.score = 0;
      t.win_counter = 0;
      t.hits_career = {};
      // FUN_3a16_0320.c:31-39 new-game tank init: zero the whole arsenal, then
      // force slot 0 (Baby Missile) to 99.  Weapons do NOT carry from a previous
      // match.  (Per-round _reset_round_tanks does not touch inventory, so bought
      // weapons DO carry across rounds.)
      for (let i = 0; i < weapons.NUM_ITEMS; i++) {
        t.inventory[i] = 0;
      }
      t.inventory[weapons.SLOT_BABY_MISSILE] = 99;
    }
    // `mayhem` cheat (FUN_3a16_0320.c:32-38): stocks 99 of every ENABLED item.
    // Config has no `mayhem` field; mirror Python's getattr(cfg, "mayhem", False).
    if ((this.cfg as { mayhem?: boolean }).mayhem) {
      for (const t of this.tanks) {
        for (let slot = 1; slot < weapons.NUM_ITEMS; slot++) {
          if (weapons.ITEMS[slot].enabled) {
            t.inventory[slot] = 99;
          }
        }
      }
    }
    this.economy.refresh_availability();
    if (this.talk === null) {
      // load attack/die taunt pools once (no on-disk talk*.cfg in the port: use
      // the built-in defaults talk.load_from_config falls back to)
      // Python loads talk*.cfg from 1.5/; the browser/Node port has no synchronous
      // filesystem, so supply an fs provider that reports "no files".  The pools
      // are then empty -- harmless because TALKING_TANKS gates BEFORE any rng draw
      // (talk._talks; default OFF), so neither side consumes taunt rng.
      this.talk = talk.load_from_config(
        this.cfg as unknown as talk.TalkSettingsSource,
        this._data_dir,
        {
          joinPath: (a: string, b: string) => (a ? `${a}/${b}` : b),
          pathExists: () => false,
          listDir: () => null,
          readFile: () => null,
        },
      );
    }
    if (cash > 0) {
      this.phase = SHOP; // pre-round shop; main calls begin_next_round() after
    } else {
      this.start_round();
    }
  }

  // -------------------------------------------------------------- round loop
  start_round(): void {
    // Round loop body head (FUN_33a1_05ee): terrain + placement + order.
    this.cfg.live_elastic = this._roll_elastic();
    this._setup_wind();
    this.terrain.generate(
      this.cfg as unknown as Parameters<Terrain["generate"]>[0],
      this.rng,
      this.mtn_ranges as Parameters<Terrain["generate"]>[2],
    );
    this.live_sky = hazard.resolve_round_sky(this.cfg, this.rng); // SKY=RANDOM -> concrete
    hazard.install_cavern_ceiling(this as unknown as hazard.State); // solid dirt ceiling if CAVERN
    sfx.field_height = this.h;
    this._place_tanks();
    this._reset_round_tanks();
    this._build_firing_order();
    this.projectiles.length = 0;
    this.explosions.length = 0;
    this.beams.length = 0;
    this.plasma_rings.length = 0;
    this.death_fountains.length = 0;
    this.throe_fx.length = 0;
    this.flashes.length = 0;
    this.trace_marks.length = 0;
    this.shield_fades = {};
    this._prev_shield_hp = {};
    this.last_landing = null;
    this.fire_index = 0;
    this.timer = 0.0;
    // PLAY_MODE dispatch (catalog 13 s.1.2): SEQUENTIAL keeps the firing-order
    // turn loop; SYNCHRONOUS / SIMULTANEOUS install their own entry phase.
    const pm = this.cfg.play_mode;
    if (pm === C.PLAYMODE_SYNCHRONOUS) {
      this._sync_begin_round();
    } else if (pm === C.PLAYMODE_SIMULTANEOUS) {
      this._sim_begin_round();
    } else {
      this.phase = TURN_START;
    }
  }

  _roll_elastic(): number {
    // Resolve cfg.ELASTIC to a concrete live wall sub-mode for round setup.
    // RANDOM (6) picks one sub-mode that holds for the whole round.  ERRATIC (7)
    // is re-rolled PER SHOT (FUN_2a4a_0b1f.c:197-198 via FUN_3bf9_048b).  This
    // round-start seed gives ERRATIC a valid first value; _reroll_erratic re-rolls.
    const e = this.cfg.elastic;
    if (e === 6) {
      // RANDOM: pick one per round
      return this.rng.pick(6);
    }
    if (e === 7) {
      // ERRATIC: seed; re-rolled per shot
      return this.rng.pick(6);
    }
    return e;
  }

  _reroll_erratic(): void {
    // Per-shot ERRATIC re-roll (FUN_2a4a_0b1f.c:197-198): when ELASTIC is ERRATIC
    // (cfg.elastic == 7) the binary re-picks the live wall sub-mode from
    // FUN_3bf9_048b at each detonation step.  No-op for every other ELASTIC.
    if (this.cfg.elastic === 7) {
      // ERRATIC (DAT_5f38_5156 == 7)
      this.cfg.live_elastic = this.rng.pick(6); // FUN_3bf9_048b()
    }
  }

  _setup_wind(): void {
    // FUN_323a_04de:52-60 per-round wind init.  Base spread then two nested
    // doublings, no clamp (the clamp lives only in the per-turn jitter):
    //   wind  = rand(MAX_WIND/2) - MAX_WIND/4         ; :52-53
    //   if rand(100) < 20:  wind *= 2                 ; :55-56  (20% chance)
    //       if rand(100) < 40:  wind *= 2             ; :58-59  (nested 40%)
    const mw = this.cfg.MAX_WIND;
    if (mw <= 0) {
      this.cfg.wind = 0;
      return;
    }
    let w = this.rng.pick(Math.max(1, floorDiv(mw, 2))) - floorDiv(mw, 4);
    if (this.rng.chance(20, 100)) {
      // :55-56  20% double
      w *= 2;
      if (this.rng.chance(40, 100)) {
        // :58-59  nested 40% double
        w *= 2;
      }
    }
    this.cfg.wind = w;
  }

  _perturb_wind(): void {
    // CHANGING_WIND per-turn jitter (FUN_323a_00f9, gated by DAT_5f38_50fa):
    //   wind += rand(11) - 5                          ; :10-11
    //   clamp wind to [-MAX_WIND, +MAX_WIND]          ; :13-20
    const mw = this.cfg.MAX_WIND;
    if (mw <= 0) {
      this.cfg.wind = 0;
      return;
    }
    this.cfg.wind = Math.max(-mw, Math.min(mw, this.cfg.wind + this.rng.pick(11) - 5));
  }

  _place_tanks(): void {
    // Drop tanks onto the terrain, min 15px spacing (FUN_33a1_0a43).
    const n = this.tanks.length;
    const margin = 30;
    const usable = this.w - 2 * margin;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const base = margin + pyInt((usable * (i + 0.5)) / n);
      const jitter = this.rng.pick(20) - 10;
      xs.push(Math.max(margin, Math.min(this.w - margin, base + jitter)));
    }
    // enforce >= 15px spacing (FUN_4a4c_0ee9)
    xs.sort((a, b) => a - b);
    for (let i = 1; i < n; i++) {
      if (xs[i] - xs[i - 1] < 15) {
        xs[i] = Math.min(this.w - margin, xs[i - 1] + 15);
      }
    }
    this._shuffle(xs); // Python's module-level random.shuffle (NOT self.rng)
    for (let i = 0; i < this.tanks.length; i++) {
      const t = this.tanks[i];
      const x = xs[i];
      t.x = x;
      t.y = this.terrain.drop_to_footprint(x, t.half_width); // FUN_4a4c_0fbf full-footprint drop
      // carve the flat seat under the tank (FUN_33a1_08e7 conform) so the body
      // sits level on a slope.  Tanks are >= 15px apart and the footprint is 15px.
      this.terrain.level_under_tank(x, t.y, t.half_width);
      t.color = tank_color_index(t.player_index);
    }
  }

  _reset_round_tanks(): void {
    for (const t of this.tanks) {
      t.alive = true;
      t.health = C.TANK_DEFAULT_HEALTH;
      t.shield_hp = 0;
      t.shield_item = 0;
      t.chute_up = 0;
      (t as { chute_descent?: unknown }).chute_descent = null; // clear leftover parachute replay (#33)
      t.fall_accum = 0;
      t.hits_this_round = {};
      t.ai_tries = 0;
      t.angle = t.x < this.w / 2 ? 45 : 135;
      t.power = 500;
      t.selected_guidance = null;
      t.selected_weapon = 0; // FUN_3a16_0320.c:29 round init resets to slot 0
      // auto-activate the best owned shield (defenses are pre-armed)
      this._arm_defenses(t);
    }
  }

  _announce_defense(tank: Tank, slot: number): void {
    // Surface the "<tankname> activating <DefenseName>" notice (DS 0x61fe).
    // FACT (FUN_4191_0455.c:31): format `"%s activating %s"`; shown via the
    // on-screen speech system in the port (no status-line channel).
    const name = weapons.ITEMS[slot].name;
    talk.set_speech(
      this as unknown as talk.SpeechState,
      tank as unknown as talk.TankLike,
      `${tank.name} activating ${name}`,
      this.talk as unknown as talk.TalkConfig,
    );
  }

  _arm_defenses(t: Tank): void {
    // Auto-Defense gate (catalog 02 s.C, DOC L2248): in SIMULTANEOUS a tank may
    // use shields ONLY if it owns an Automatic Defense System.  SEQUENTIAL /
    // SYNCHRONOUS pre-arm the best owned shield unconditionally.
    if (
      this.cfg.play_mode === C.PLAYMODE_SIMULTANEOUS &&
      t.inventory[weapons.SLOT_AUTO_DEFENSE] <= 0
    ) {
      t.shield_hp = 0;
      t.shield_item = 0;
      return;
    }
    if (
      this.cfg.play_mode === C.PLAYMODE_SIMULTANEOUS &&
      t.inventory[weapons.SLOT_AUTO_DEFENSE] > 0
    ) {
      // The Auto-Defense System gated this tank's shield in SIMULTANEOUS.
      const slot = this._arm_best_shield(t, false);
      if (slot !== null) {
        this._announce_defense(t, weapons.SLOT_AUTO_DEFENSE);
        this._announce_defense(t, slot);
      }
      return;
    }
    this._arm_best_shield(t, false);
  }

  _arm_best_shield(t: Tank, announce = true): number | null {
    // Arm the highest-tier owned shield IF none is up, consuming one from inventory
    // (FUN_21b5_0003.c:91-115).  Returns the armed slot, or null.
    if (t.shield_hp > 0) {
      // FUN_21b5_0003.c:91 -- shield already up
      return null;
    }
    for (let i = weapons.SHIELD_SLOTS.length - 1; i >= 0; i--) {
      const slot = weapons.SHIELD_SLOTS[i];
      if (t.inventory[slot] > 0) {
        const p = weapons.ITEMS[slot].params as { [k: string]: unknown };
        t.shield_hp = (p.hp as number | undefined) ?? 100;
        t.shield_item = slot;
        t.shield_push = (p.push as boolean | undefined) ?? false;
        t.shield_deflect = (p.deflect as boolean | undefined) ?? false;
        t.shield_laserproof = (p.laserproof as boolean | undefined) ?? false;
        t.shield_failproof = (p.failproof as boolean | undefined) ?? false;
        t.inventory[slot] -= 1;
        // 51-frame swatch fade-IN on activate (FUN_4191_0455.c:50-64).
        this._start_shield_fade(t, +1);
        // Shield-deploy rising sweep (FUN_4191_0455.c:58-62): gated on the arm.
        sfx.play("shield_deploy", this.cfg.is_on("SOUND"));
        if (announce) {
          this._announce_defense(t, slot);
        }
        return slot;
      }
    }
    return null;
  }

  // 51-frame shield SWATCH fade (FUN_4191_0034.c:37 collapse / FUN_4191_0455.c:50
  // activate both loop `for ... < 0x33` = 51 frames).  Status-bar swatch only.
  static SHIELD_FADE_FRAMES = 51; // 0x33

  _start_shield_fade(tank: Tank, direction: number): void {
    // direction +1 = fade-in (shield armed), -1 = fade-out (shield collapsed).
    this.shield_fades[tank.player_index] = { dir: direction, frame: 0 };
  }

  _tick_shield_fades(): void {
    // Advance shield swatch fades and detect collapses to 0.
    for (const t of this.tanks) {
      const prev = this._prev_shield_hp[t.player_index] ?? 0;
      if (prev > 0 && t.shield_hp <= 0) {
        // collapsed this frame
        this._start_shield_fade(t, -1);
      }
      this._prev_shield_hp[t.player_index] = t.shield_hp;
    }
    for (const k of Object.keys(this.shield_fades)) {
      this.shield_fades[Number(k)].frame += 1;
    }
    const kept: { [playerIndex: number]: { dir: number; frame: number } } = {};
    for (const k of Object.keys(this.shield_fades)) {
      const f = this.shield_fades[Number(k)];
      if (f.frame <= GameState.SHIELD_FADE_FRAMES) {
        kept[Number(k)] = f;
      }
    }
    this.shield_fades = kept;
  }

  _build_firing_order(): void {
    // PLAY_ORDER (BLOCKED build; documented semantics, catalog 03).
    let order: number[] = [];
    for (let i = 0; i < this.tanks.length; i++) order.push(i);
    const po = this.cfg.play_order;
    if (po === C.PLAYORDER_RANDOM) {
      this._shuffle(order); // Python's module-level random.shuffle
    } else if (po === C.PLAYORDER_LOSERS) {
      // stable sort by score ascending (Python's sort is stable)
      order = this._stableSort(order, (i) => this.tanks[i].score);
    } else if (po === C.PLAYORDER_WINNERS) {
      // sort by score descending; Python sort(reverse=True) keeps the original
      // relative order of equal keys (stable on the reversed comparison).
      order = this._stableSortReverse(order, (i) => this.tanks[i].score);
    } else if (po === C.PLAYORDER_ROBIN) {
      const shift = this.round_index % order.length;
      order = order.slice(shift).concat(order.slice(0, shift));
    }
    this.firing_order = order;
  }

  /** Python list.sort(key=...) -- stable ascending by numeric key. */
  _stableSort(arr: number[], key: (i: number) => number): number[] {
    return arr
      .map((v, idx) => ({ v, idx, k: key(v) }))
      .sort((a, b) => (a.k - b.k) || (a.idx - b.idx))
      .map((e) => e.v);
  }

  /** Python list.sort(key=..., reverse=True) -- reverse a stable ascending sort:
   *  ties keep their ORIGINAL order (CPython reverses input, stable-sorts, reverses
   *  output), equivalent to sorting by (-key) stably. */
  _stableSortReverse(arr: number[], key: (i: number) => number): number[] {
    return arr
      .map((v, idx) => ({ v, idx, k: key(v) }))
      .sort((a, b) => (b.k - a.k) || (a.idx - b.idx))
      .map((e) => e.v);
  }

  // --------------------------------------------------------------- turn loop
  _alive_count(): number {
    let n = 0;
    for (const t of this.tanks) if (t.alive) n += 1;
    return n;
  }

  _win_check(): boolean {
    // FUN_33a1_0ff5.
    const tm = this.cfg.team_mode;
    if (tm === C.TEAM_NONE || tm === C.TEAM_VICIOUS) {
      return this._alive_count() < 2;
    }
    const teams = new Set<number>();
    for (const t of this.tanks) if (t.alive) teams.add(t.team_id);
    return teams.size <= 1;
  }

  _next_shooter(): Tank | null {
    // Advance fire_index over firing_order, skipping dead (+0x18).
    const n = this.firing_order.length;
    for (let k = 0; k < n; k++) {
      const t = this.tanks[this.firing_order[this.fire_index]];
      this.fire_index = (this.fire_index + 1) % n;
      if (t.alive) {
        return t;
      }
    }
    return null;
  }

  _resolve_unknown_class(tank: Tank): void {
    // Per-turn Unknown(class 8) class re-roll (FUN_3014_10bd.c:70-75).
    // When [0x11]==8 (Unknown) and [0x12]!=-2, set [0x12]=-2 then re-pick class
    // as FUN_3bf9_048b(7)+1 (uniform 1..7).  Done ONCE per match (the -2 latch).
    if (tank.ai_class === C.AI_UNKNOWN && tank.reveal_type !== -2) {
      tank.reveal_type = -2; // [0x12] = -2 (type hidden)
      tank.ai_class = this.rng.pick(7) + 1; // FUN_3bf9_048b(7)+1 => 1..7
    }
  }

  _begin_turn(): void {
    if (this._win_check()) {
      this._end_round();
      return;
    }
    const shooter = this._next_shooter();
    if (shooter === null) {
      this._end_round();
      return;
    }
    this.current_shooter = shooter;
    sfx.play("turn", this.cfg.is_on("SOUND")); // next-player tone (FUN_38b5_13c0)
    this._resolve_unknown_class(shooter); // FUN_3014_10bd Unknown class re-roll
    if (this.cfg.is_on("CHANGING_WIND")) {
      // FUN_323a_00f9 jitter, once per turn
      this._perturb_wind();
    }
    // FUN_21b5_0003.c:91-115 re-arms the best owned shield at turn start when none
    // is up, with the "%s activating %s" notice.
    this._arm_best_shield(shooter, true);
    hazard.maybe_strike(this as unknown as hazard.State); // hostile-sky lightning at turn start
    if (shooter.ai_class === C.AI_HUMAN) {
      this.awaiting_human = true;
      this.phase = AIM;
    } else {
      this.awaiting_human = false;
      const [ang, pw, slot] = ai.take_turn(this as unknown as ai.AIState, shooter);
      shooter.angle = pyInt(Math.max(0, Math.min(180, ang)));
      shooter.power = pyInt(Math.max(0, Math.min(1000, pw)));
      shooter.selected_weapon = slot;
      this.phase = TURN_START;
      this.timer = AI_TURN_DELAY; // brief pause, then fire
    }
  }

  // ----------------------------------------------------------------- retreat
  retreat(tank: Tank | null = null): boolean {
    // The 'r' Retreat action (SCORCH.DOC:L520-528): flee + forfeit the round for
    // this tank, deny the enemy the kill bonus, no points, no plain-retreat cash
    // penalty.  Removal uses the same death path as any kill.
    const t = tank !== null ? tank : this.current_shooter;
    if (t === null || !t.alive) {
      return false;
    }
    // deny the enemy the kill: no attacker is current when the tank is removed
    this.current_shooter = null;
    damage.kill_tank(this as unknown as damage.State, t as unknown as damage.Tank); // alive=False + death/explosion; 0 pts
    // advance the round (SEQUENTIAL only; the live loops advance on their own clock)
    if (this.cfg.play_mode === C.PLAYMODE_SEQUENTIAL) {
      if (this._win_check()) {
        this._end_round();
      } else {
        this.awaiting_human = false;
        this.phase = SETTLE;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------- fire
  fire(shooter: Tank | null = null): Projectile[] {
    // Launch `shooter`'s selected weapon (FUN_2a4a_02f2 entry).  Defaults to
    // current_shooter so every SEQUENTIAL caller is unchanged; SYNC/SIM pass a tank.
    const t = shooter !== null ? shooter : this.current_shooter;
    if (t === null) {
      return [];
    }
    // Mode-aware human entry: external callers reach fire() with no shooter on a
    // human fire action.  SYNCHRONOUS records the lock; SIMULTANEOUS respects the
    // per-tank re-fire gate.  The volley launcher / sim AI cadence pass shooter=t
    // and set the phase first, so they skip this re-entry guard.
    if (shooter === null) {
      if (this.phase === AIM && this.cfg.play_mode === C.PLAYMODE_SYNCHRONOUS) {
        this._sync_human_fire(t);
        return [];
      }
      if (this.phase === SIM_LIVE && this.cfg.play_mode === C.PLAYMODE_SIMULTANEOUS) {
        this._sim_human_fire(t);
        return [];
      }
    }
    // ERRATIC re-rolls the live wall sub-mode PER SHOT (FUN_2a4a_0b1f.c:197-198).
    this._reroll_erratic();
    // Stash the launch height for the POS flight-tone pitch (pivot_y = t.y - 4).
    sfx.set_launch_y(t.y - 4);
    let slot = t.selected_weapon;
    let weapon = weapons.ITEMS[slot];
    if (!t.has_ammo(slot)) {
      slot = weapons.SLOT_BABY_MISSILE;
      weapon = weapons.ITEMS[slot];
    }
    t.consume(slot);
    // Auto-switch off a depleted weapon (FUN_38b5_145b.c:16-20): fall the selection
    // back to Baby Missile (slot 0), not the next owned weapon.
    if (
      t.selected_weapon !== weapons.SLOT_BABY_MISSILE &&
      !t.has_ammo(t.selected_weapon)
    ) {
      t.selected_weapon = weapons.SLOT_BABY_MISSILE;
    }
    this.awaiting_human = false;
    const _line = talk.maybe_attack_taunt(
      t as unknown as talk.TankLike,
      this.talk as unknown as talk.TalkConfig,
      this.rng,
    ); // taunt before firing
    if (_line !== null) {
      talk.set_speech(
        this as unknown as talk.SpeechState,
        t as unknown as talk.TankLike,
        _line,
        this.talk as unknown as talk.TalkConfig,
      );
    }
    sfx.play("fire", this.cfg.is_on("SOUND"));

    const beh = weapon.behavior;
    if (beh === "laser") {
      const proj = physics.launch(
        t,
        this.cfg as unknown as physics.PhysicsCfg,
        weapon,
      );
      // d506 = field*10 (FUN_3319_0516:14).  `field` is LAUNCH POWER.  The Laser
      // does NOT consume batteries.  The 0x28/px beam bleed gives range ~ energy/40.
      proj.state["energy"] = Math.max(200, t.power) * 10;
      wb.fire_laser(this as unknown as wb.BState, proj as unknown as wb.BProjectile);
      this._enter_firing();
      return [proj];
    }
    if (beh === "plasma") {
      // Plasma is synchronous charge-and-fire (FUN_3770_0009), consuming its OWN
      // ammo, NOT batteries.  Radius is unrecoverable; _det_plasma keeps the
      // eff_radius placeholder.
      const proj = physics.launch(
        t,
        this.cfg as unknown as physics.PhysicsCfg,
        weapon,
      );
      // Python's fire() calls wb._det_plasma directly; that helper is module-
      // private in weapon_behaviors.ts.  The exported wb.detonate dispatches a
      // plasma-behavior projectile through the SAME _DETONATORS["plasma"] =
      // _det_plasma path with identical observable state (current_weapon latch,
      // damage.explode(carve=false), carve_circle, add_plasma_ring) -- the only
      // difference is which sfx event fires, and sfx is a no-op in the test.
      wb.detonate(
        this as unknown as wb.BState,
        proj as unknown as wb.BProjectile,
        t.x,
        t.y - 4,
      );
      this._enter_firing();
      return [proj];
    }

    // Triple-turret triple-shot (manual L347): the CPU-only triple-turret tank
    // fires THREE Missiles / Baby Missiles at once, fanned a few degrees apart.
    const angles = this._triple_fan_angles(t, slot);
    const spawned: Projectile[] = [];
    for (const ang of angles) {
      const proj = physics.launch(
        t,
        this.cfg as unknown as physics.PhysicsCfg,
        weapon,
        null,
        ang,
      );
      if (t.contact_trigger) {
        // detonate on first contact, disabling tunnelling for this shot
        proj.contact = true;
      }
      this.projectiles.push(proj);
      spawned.push(proj);
    }
    // contact trigger is a one-shot: consume it once for the whole salvo
    if (t.contact_trigger) {
      t.contact_trigger = false;
    }
    if (spawned.length > 0) {
      sfx.start_fly(this.cfg.FLY_SOUND, this.cfg.is_on("SOUND"));
    }
    this._enter_firing();
    return spawned;
  }

  _triple_fan_angles(t: Tank, slot: number): number[] {
    // Three fanned angles for the CPU-only triple-turret firing a Missile / Baby
    // Missile (manual L347), else the single current angle.
    if (
      t.tank_icon === TANK_ICON_CPU_ONLY &&
      (slot === weapons.SLOT_MISSILE || slot === weapons.SLOT_BABY_MISSILE)
    ) {
      return [t.angle - TRIPLE_FAN_DEG, t.angle, t.angle + TRIPLE_FAN_DEG];
    }
    return [t.angle];
  }

  _enter_firing(): void {
    // Sequential fire() transitions into FIRING here.  In SYNC/SIM fire() is
    // called with the phase already set (SYNC_VOLLEY / SIM_LIVE) -> no clobber.
    if (this.phase === AIM || this.phase === TURN_START) {
      this.phase = FIRING;
    }
  }

  _discharge_batteries(t: Tank, count: number | null = null): void {
    if (count === null) {
      count = t.batteries;
    }
    let used = 0;
    for (let i = 0; i < count; i++) {
      if (t.inventory[weapons.SLOT_BATTERY] > 0) {
        t.inventory[weapons.SLOT_BATTERY] -= 1;
        sfx.play("battery", this.cfg.is_on("SOUND"));
        used += 1;
      }
    }
    if (used > 0) {
      // "%s activating Battery"
      this._announce_defense(t, weapons.SLOT_BATTERY);
    }
  }

  _battery_auto_trigger(t: Tank): number {
    // SIMULTANEOUS auto-recharge (catalog 02 s.D, DOC L2254): while intact and
    // health < 91, trigger batteries (+10 each, capped at full) to get above 90.
    let used = 0;
    while (t.alive && t.health < 91 && t.inventory[weapons.SLOT_BATTERY] > 0) {
      t.inventory[weapons.SLOT_BATTERY] -= 1;
      t.health = Math.min(C.TANK_DEFAULT_HEALTH, t.health + 10);
      used += 1;
    }
    if (used > 0) {
      // "%s activating Battery"
      this._announce_defense(t, weapons.SLOT_BATTERY);
    }
    return used;
  }

  // ------------------------------------------------------------- main update
  update(dt: number): void {
    talk.tick(this as unknown as talk.SpeechState, dt); // expire on-screen speech bubbles
    this._tick_palette(dt); // rotate/re-ramp the cycling DAC bands (70 Hz wall-clock)
    this._tick_sky(); // bolts + flashes age every frame
    if (this.phase === TURN_START) {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (
          this.current_shooter &&
          this.current_shooter.ai_class !== C.AI_HUMAN &&
          this.projectiles.length === 0
        ) {
          this.fire();
        } else {
          this._begin_turn();
        }
      }
    } else if (this.phase === AIM) {
      // waiting on human input
    } else if (this.phase === FIRING) {
      for (let i = 0; i < SHOT_STEPS_PER_FRAME; i++) {
        this._step_flight();
      }
      this._animate_effects();
      if (
        this.projectiles.length === 0 &&
        this.explosions.length === 0 &&
        this.beams.length === 0 &&
        this.plasma_rings.length === 0 &&
        this.death_fountains.length === 0 &&
        this.throe_fx.length === 0
      ) {
        sfx.stop_fly();
        this.phase = SETTLE;
        this._settle_done = false;
      }
    } else if (this.phase === SETTLE) {
      if (!this._settle_done) {
        this._do_settle();
        this._settle_done = true;
      }
      this._step_chute_anims(dt); // animate parachute descents (#33)
      if (this.tanks.some((t) => (t as { chute_descent?: unknown }).chute_descent)) {
        return; // hold SETTLE while a canopy descends
      }
      this._settle_done = false;
      if (this._win_check()) {
        // A round-ending kill sets a die-taunt bubble.  Linger until talk.tick
        // expires it before switching to rankings.
        if (this.speech === null) {
          this._end_round();
        }
      } else {
        this._begin_turn();
      }
    } else if (this.phase === SYNC_AIM) {
      this._sync_collect(dt);
    } else if (this.phase === SYNC_VOLLEY) {
      this._sync_volley(dt);
    } else if (this.phase === SIM_LIVE) {
      this._sim_update(dt);
    }
  }

  // ====================================================================
  // SYNCHRONOUS turn loop (FUN_4249_000f; catalog 04 s.6.1, 13 s.1.4)
  // ====================================================================
  _sync_begin_round(): void {
    this._sync_locks = {}; // player_index -> (angle, power, slot)
    this._sync_queue = this.firing_order.filter((i) => this.tanks[i].alive);
    this.current_shooter = null;
    this.awaiting_human = false;
    this.phase = SYNC_AIM;
    this.timer = 0.0;
    this._sync_advance();
  }

  _sync_start_volley(): void {
    // Re-aim phase head for the next volley: rebuild the alive queue and collect
    // a fresh lock from every survivor.
    if (this.cfg.is_on("CHANGING_WIND")) {
      // jitter once per re-aim cycle (FUN_323a_00f9)
      this._perturb_wind();
    }
    this._sync_locks = {};
    this._sync_queue = this.firing_order.filter((i) => this.tanks[i].alive);
    this.current_shooter = null;
    this.awaiting_human = false;
    this.phase = SYNC_AIM;
    this.timer = 0.0;
    this._sync_advance();
  }

  _sync_advance(): void {
    // Pop the next un-locked alive tank.  AI locks instantly (after a beat); a
    // human gets the AIM phase and we wait for its fire()/lock.
    if (this._win_check()) {
      this._end_round();
      return;
    }
    // drop dead/duplicate entries
    while (
      this._sync_queue.length > 0 &&
      (!this.tanks[this._sync_queue[0]].alive ||
        this._sync_queue[0] in this._sync_locks)
    ) {
      this._sync_queue.shift();
    }
    if (this._sync_queue.length === 0) {
      this._sync_launch_volley();
      return;
    }
    const idx = this._sync_queue[0];
    const shooter = this.tanks[idx];
    this.current_shooter = shooter;
    if (shooter.ai_class === C.AI_HUMAN) {
      // reuse the Sequential human aim UI: fire() records the lock (below).
      this.awaiting_human = true;
      this.phase = AIM;
    } else {
      this.awaiting_human = false;
      const [ang, pw, slot] = ai.take_turn(this as unknown as ai.AIState, shooter);
      this._sync_record_lock(shooter, ang, pw, slot);
      this.phase = SYNC_AIM;
      this.timer = SYNC_LOCK_DELAY; // watchable beat, then next tank
    }
  }

  _sync_record_lock(shooter: Tank, ang: number, pw: number, slot: number): void {
    shooter.angle = pyInt(Math.max(0, Math.min(180, ang)));
    shooter.power = pyInt(Math.max(0, Math.min(1000, pw)));
    shooter.selected_weapon = slot;
    this._sync_locks[shooter.player_index] = [shooter.angle, shooter.power, slot];
    if (this._sync_queue.length > 0 && this._sync_queue[0] === shooter.player_index) {
      this._sync_queue.shift();
    }
  }

  _sync_human_fire(shooter: Tank): boolean {
    // A human pressing fire in SYNCHRONOUS locks this human's aim and advances.
    this._sync_record_lock(
      shooter,
      shooter.angle,
      shooter.power,
      shooter.selected_weapon,
    );
    this.awaiting_human = false;
    this.current_shooter = null;
    this.phase = SYNC_AIM;
    this.timer = SYNC_LOCK_DELAY;
    return true;
  }

  _sync_collect(dt: number): void {
    // SYNC_AIM frame step: AI beats tick down here; a human turn parks on AIM.
    if (
      this.current_shooter !== null &&
      this.current_shooter.ai_class === C.AI_HUMAN
    ) {
      return; // waiting on the human's lock
    }
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer > 0) {
        return;
      }
    }
    this._sync_advance();
  }

  _sync_launch_volley(): void {
    // Fire every locked alive tank at once, then fly the volley together.
    this.current_shooter = null;
    this.awaiting_human = false;
    // fire in firing order; fire() appends to projectiles for each, and
    // _enter_firing() is a no-op here (phase is not a Sequential firing-entry phase).
    this.phase = SYNC_VOLLEY;
    for (const i of this.firing_order) {
      const t = this.tanks[i];
      if (t.alive && t.player_index in this._sync_locks) {
        this.current_shooter = t; // so launch/laser draw against it
        this.fire(t);
      }
    }
    this.current_shooter = null;
    this.timer = SYNC_VOLLEY_DELAY;
  }

  _sync_volley(dt: number): void {
    // SYNC_VOLLEY frame step: advance the whole volley, settle once, re-aim.
    for (let i = 0; i < SHOT_STEPS_PER_FRAME; i++) {
      this._step_flight();
    }
    this._animate_effects();
    if (
      this.projectiles.length > 0 ||
      this.explosions.length > 0 ||
      this.beams.length > 0 ||
      this.plasma_rings.length > 0 ||
      this.death_fountains.length > 0 ||
      this.throe_fx.length > 0
    ) {
      return;
    }
    // let the post-volley beat play out so the last detonation is visible
    if (this.timer > 0) {
      this.timer -= dt;
      return;
    }
    this._do_settle();
    if (this._win_check()) {
      this._end_round();
    } else {
      this._sync_start_volley();
    }
  }

  // ====================================================================
  // SIMULTANEOUS turn loop (FUN_4855_000e)
  // ====================================================================
  _sim_begin_round(): void {
    this.current_shooter = null;
    this.awaiting_human = false;
    this._sim = {};
    for (const t of this.tanks) {
      if (!t.alive) {
        continue;
      }
      // auto-deploy parachutes unless an Auto-Defense System is owned (task spec)
      if (t.inventory[weapons.SLOT_AUTO_DEFENSE] > 0) {
        t.parachute_deployed = false;
      } else {
        t.parachute_deployed = true;
      }
      // stagger first shots so AI don't all fire on frame 0
      const first =
        this.rng.pick(Math.max(1, pyInt(SIM_AI_FIRST_DELAY_MAX * 1000))) / 1000.0;
      this._sim[t.player_index] = { timer: first, shots: 0 };
    }
    // the local human (if any) drives sim_keys; default keymap when empty.
    this._sim_human =
      this.tanks.find((t) => t.alive && t.ai_class === C.AI_HUMAN) ?? null;
    this._sim_keymap = this._sim_build_keymap(this._sim_human);
    this.phase = SIM_LIVE;
    this.timer = 0.0;
  }

  _sim_build_keymap(_human: Tank | null): { [label: string]: number } {
    // Map the 6 Simultaneous controls to key codes.  The browser/Node port has no
    // pygame.key.key_code; without a captured keymap the human is a spectator (the
    // SIM AI/physics path is unaffected).  Returns an empty map (the held/keydown
    // handlers are no-ops on an empty map), matching the Python headless branch
    // (pygame is None -> {}).
    return {};
  }

  _sim_in_flight(tank: Tank): boolean {
    // True while any of this tank's own shells is still in flight.
    return this.projectiles.some((p) => p.owner === tank);
  }

  _sim_update(dt: number): void {
    // SIMULTANEOUS frame: step every in-flight shell, animate, settle landed
    // shells, then let each tank act on its own clock.
    for (let i = 0; i < SHOT_STEPS_PER_FRAME; i++) {
      this._step_flight();
    }
    this._animate_effects();
    // Settle only when no shell is mid-flight so tanks are not yanked mid-salvo.
    if (this.projectiles.length === 0) {
      this._do_settle();
    }
    // SIMULTANEOUS battery auto-trigger (catalog 02 s.D, DOC L2254).
    for (const t of this.tanks) {
      this._battery_auto_trigger(t);
    }
    if (this._win_check()) {
      this._end_round();
      return;
    }
    // AI cadence: re-aim + fire when the previous shell has cleared and the recock
    // beat has elapsed.  Humans fire via _sim_human_fire (key-driven).
    for (const t of this.tanks) {
      if (!t.alive || t.ai_class === C.AI_HUMAN) {
        continue;
      }
      const rec = this._sim[t.player_index];
      if (rec === undefined) {
        continue;
      }
      if (this._sim_in_flight(t)) {
        continue; // own shell still out: gated
      }
      if (rec.timer > 0) {
        rec.timer -= dt;
        continue;
      }
      if (this.cfg.is_on("CHANGING_WIND")) {
        // jitter as each shot resolves (FUN_4855_000e.c:134)
        this._perturb_wind();
      }
      const [ang, pw, slot] = ai.take_turn(this as unknown as ai.AIState, t);
      t.angle = pyInt(Math.max(0, Math.min(180, ang)));
      t.power = pyInt(Math.max(0, Math.min(1000, pw)));
      t.selected_weapon = slot;
      this.current_shooter = t; // for launch/laser draw + checks
      this.fire(t);
      rec.shots += 1;
      rec.timer = SIM_AI_RECOCK_DELAY;
    }
    this.current_shooter = this._sim_human; // HUD shows the local human
  }

  _sim_human_fire(tank: Tank): boolean {
    // A human fire keypress in SIMULTANEOUS: launch only if no shell in flight.
    if (this._sim_in_flight(tank)) {
      return true; // gated: own shell still out
    }
    this.current_shooter = tank;
    this.fire(tank);
    return true;
  }

  _sim_human_input(keys: ArrayLike<boolean> | null, dt: number): void {
    // Drive the local human's tank from the HELD SIMULTANEOUS controls each frame.
    // No-op when the keymap is empty (the headless/browser default), matching the
    // Python headless path; the renderer/main drive this when a keymap exists.
    const t = this._sim_human;
    if (
      t === null ||
      !t.alive ||
      this.phase !== SIM_LIVE ||
      !keys ||
      Object.keys(this._sim_keymap).length === 0
    ) {
      return;
    }
    const held = (label: string): boolean => {
      const c = this._sim_keymap[label];
      return c !== undefined && c >= 0 && c < keys.length && !!keys[c];
    };
    let ang = t.angle;
    let pw = t.power;
    if (held("cw")) {
      ang -= SIM_AIM_RATE * dt; // clockwise -> toward East (angle 0)
    }
    if (held("ccw")) {
      ang += SIM_AIM_RATE * dt;
    }
    if (held("power_up")) {
      pw += SIM_POWER_RATE * dt;
    }
    if (held("power_down")) {
      pw -= SIM_POWER_RATE * dt;
    }
    t.angle = pyInt(Math.max(0, Math.min(180, ang)));
    t.power = pyInt(Math.max(0, Math.min(1000, pw)));
  }

  _sim_human_keydown(key: number): boolean {
    // Edge-triggered SIMULTANEOUS controls for the local human: fire + cycle
    // weapon.  No-op on an empty keymap (headless/browser default).
    const t = this._sim_human;
    if (
      t === null ||
      !t.alive ||
      this.phase !== SIM_LIVE ||
      Object.keys(this._sim_keymap).length === 0
    ) {
      return false;
    }
    if (key === this._sim_keymap["fire"]) {
      this._sim_human_fire(t);
      return true;
    }
    if (key === this._sim_keymap["weapon"]) {
      // ingame.cycle_weapon would run here when a keymap exists; with the empty
      // headless keymap this branch is never reached.
      return true;
    }
    return false;
  }

  // ---- flight (one physics step over all in-flight projectiles) ----
  _step_flight(): void {
    for (const proj of this.projectiles.slice()) {
      if (!proj.active) {
        continue;
      }
      const st = proj.state;
      if (st["rolling"]) {
        wb.step_roller(this as unknown as wb.BState, proj as unknown as wb.BProjectile);
        continue;
      }
      if (st["tunneling"]) {
        if (proj.weapon.behavior === "sandhog") {
          wb.step_sandhog(this as unknown as wb.BState, proj as unknown as wb.BProjectile);
        } else {
          wb.step_digger(this as unknown as wb.BState, proj as unknown as wb.BProjectile);
        }
        continue;
      }

      const prev_vy = proj.vy;
      physics.step(
        proj,
        this.cfg as unknown as physics.PhysicsCfg,
        undefined,
        this.tanks,
      ); // guidance steering hook
      sfx.fly_tone(this.cfg.FLY_SOUND, proj, this.cfg.is_on("SOUND"));
      const _bc = proj.bounce_count ?? 0;
      if (
        !physics.handle_walls(proj, this.cfg as unknown as physics.PhysicsCfg, this.w, this.h)
      ) {
        // handle_walls returned False = the projectile left the tracked field.
        // FLOOR / WRAP side+ceiling DETONATE at the edge; a NONE-mode side exit is
        // LOST.  The detonate-vs-lose decision is the port's (geometry already ran).
        this._resolve_off_field(proj);
        continue;
      }
      if ((proj.bounce_count ?? 0) > _bc) {
        sfx.play("bounce", this.cfg.is_on("SOUND"));
      }
      // MIRV/Death's Head split at apogee (vy crosses + -> <=0)
      if (
        proj.weapon.behavior === "mirv" &&
        !proj.split_done &&
        prev_vy > 0 &&
        0 >= proj.vy
      ) {
        const n_before = this.projectiles.length;
        wb.on_apogee(this as unknown as wb.BState, proj as unknown as wb.BProjectile);
        if (proj.contact) {
          // one trigger covers every warhead (DOC L1436)
          for (const child of this.projectiles.slice(n_before)) {
            child.contact = true;
          }
        }
        continue;
      }
      this._mag_deflect(proj);
      this._force_deflect(proj);
      this._collect_trace(proj); // TRACE-gated persistent path
      const hit = this._check_collision(proj);
      if (hit) {
        this._resolve_hit(proj, hit);
      }
    }
    // flush completed traced paths into the persistent layer (TRACE-ON only)
    for (const p of this.projectiles) {
      if (!p.active) {
        this._flush_trace(p);
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.active);
  }

  _resolve_off_field(proj: Projectile): void {
    // Detonate-or-lose decision for a projectile that left the tracked field
    // (port of FUN_2a4a_1349's boundary split; geometry already ran in handle_walls).
    const mode =
      this.cfg.live_elastic !== undefined ? this.cfg.live_elastic : this.cfg.elastic;
    const floor_row = this.h - 2; // ef38 floor (the carve/blast row)
    const x = Math.max(0, Math.min(this.w - 1, proj.sx));
    const hit_floor = proj.py >= this.h - 1;
    const wrap = mode === 5;
    const hit_side = proj.px < 0 || proj.px > this.w - 1;
    const hit_ceil = proj.py < 0;
    let detonate: boolean;
    let dx = x;
    let dy = floor_row;
    if (hit_floor) {
      detonate = true;
      dx = x;
      dy = floor_row; // FUN_2a4a_2228 at (x, ef38)
    } else if (wrap && (hit_side || hit_ceil)) {
      dx = proj.px < 0 ? 0 : proj.px > this.w - 1 ? this.w - 2 : x;
      dy = hit_ceil ? 2 : Math.max(2, Math.min(floor_row, proj.sy));
      detonate = true;
    } else {
      detonate = false;
    }
    proj.active = false;
    if (!detonate) {
      this.last_landing = [proj.sx, proj.sy]; // tracked off, no detonation
      return;
    }
    this.last_landing = [dx, dy];
    const beh = proj.weapon.behavior;
    if (beh === "tracer") {
      return; // tracers never detonate
    }
    if (beh === "digger" || beh === "sandhog") {
      // a tunneller that reaches the edge without ever entering terrain has no
      // warhead.  Detonate as a surface explosive only if it carries positive blast.
      if (Math.abs(proj.weapon.blast) <= 0) {
        return;
      }
      damage.explode(
        this as unknown as damage.State,
        dx,
        dy,
        wb.eff_radius(this as unknown as wb.BState, proj.weapon),
      );
      return;
    }
    wb.detonate(this as unknown as wb.BState, proj as unknown as wb.BProjectile, dx, dy); // per-type handler at the edge
  }

  _flush_trace(proj: Projectile): void {
    const path = proj.state["trace_path"] as Array<[number, number]> | undefined;
    if (!path || path.length === 0) {
      return;
    }
    const owner = proj.owner;
    const cidx = Math.max(
      0,
      Math.min(0xff, (owner !== null ? owner.color : C.COL_TRACER) + 110),
    );
    for (const [x, y] of path) {
      this.trace_marks.push([x, y, cidx]);
    }
    proj.state["trace_path"] = [];
  }

  _collect_trace(proj: Projectile): void {
    // Record the projectile's persistent ballistic trail, gated by TRACE
    // (FUN_2a4a_0763.c:90-97).  TRACE OFF + non-tracer leaves NO lasting mark.
    const persist = this.cfg.is_on("TRACE") || proj.weapon.behavior === "tracer";
    if (!persist) {
      return;
    }
    let path = proj.state["trace_path"] as Array<[number, number]> | undefined;
    if (path === undefined) {
      path = [];
      proj.state["trace_path"] = path;
    }
    // plot the segment prev->current (the binary plots every integer step)
    const x0 = pyInt(proj.prev_px);
    const y0 = pyInt(proj.prev_py);
    const x1 = proj.sx;
    const y1 = proj.sy;
    for (const pt of _bresenham(x0, y0, x1, y1)) {
      if (path.length === 0 || path[path.length - 1][0] !== pt[0] || path[path.length - 1][1] !== pt[1]) {
        path.push(pt);
      }
    }
  }

  _mag_deflect(proj: Projectile): void {
    // Mag Deflector / Super Mag (shield flag & 6): a per-step UPWARD velocity bump
    // on a shell inside an overhead box.  Byte-exact port of FUN_2a4a_28b4.
    const fire_delay = this.cfg.FIRE_DELAY;
    const bump = fire_delay === 0 ? C.MAG_PUSH_VY_NUM : C.MAG_PUSH_VY_NUM / fire_delay;
    const h_div = floorDiv(this.h - 1, C.MAG_PUSH_HEIGHT_DIV);
    for (const t of this.tanks) {
      if (!(t.alive && t.shield_hp > 0 && t.shield_push)) {
        continue;
      }
      if (t === proj.owner) {
        // never the owner's own shot
        continue;
      }
      if (proj.vx === 0.0) {
        // vx==0 short-circuit (0x23847)
        continue;
      }
      if (Math.abs(pyRound(proj.px - t.x)) > C.MAG_PUSH_HALF_W) {
        // |dx| <= 15
        continue;
      }
      const dy = pyRound(t.y - proj.py); // tank_y - py, screen-down
      if (!(0 < dy && dy <= h_div)) {
        // overhead, within (h-1)/4
        continue;
      }
      proj.vy += bump;
    }
  }

  _force_deflect(proj: Projectile): void {
    // Force Shield (shield flag & 1): a single MIRROR REFLECTION when the shell
    // reaches the shield ring, NOT a per-step radial push.  Byte-exact port of
    // FUN_2a4a_2487, latched per ring-entry.
    const latched = proj.state["force_reflect_in_ring"] as boolean | undefined;
    let in_ring_now = false;
    for (const t of this.tanks) {
      if (!(t.alive && t.shield_hp > 0 && t.shield_deflect)) {
        continue;
      }
      const ring_r = t.half_width + C.FORCE_SHIELD_RING_PAD; // drawn outer ring
      // ring-entry test against the DRAWN ring centre (y-4 pivot, render.py)
      const ddx = proj.sx - t.x;
      const ddy = proj.sy - (t.y - 4);
      if (ddx * ddx + ddy * ddy >= ring_r * ring_r) {
        continue;
      }
      in_ring_now = true;
      if (latched) {
        // already bounced this entry
        continue;
      }
      // the reflection NORMAL uses the tank base centre +0xe/+0x10 (x, base y).
      const ndx = proj.sx - t.x;
      const ndy = t.y - proj.sy;
      const ev_x = proj.vx;
      const ev_y = -proj.vy; // engine vy is screen-down; port vy is up
      // sign-test early-out (:27-75): skip when departing on both axes.
      if (_sgn(ndx) === _sgn(ev_x) && _sgn(ndy) === _sgn(ev_y)) {
        proj.state["force_reflect_in_ring"] = true;
        continue;
      }
      // delta = (vel_ang - normal_ang) * 2.0 (ground-truth operand order).
      const normal_ang = Math.atan2(ndy, ndx);
      const vel_ang = Math.atan2(ev_y, ev_x);
      const delta = (vel_ang - normal_ang) * C.FORCE_REFLECT_ANGLE_K;
      const cos_d = Math.cos(delta); // FUN_1000_13d1 -> ST2
      const sin_d = Math.sin(delta); // FUN_1000_1204 -> ST3
      // exact engine rotation (FUN_2a4a_2487.c:82-84, dVar1 = -e4dc):
      //   e4dc' = -cos*evx - sin*evy ; e4e4' = sin*evx - cos*evy
      const nevx = (-cos_d * ev_x - sin_d * ev_y) * C.FORCE_REFLECT_RESTITUTION;
      const nevy = (sin_d * ev_x - cos_d * ev_y) * C.FORCE_REFLECT_RESTITUTION;
      proj.vx = nevx;
      proj.vy = -nevy; // engine e4e4 is screen-down; port vy is up
      damage.shield_chip(t as unknown as damage.Tank); // the ring takes the hit (FUN_4912_04b2)
      proj.state["force_reflect_in_ring"] = true;
    }
    if (!in_ring_now && latched) {
      // left every ring -> re-arm
      proj.state["force_reflect_in_ring"] = false;
    }
  }

  _check_collision(proj: Projectile): Hit | null {
    // Walk the segment prev->current; first tank bbox or dirt pixel.
    const x0 = pyInt(proj.prev_px);
    const y0 = pyInt(proj.prev_py);
    const x1 = proj.sx;
    const y1 = proj.sy;
    for (const [x, y] of _bresenham(x0, y0, x1, y1)) {
      if (y >= this.h - 1) {
        return { 0: "terrain", 1: null, 2: x, 3: this.h - 2 };
      }
      for (const t of this.tanks) {
        if (
          t.alive &&
          t !== proj.owner &&
          Math.abs(t.x - x) <= t.half_width &&
          0 <= t.y - y &&
          t.y - y <= 10
        ) {
          return { 0: "tank", 1: t, 2: x, 3: y };
        }
        // a tank can hit itself only after the shell has left the muzzle
        if (
          t === proj.owner &&
          proj.owner !== null &&
          Math.abs(t.x - x) <= t.half_width &&
          0 <= t.y - y &&
          t.y - y <= 10 &&
          proj.armed &&
          Math.hypot(x - proj.owner.x, y - (proj.owner.y - 4)) > 16
        ) {
          return { 0: "tank", 1: t, 2: x, 3: y };
        }
      }
      if (0 <= x && x < this.w && 0 <= y && y < this.h && this.terrain.is_dirt(x, y)) {
        return { 0: "terrain", 1: null, 2: x, 3: y };
      }
    }
    return null;
  }

  _resolve_hit(proj: Projectile, hit: Hit): void {
    const kind = hit[0];
    const tank = hit[1];
    const x = hit[2];
    const y = hit[3];
    const beh = proj.weapon.behavior;
    this.last_landing = [x, y];
    if (kind === "tank" && tank !== null) {
      if (tank.shield_hp > 0 && beh !== "laser") {
        if (beh === "digger") {
          proj.active = false; // digger fizzles on a tank
        } else {
          damage.shield_chip(tank as unknown as damage.Tank); // no detonation (catalog 11 s.3.2)
          // a direct hit is a shield event: a non-failproof shield may fail
          damage.shield_failure_check(
            this as unknown as damage.State,
            tank as unknown as damage.Tank,
          );
          sfx.play("shield_hit", this.cfg.is_on("SOUND"));
          proj.active = false;
        }
        return;
      }
      if (beh === "digger") {
        proj.active = false; // fizzle (no damage)
        sfx.play("fizzle", this.cfg.is_on("SOUND"));
        return;
      }
      if (
        beh === "dirt_sphere" ||
        beh === "dirt_slump" ||
        beh === "dirt_wedge" ||
        beh === "dirt_settle" ||
        beh === "riot_sphere" ||
        beh === "riot_wedge" ||
        beh === "tracer"
      ) {
        wb.detonate(this as unknown as wb.BState, proj as unknown as wb.BProjectile, x, y); // no tank damage by design
        proj.active = false;
        return;
      }
      damage.direct_hit(this as unknown as damage.State, tank as unknown as damage.Tank); // instakill
      wb.detonate(this as unknown as wb.BState, proj as unknown as wb.BProjectile, x, y); // radial + crater
      proj.active = false;
    } else {
      // terrain
      // Contact Trigger disables tunnelling/rolling: detonate on first ground hit.
      if (!proj.contact) {
        if (beh === "roller") {
          wb.start_roller(this as unknown as wb.BState, proj as unknown as wb.BProjectile, x, y);
          return;
        }
        if (beh === "digger") {
          wb.start_digger(this as unknown as wb.BState, proj as unknown as wb.BProjectile, x, y);
          return;
        }
        if (beh === "sandhog") {
          wb.start_sandhog(this as unknown as wb.BState, proj as unknown as wb.BProjectile, x, y);
          return;
        }
      }
      if (beh === "tracer") {
        proj.active = false;
        return;
      }
      // A contact-triggered digger/sandhog can't tunnel -> detonate at the surface.
      if (proj.contact && beh === "digger") {
        const r = pyInt(wb.eff_radius(this as unknown as wb.BState, proj.weapon));
        this.terrain.carve_circle(x, y, r);
        this.add_explosion(x, y, r, true);
        proj.active = false;
        return;
      }
      if (proj.contact && beh === "sandhog") {
        damage.explode(
          this as unknown as damage.State,
          x,
          y,
          wb.eff_radius(this as unknown as wb.BState, proj.weapon),
        );
        proj.active = false;
        return;
      }
      wb.detonate(this as unknown as wb.BState, proj as unknown as wb.BProjectile, x, y);
      if (beh === "leapfrog" && proj.warheads_left > 1) {
        this._leapfrog_hop(proj, x, y);
      }
      proj.active = false;
    }
  }

  _leapfrog_hop(proj: Projectile, x: number, y: number): void {
    // Leapfrog: next warhead launches forward from the impact (3 total).
    // A fired projectile always carries its owner (physics.launch set it); Python
    // relies on proj.owner being non-null here (it would AttributeError otherwise).
    const owner = proj.owner;
    if (owner === null) {
      return;
    }
    const idx = proj.weapon.warheads - proj.warheads_left + 1;
    const radii = (proj.weapon.params as { radii?: number[] }).radii ?? [20, 25, 30];
    const nxt = physics.launch(
      owner,
      this.cfg as unknown as physics.PhysicsCfg,
      proj.weapon,
      350,
      proj.vx >= 0 ? 60 : 120,
    );
    nxt.warheads_left = proj.warheads_left - 1;
    nxt.weapon = wb._single_warhead(proj.weapon);
    nxt.weapon.behavior = "leapfrog";
    nxt.weapon.warheads = proj.weapon.warheads;
    nxt.weapon.blast = radii[Math.min(idx, radii.length - 1)];
    nxt.px = x;
    nxt.py = y - 4;
    nxt.contact = proj.contact; // carry the contact trigger to the hop
    this.projectiles.push(nxt);
  }

  // ---- settle: dirt collapse + tank fall (catalog 11 sections 2.5, 5) ----
  _do_settle(): void {
    this.terrain.settle(
      this.cfg as unknown as Parameters<Terrain["settle"]>[0],
      this.rng,
    );
    for (const t of this.tanks) {
      if (t.alive) {
        this._settle_tank(t);
      }
    }
  }

  _settle_tank(t: Tank): void {
    // One tank's post-blast settle (FUN_2975_048c collapsed to a single drop).
    // Fall damage = 2*pixels; a chute deployed for this fall negates it.  Fall/
    // squash-faller damage uses the health-direct path (no shield absorb); the
    // squash VICTIM goes through the shield gate.
    if (!this.cfg.is_on("FALLING_TANKS")) {
      t.y = Math.max(2, this.terrain.column_top(t.x) - 1);
      return;
    }
    const floor = this.h - 2;
    // decide parachute BEFORE moving (predictor runs on the pre-fall position)
    const chute = damage.chute_should_deploy(
      this.terrain as unknown as damage.Terrain,
      t as unknown as damage.Tank,
    );
    let pixels = 0;
    const path: Array<[number, number]> = [[t.x, t.y]]; // recorded descent, for the chute replay
    while (t.y < floor && !this.terrain.is_supported(t.x, t.y, t.half_width)) {
      t.y += 1;
      pixels += 1;
      // Parachute wind-drift (FUN_2975_048c.c:173-214): gated on the chute flag
      // AND |wind| > 10, with a round(|wind|)/100 chance per step to drift ONE
      // pixel downwind, terrain permitting, then clamps x to [9, w-10].
      if (
        chute &&
        Math.abs(this.cfg.wind) > 10 &&
        this.rng.pick(100) < pyRound(Math.abs(this.cfg.wind))
      ) {
        const drift = this.cfg.wind > 0 ? 1 : -1;
        const nx = t.x + drift;
        if (9 <= nx && nx <= this.w - 10 && !this.terrain.is_solid(nx, t.y)) {
          t.x = nx;
        }
      }
      path.push([t.x, t.y]);
    }
    if (pixels <= 0) {
      return;
    }
    const accum = pixels * C.FALL_DMG_PER_PIXEL;
    // landed on an enemy?  BOTH take damage regardless of chute (FUN_2975_048c:57-74):
    // victim accum+50 (shield gate), faller accum/2+10 (health direct).
    const landed_on = this._tank_under(t);
    if (landed_on !== null) {
      damage.apply_tank_damage(
        this as unknown as damage.State,
        landed_on as unknown as damage.Tank,
        accum + C.FALL_ON_ENEMY_VICTIM_BONUS,
      );
      damage.apply_fall_damage(
        this as unknown as damage.State,
        t as unknown as damage.Tank,
        floorDiv(accum, 2) + C.FALL_ON_ENEMY_FALLER_BASE,
      );
      return;
    }
    if (chute) {
      sfx.play("parachute", this.cfg.is_on("SOUND"));
      this._announce_defense(t, weapons.SLOT_PARACHUTE); // "%s activating Parachute"
      if (t.inventory[weapons.SLOT_PARACHUTE] > 0) {
        t.inventory[weapons.SLOT_PARACHUTE] -= 1; // consume one chute (:40-41)
      }
      if (t.parachutes < 1) {
        t.parachute_deployed = false; // out of chutes -> passive
      }
      this._start_chute_descent(t, path); // visual canopy descent (#33)
      return; // chute negates fall damage
    }
    damage.apply_fall_damage(
      this as unknown as damage.State,
      t as unknown as damage.Tank,
      accum,
    );
  }

  _start_chute_descent(t: Tank, path: Array<[number, number]>): void {
    // Register a VISUAL-ONLY parachute descent for `t` (#33).
    if (!path || path.length < 2) {
      return;
    }
    (t as { chute_descent?: unknown }).chute_descent = { path, i: 0.0 };
  }

  _step_chute_anims(_dt: number): void {
    // Advance each active parachute descent (#33); clear on reaching landed pos.
    for (const t of this.tanks) {
      const cd = (t as { chute_descent?: { path: unknown[]; i: number } | null }).chute_descent;
      if (!cd) {
        continue;
      }
      cd.i += CHUTE_DESCENT_PX_PER_FRAME;
      if (cd.i >= cd.path.length - 1) {
        (t as { chute_descent?: unknown }).chute_descent = null;
      }
    }
  }

  _tank_under(faller: Tank): Tank | null {
    for (const t of this.tanks) {
      if (
        t !== faller &&
        t.alive &&
        Math.abs(t.x - faller.x) <= t.half_width + 2 &&
        0 <= faller.y - t.y &&
        faller.y - t.y <= 4
      ) {
        return t;
      }
    }
    return null;
  }

  // ---- visual effects animation ----
  static EXPLO_FLASH_FRAMES = 49; // FUN_4d1e_015a.c:57  for iVar2=1; iVar2<0x32
  static EXPLO_SHRINK_FRAMES = 25; // FUN_4d1e_015a.c:75  for iVar2=0; iVar2<0x19
  static EXPLO_FLASH_MIN_R = 0x1f; // FUN_4d1e_015a.c:51  flash only when R>=0x1f
  static EXPLO_STAMP_HOLD = 3; // port hold for the single-pass stamp (visual)
  static NUKE_FLASH_FRAMES = 129; // FUN_3770_041d.c:48  for iVar2=1; iVar2<0x82

  add_explosion(x: number, y: number, r: number, dirt_only = false, nuke = false): void {
    r = Math.max(2, pyInt(r));
    // EXPAND step is 1 below 0x28 (40), else 2 (FUN_4d1e_015a.c:38-43).  The nuke
    // engine steps by 1 for the whole grow regardless of R.
    const step = nuke || r < 0x28 ? 1 : 2;
    let style: string;
    if (nuke) {
      style = "nuke"; // FUN_3770_041d: flat-fill grow + 129-frame flash
    } else if (dirt_only) {
      style = "stamp"; // FUN_4c70_09ca single pass (riot/dirt/debris)
    } else {
      style = "grow"; // FUN_4d1e_015a ring grow + 49-frame flash
    }
    // nuke ALWAYS flashes; otherwise flash only when R>=0x1f and it is a fireball.
    const flash = nuke || (!dirt_only && r >= GameState.EXPLO_FLASH_MIN_R);
    this.explosions.push({
      x: pyInt(x),
      y: pyInt(y),
      maxr: r,
      style,
      dirt: dirt_only,
      step,
      flash,
      // phase: 0=expand, 1=flash, 2=shrink, 3=done.
      phase: 0,
      frame: 0,
    });
  }

  add_beam(pts: Array<[number, number]>): void {
    this.beams.push({ pts, frame: 0 });
  }

  // ---- plasma ring (FUN_3f76_03bd) ----
  add_plasma_ring(x: number, y: number, max_r: number): void {
    // Spawn the plasma grow->shrink ring outline (FUN_3f76_03bd.c:16-23).
    max_r = Math.max(2, pyInt(max_r));
    this.plasma_rings.push({ x: pyInt(x), y: pyInt(y), maxr: max_r, r: 1, dir: 1 });
  }

  _step_plasma_rings(): void {
    for (const ring of this.plasma_rings) {
      ring.r += ring.dir;
      if (ring.r >= ring.maxr) {
        // reached R -> begin shrink
        ring.r = ring.maxr;
        ring.dir = -1;
      }
    }
    // expire once the shrink has erased back past radius 1
    this.plasma_rings = this.plasma_rings.filter((r) => r.r >= 1);
  }

  // ---- full-screen palette flash (lightning ground strike / thunder) ----
  add_flash(
    up_frames: number,
    down_frames: number,
    rgb: [number, number, number] = [255, 255, 235],
    delay = 0,
  ): void {
    // Queue a full-screen brightness flash ramping UP then DOWN, peaking at rgb.
    this.flashes.push({
      up: Math.max(1, pyInt(up_frames)),
      down: Math.max(1, pyInt(down_frames)),
      frame: -Math.max(0, pyInt(delay)),
      rgb,
    });
  }

  _step_flashes(): void {
    for (const f of this.flashes) {
      (f.frame as number) += 1;
    }
    // a flash is live while frame in [0, up+down]; negative frame = pending delay
    this.flashes = this.flashes.filter(
      (f) => (f.frame as number) <= (f.up as number) + (f.down as number),
    );
  }

  // ---- tank-death debris fountain (FUN_3ef5_029a.c:60-77) ----
  add_death_fountain(
    x: number,
    y: number,
    top: number,
    color = 15,
    stride = 6,
    scatter = 1,
  ): void {
    // Register the RISING tank-death / retreat ASCENSION tile (FUN_3ef5_029a:60-77).
    this.death_fountains.push({
      col: pyInt(x),
      y: pyInt(y),
      top: pyInt(top),
      color: pyInt(color),
      stride: pyInt(stride),
      scatter: pyInt(scatter),
    });
  }

  _step_death_fountains(): void {
    // Climb each death/retreat tile one step UP toward its top clip, then retire.
    for (const f of this.death_fountains) {
      const drift = (this.rng.pick(3) - 1) * f.scatter; // {-1,0,+1} * width
      f.col = Math.max(0, Math.min(this.w - 1, f.col + drift));
      f.y -= f.stride;
    }
    this.death_fountains = this.death_fountains.filter((f) => f.y >= f.top);
  }

  // ---- death-throe animations (the FUN_271b_0005 rand(11) roulette, #21) ----
  static THROE_LIFE: { [k: string]: number } = {
    spiral: 46,
    ring: 40,
    geyser: 40,
    sparkle: 46,
    sink: 34,
  };

  add_throe(kind: string, x: number, y: number, color: number): void {
    // Spawn one death-throe animation of `kind` at (x, y) in palette `color`.
    const e: { [k: string]: unknown } = {
      kind,
      x: pyInt(x),
      y: pyInt(y),
      color: pyInt(color),
      frame: 0,
      life: GameState.THROE_LIFE[kind] ?? 40,
    };
    if (kind === "sparkle") {
      const parts: number[][] = [];
      for (let i = 0; i < 36; i++) {
        const ang = (this.rng.pick(360) * Math.PI) / 180.0;
        const spd = 1.0 + this.rng.pick(40) / 10.0;
        parts.push([x, y, spd * Math.cos(ang), spd * Math.sin(ang) - 2.4]);
      }
      e.parts = parts;
    } else if (kind === "sink") {
      this.terrain.carve_circle(pyInt(x), pyInt(y), 11); // the collapse pit
    }
    this.throe_fx.push(e);
  }

  _step_throe_fx(): void {
    // Advance each death-throe a frame; retire when it outlives its `life`.
    for (const e of this.throe_fx) {
      (e.frame as number) += 1;
      if (e.kind === "sparkle") {
        for (const p of e.parts as number[][]) {
          p[0] += p[2];
          p[1] += p[3];
          p[3] += 0.35; // gravity
        }
      }
    }
    this.throe_fx = this.throe_fx.filter((e) => (e.frame as number) < (e.life as number));
  }

  _step_explosion(e: { [k: string]: unknown }): void {
    // Advance one explosion through expand -> flash -> shrink.
    (e.frame as number) += 1;
    if (e.style === "stamp") {
      if ((e.frame as number) > GameState.EXPLO_STAMP_HOLD) {
        e.phase = 3;
      }
      return;
    }
    const flash_frames =
      e.style === "nuke" ? GameState.NUKE_FLASH_FRAMES : GameState.EXPLO_FLASH_FRAMES;
    const ph = e.phase as number;
    if (ph === 0) {
      // EXPAND: radii 1..R by step
      if ((e.frame as number) * (e.step as number) >= (e.maxr as number)) {
        e.phase = e.flash ? 1 : 2;
        e.frame = 0;
      }
    } else if (ph === 1) {
      // FLASH: 49 (nuke 129) frames at full R
      if ((e.frame as number) >= flash_frames) {
        e.phase = 2;
        e.frame = 0;
      }
    } else if (ph === 2) {
      // SHRINK: 25-frame fade-out
      if ((e.frame as number) >= GameState.EXPLO_SHRINK_FRAMES) {
        e.phase = 3;
      }
    }
  }

  _animate_effects(): void {
    this._step_death_fountains(); // rising tank-death debris (emit first)
    for (const e of this.explosions) {
      this._step_explosion(e);
    }
    this.explosions = this.explosions.filter((e) => (e.phase as number) < 3);
    for (const b of this.beams) {
      b.frame += 1;
    }
    this.beams = this.beams.filter((b) => b.frame <= 8);
    this._step_plasma_rings(); // plasma grow->shrink ring sweep
    this._step_throe_fx(); // death-throe animations (#21)
  }

  _tick_sky(): void {
    // Age the sky-borne transient visuals every frame, regardless of phase.
    this._step_flashes(); // full-screen lightning flashes
    this._tick_shield_fades(); // 51-frame shield swatch fades
    hazard.age_bolts(this as unknown as hazard.State); // expire hostile-sky lightning bolts
  }

  // ---- master palette tick (the IRQ0/retrace-rate band animator) ----
  _tick_palette(dt: number): void {
    // Advance whichever DAC bands are currently cycling at the VGA retrace rate
    // (C.PALETTE_CYCLE_HZ = 70 Hz), accumulated against wall-clock dt.
    const lut = this.lut;
    this._pal_accum += dt * C.PALETTE_CYCLE_HZ;
    const steps = pyInt(this._pal_accum);
    this._pal_accum -= steps;

    // 1) Sky band -- STATIC.  Reset to its seeded gradient base each frame WITHOUT
    //    rolling (the in-game sky does NOT scroll; user-confirmed 2026-06-22).
    const base_sky = this._sliceTable(this._lut_base, _pal.SKY_BAND_LO, _pal.SKY_BAND_HI);
    lut.set_band(_pal.SKY_BAND_LO, _pal.SKY_BAND_HI, base_sky);

    // 2) Explosion / nuke fireball band (0xC8..0xEF).
    this._tick_explosion_band();
    // 3) Lightning ground-strike sky whiten.
    this._tick_lightning_band();
    // 4) Digger/tunneler trail glow cycle (band 0xAF..0xB8).
    this._tick_digger_band(steps);
    // 5) Firewall fire shimmer (band 0xAA,0x14).
    this._tick_firewall_band(steps);
  }

  // Explosion/nuke band colours, BYTE-EXACT from FUN_4d1e_00ae.c:11-17: PURE RED,
  // G=B=0, R ramping 0->0x3f then 0x3f->0.  No yellow/orange/white.
  static _EXPLO_HOT_OUTER: RGB = [24, 0, 0]; // near-black dark red at the band's low end
  static _EXPLO_HOT_INNER: RGB = [252, 0, 0]; // bright red (0x3f << 2) at the ring base

  _tick_explosion_band(): void {
    // Load/animate the explosion red band from the live fireballs.
    const lo = _pal.EXPLO_BAND_LO;
    const hi = _pal.EXPLO_BAND_HI;
    const ring = C.EXPLOSION_RING_BASE; // 0xDD: the hot end of the on-screen ring
    let bright: { [k: string]: unknown } | null = null; // an expanding/flashing fireball
    let dim_t: number | null = null; // 0..1 darkening for a shrinking fireball
    for (const e of this.explosions) {
      if (e.style === "stamp") {
        continue;
      }
      const ph = e.phase as number;
      if (ph === 0 || ph === 1) {
        bright = e;
        break;
      }
      if (ph === 2) {
        const t = Math.min(1.0, (e.frame as number) / GameState.EXPLO_SHRINK_FRAMES);
        dim_t = dim_t === null ? t : Math.min(dim_t, t);
      }
    }
    if (bright !== null || dim_t !== null) {
      // (re)build the hot ramp: cool red at lo rising to bright at the ring base.
      this.lut.reramp_band(lo, ring, GameState._EXPLO_HOT_OUTER, GameState._EXPLO_HOT_INNER);
      // the tail 0xDE..0xEF stays at the inner hot color
      this.lut.reramp_band(ring, hi, GameState._EXPLO_HOT_INNER, GameState._EXPLO_HOT_INNER);
      if (dim_t !== null && bright === null) {
        // cycle the whole band DOWN during shrink: scale toward black.
        const f = Math.max(0.0, 1.0 - 0.9 * dim_t);
        const rows: RGB[] = [];
        for (let idx = lo; idx <= hi; idx++) {
          const row = this.lut.table[idx];
          rows.push([
            Math.trunc(row[0] * f) & 0xff,
            Math.trunc(row[1] * f) & 0xff,
            Math.trunc(row[2] * f) & 0xff,
          ]);
        }
        this.lut.set_band(lo, hi, rows);
      }
      this._explo_band_active = true;
    } else if (this._explo_band_active) {
      // no live fireball -> revert the band to its at-rest build_palette ramp.
      this.lut.set_band(lo, hi, this._sliceTable(this._lut_base, lo, hi));
      this._explo_band_active = false;
    }
  }

  _tick_lightning_band(): void {
    // Ramp the sky band toward white-hot per the active strike flash level.
    const flashes = this.flashes;
    if (flashes.length === 0) {
      return;
    }
    let level = 0.0;
    for (const f of flashes) {
      const fr = f.frame as number;
      if (fr < 0) {
        // still in its stagger delay
        continue;
      }
      const up = f.up as number;
      const down = f.down as number;
      const lv = fr <= up ? fr / up : Math.max(0.0, 1.0 - (fr - up) / down);
      level = Math.max(level, lv);
    }
    if (level <= 0.0) {
      return;
    }
    const lo = _pal.LIGHTNING_BAND_LO;
    const hi = _pal.LIGHTNING_BAND_HI;
    const rows: RGB[] = [];
    for (let idx = lo; idx <= hi; idx++) {
      const cur = this.lut.table[idx];
      const r = Math.max(0, Math.min(255, Math.trunc(cur[0] * (1.0 - level) + 255 * level)));
      const g = Math.max(0, Math.min(255, Math.trunc(cur[1] * (1.0 - level) + 255 * level)));
      const b = Math.max(0, Math.min(255, Math.trunc(cur[2] * (1.0 - level) + 255 * level)));
      rows.push([r, g, b]);
    }
    this.lut.set_band(lo, hi, rows);
  }

  static DIGGER_CYCLE_FRAMES = 200; // 0xc8 (FUN_352c_00c9.c:119)

  start_digger_cycle(): void {
    // Arm/refresh the 200-frame digger trail glow cycle.
    this._digger_cycle = GameState.DIGGER_CYCLE_FRAMES;
  }

  _tick_digger_band(steps = 1): void {
    // Rotate the 0xAF trail band at the retrace rate while the cycle is armed.
    const lo = _pal.DIGGER_BAND_LO;
    const hi = _pal.DIGGER_BAND_HI;
    const n = hi - lo + 1;
    if (this._digger_cycle > 0) {
      this._digger_step = (this._digger_step + steps) % n;
      const base = this._sliceTable(this._lut_base, lo, hi);
      this.lut.set_band(lo, hi, this._rollRows(base, this._digger_step));
      this._digger_cycle -= 1;
      if (this._digger_cycle === 0) {
        // expired: retire the trail
        this.lut.set_band(lo, hi, base); // LUT back to glow base
        this._digger_step = 0;
        // sweep the 0xAF trail pixels out of the terrain plane (FUN_352c_00c9.c:143-152)
        this.terrain.clear_index_band(lo, hi);
      }
    }
  }

  static FIREWALL_FRAMES = 120;

  add_firewall(x: number, top_y: number, bottom_y: number): void {
    // Spawn a vertical flame wall at column x.  SCAFFOLD (no item spawns one).
    this.firewalls.push({
      x: pyInt(x),
      y0: pyInt(Math.min(top_y, bottom_y)),
      y1: pyInt(Math.max(top_y, bottom_y)),
      frame: 0,
    });
    // prime the flame/ember slots immediately so a fresh wall reads as fire.
    _pal.firewall_apply(this.lut, 0);
    this._firewall_band_active = true;
  }

  _tick_firewall_band(steps = 1): void {
    // Animate the firewall palette while any flame wall is alive, then restore.
    if (this.firewalls.length > 0) {
      this._firewall_counter += steps; // DAT_5f38_00ec++ (:6), retrace-paced
      if (this._firewall_counter > 100) {
        // :7 wrap at 100
        this._firewall_counter %= 101;
      }
      _pal.firewall_apply(this.lut, this._firewall_counter);
      this._firewall_band_active = true;
      for (const fw of this.firewalls) {
        fw.frame += 1;
      }
      this.firewalls = this.firewalls.filter((fw) => fw.frame <= GameState.FIREWALL_FRAMES);
    } else if (this._firewall_band_active) {
      // no live wall -> restore the firewall slots to their build_palette base
      this.lut.set_index(_pal.FIREWALL_PULSE_IDX, this._lut_base[_pal.FIREWALL_PULSE_IDX]);
      this.lut.set_band(
        _pal.FIREWALL_FLAME_LO,
        _pal.FIREWALL_FLAME_HI,
        this._sliceTable(this._lut_base, _pal.FIREWALL_FLAME_LO, _pal.FIREWALL_FLAME_HI),
      );
      this.lut.set_band(
        _pal.FIREWALL_EMBER_LO,
        _pal.FIREWALL_EMBER_HI,
        this._sliceTable(this._lut_base, _pal.FIREWALL_EMBER_LO, _pal.FIREWALL_EMBER_HI),
      );
      this._firewall_band_active = false;
    }
  }

  /** Slice rows [lo..hi] inclusive out of a PaletteTable as fresh RGB rows
   *  (mirrors numpy `table[lo:hi+1]`). */
  _sliceTable(table: PaletteTable, lo: number, hi: number): RGB[] {
    const out: RGB[] = [];
    for (let i = lo; i <= hi; i++) {
      const r = table[i];
      out.push([r[0], r[1], r[2]]);
    }
    return out;
  }

  /** np.roll(rows, step, axis=0): entry at k moves to (k+step) mod n. */
  _rollRows(rows: RGB[], step: number): RGB[] {
    const n = rows.length;
    if (n === 0) return rows;
    const s = ((step % n) + n) % n;
    const out: RGB[] = new Array(n);
    for (let k = 0; k < n; k++) {
      out[(k + s) % n] = rows[k];
    }
    return out;
  }

  on_tank_destroyed(victim: Tank, weapon: weapons.Item | null = null): void {
    // Death sequence (FUN_3ef5_029a): debris fountain + weapon-radius blast, the
    // death buzz, and a die-pool taunt.
    death.death_sequence(
      this as unknown as death.DState,
      victim as unknown as death.DTank,
      weapon as unknown as Parameters<typeof death.death_sequence>[2],
    );
    sfx.play("death", this.cfg.is_on("SOUND"));
    const _line = talk.die_taunt(
      victim as unknown as talk.TankLike,
      this.talk as unknown as talk.TalkConfig,
      this.rng,
    );
    if (_line !== null) {
      talk.set_speech(
        this as unknown as talk.SpeechState,
        victim as unknown as talk.TankLike,
        _line,
        this.talk as unknown as talk.TalkConfig,
      );
    }
  }

  // --------------------------------------------------------------- round end
  _end_round(): void {
    scoring.survival_award(this as unknown as scoring.State);
    // Victory fanfare on the winner path: a round that ends with a surviving tank
    // has a winner.  A mutual-kill round (no survivor) ends with no fanfare.
    if (this.tanks.some((t) => t.alive)) {
      sfx.play("victory", this.cfg.is_on("SOUND"));
    }
    this.round_index += 1;
    this.ranking = scoring.rank(this as unknown as scoring.State) as unknown as Tank[];
    this.phase = ROUND_END;
  }

  mass_kill(): void {
    // System Menu -> Mass Kill (SCORCH.DOC:L1461-1469): kill EVERY tank, split the
    // round's survival pool EQUALLY with NO win/survival credit, then end the round.
    const n = this.tanks.length;
    if (n === 0) {
      return;
    }
    const pool =
      this.cfg.scoring === C.SCORING_BASIC
        ? n * C.SCORE_SURVIVAL_BASIC_PER
        : C.SCORE_SURVIVAL_STD;
    const share = floorDiv(pool, n);
    for (const t of this.tanks) {
      t.alive = false;
      t.health = 0;
      t.score += share; // equal split, NO win_counter++
      t.cash = Math.max(0, t.cash + share); // awards feed cash too
    }
    this.round_index += 1;
    this.ranking = scoring.rank(this as unknown as scoring.State) as unknown as Tank[];
    this.phase = ROUND_END;
  }

  proceed_after_round(): void {
    // Called by main after the rankings screen: shop, then next round or end.
    if (this.round_index >= this.cfg.MAXROUNDS) {
      this.winner = this.ranking.length > 0 ? this.ranking[0] : null;
      this.phase = GAME_OVER;
      return;
    }
    // post-round economy: interest, annuity, market, AI buys
    this.economy.accrue_interest(this.tanks as unknown as Parameters<Economy["accrue_interest"]>[0]);
    // Annuity remaining-rounds N (FUN_1dbc_0105.c:19): MAXROUNDS - round - 1.
    this.economy.update_repeated_use(this.cfg.MAXROUNDS - this.round_index - 1);
    this.economy.market_update(this.tanks.length);
    this.phase = SHOP;
  }

  run_ai_buys(): void {
    for (const t of this.tanks) {
      if (t.ai_class !== C.AI_HUMAN) {
        ai.buy(this as unknown as ai.AIState, t);
      }
    }
  }

  begin_next_round(): void {
    this.start_round();
  }
}

/** Build a fresh GameState seeded the way main.py:474-483 does.  (cfg,w,h,seed)
 *  mirror the Python constructor + the random.seed(seed)/grng.seed(seed) call:
 *  the shared MT singleton AND Python's module-level random are both seeded with
 *  `seed` (two distinct streams sharing the value). */
/** Integrator hook: the decoded .MTN ranges the browser fetched.  The Python globs
 *  1.5/*.MTN (game.py:127); the browser cannot, so main.ts fetches them and registers
 *  here.  start_round passes mtn_ranges to terrain.generate; empty -> procedural. */
let _mtnRanges: MtnFile[] = [];
export function setMtnRanges(files: MtnFile[]): void {
  _mtnRanges = files;
}

export function createGameState(
  cfg: Config,
  w: number,
  h: number,
  seed: number,
): GameState {
  global_rng.seed(seed); // grng.seed(seed) -- the shared MT singleton (self.rng)
  const gs = new GameState(cfg, w, h);
  gs.mtn_ranges = _mtnRanges; // fetched .MTN ranges (main wires them; [] -> procedural)
  gs._pyrandom.seed(seed); // random.seed(seed) -- Python's module-level random
  return gs;
}

/**
 * Projectile and Tank/Player models -- a faithful TypeScript port of
 * scorch-py/scorch/objects.py (the fidelity oracle, itself byte-verified against
 * 1.5/SCORCH.EXE).
 *
 * These mirror the recovered struct layouts (projectile stride 0x6c, tank stride
 * 0xca). The original field offsets are kept in comments for traceability, as in
 * the Python; downstream physics / ai / weapon_behaviors depend on the exact
 * field names and shapes, so they are preserved verbatim.
 *
 * NUMERIC NOTE: this module has NO transcendental math (no sin/cos/pow/sqrt/atan2)
 * and NO rng. Every field is an int, an exactly-representable float, a boolean, a
 * string, or a reference. So the differential gate (test/objects.test.ts) asserts
 * every value with EXACT equality -- there is no float epsilon and none is
 * warranted.
 *
 * THE ONE NUMERIC GOTCHA (sx/sy): the Projectile constructor computes
 *   self.sx = int(round(px))   # +0x00 (FUN_1000_14df rounding)
 *   self.sy = int(round(py))   # +0x02
 * Python 3's round() is ROUND-HALF-TO-EVEN (banker's rounding): round(0.5)=0,
 * round(1.5)=2, round(2.5)=2, round(99.5)=100, round(100.5)=100. JS Math.round is
 * round-half-UP (Math.round(0.5)=1, Math.round(2.5)=3) and DIVERGES on every .5
 * tie. So sx/sy use pyRound() below (exact CPython round semantics), NOT
 * Math.round. Verified against CPython this session.
 */
import * as C from "./constants";
import * as weapons from "./weapons";

/**
 * CPython round(x) for the default (ndigits omitted) case: round half to even,
 * returning an integer. Mirrors `int(round(x))` in objects.py.
 *
 * CPython's float.__round__ with no ndigits delegates to round-half-to-even
 * (Objects/floatobject.c float___round___impl -> _Py_dg_dtoa / round_to_nearest;
 * for the common range this equals: if the fractional part is exactly 0.5, pick
 * the even neighbour, else round to nearest). We reproduce that: only the exact
 * half-way case is steered to even; everything else rounds to nearest, which is
 * what Math.round already does for non-ties (Math.round rounds .5 toward +Inf,
 * but for a non-tie there is a unique nearest integer and Math.round gives it).
 */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor; // fractional part in [0, 1)
  // `+ 0` collapses a JS negative zero to +0: Math.floor(-0) is -0 (and so is
  // floor for x in [-0, 0.5)), but CPython round() returns a Python int that has
  // no -0 (the oracle serializes it as +0). Without this, expect(...).toBe uses
  // Object.is and -0 !== +0 fails. No expected round() value is -0, so this never
  // masks a divergence. The +1 / even-branch paths already yield +0.
  if (diff < 0.5) return floor + 0;
  if (diff > 0.5) return floor + 1;
  // Exactly halfway: round to even.
  return floor % 2 === 0 ? floor + 0 : floor + 1;
}

/** Object array DAT_5f38_ceb8 entry (stride 0x6c). */
export class Projectile {
  vx: number;
  vy: number;
  px: number;
  py: number;
  sx: number;
  sy: number;
  prev_px: number;
  prev_py: number;
  saved_vx: number;
  saved_vy: number;
  weapon: weapons.Item;
  weapon_type: number;
  owner: Tank | null;
  owner_index: number;
  active: boolean;
  mode: number;
  flags: number;
  bounce_energy: number;
  bounce_count: number;
  spring_armed: boolean;
  warheads_left: number;
  guidance: unknown;
  target: unknown;
  state: { [k: string]: unknown };
  trail: unknown[];
  armed: boolean;
  split_done: boolean;
  contact: boolean;

  constructor(
    owner: Tank | null,
    weapon: weapons.Item,
    px: number,
    py: number,
    vx: number,
    vy: number,
  ) {
    this.vx = vx;                         // +0x04 (float(vx); JS numbers are already f64)
    this.vy = vy;                         // +0x0c
    this.px = px;                         // +0x14
    this.py = py;                         // +0x1c
    this.sx = pyRound(px);                // +0x00 (FUN_1000_14df rounding; int(round(px)))
    this.sy = pyRound(py);                // +0x02
    this.prev_px = this.px;
    this.prev_py = this.py;
    this.saved_vx = this.vx;              // DAT_5f38_e4dc pre-bounce vx (FUN_2a4a_0b1f.c:70)
    this.saved_vy = this.vy;              // DAT_5f38_e4e4 pre-bounce vy (FUN_2a4a_0b1f.c:71)
    this.weapon = weapon;
    this.weapon_type = weapon.idx;        // +0x26
    this.owner = owner;
    this.owner_index = owner ? owner.player_index : -1;
    this.active = true;                   // +0x3c
    this.mode = 0;                        // +0x4a (1 = stuck/landed)
    this.flags = 0;                       // +0x3a (bit0 = dirt/riot blast)
    this.bounce_energy = C.BOUNCE_ENERGY; // +0x32 (seed 0.8, DAT_5f38_1d24)
    this.bounce_count = 0;                // +0x30 wall-bounce counter (FUN_2a4a_0763.c:87)
    this.spring_armed = false;            // DAT_5f38_1c7a spring-catapult flag
    this.warheads_left = weapon.warheads; // multi-warhead counter (+0x2e analog)
    this.guidance = null;                 // +0x4c predicate analog
    this.target = null;
    this.state = {};                      // behavior scratch (rollers/diggers/etc.)
    this.trail = [];                      // TRACE / smoke-tracer path
    this.armed = true;                    // self-hit / muzzle-clearance gate
    this.split_done = false;              // MIRV apogee split latch
    // Contact Trigger (+0x4a == 0xffff in the original): this shot detonates on
    // FIRST contact, disabling tunnelling for it (DOC L1436 "equivalent to
    // turning off the Tunneling option"). One trigger covers all MIRV warheads,
    // so children inherit it. Default off.
    this.contact = false;
  }
}

/** Player struct array entry (stride 0xca). */
export class Tank {
  player_index: number;
  name: string;
  ai_class: number;
  reveal_type: number;
  team_id: number;
  color: number;
  tank_icon: number;
  mobile: boolean;

  // kinematics / placement
  x: number;
  y: number;
  half_width: number;
  angle: number;
  power: number;

  // health / life
  health: number;
  alive: boolean;

  // defenses
  shield_hp: number;
  shield_item: number;
  shield_push: boolean;
  shield_deflect: boolean;
  shield_laserproof: boolean;
  shield_failproof: boolean;
  parachute_deployed: boolean;
  parachute_threshold: number;
  chute_up: number;
  contact_trigger: boolean;
  selected_guidance: unknown;
  guidance_target: unknown;
  guidance_target_pt: unknown;

  // economy
  cash: number;
  cash_ceiling: number;
  inventory: number[];
  selected_weapon: number;
  fuel_remainder: number;

  // scoring / stats
  score: number;
  win_counter: number;
  hits_this_round: { [k: number]: number };
  hits_career: { [k: number]: number };

  // fall state (indexed-by-player arrays in the original)
  fall_accum: number;
  falling: boolean;

  // AI scratch
  ai_tries: number;
  ai_saved_tactic: unknown;

  constructor(
    player_index: number,
    name: string,
    ai_class: number = 0,
    team_id: number = 0,
    tank_icon: number = 0,
  ) {
    this.player_index = player_index;     // +0xa0
    this.name = name;
    this.ai_class = ai_class;             // +0x22 (0 = human)
    this.reveal_type = ai_class ? ai_class - 1 : -1;  // +0x24
    this.team_id = team_id;               // +0x30
    this.color = 0;                       // palette index, set at placement
    // chosen tank-icon index (Tank Init Panel icon strip, SCORCH.DOC:L332-347).
    // Icons without wheels/treads are fixed emplacements: immobile, no fuel.
    this.tank_icon = tank_icon;
    this.mobile = true;                   // set False for a wheelless icon

    // kinematics / placement
    this.x = 0;                           // +0x0e screen X (center)
    this.y = 0;                           // +0x10 screen Y (base)
    this.half_width = 7;                  // +0x08
    this.angle = 45;                      // +0x32 firing angle (deg, 0=E,90=up,180=W)
    this.power = 500;                     // +0x34 firing power (0..1000)

    // health / life
    this.health = C.TANK_DEFAULT_HEALTH;  // tank+0xa2 (energy/health 0..100)
    this.alive = true;                    // +0x18 (in-play flag)

    // defenses
    this.shield_hp = 0;                   // +0x96
    this.shield_item = 0;                 // active shield slot (0 = none)
    this.shield_push = false;
    this.shield_deflect = false;
    this.shield_laserproof = false;
    this.shield_failproof = false;
    this.parachute_deployed = true;       // +0x28 (default deployed)
    this.parachute_threshold = C.PARACHUTE_THRESHOLD_DEFAULT;  // +0x2c (=5)
    this.chute_up = 0;                    // +0x0c (chute up THIS fall)
    this.contact_trigger = false;         // one-shot detonate-on-contact
    this.selected_guidance = null;        // resets to None after firing
    this.guidance_target = null;          // +0xae/+0xb0 chosen target tank (Choose Target)
    this.guidance_target_pt = null;       // +0x3a/+0x3c stored click point (x,y)

    // economy
    this.cash = 0;                        // +0xbe spendable cash (VERIFY_FIXES.md 1f)
    this.cash_ceiling = 0;                // DEAD: was +0xa6 (health-max) misread as a cash
    //   cap; economy.credit no longer clamps to it. Kept only for savegame compat.
    this.inventory = new Array<number>(weapons.NUM_ITEMS).fill(0);  // per-item counts (*(tank+0xb2))
    this.inventory[weapons.SLOT_BABY_MISSILE] = 99;  // FUN_3a16_0320.c:31 seeds
    //   slot 0 = 99 unconditionally at every tank init; the "unlimited" Baby
    //   Missile is a live, decrementing count (not a sentinel) -- see consume().
    this.selected_weapon = 0;             // current weapon slot
    // fuel: +0xaa = the tenths-of-a-tank REMAINDER counter (FUN_3a16_0718).
    // Total fuel units = inventory[SLOT_FUEL]*10 + fuel_remainder, the
    // net-worth form of FUN_3a16_06e9 (catalog 20_inventory_ab.md:141). Seeded
    // at 0; a set inventory of N Fuel Tanks is therefore N*10 units with no
    // separate round-seed. movement.move_tank spends this; see movement.py.
    this.fuel_remainder = 0;              // +0xaa (live spend counter)

    // scoring / stats
    this.score = 0;                       // +0xac cumulative score
    this.win_counter = 0;                 // +0x94 rounds-survived
    this.hits_this_round = {};            // +0x52[attacker]
    this.hits_career = {};                // +0x66[attacker] (persists match)

    // fall state (indexed-by-player arrays in the original)
    this.fall_accum = 0;                  // DAT_5f38_ce80[player]
    this.falling = false;

    // AI scratch
    this.ai_tries = 0;                    // +0x38 ranging attempt counter
    this.ai_saved_tactic = null;          // +0x8e delegated tactic (Chooser/Cyborg)
  }

  // ----- baby missiles are unlimited (manual L1043) -----
  has_ammo(slot: number): boolean {
    // Slot 0 is never "out": the binary's weapon-select fallback always lands
    // on it and refills to 99 (FUN_38b5_145b.c:18), so it is always firable.
    if (slot === weapons.SLOT_BABY_MISSILE) {
      return true;
    }
    return this.inventory[slot] > 0;
  }

  consume(slot: number): void {
    if (slot === weapons.SLOT_BABY_MISSILE) {
      // The binary holds slot 0 as a live count: fire decrements it, and the
      // weapon-select fallback tops it back to 99 when it would empty (seed
      // FUN_3a16_0320.c:31 = 99; refill FUN_38b5_145b.c:18 = 99). Collapse
      // that to a zero-crossing refill so the HUD shows a count ticking down
      // and snapping back to 99 -- never a "--" sentinel, never a stuck 0.
      // INTERP: the original briefly shows 0 between the depleting shot and
      // the next select; the port refills one shot earlier (1 -> 99). The
      // divergence is a single frame at the floor.
      this.inventory[slot] = this.inventory[slot] > 1 ? this.inventory[slot] - 1 : 99;
      return;
    }
    if (this.inventory[slot] > 0) {
      this.inventory[slot] -= 1;
    }
  }

  /** Total fuel units available = inventory[SLOT_FUEL]*10 + remainder
   * (FUN_3a16_06e9 net-worth form; see fuel_remainder above). */
  get fuel(): number {
    return this.inventory[weapons.SLOT_FUEL] * 10 + this.fuel_remainder;
  }

  get parachutes(): number {
    return this.inventory[weapons.SLOT_PARACHUTE];
  }

  get batteries(): number {
    return this.inventory[weapons.SLOT_BATTERY];
  }
}

/**
 * The 48-item equipment table (weapons + defense/utility) -- a faithful
 * TypeScript port of scorch-py/scorch/weapons.py (the fidelity oracle, itself
 * byte-verified against 1.5/SCORCH.EXE).
 *
 * On-disk order and (cost, bundle, arms) are FACT from catalog 08 section 1
 * (base-cost table read byte-exact, DAT_5f38_1bb6 = 48 items, stride 0x34).
 * Names/categories cross-referenced with catalog 01 (weapons) and 02 (equipment).
 * Blast radii are the authoritative MECHANICS addenda values (weapon table +0x04
 * and the size table 5f38:529e). The binary's (cost,bundle,arms) is source of
 * truth where it diverges from the manual (e.g. Smoke Tracer arms 0).
 *
 * behavior keys drive weapon_behaviors dispatch. Multi-warhead / fire / dirt
 * params (warheads, fan, depth, heat) are from MECHANICS "Weapon behaviors".
 *
 * NUMERIC NOTE: this module has no transcendental math and no rng. Every field is
 * an integer, a string, a boolean, or an exactly-representable float, so the
 * differential gate (test/weapons.test.ts) asserts all of them with exact
 * equality (no epsilon).
 */

/** Per-item params bag (heterogeneous: ints, bools, int arrays). Mirrors the
 * Python `params: dict` (default empty). */
export type ItemParams = { [k: string]: number | boolean | number[] };

/** Options carrying the Item fields that have defaults in the Python dataclass
 * (everything after `category`). Each default matches scorch/weapons.py:16-30. */
export interface ItemOptions {
  blast?: number;       // base blast radius R (px); negative = dirt removal depth
  behavior?: string;
  warheads?: number;    // multi-warhead split count
  fan?: number;         // x-velocity spread of split warheads
  heat?: number;        // napalm heat coefficient
  params?: ItemParams;
  enabled?: boolean;    // Weapons-menu per-item enable/disable toggle
}

export class Item {
  idx: number;
  name: string;
  cost: number;
  bundle: number;
  arms: number;
  category: string;
  blast: number;
  behavior: string;
  warheads: number;
  fan: number;
  heat: number;
  params: ItemParams;
  enabled: boolean;

  constructor(
    idx: number,
    name: string,
    cost: number,
    bundle: number,
    arms: number,
    category: string,
    opts: ItemOptions = {},
  ) {
    this.idx = idx;
    this.name = name;
    this.cost = cost;
    this.bundle = bundle;
    this.arms = arms;
    this.category = category;
    // Defaults per the @dataclass field declarations (weapons.py:23-30).
    this.blast = opts.blast ?? 0;
    this.behavior = opts.behavior ?? "explosive";
    this.warheads = opts.warheads ?? 1;
    this.fan = opts.fan ?? 0;
    this.heat = opts.heat ?? 0;
    // field(default_factory=dict): a fresh dict per record. Mirror that by
    // defaulting to a new object so records never share a params reference.
    this.params = opts.params ?? {};
    this.enabled = opts.enabled ?? true;
  }

  /** @property offensive: category not in {guidance, shield, utility}. */
  get offensive(): boolean {
    return (
      this.category !== "guidance" &&
      this.category !== "shield" &&
      this.category !== "utility"
    );
  }
}

// Categories: explosive, nuclear, multi, fire, tracer, roller, riot, digger,
//   sandhog, dirt, energy, special, guidance, shield, utility.
// prettier-ignore
export const ITEMS: Item[] = [
  // idx, name,              cost,  bndl, arms, category,    extras...
  new Item( 0, "Baby Missile",    400,  10, 0, "explosive", { blast: 10, behavior: "explosive" }),
  new Item( 1, "Missile",        1875,   5, 0, "explosive", { blast: 20, behavior: "explosive" }),
  new Item( 2, "Baby Nuke",     10000,   3, 0, "nuclear",   { blast: 40, behavior: "explosive" }),
  new Item( 3, "Nuke",          12000,   1, 1, "nuclear",   { blast: 75, behavior: "explosive" }),
  new Item( 4, "LeapFrog",      10000,   2, 3, "multi",     { blast: 20, behavior: "leapfrog", warheads: 3,
            params: { radii: [20, 25, 30] } }),
  new Item( 5, "Funky Bomb",     7000,   2, 4, "special",   { blast: 80, behavior: "funky",
            params: { scatter: 15 } }),
  new Item( 6, "MIRV",          10000,   3, 2, "multi",     { blast: 20, behavior: "mirv", warheads: 5, fan: 50 }),
  new Item( 7, "Death's Head",  20000,   1, 4, "multi",     { blast: 35, behavior: "mirv", warheads: 9, fan: 20 }),
  new Item( 8, "Napalm",        10000,  10, 2, "fire",      { blast: 15, behavior: "napalm", heat: 25,
            params: { deep_heat: 30 } }),
  new Item( 9, "Hot Napalm",    20000,   2, 4, "fire",      { blast: 20, behavior: "napalm", heat: 40,
            params: { deep_heat: 50 } }),
  new Item(10, "Tracer",           10,  20, 0, "tracer",    { blast: 0, behavior: "tracer" }),
  new Item(11, "Smoke Tracer",    500,  10, 0, "tracer",    { blast: 0, behavior: "tracer",
            params: { smoke: true } }),
  new Item(12, "Baby Roller",    5000,  10, 2, "roller",    { blast: 10, behavior: "roller" }),
  new Item(13, "Roller",         6000,   5, 2, "roller",    { blast: 20, behavior: "roller" }),
  new Item(14, "Heavy Roller",   6750,   2, 3, "roller",    { blast: 45, behavior: "roller" }),
  new Item(15, "Riot Charge",    2000,  10, 2, "riot",      { blast: 36, behavior: "riot_wedge" }),
  new Item(16, "Riot Blast",     5000,   5, 3, "riot",      { blast: 60, behavior: "riot_wedge" }),
  new Item(17, "Riot Bomb",      5000,   5, 3, "riot",      { blast: 30, behavior: "riot_sphere" }),
  new Item(18, "Heavy Riot Bomb", 4750,  2, 3, "riot",      { blast: 45, behavior: "riot_sphere" }),
  new Item(19, "Baby Digger",    3000,  10, 0, "digger",    { blast: -10, behavior: "digger" }),
  new Item(20, "Digger",         2500,   5, 0, "digger",    { blast: -20, behavior: "digger" }),
  new Item(21, "Heavy Digger",   6750,   2, 1, "digger",    { blast: -35, behavior: "digger" }),
  new Item(22, "Baby Sandhog",  10000,  10, 0, "sandhog",   { blast: 10, behavior: "sandhog", warheads: 1 }),
  new Item(23, "Sandhog",       16750,   5, 0, "sandhog",   { blast: 15, behavior: "sandhog", warheads: 2 }),
  new Item(24, "Heavy Sandhog", 25000,   2, 1, "sandhog",   { blast: 20, behavior: "sandhog", warheads: 4 }),
  new Item(25, "Dirt Clod",      5000,  10, 0, "dirt",      { blast: 20, behavior: "dirt_sphere" }),
  new Item(26, "Dirt Ball",      5000,   5, 0, "dirt",      { blast: 35, behavior: "dirt_sphere" }),
  new Item(27, "Ton of Dirt",    6750,   2, 1, "dirt",      { blast: 70, behavior: "dirt_sphere" }),
  new Item(28, "Liquid Dirt",    5000,   5, 2, "dirt",      { blast: 25, behavior: "dirt_slump" }),
  new Item(29, "Dirt Charge",    5000,  10, 1, "dirt",      { blast: 30, behavior: "dirt_wedge" }),
  new Item(30, "Earth Disrupter", 5000, 10, 0, "dirt",      { blast: 0, behavior: "dirt_settle" }),
  // Plasma Blast radius is NOT byte-exact recoverable. RECOVERED_BATTERY.md:
  // the real Plasma handler is rec 31 -> {IP=0x9,SEG=0x2770} = FUN_3770_0009
  // (synchronous charge-and-fire), radius = 1242 + (12aa-1242)*tier/10 where
  // tier in [0,min(ammo,10)]; both endpoints 5f38:1242/12aa are BSS, 00 00 on
  // disk, no initializer in the corpus -> unrecoverable. Static base word +0x04
  // is 0 (file 0x575d0). NOTE: RECOVERED_FP.md T2 mislabeled handler
  // {0x3bd,0x2f76}=FUN_3f76_03bd "Plasma"; that handler is records 17/18 =
  // Riot Bomb / Heavy Riot Bomb (base 30/45), already correct above. blast=40
  // is a FLAGGED placeholder inside the manual's documented 10..75 Plasma
  // envelope (RECOVERED_FP.md:280), not a recovered constant.
  new Item(31, "Plasma Blast",   9000,   5, 3, "energy",    { blast: 40, behavior: "plasma" }),
  new Item(32, "Laser",          5000,   5, 2, "energy",    { blast: 0, behavior: "laser" }),
  // ---- equipment (non-projectile) ----
  new Item(33, "Heat Guidance", 10000,   6, 2, "guidance",  { behavior: "equip" }),
  new Item(34, "Bal Guidance",  10000,   2, 2, "guidance",  { behavior: "equip" }),
  new Item(35, "Horz Guidance", 15000,   5, 1, "guidance",  { behavior: "equip" }),
  new Item(36, "Vert Guidance", 20000,   5, 1, "guidance",  { behavior: "equip" }),
  new Item(37, "Lazy Boy",      20000,   2, 3, "guidance",  { behavior: "equip" }),
  new Item(38, "Parachute",     10000,   8, 2, "utility",   { behavior: "equip" }),
  new Item(39, "Battery",        5000,  10, 2, "utility",   { behavior: "equip" }),
  // Shield HP byte-exact from the 5 shield-def structs at 5f38:61d0..61e0
  // (RECOVERED_SHIELDS.md T1, armed at FUN_4191_0455:46); 100/250/400/600/800
  // were all guesses. Flag (+0xc): MagDef 0x2 push, Force 0x1 bounce/deflect,
  // SuperMag 0x4 push (+ laser-recharge special-case FUN_3319_01fe:63). No
  // failproof bit exists (Heavy/SuperMag flag 0x0/0x4) and shield failure is
  // deterministic-only (T2), so the `failproof` flag is dropped. Force Shield
  // HP == normal Shield HP == 100 in code (binary; contradicts manual prose).
  new Item(40, "Mag Deflector", 10000,   2, 2, "shield",    { behavior: "equip", params: { hp: 55, push: true } }),
  new Item(41, "Shield",        20000,   3, 3, "shield",    { behavior: "equip", params: { hp: 100 } }),
  new Item(42, "Force Shield",  25000,   3, 3, "shield",    { behavior: "equip", params: { hp: 100, deflect: true } }),
  new Item(43, "Heavy Shield",  30000,   2, 4, "shield",    { behavior: "equip", params: { hp: 150 } }),
  new Item(44, "Super Mag",     40000,   2, 4, "shield",    { behavior: "equip",
            params: { hp: 200, push: true, laserproof: true } }),
  new Item(45, "Auto Defense",   1500,   1, 3, "utility",   { behavior: "equip" }),
  new Item(46, "Fuel Tank",     10000,  10, 3, "utility",   { behavior: "equip" }),
  new Item(47, "Contact Trigger", 1000, 25, 3, "utility",   { behavior: "equip" }),
];

export const NUM_ITEMS = ITEMS.length;   // 48 (DAT_5f38_1bb6)
if (NUM_ITEMS !== 48) {
  // Mirrors `assert NUM_ITEMS == 48` in weapons.py:118.
  throw new Error(`NUM_ITEMS must be 48, got ${NUM_ITEMS}`);
}

// Named slot indices used by AI-buy / shield logic (catalog 14 section 6.1
// resolves these via DAT_5f38_d554/d556/d55a..d55e at store init).
export const SLOT_BABY_MISSILE = 0;
export const SLOT_MISSILE = 1;
export const SLOT_PARACHUTE = 38;
export const SLOT_BATTERY = 39;
export const SLOT_MAG_DEFLECTOR = 40;
export const SLOT_SHIELD = 41;
export const SLOT_FORCE_SHIELD = 42;
export const SLOT_HEAVY_SHIELD = 43;
export const SLOT_SUPER_MAG = 44;
export const SLOT_AUTO_DEFENSE = 45;
export const SLOT_FUEL = 46;
export const SLOT_CONTACT_TRIGGER = 47;

export const SHIELD_SLOTS: readonly number[] = [
  SLOT_MAG_DEFLECTOR,
  SLOT_SHIELD,
  SLOT_FORCE_SHIELD,
  SLOT_HEAVY_SHIELD,
  SLOT_SUPER_MAG,
];

// Reconstructed desirability weights for the Moron weighted-random buyer
// (DAT_5f38_52ae[], catalog 14 section 6.2: Baby Missile 3.0, Missile/Nuke 2.0,
// Baby Nuke 1.0, heavies/MIRV/napalm ~0.1-0.2, most dirt/utility 0.0).
// Keyed by item idx, matching the Python dict's int keys.
export const MORON_WEIGHTS: { [idx: number]: number } = {
  0: 3.0, 1: 2.0, 2: 1.0, 3: 2.0, 6: 0.2, 7: 0.1, 8: 0.2, 9: 0.1,
  12: 0.2, 13: 0.2, 17: 0.2, 25: 0.1, 31: 0.2, 32: 0.2,
};

/** Case-insensitive name lookup; returns the Item or null (Python returns None).
 * Matches weapons.py:147-151 exactly: first record whose name.lower() equals the
 * query's lower-case. NO whitespace stripping. */
export function by_name(name: string): Item | null {
  for (const it of ITEMS) {
    if (it.name.toLowerCase() === name.toLowerCase()) {
      return it;
    }
  }
  return null;
}

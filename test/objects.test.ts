/**
 * Differential gate: TS objects (Projectile + Tank) == Python scorch/objects.py,
 * field-exact.
 *
 * Golden vectors are produced by oracle/dump_objects.py from the Python port
 * (itself byte-verified against 1.5/SCORCH.EXE) and written to
 * oracle/vectors/objects.json.
 *
 * EPSILON: NONE. The objects module has no transcendental math (no
 * sin/cos/pow/sqrt/atan2) and no rng; every field is an int, an
 * exactly-representable float (literal defaults like 0.8, or pure assignments of
 * the dumped px/py/vx/vy doubles), a boolean, a string, or a structural
 * descriptor. So every assertion below is EXACT equality (toBe / toEqual). The
 * one rounding op, Projectile.sx/sy = int(round(px/py)), is integer-valued and
 * checked with toBe; it uses pyRound() (CPython round-half-to-even), which the
 * dense `pyround` battery proves bit-identical to CPython round -- the place JS
 * Math.round would diverge on every .5 tie.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Projectile, Tank, pyRound } from "../src/objects";
import { ITEMS } from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "objects.json");

type ProjRec = {
  vx: number; vy: number; px: number; py: number;
  sx: number; sy: number; prev_px: number; prev_py: number;
  saved_vx: number; saved_vy: number;
  weapon_idx: number; weapon_type: number;
  owner_index: number; owner_is_none: boolean;
  active: boolean; mode: number; flags: number;
  bounce_energy: number; bounce_count: number; spring_armed: boolean;
  warheads_left: number; guidance_is_none: boolean; target_is_none: boolean;
  state_empty: boolean; trail_len: number;
  armed: boolean; split_done: boolean; contact: boolean;
};

type TankRec = {
  player_index: number; name: string; ai_class: number; reveal_type: number;
  team_id: number; color: number; tank_icon: number; mobile: boolean;
  x: number; y: number; half_width: number; angle: number; power: number;
  health: number; alive: boolean;
  shield_hp: number; shield_item: number; shield_push: boolean;
  shield_deflect: boolean; shield_laserproof: boolean; shield_failproof: boolean;
  parachute_deployed: boolean; parachute_threshold: number; chute_up: number;
  contact_trigger: boolean;
  selected_guidance_is_none: boolean; guidance_target_is_none: boolean;
  guidance_target_pt_is_none: boolean;
  cash: number; cash_ceiling: number; inventory: number[]; inventory_len: number;
  selected_weapon: number; fuel_remainder: number;
  score: number; win_counter: number;
  hits_this_round_empty: boolean; hits_career_empty: boolean;
  fall_accum: number; falling: boolean;
  ai_tries: number; ai_saved_tactic_is_none: boolean;
  fuel: number; parachutes: number; batteries: number;
};

type ObjectsVectors = {
  constants: {
    TANK_DEFAULT_HEALTH: number; PARACHUTE_THRESHOLD_DEFAULT: number;
    BOUNCE_ENERGY: number; NUM_ITEMS: number; SLOT_BABY_MISSILE: number;
    SLOT_FUEL: number; SLOT_PARACHUTE: number; SLOT_BATTERY: number;
  };
  proj_keys: string[];
  tank_keys: string[];
  pyround: { x: number; round: number }[];
  projectiles: ProjRec[];
  tanks: TankRec[];
  has_ammo: { label: string; slots: number[]; out: boolean[] }[];
  consume: {
    label: string; slot: number; start: number;
    steps: { slot_val: number; has_ammo: boolean }[];
  }[];
  props: {
    fuel_tanks: number; fuel_remainder: number;
    parachutes_inv: number; batteries_inv: number;
    fuel: number; parachutes: number; batteries: number;
  }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as ObjectsVectors;

// Build a TS Tank whose player_index equals the dumped owner_index, so the
// Projectile constructor's owner_index derivation is checked independently
// (owner ? owner.player_index : -1). null when the dump recorded owner_is_none.
function ownerFor(rec: ProjRec): Tank | null {
  if (rec.owner_is_none) return null;
  return new Tank(rec.owner_index, "owner");
}

// Re-derive a Projectile record from a freshly constructed TS Projectile, mapping
// references to the same structural descriptors the Python dumper emitted.
function projRecord(p: Projectile): ProjRec {
  return {
    vx: p.vx, vy: p.vy, px: p.px, py: p.py,
    sx: p.sx, sy: p.sy, prev_px: p.prev_px, prev_py: p.prev_py,
    saved_vx: p.saved_vx, saved_vy: p.saved_vy,
    weapon_idx: p.weapon.idx, weapon_type: p.weapon_type,
    owner_index: p.owner_index, owner_is_none: p.owner === null,
    active: p.active, mode: p.mode, flags: p.flags,
    bounce_energy: p.bounce_energy, bounce_count: p.bounce_count,
    spring_armed: p.spring_armed,
    warheads_left: p.warheads_left,
    guidance_is_none: p.guidance === null,
    target_is_none: p.target === null,
    state_empty: Object.keys(p.state).length === 0,
    trail_len: p.trail.length,
    armed: p.armed, split_done: p.split_done, contact: p.contact,
  };
}

function tankRecord(t: Tank): TankRec {
  return {
    player_index: t.player_index, name: t.name, ai_class: t.ai_class,
    reveal_type: t.reveal_type, team_id: t.team_id, color: t.color,
    tank_icon: t.tank_icon, mobile: t.mobile,
    x: t.x, y: t.y, half_width: t.half_width, angle: t.angle, power: t.power,
    health: t.health, alive: t.alive,
    shield_hp: t.shield_hp, shield_item: t.shield_item, shield_push: t.shield_push,
    shield_deflect: t.shield_deflect, shield_laserproof: t.shield_laserproof,
    shield_failproof: t.shield_failproof,
    parachute_deployed: t.parachute_deployed,
    parachute_threshold: t.parachute_threshold, chute_up: t.chute_up,
    contact_trigger: t.contact_trigger,
    selected_guidance_is_none: t.selected_guidance === null,
    guidance_target_is_none: t.guidance_target === null,
    guidance_target_pt_is_none: t.guidance_target_pt === null,
    cash: t.cash, cash_ceiling: t.cash_ceiling,
    inventory: t.inventory.slice(), inventory_len: t.inventory.length,
    selected_weapon: t.selected_weapon, fuel_remainder: t.fuel_remainder,
    score: t.score, win_counter: t.win_counter,
    hits_this_round_empty: Object.keys(t.hits_this_round).length === 0,
    hits_career_empty: Object.keys(t.hits_career).length === 0,
    fall_accum: t.fall_accum, falling: t.falling,
    ai_tries: t.ai_tries, ai_saved_tactic_is_none: t.ai_saved_tactic === null,
    fuel: t.fuel, parachutes: t.parachutes, batteries: t.batteries,
  };
}

// ---------------------------------------------------------------------------
describe("objects: pyRound == CPython round (half-to-even)", () => {
  it(`${vec.pyround.length} round() probes match (incl. .5 ties -> even)`, () => {
    for (let i = 0; i < vec.pyround.length; i++) {
      const { x, round } = vec.pyround[i];
      expect(pyRound(x), `pyRound(${x}) #${i}`).toBe(round);
    }
  });
  it("the .5 ties round to the EVEN neighbour (the Math.round divergence)", () => {
    // Spot-pin the exact ties Math.round would get wrong.
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(-0.5)).toBe(0);
    expect(pyRound(-1.5)).toBe(-2);
    expect(pyRound(99.5)).toBe(100);
    expect(pyRound(100.5)).toBe(100);
    // And a strictly-below-tie double is plain round-down (not steered to even).
    expect(pyRound(2.4999999999999996)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("objects: Projectile field shape (key set)", () => {
  it("a TS Projectile record has exactly the Python field set", () => {
    const p = new Projectile(null, ITEMS[0], 0.0, 0.0, 0.0, 0.0);
    const tsKeys = Object.keys(projRecord(p)).sort();
    expect(tsKeys).toEqual(vec.proj_keys.slice().sort());
  });
});

describe("objects: Projectile construction is field-exact", () => {
  for (let i = 0; i < vec.projectiles.length; i++) {
    const ev = vec.projectiles[i];
    it(`projectile #${i} (px=${ev.px},py=${ev.py},w=${ev.weapon_idx}): all fields match`, () => {
      const p = new Projectile(ownerFor(ev), ITEMS[ev.weapon_idx], ev.px, ev.py, ev.vx, ev.vy);
      const rec = projRecord(p);
      // Assert every leaf exactly (floats here are pure assignments / int-valued).
      expect(rec.vx, "vx").toBe(ev.vx);
      expect(rec.vy, "vy").toBe(ev.vy);
      expect(rec.px, "px").toBe(ev.px);
      expect(rec.py, "py").toBe(ev.py);
      expect(rec.sx, "sx (int(round(px)))").toBe(ev.sx);
      expect(rec.sy, "sy (int(round(py)))").toBe(ev.sy);
      expect(rec.prev_px, "prev_px").toBe(ev.prev_px);
      expect(rec.prev_py, "prev_py").toBe(ev.prev_py);
      expect(rec.saved_vx, "saved_vx").toBe(ev.saved_vx);
      expect(rec.saved_vy, "saved_vy").toBe(ev.saved_vy);
      expect(rec.weapon_idx, "weapon_idx").toBe(ev.weapon_idx);
      expect(rec.weapon_type, "weapon_type").toBe(ev.weapon_type);
      expect(rec.owner_index, "owner_index").toBe(ev.owner_index);
      expect(rec.owner_is_none, "owner_is_none").toBe(ev.owner_is_none);
      expect(rec.active, "active").toBe(ev.active);
      expect(rec.mode, "mode").toBe(ev.mode);
      expect(rec.flags, "flags").toBe(ev.flags);
      expect(rec.bounce_energy, "bounce_energy").toBe(ev.bounce_energy);
      expect(rec.bounce_count, "bounce_count").toBe(ev.bounce_count);
      expect(rec.spring_armed, "spring_armed").toBe(ev.spring_armed);
      expect(rec.warheads_left, "warheads_left").toBe(ev.warheads_left);
      expect(rec.guidance_is_none, "guidance_is_none").toBe(ev.guidance_is_none);
      expect(rec.target_is_none, "target_is_none").toBe(ev.target_is_none);
      expect(rec.state_empty, "state_empty").toBe(ev.state_empty);
      expect(rec.trail_len, "trail_len").toBe(ev.trail_len);
      expect(rec.armed, "armed").toBe(ev.armed);
      expect(rec.split_done, "split_done").toBe(ev.split_done);
      expect(rec.contact, "contact").toBe(ev.contact);
    });
  }
});

// ---------------------------------------------------------------------------
describe("objects: Tank field shape (key set)", () => {
  it("a TS Tank record has exactly the Python field set", () => {
    const t = new Tank(0, "k");
    const tsKeys = Object.keys(tankRecord(t)).sort();
    expect(tsKeys).toEqual(vec.tank_keys.slice().sort());
  });
});

describe("objects: Tank construction is field-exact", () => {
  for (let i = 0; i < vec.tanks.length; i++) {
    const ev = vec.tanks[i];
    it(`tank #${i} (${ev.name}, ai=${ev.ai_class}, team=${ev.team_id}, icon=${ev.tank_icon}): all fields match`, () => {
      const t = new Tank(ev.player_index, ev.name, ev.ai_class, ev.team_id, ev.tank_icon);
      const rec = tankRecord(t);
      expect(rec.player_index, "player_index").toBe(ev.player_index);
      expect(rec.name, "name").toBe(ev.name);
      expect(rec.ai_class, "ai_class").toBe(ev.ai_class);
      expect(rec.reveal_type, "reveal_type").toBe(ev.reveal_type);
      expect(rec.team_id, "team_id").toBe(ev.team_id);
      expect(rec.color, "color").toBe(ev.color);
      expect(rec.tank_icon, "tank_icon").toBe(ev.tank_icon);
      expect(rec.mobile, "mobile").toBe(ev.mobile);
      expect(rec.x, "x").toBe(ev.x);
      expect(rec.y, "y").toBe(ev.y);
      expect(rec.half_width, "half_width").toBe(ev.half_width);
      expect(rec.angle, "angle").toBe(ev.angle);
      expect(rec.power, "power").toBe(ev.power);
      expect(rec.health, "health").toBe(ev.health);
      expect(rec.alive, "alive").toBe(ev.alive);
      expect(rec.shield_hp, "shield_hp").toBe(ev.shield_hp);
      expect(rec.shield_item, "shield_item").toBe(ev.shield_item);
      expect(rec.shield_push, "shield_push").toBe(ev.shield_push);
      expect(rec.shield_deflect, "shield_deflect").toBe(ev.shield_deflect);
      expect(rec.shield_laserproof, "shield_laserproof").toBe(ev.shield_laserproof);
      expect(rec.shield_failproof, "shield_failproof").toBe(ev.shield_failproof);
      expect(rec.parachute_deployed, "parachute_deployed").toBe(ev.parachute_deployed);
      expect(rec.parachute_threshold, "parachute_threshold").toBe(ev.parachute_threshold);
      expect(rec.chute_up, "chute_up").toBe(ev.chute_up);
      expect(rec.contact_trigger, "contact_trigger").toBe(ev.contact_trigger);
      expect(rec.selected_guidance_is_none, "selected_guidance_is_none").toBe(ev.selected_guidance_is_none);
      expect(rec.guidance_target_is_none, "guidance_target_is_none").toBe(ev.guidance_target_is_none);
      expect(rec.guidance_target_pt_is_none, "guidance_target_pt_is_none").toBe(ev.guidance_target_pt_is_none);
      expect(rec.cash, "cash").toBe(ev.cash);
      expect(rec.cash_ceiling, "cash_ceiling").toBe(ev.cash_ceiling);
      expect(rec.inventory_len, "inventory_len").toBe(ev.inventory_len);
      // full inventory vector, element-exact
      expect(rec.inventory, "inventory").toEqual(ev.inventory);
      expect(rec.selected_weapon, "selected_weapon").toBe(ev.selected_weapon);
      expect(rec.fuel_remainder, "fuel_remainder").toBe(ev.fuel_remainder);
      expect(rec.score, "score").toBe(ev.score);
      expect(rec.win_counter, "win_counter").toBe(ev.win_counter);
      expect(rec.hits_this_round_empty, "hits_this_round_empty").toBe(ev.hits_this_round_empty);
      expect(rec.hits_career_empty, "hits_career_empty").toBe(ev.hits_career_empty);
      expect(rec.fall_accum, "fall_accum").toBe(ev.fall_accum);
      expect(rec.falling, "falling").toBe(ev.falling);
      expect(rec.ai_tries, "ai_tries").toBe(ev.ai_tries);
      expect(rec.ai_saved_tactic_is_none, "ai_saved_tactic_is_none").toBe(ev.ai_saved_tactic_is_none);
      // computed properties at construction (default inventory)
      expect(rec.fuel, "fuel").toBe(ev.fuel);
      expect(rec.parachutes, "parachutes").toBe(ev.parachutes);
      expect(rec.batteries, "batteries").toBe(ev.batteries);
    });
  }
});

// ---------------------------------------------------------------------------
describe("objects: Tank.has_ammo", () => {
  for (const grp of vec.has_ammo) {
    it(`${grp.label}: ${grp.slots.length} slot probes match`, () => {
      // Reconstruct the inventory state for this group, then probe.
      const t = new Tank(0, grp.label);
      if (grp.label === "fresh") {
        // default tank (only slot 0 == 99)
      } else if (grp.label === "mixed_slot0_zeroed") {
        for (const s of [1, 5, 10, 38, 40, 46, 47]) t.inventory[s] = s;
        t.inventory[0] = 0;
      } else if (grp.label === "only_slot0_one") {
        for (let s = 0; s < t.inventory.length; s++) t.inventory[s] = 0;
        t.inventory[0] = 1;
      } else {
        throw new Error(`unknown has_ammo group ${grp.label}`);
      }
      for (let i = 0; i < grp.slots.length; i++) {
        expect(t.has_ammo(grp.slots[i]), `has_ammo(${grp.slots[i]}) in ${grp.label}`).toBe(grp.out[i]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
describe("objects: Tank.consume trajectories", () => {
  for (const seq of vec.consume) {
    it(`${seq.label}: slot ${seq.slot} from ${seq.start}, ${seq.steps.length} steps match`, () => {
      const t = new Tank(0, seq.label);
      t.inventory[seq.slot] = seq.start;
      for (let i = 0; i < seq.steps.length; i++) {
        t.consume(seq.slot);
        expect(t.inventory[seq.slot], `${seq.label} slot_val step ${i}`).toBe(seq.steps[i].slot_val);
        expect(t.has_ammo(seq.slot), `${seq.label} has_ammo step ${i}`).toBe(seq.steps[i].has_ammo);
      }
    });
  }
});

// ---------------------------------------------------------------------------
describe("objects: Tank fuel/parachutes/batteries properties", () => {
  for (let i = 0; i < vec.props.length; i++) {
    const c = vec.props[i];
    it(`case #${i} (fuel_tanks=${c.fuel_tanks}, rem=${c.fuel_remainder}): properties match`, () => {
      const t = new Tank(0, "p");
      t.inventory[vec.constants.SLOT_FUEL] = c.fuel_tanks;
      t.fuel_remainder = c.fuel_remainder;
      t.inventory[vec.constants.SLOT_PARACHUTE] = c.parachutes_inv;
      t.inventory[vec.constants.SLOT_BATTERY] = c.batteries_inv;
      expect(t.fuel, "fuel").toBe(c.fuel);
      expect(t.parachutes, "parachutes").toBe(c.parachutes);
      expect(t.batteries, "batteries").toBe(c.batteries);
    });
  }
});

// ---------------------------------------------------------------------------
describe("objects: constants the port imports match the dump", () => {
  it("TANK_DEFAULT_HEALTH / PARACHUTE_THRESHOLD / BOUNCE_ENERGY via constructed defaults", () => {
    const t = new Tank(0, "c");
    expect(t.health, "health default").toBe(vec.constants.TANK_DEFAULT_HEALTH);
    expect(t.parachute_threshold, "parachute_threshold default").toBe(vec.constants.PARACHUTE_THRESHOLD_DEFAULT);
    const p = new Projectile(null, ITEMS[0], 0.0, 0.0, 0.0, 0.0);
    expect(p.bounce_energy, "bounce_energy default").toBe(vec.constants.BOUNCE_ENERGY);
  });
});

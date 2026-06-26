/**
 * Differential gate: TS weapons table == Python scorch/weapons.py, field-exact.
 *
 * Golden vectors are produced by oracle/dump_weapons.py from the Python port
 * (itself byte-verified against 1.5/SCORCH.EXE) and written to
 * oracle/vectors/weapons.json. The weapons module is pure static data + a
 * case-insensitive string lookup: NO rng, NO transcendental math. Every emitted
 * value is an int / string / bool / exactly-representable float, so EVERY
 * assertion here is exact equality (toBe / toEqual). There is no float epsilon in
 * this module and none is warranted -- no sin/cos/pow/sqrt/atan2 anywhere on this
 * path (the params floats like MORON_WEIGHTS 0.2 are written as literals, equal
 * bit-for-bit).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  Item,
  ITEMS,
  NUM_ITEMS,
  SHIELD_SLOTS,
  MORON_WEIGHTS,
  by_name,
  SLOT_BABY_MISSILE,
  SLOT_MISSILE,
  SLOT_PARACHUTE,
  SLOT_BATTERY,
  SLOT_MAG_DEFLECTOR,
  SLOT_SHIELD,
  SLOT_FORCE_SHIELD,
  SLOT_HEAVY_SHIELD,
  SLOT_SUPER_MAG,
  SLOT_AUTO_DEFENSE,
  SLOT_FUEL,
  SLOT_CONTACT_TRIGGER,
} from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "weapons.json");

type ItemVec = {
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
  params: { [k: string]: number | boolean | number[] };
  enabled: boolean;
  offensive: boolean;
};

type WeaponsVectors = {
  num_items: number;
  field_names: string[];
  items: ItemVec[];
  slots: { [k: string]: number };
  shield_slots: number[];
  moron_weights: [number, number][];
  by_name: { name: string; found: boolean; idx: number | null }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as WeaponsVectors;

// Local name->constant map so we can check each emitted slot value against the
// actual exported TS constant (not just the JSON echoing itself).
const SLOT_CONSTS: { [k: string]: number } = {
  SLOT_BABY_MISSILE,
  SLOT_MISSILE,
  SLOT_PARACHUTE,
  SLOT_BATTERY,
  SLOT_MAG_DEFLECTOR,
  SLOT_SHIELD,
  SLOT_FORCE_SHIELD,
  SLOT_HEAVY_SHIELD,
  SLOT_SUPER_MAG,
  SLOT_AUTO_DEFENSE,
  SLOT_FUEL,
  SLOT_CONTACT_TRIGGER,
};

describe("weapons: table size", () => {
  it("NUM_ITEMS matches Python (48)", () => {
    expect(NUM_ITEMS).toBe(vec.num_items);
    expect(ITEMS.length).toBe(vec.num_items);
    expect(NUM_ITEMS).toBe(48);
  });
});

describe("weapons: every Item field is byte-exact", () => {
  for (const ev of vec.items) {
    it(`item ${ev.idx} (${ev.name}): all fields match`, () => {
      const it = ITEMS[ev.idx];
      // Index alignment: the array position must equal the record's own idx.
      expect(it.idx).toBe(ev.idx);
      expect(it.name).toBe(ev.name);
      expect(it.cost).toBe(ev.cost);
      expect(it.bundle).toBe(ev.bundle);
      expect(it.arms).toBe(ev.arms);
      expect(it.category).toBe(ev.category);
      expect(it.blast).toBe(ev.blast);
      expect(it.behavior).toBe(ev.behavior);
      expect(it.warheads).toBe(ev.warheads);
      expect(it.fan).toBe(ev.fan);
      expect(it.heat).toBe(ev.heat);
      expect(it.enabled).toBe(ev.enabled);
      // offensive is the computed @property; recompute on the TS side.
      expect(it.offensive).toBe(ev.offensive);
      // params: structural deep-equality (ints/bools/int-arrays, all exact).
      expect(it.params).toEqual(ev.params);
      // each params key individually, so a missing/extra key is pinpointed.
      const evKeys = Object.keys(ev.params).sort();
      expect(Object.keys(it.params).sort()).toEqual(evKeys);
      for (const k of evKeys) {
        expect(it.params[k], `params[${k}] of item ${ev.idx}`).toEqual(ev.params[k]);
      }
    });
  }
});

describe("weapons: named slot constants", () => {
  for (const [slotName, slotVal] of Object.entries(vec.slots)) {
    it(`${slotName} == ${slotVal}`, () => {
      expect(SLOT_CONSTS[slotName]).toBe(slotVal);
    });
  }
});

describe("weapons: SHIELD_SLOTS", () => {
  it("matches Python tuple order and values", () => {
    expect(Array.from(SHIELD_SLOTS)).toEqual(vec.shield_slots);
  });
});

describe("weapons: MORON_WEIGHTS", () => {
  it("has exactly the Python keys (and no extras)", () => {
    const tsKeys = Object.keys(MORON_WEIGHTS).map(Number).sort((a, b) => a - b);
    const pyKeys = vec.moron_weights.map(([k]) => k).sort((a, b) => a - b);
    expect(tsKeys).toEqual(pyKeys);
  });
  for (const [idx, weight] of vec.moron_weights) {
    it(`weight[${idx}] == ${weight}`, () => {
      expect(MORON_WEIGHTS[idx]).toBe(weight);
    });
  }
});

describe("weapons: by_name lookup (case-insensitive, no strip)", () => {
  for (let i = 0; i < vec.by_name.length; i++) {
    const probe = vec.by_name[i];
    it(`by_name(${JSON.stringify(probe.name)}) -> ${probe.found ? `idx ${probe.idx}` : "null"}`, () => {
      const hit = by_name(probe.name);
      if (probe.found) {
        expect(hit, `expected a hit for ${JSON.stringify(probe.name)}`).not.toBeNull();
        expect((hit as Item).idx).toBe(probe.idx);
      } else {
        expect(hit, `expected no hit for ${JSON.stringify(probe.name)}`).toBeNull();
      }
    });
  }
});

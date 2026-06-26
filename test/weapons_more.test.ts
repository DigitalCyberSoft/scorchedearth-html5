/**
 * Coverage mop-up (differential): an Item built with ONLY the required positional
 * fields exercises every `opts.* ?? default` (the behavior default in particular,
 * which every shipped ITEMS record overrides). Golden defaults come from
 * oracle/dump_more.py constructing the Python dataclass weapons.Item(99,"X",...).
 *
 * The `NUM_ITEMS !== 48` throw (weapons.ts:170-173) is a load-time assert that is
 * unreachable while ITEMS has its fixed 48 records; it mirrors weapons.py:118's
 * `assert NUM_ITEMS == 48` and is left as a documented defensive guard.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Item } from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "weapons_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

describe("weapons(more): Item dataclass defaults (no opts) match Python", () => {
  it("new Item(99,'X',0,1,0,'explosive') == weapons.Item defaults", () => {
    const d = vec.defaults;
    const it = new Item(99, "X", 0, 1, 0, "explosive");
    expect(it.idx).toBe(d.idx);
    expect(it.name).toBe(d.name);
    expect(it.cost).toBe(d.cost);
    expect(it.bundle).toBe(d.bundle);
    expect(it.arms).toBe(d.arms);
    expect(it.category).toBe(d.category);
    expect(it.blast).toBe(d.blast);
    expect(it.behavior).toBe(d.behavior); // "explosive" default (the ?? branch)
    expect(it.warheads).toBe(d.warheads);
    expect(it.fan).toBe(d.fan);
    expect(it.heat).toBe(d.heat);
    expect(it.params).toEqual(d.params);
    expect(it.enabled).toBe(d.enabled);
    expect(it.offensive).toBe(d.offensive);
  });

  it("each Item gets its OWN params object (no shared default-factory ref)", () => {
    const a = new Item(1, "A", 0, 1, 0, "explosive");
    const b = new Item(2, "B", 0, 1, 0, "explosive");
    (a.params as { [k: string]: number }).x = 1;
    expect(b.params).toEqual({}); // mirrors field(default_factory=dict)
  });
});

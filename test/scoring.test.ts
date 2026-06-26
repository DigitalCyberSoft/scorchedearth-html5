/**
 * Differential gate: TS scoring == Python scorch.scoring (the byte-verified oracle).
 *
 * Golden vectors are produced by oracle/dump_scoring.py from the Python port and
 * written to oracle/vectors/scoring.json. The Python dumper drives the REAL
 * scorch.scoring functions over lightweight mock Tank/Cfg/Economy/State objects;
 * this test builds STRUCTURALLY IDENTICAL mocks (same fields, same deterministic
 * unit_price formula) and asserts src/scoring.ts reproduces every result.
 *
 * EPSILON: none. Every scoring output is an integer award/penalty, an integer
 * floor-division survival share, an int()-truncated net-worth, a boolean
 * (friendly), or a stable id permutation (rank). There is NO transcendental math
 * (no sin/cos/pow/sqrt/atan2) anywhere in scoring, so every assertion is EXACT
 * (.toBe). The single float operation -- unit_price's `price/bundle` reused inside
 * net_worth -- is consumed by Math.trunc and the operand grouping matches Python
 * (`qty * (unit_price * 0.80)`), so the asserted net_worth is an exact integer that
 * IEEE754 reproduces bit-for-bit on both sides. (Verified in the oracle: e.g.
 * 9.9*30 == 297.0 exactly; 13 * unit_price(10) * 0.80 == 566.057... -> trunc 566.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  friendly,
  award_kill,
  award_hit,
  survival_award,
  net_worth,
  rank,
  type Tank,
  type State,
  type Economy,
  type Cfg,
} from "../src/scoring";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "scoring.json");

// ---------------------------------------------------------------------------
// Mocks -- mirror oracle/dump_scoring.py exactly. economy.unit_price uses the
// same deterministic fractional formula as the dumper so net_worth's truncation
// path is under genuine differential test.
// ---------------------------------------------------------------------------
function unitPriceFormula(slot: number): number {
  return (slot * 37 + 11) / 7.0; // mirror of dump_scoring.unit_price_formula
}

class MockEconomy implements Economy {
  unit_price(slot: number): number {
    return unitPriceFormula(slot);
  }
}

class MockTank implements Tank {
  id: string;
  team_id: number;
  alive: boolean;
  score: number;
  cash: number;
  win_counter: number;
  inventory: number[];
  constructor(
    id: string,
    opts: {
      team_id?: number;
      alive?: boolean;
      score?: number;
      cash?: number;
      win_counter?: number;
      inventory?: number[];
    } = {}
  ) {
    this.id = id;
    this.team_id = opts.team_id ?? 0;
    this.alive = opts.alive ?? true;
    this.score = opts.score ?? 0;
    this.cash = opts.cash ?? 0;
    this.win_counter = opts.win_counter ?? 0;
    this.inventory = opts.inventory ? opts.inventory.slice() : [];
  }
}

class MockState implements State {
  cfg: Cfg;
  tanks: MockTank[];
  economy: Economy;
  constructor(cfg: Cfg, tanks: MockTank[], economy?: Economy) {
    this.cfg = cfg;
    this.tanks = tanks;
    this.economy = economy ?? new MockEconomy();
  }
}

function mkCfg(scoring: number, team_mode: number): Cfg {
  return { scoring, team_mode };
}

/** Same field order the dumper's _snapshot emits: [score, cash, win_counter]. */
function snapshot(t: MockTank): [number, number, number] {
  return [t.score, t.cash, t.win_counter];
}

// ---------------------------------------------------------------------------
// Vector types (match dump_scoring.py case dicts).
// ---------------------------------------------------------------------------
type FriendlyCase = {
  fn: "friendly";
  team_mode: number;
  rel: "self" | "same_team" | "diff_team";
  friendly: boolean;
};
type AwardKillCase = {
  fn: "award_kill";
  scoring: number;
  team_mode: number;
  rel: "killer_none" | "self" | "teammate" | "enemy";
  start: number;
  tanks_after: number[][];
};
type AwardHitCase = {
  fn: "award_hit";
  scoring: number;
  team_mode: number;
  shield: boolean;
  damage: number;
  rel: "attacker_none" | "enemy" | "self" | "teammate" | "self_floor";
  tanks_after: number[][];
};
type SurvivalCase = {
  fn: "survival_award";
  scoring: number;
  team_mode: number;
  variant: string;
  tanks_after: number[][];
};
type NetWorthCase = {
  fn: "net_worth";
  inventory: number[];
  cash: number;
  net_worth: number;
};
type RankCase = {
  fn: "rank";
  scoring: number;
  variant: string;
  input_ids: string[];
  rank: string[];
};
type Case =
  | FriendlyCase
  | AwardKillCase
  | AwardHitCase
  | SurvivalCase
  | NetWorthCase
  | RankCase;

type ScoringVectors = {
  module: string;
  unit_price_formula: string;
  cases: Case[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as ScoringVectors;

const byFn = <T extends Case>(fn: T["fn"]): T[] =>
  vec.cases.filter((c) => c.fn === fn) as T[];

// Lock the oracle's mock economy formula to the test's. If the dumper ever changes
// it, this fails loudly rather than silently diverging.
describe("scoring: oracle/mock invariants", () => {
  it("module tag and unit_price formula match the dumper", () => {
    expect(vec.module).toBe("scoring");
    expect(vec.unit_price_formula).toBe("(slot*37 + 11) / 7.0");
  });
  it("vector battery is non-trivial", () => {
    expect(vec.cases.length).toBeGreaterThan(900);
  });
});

describe("scoring: friendly()", () => {
  const cases = byFn<FriendlyCase>("friendly");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    it(`#${i} team_mode=${c.team_mode} rel=${c.rel} -> ${c.friendly}`, () => {
      const cfg = mkCfg(1 /* STANDARD */, c.team_mode);
      const a = new MockTank("a", { team_id: 1 });
      const bSame = new MockTank("b", { team_id: 1 });
      const bDiff = new MockTank("c", { team_id: 2 });
      const st = new MockState(cfg, [a, bSame, bDiff]);
      let got: boolean;
      if (c.rel === "self") got = friendly(st, a, a);
      else if (c.rel === "same_team") got = friendly(st, a, bSame);
      else got = friendly(st, a, bDiff);
      expect(got).toBe(c.friendly);
    });
  }
});

describe("scoring: award_kill()", () => {
  const cases = byFn<AwardKillCase>("award_kill");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label = `#${i} scoring=${c.scoring} team=${c.team_mode} rel=${c.rel} start=${c.start}`;
    it(label, () => {
      const cfg = mkCfg(c.scoring, c.team_mode);
      let tanks: MockTank[];
      if (c.rel === "killer_none") {
        const k = new MockTank("k", { team_id: 1, score: c.start, cash: c.start });
        const v = new MockTank("v", { team_id: 2 });
        const st = new MockState(cfg, [k, v]);
        award_kill(st, null, v);
        tanks = [k, v];
      } else if (c.rel === "self") {
        const k = new MockTank("k", { team_id: 1, score: c.start, cash: c.start });
        const st = new MockState(cfg, [k]);
        award_kill(st, k, k);
        tanks = [k];
      } else if (c.rel === "teammate") {
        const k = new MockTank("k", { team_id: 1, score: c.start, cash: c.start });
        const v = new MockTank("v", { team_id: 1 });
        const st = new MockState(cfg, [k, v]);
        award_kill(st, k, v);
        tanks = [k, v];
      } else {
        const k = new MockTank("k", { team_id: 1, score: c.start, cash: c.start });
        const v = new MockTank("v", { team_id: 2 });
        const st = new MockState(cfg, [k, v]);
        award_kill(st, k, v);
        tanks = [k, v];
      }
      const after = tanks.map(snapshot);
      expect(after.length).toBe(c.tanks_after.length);
      for (let t = 0; t < after.length; t++) {
        expect(after[t][0], `${label} tank${t}.score`).toBe(c.tanks_after[t][0]);
        expect(after[t][1], `${label} tank${t}.cash`).toBe(c.tanks_after[t][1]);
        expect(after[t][2], `${label} tank${t}.win_counter`).toBe(c.tanks_after[t][2]);
      }
    });
  }
});

describe("scoring: award_hit()", () => {
  const cases = byFn<AwardHitCase>("award_hit");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label = `#${i} scoring=${c.scoring} team=${c.team_mode} shield=${c.shield} dmg=${c.damage} rel=${c.rel}`;
    it(label, () => {
      const cfg = mkCfg(c.scoring, c.team_mode);
      let tanks: MockTank[];
      if (c.rel === "attacker_none") {
        const a = new MockTank("a", { team_id: 1 });
        const v = new MockTank("v", { team_id: 2 });
        const st = new MockState(cfg, [a, v]);
        award_hit(st, null, v, c.damage, c.shield);
        tanks = [a, v];
      } else if (c.rel === "enemy") {
        const a = new MockTank("a", { team_id: 1 });
        const v = new MockTank("v", { team_id: 2 });
        const st = new MockState(cfg, [a, v]);
        award_hit(st, a, v, c.damage, c.shield);
        tanks = [a, v];
      } else if (c.rel === "self") {
        const a = new MockTank("a", { team_id: 1 });
        const st = new MockState(cfg, [a]);
        award_hit(st, a, a, c.damage, c.shield);
        tanks = [a];
      } else if (c.rel === "teammate") {
        const a = new MockTank("a", { team_id: 1 });
        const v = new MockTank("v", { team_id: 1 });
        const st = new MockState(cfg, [a, v]);
        award_hit(st, a, v, c.damage, c.shield);
        tanks = [a, v];
      } else {
        // self_floor
        const a = new MockTank("a", { team_id: 1, score: 100, cash: 20 });
        const st = new MockState(cfg, [a]);
        award_hit(st, a, a, c.damage, c.shield);
        tanks = [a];
      }
      const after = tanks.map(snapshot);
      expect(after.length).toBe(c.tanks_after.length);
      for (let t = 0; t < after.length; t++) {
        expect(after[t][0], `${label} tank${t}.score`).toBe(c.tanks_after[t][0]);
        expect(after[t][1], `${label} tank${t}.cash`).toBe(c.tanks_after[t][1]);
        expect(after[t][2], `${label} tank${t}.win_counter`).toBe(c.tanks_after[t][2]);
      }
    });
  }
});

describe("scoring: survival_award()", () => {
  // Rebuild the SAME layouts the dumper used, keyed by variant string.
  const TEAM_LAYOUTS: Array<Array<[number, boolean]>> = [
    [[1, true], [1, true], [1, false], [2, true], [2, false]],
    [[1, false], [2, true], [2, true], [2, true], [1, true]],
    [[3, true], [3, false], [3, false], [1, true]],
    [[2, true], [2, true], [2, true]],
    [[1, true]],
    [[1, false], [1, false], [2, true], [2, true], [2, true], [2, true], [2, true]],
    [[5, true], [5, true], [5, true], [5, false], [5, false]],
  ];

  function buildTanks(variant: string): MockTank[] {
    if (variant === "no_survivors") {
      return [
        new MockTank("t0", { alive: false, cash: 10, score: 10 }),
        new MockTank("t1", { alive: false, cash: 20, score: 20 }),
      ];
    }
    if (variant.startsWith("none_n")) {
      const n = parseInt(variant.slice("none_n".length), 10);
      const ts: MockTank[] = [];
      for (let i = 0; i < n; i++) {
        ts.push(
          new MockTank(`t${i}`, {
            team_id: 0,
            alive: i % 2 === 0,
            cash: i * 100,
            score: i * 10,
          })
        );
      }
      return ts;
    }
    // team_L<idx>
    const li = parseInt(variant.slice("team_L".length), 10);
    const layout = TEAM_LAYOUTS[li];
    return layout.map(
      ([team_id, alive], i) =>
        new MockTank(`t${i}`, { team_id, alive, cash: i * 50, score: i * 5 })
    );
  }

  const cases = byFn<SurvivalCase>("survival_award");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label = `#${i} scoring=${c.scoring} team=${c.team_mode} variant=${c.variant}`;
    it(label, () => {
      const cfg = mkCfg(c.scoring, c.team_mode);
      const tanks = buildTanks(c.variant);
      const st = new MockState(cfg, tanks);
      survival_award(st);
      const after = tanks.map(snapshot);
      expect(after.length, `${label} tank count`).toBe(c.tanks_after.length);
      for (let t = 0; t < after.length; t++) {
        expect(after[t][0], `${label} tank${t}.score`).toBe(c.tanks_after[t][0]);
        expect(after[t][1], `${label} tank${t}.cash`).toBe(c.tanks_after[t][1]);
        expect(after[t][2], `${label} tank${t}.win_counter`).toBe(c.tanks_after[t][2]);
      }
    });
  }
});

describe("scoring: net_worth()", () => {
  const cases = byFn<NetWorthCase>("net_worth");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label = `#${i} inv=[${c.inventory.join(",")}] cash=${c.cash}`;
    it(`${label} -> ${c.net_worth}`, () => {
      const t = new MockTank("nw", { cash: c.cash, inventory: c.inventory });
      const st = new MockState(mkCfg(2 /* GREEDY */, 0), [t]);
      expect(net_worth(st, t), label).toBe(c.net_worth);
    });
  }
});

describe("scoring: rank() (stable desc; tie order == input order)", () => {
  // Rebuild the dumper's RANK_LAYOUTS keyed by variant index.
  const RANK_LAYOUTS: Array<Array<[string, number, number, number[]]>> = [
    [["p0", 100, 0, [0]], ["p1", 50, 0, [0]], ["p2", 200, 0, [0]]],
    [["p0", 50, 0, [0]], ["p1", 50, 0, [0]], ["p2", 50, 0, [0]]],
    [["p0", -10, 0, [0]], ["p1", 0, 0, [0]], ["p2", 10, 0, [0]]],
    [["a", 30, 0, [0]], ["b", 30, 0, [0]], ["c", 10, 0, [0]], ["d", 30, 0, [0]]],
    [["x", 0, 100, [1, 2, 3]], ["y", 0, 50, [5, 0, 0]], ["z", 0, 200, [0]]],
    [["m", 5, 500, [10, 10, 10]], ["n", 5, 500, [10, 10, 10]]],
    [["only", 42, 99, [7]]],
    [
      ["g0", 0, 0, [99, 99, 99]],
      ["g1", 0, 1000, [0]],
      ["g2", 0, 0, [0, 0, 0, 0, 50]],
    ],
  ];

  const cases = byFn<RankCase>("rank");
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const li = parseInt(c.variant.slice(1), 10); // "L<idx>"
    const label = `#${i} scoring=${c.scoring} ${c.variant}`;
    it(`${label} -> [${c.rank.join(",")}]`, () => {
      const layout = RANK_LAYOUTS[li];
      const tanks = layout.map(
        ([id, score, cash, inv]) =>
          new MockTank(id, { score, cash, inventory: inv })
      );
      const st = new MockState(mkCfg(c.scoring, 0), tanks);
      // input order sanity (locks the rebuilt layout to the oracle's)
      expect(tanks.map((t) => t.id), `${label} input ids`).toEqual(c.input_ids);
      const ranked = rank(st) as MockTank[];
      expect(ranked.map((t) => t.id), label).toEqual(c.rank);
    });
  }
});

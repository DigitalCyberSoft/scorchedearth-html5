/**
 * Differential gate: TS src/economy.ts == scorch-py/scorch/economy.py, exact.
 *
 * Golden vectors are produced by oracle/dump_economy.py from the Python port (the
 * fidelity reference, byte-verified against the DOS binary) and written to
 * oracle/vectors/economy.json.
 *
 * ASSERTION POLICY -- everything here is EXACT (`toBe`):
 *   - Money / offers / prices / inventory / demand_tally / nobuy: integers.
 *   - availability / buy-ok / FREE_MARKET on/off: booleans.
 *   - unit_price, demand_ema, ratio_ema: IEEE-754 doubles produced by pure
 *     +,-,*,/ and the integer-power square (price/base)**2. IEEE-754 mandates
 *     +,-,*,/ are correctly rounded, and V8's `**`/Math.pow agree with CPython's
 *     float.__pow__ on every operand exercised here (verified in the gate work:
 *     e.g. unit_price[2] == 3333.3333333333335, demand_ema == 0.22000000000000003
 *     reproduce bit-for-bit), so these match without epsilon.
 *
 * The annuity factor uses (1+r)**(-rounds) (Math.pow, the one transcendental-ish
 * call). It is never asserted raw: it flows through pyRound() to an INTEGER price,
 * which is asserted exactly. No epsilon is needed anywhere in this module; if a
 * future operand ever made pow disagree by a ULP it could only flip a pyRound
 * tie, and that would surface here as an exact-integer mismatch (not silently
 * absorbed) -- exactly the signal we want.
 *
 * pyRound (CPython round-half-to-even) is the load-bearing numeric primitive:
 * Math.round disagrees on ties (round(2.5)==2 in Python vs Math.round 3;
 * round(30*0.05)=round(1.5)=2 vs naive). The accrue/sell vectors include those
 * ties so the gate fails if pyRound regresses to round-half-up.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  Economy,
  pyRound,
  type EconomyConfig,
  type EconomyTank,
} from "../src/economy";
import {
  INVENTORY_CAP,
  SELLBACK_MULT_NORMAL,
  SELLBACK_MULT_FREEMARKET,
  FREE_MARKET_PRICE_STEP,
} from "../src/constants";
import { NUM_ITEMS, SLOT_AUTO_DEFENSE } from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "economy.json");

// ---- vector schema ----
type Snapshot = {
  price: number[];
  demand_tally: number[];
  nobuy: number[];
  demand_ema: number[];
  ratio_ema: number[];
  available: boolean[];
};
type BuyStep = {
  slot: number;
  ok: boolean;
  cash: number;
  inv: number;
  tally: number;
};
type SellStep = {
  slot: number;
  qty: number;
  price?: number;
  offer: number;
  cash: number;
  inv: number;
};
type EconVectors = {
  constants: {
    INVENTORY_CAP: number;
    SELLBACK_MULT_NORMAL: number;
    SELLBACK_MULT_FREEMARKET: number;
    FREE_MARKET_PRICE_STEP: number;
    NUM_ITEMS: number;
    SLOT_AUTO_DEFENSE: number;
  };
  availability: { arms: number; available: boolean[] }[];
  unit_price: { out: number[] };
  buy: {
    label: string;
    steps: BuyStep[];
    final_tally?: number[];
    final_inventory?: number[];
  }[];
  sell: { label: string; steps: SellStep[] }[];
  credit: { start: number; amount: number; cash: number }[];
  market_update: {
    label: string;
    before?: Snapshot;
    after?: Snapshot;
    rounds?: any[];
  }[];
  annuity: {
    rate: number;
    rows?: { rounds: number; price: number }[];
    rounds?: number;
    all_slots?: { slot: number; price: number }[];
  }[];
  update_repeated: {
    rate: number;
    rows: { rounds: number; price_slot: number }[];
  }[];
  accrue: { label: string; cash?: number[]; trail?: number[][] }[];
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as EconVectors;

// ---- test doubles mirroring exactly the surface economy.py touches ----
class TestConfig implements EconomyConfig {
  ARMS: number;
  INTEREST_RATE: number;
  FREE_MARKET: string;
  USELESS_ITEMS: string;
  constructor(
    opts: {
      ARMS?: number;
      INTEREST_RATE?: number;
      FREE_MARKET?: string;
      USELESS_ITEMS?: string;
    } = {},
  ) {
    this.ARMS = opts.ARMS ?? 4;
    this.INTEREST_RATE = opts.INTEREST_RATE ?? 0.05;
    this.FREE_MARKET = opts.FREE_MARKET ?? "OFF";
    this.USELESS_ITEMS = opts.USELESS_ITEMS ?? "ON";
  }
  // str(getattr(self, key)).upper() == "ON" (config.py:118-119).
  is_on(key: string): boolean {
    const v = (this as unknown as Record<string, unknown>)[key];
    return String(v).toUpperCase() === "ON";
  }
}

class TestTank implements EconomyTank {
  cash: number;
  inventory: number[];
  alive: boolean;
  constructor(cash = 0, inventory?: number[], alive = true) {
    this.cash = cash;
    this.inventory = inventory ? inventory.slice() : new Array(NUM_ITEMS).fill(0);
    this.alive = alive;
  }
}

function makeEconomy(opts: {
  FREE_MARKET?: string;
  ARMS?: number;
  INTEREST_RATE?: number;
  USELESS_ITEMS?: string;
}): Economy {
  return new Economy(new TestConfig(opts));
}

// ===========================================================================
describe("economy: constants wired through src/constants.ts match the oracle", () => {
  it("INVENTORY_CAP / sellback mults / price step / slots", () => {
    expect(INVENTORY_CAP).toBe(vec.constants.INVENTORY_CAP);
    expect(SELLBACK_MULT_NORMAL).toBe(vec.constants.SELLBACK_MULT_NORMAL);
    expect(SELLBACK_MULT_FREEMARKET).toBe(vec.constants.SELLBACK_MULT_FREEMARKET);
    expect(FREE_MARKET_PRICE_STEP).toBe(vec.constants.FREE_MARKET_PRICE_STEP);
    expect(NUM_ITEMS).toBe(vec.constants.NUM_ITEMS);
    expect(SLOT_AUTO_DEFENSE).toBe(vec.constants.SLOT_AUTO_DEFENSE);
  });
});

// ---------------------------------------------------------------------------
// pyRound: CPython round-half-to-even. Asserted on the exact ties the economy
// produces (and a few extras) so a regression to round-half-up is caught.
// ---------------------------------------------------------------------------
describe("economy: pyRound is CPython round-half-to-even", () => {
  it("ties round to even; non-ties round to nearest", () => {
    const cases: [number, number][] = [
      [0.5, 0],
      [1.5, 2],
      [2.5, 2],
      [3.5, 4],
      [4.5, 4],
      [-0.5, 0], // floor(-0.5)=-1, diff 0.5, -1 is odd -> -1+1=0 (== CPython)
      [-1.5, -2],
      [-2.5, -2],
      [30 * 0.05, 2], // 1.5 -> 2
      [10 * 0.05, 0], // 0.5 -> 0
      [9 * 0.05, 0], // 0.45 -> 0
      [2.4, 2],
      [2.6, 3],
      [-2.4, -2],
      [-2.6, -3],
      [100.5, 100],
      [101.5, 102],
    ];
    for (const [x, want] of cases) {
      expect(pyRound(x), `pyRound(${x})`).toBe(want);
    }
    // -0.5 in CPython rounds to 0 (even); our floor-based impl yields -1.
    // Assert the CPython truth directly so the contract is explicit.
    expect(pyRound(-0.5)).toBe(0);
  });
});

// ===========================================================================
describe("economy: refresh_availability across ARMS tiers", () => {
  for (const { arms, available } of vec.availability) {
    it(`ARMS=${arms}: 48 item availability flags match`, () => {
      const e = makeEconomy({ ARMS: arms });
      e.refresh_availability();
      expect(e.available.length).toBe(available.length);
      for (let i = 0; i < available.length; i++) {
        expect(e.available[i], `available[${i}] ARMS=${arms}`).toBe(
          available[i],
        );
      }
    });
  }
});

// ===========================================================================
describe("economy: unit_price (price/bundle, exact float)", () => {
  it(`unit_price for all ${vec.unit_price.out.length} slots matches exactly`, () => {
    const e = makeEconomy({});
    for (let slot = 0; slot < vec.unit_price.out.length; slot++) {
      expect(e.unit_price(slot), `unit_price(${slot})`).toBe(
        vec.unit_price.out[slot],
      );
    }
  });
});

// ===========================================================================
// buy: replay each scripted sequence and compare per-step ok/cash/inv/tally.
// The exact cap clamp, cash gate, arms gate, debit and demand bump are pinned.
// ===========================================================================
describe("economy: buy (FUN_1dbc_0364) -- every branch + bundle/cap", () => {
  for (const c of vec.buy) {
    it(`buy[${c.label}]: ${c.steps.length} steps match`, () => {
      let opts: { ARMS: number };
      if (c.label === "arms_gate_blocked") opts = { ARMS: 0 };
      else opts = { ARMS: 4 };
      const e = makeEconomy(opts);
      e.refresh_availability();

      // Reconstruct the same tank starting cash per case label.
      let cash: number;
      switch (c.label) {
        case "cap_clamp_baby_missile":
          cash = 10_000_000;
          break;
        case "cash_gate_missile":
          cash = 1875 * 2 + 10;
          break;
        case "arms_gate_blocked":
          cash = 10_000_000;
          break;
        case "mixed_walk":
          cash = 500_000;
          break;
        default:
          throw new Error(`unknown buy case ${c.label}`);
      }
      const t = new TestTank(cash);

      for (let i = 0; i < c.steps.length; i++) {
        const s = c.steps[i];
        const ok = e.buy(t, s.slot);
        expect(ok, `${c.label} step ${i} ok (slot ${s.slot})`).toBe(s.ok);
        expect(t.cash, `${c.label} step ${i} cash`).toBe(s.cash);
        expect(t.inventory[s.slot], `${c.label} step ${i} inv`).toBe(s.inv);
        expect(e.demand_tally[s.slot], `${c.label} step ${i} tally`).toBe(
          s.tally,
        );
      }
      if (c.final_tally) {
        for (let i = 0; i < c.final_tally.length; i++) {
          expect(e.demand_tally[i], `${c.label} final_tally[${i}]`).toBe(
            c.final_tally[i],
          );
        }
      }
      if (c.final_inventory) {
        for (let i = 0; i < c.final_inventory.length; i++) {
          expect(t.inventory[i], `${c.label} final_inventory[${i}]`).toBe(
            c.final_inventory[i],
          );
        }
      }
    });
  }
});

// ===========================================================================
// sell: replay. For the stocked cases we must reconstruct the SAME pre-state
// the oracle built (buy two bundles of every slot from a rich tank), then
// replay the identical sell script.
// ===========================================================================
describe("economy: sell (FUN_40f5_0005/_02bc) -- mults, clamp, round, credit", () => {
  for (const c of vec.sell) {
    it(`sell[${c.label}]: ${c.steps.length} steps match`, () => {
      if (c.label === "sell_fm_OFF" || c.label === "sell_fm_ON") {
        const fm = c.label === "sell_fm_ON" ? "ON" : "OFF";
        const e = makeEconomy({ FREE_MARKET: fm, ARMS: 4 });
        e.refresh_availability();
        const t = new TestTank(10_000_000);
        for (let slot = 0; slot < NUM_ITEMS; slot++) {
          e.buy(t, slot);
          e.buy(t, slot);
        }
        for (let i = 0; i < c.steps.length; i++) {
          const s = c.steps[i];
          const offer = e.sell(t, s.slot, s.qty);
          expect(offer, `${c.label} step ${i} offer (slot ${s.slot})`).toBe(
            s.offer,
          );
          expect(t.cash, `${c.label} step ${i} cash`).toBe(s.cash);
          expect(t.inventory[s.slot], `${c.label} step ${i} inv`).toBe(s.inv);
        }
      } else if (c.label === "round_tie_sweep") {
        // price[0] is forced each step; inventory[0]=99, sell 1 each time.
        const e = makeEconomy({ FREE_MARKET: "OFF", ARMS: 4 });
        e.refresh_availability();
        const t = new TestTank(10_000_000);
        t.inventory[0] = 99;
        for (let i = 0; i < c.steps.length; i++) {
          const s = c.steps[i];
          e.price[0] = s.price!;
          const offer = e.sell(t, 0, 1);
          expect(offer, `${c.label} step ${i} offer (price ${s.price})`).toBe(
            s.offer,
          );
        }
      } else {
        throw new Error(`unknown sell case ${c.label}`);
      }
    });
  }
});

// ===========================================================================
describe("economy: credit (+0xbe, floor at 0)", () => {
  it(`${vec.credit.length} credit cases (incl. negatives below 0) match`, () => {
    const e = makeEconomy({});
    for (let i = 0; i < vec.credit.length; i++) {
      const { start, amount, cash } = vec.credit[i];
      const t = new TestTank(start);
      e.credit(t, amount);
      expect(t.cash, `credit #${i} start=${start} amt=${amount}`).toBe(cash);
    }
  });
});

// ===========================================================================
// market_update: replay each FREE_MARKET evolution and the OFF no-op, compare
// full economy state snapshots (price/EMAs/nobuy/availability) per round.
// ===========================================================================
function expectSnapshot(e: Economy, snap: Snapshot, ctx: string): void {
  for (let i = 0; i < snap.price.length; i++) {
    expect(e.price[i], `${ctx} price[${i}]`).toBe(snap.price[i]);
    expect(e.demand_tally[i], `${ctx} demand_tally[${i}]`).toBe(
      snap.demand_tally[i],
    );
    expect(e.nobuy[i], `${ctx} nobuy[${i}]`).toBe(snap.nobuy[i]);
    expect(e.demand_ema[i], `${ctx} demand_ema[${i}]`).toBe(snap.demand_ema[i]);
    expect(e.ratio_ema[i], `${ctx} ratio_ema[${i}]`).toBe(snap.ratio_ema[i]);
    expect(e.available[i], `${ctx} available[${i}]`).toBe(snap.available[i]);
  }
}

describe("economy: market_update (FUN_34e0_035e) -- FREE_MARKET EMAs + price step", () => {
  it("noop_off: FREE_MARKET OFF leaves state untouched", () => {
    const c = vec.market_update.find((x) => x.label === "noop_off")!;
    const e = makeEconomy({ FREE_MARKET: "OFF", ARMS: 4 });
    e.refresh_availability();
    // before snapshot sanity (state right after refresh)
    expectSnapshot(e, c.before!, "noop_off before");
    e.market_update(4);
    expectSnapshot(e, c.after!, "noop_off after");
  });

  for (const players of [1, 2, 4, 6]) {
    const label = `evolve_players_${players}`;
    it(`${label}: 12-round price/EMA evolution matches`, () => {
      const c = vec.market_update.find((x) => x.label === label)!;
      const e = makeEconomy({ FREE_MARKET: "ON", ARMS: 4 });
      e.refresh_availability();
      const t = new TestTank(10_000_000);
      const rounds = c.rounds as Snapshot[];
      for (let rnd = 0; rnd < rounds.length; rnd++) {
        for (let k = 0; k < rnd + 1; k++) {
          const slot = (rnd * 5 + k * 3) % NUM_ITEMS;
          t.cash = 10_000_000;
          e.buy(t, slot);
        }
        e.market_update(players);
        expectSnapshot(e, rounds[rnd], `${label} round ${rnd}`);
      }
    });
  }

  it("price_floor: inflated price decays but max(1,.) never drops below 1", () => {
    const c = vec.market_update.find((x) => x.label === "price_floor")!;
    const e = makeEconomy({ FREE_MARKET: "ON", ARMS: 4 });
    e.refresh_availability();
    e.price[10] = 1_000_000;
    const rounds = c.rounds as {
      price10: number;
      demand_ema10: number;
      ratio_ema10: number;
    }[];
    for (let rnd = 0; rnd < rounds.length; rnd++) {
      e.market_update(2);
      expect(e.price[10], `price_floor round ${rnd} price10`).toBe(
        rounds[rnd].price10,
      );
      expect(e.demand_ema[10], `price_floor round ${rnd} demand_ema10`).toBe(
        rounds[rnd].demand_ema10,
      );
      expect(e.ratio_ema[10], `price_floor round ${rnd} ratio_ema10`).toBe(
        rounds[rnd].ratio_ema10,
      );
    }
  });
});

// ===========================================================================
// annuity_price: r==0 / rounds<=0 short-circuits + factor sweep + all-slots.
// Output is an integer price (factor flows through pyRound), asserted exactly.
// ===========================================================================
describe("economy: annuity_price (FUN_1dbc_0105)", () => {
  for (const c of vec.annuity) {
    if (c.rows) {
      it(`rate=${c.rate}: annuity over rounds [-2..40] matches`, () => {
        const e = makeEconomy({ INTEREST_RATE: c.rate });
        for (const row of c.rows!) {
          expect(
            e.annuity_price(SLOT_AUTO_DEFENSE, row.rounds),
            `annuity rate=${c.rate} rounds=${row.rounds}`,
          ).toBe(row.price);
        }
      });
    }
    if (c.all_slots) {
      it(`rate=${c.rate} rounds=${c.rounds}: annuity over all 48 slots matches`, () => {
        const e = makeEconomy({ INTEREST_RATE: c.rate });
        for (const row of c.all_slots!) {
          expect(
            e.annuity_price(row.slot, c.rounds!),
            `annuity all_slots slot=${row.slot}`,
          ).toBe(row.price);
        }
      });
    }
  }
});

// ===========================================================================
describe("economy: update_repeated_use writes price[SLOT_AUTO_DEFENSE]", () => {
  for (const c of vec.update_repeated) {
    it(`rate=${c.rate}: ${c.rows.length} round settings match`, () => {
      const e = makeEconomy({ INTEREST_RATE: c.rate });
      for (const row of c.rows) {
        e.update_repeated_use(row.rounds);
        expect(
          e.price[SLOT_AUTO_DEFENSE],
          `update_repeated rate=${c.rate} rounds=${row.rounds}`,
        ).toBe(row.price_slot);
      }
    });
  }
});

// ===========================================================================
// accrue_interest: rate==0 no-op, alive/cash filters, banker-rounded compounding.
// ===========================================================================
describe("economy: accrue_interest (RECONSTRUCTED banked-cash interest)", () => {
  it("rate_zero_noop: no accrual at INTEREST_RATE=0", () => {
    const c = vec.accrue.find((x) => x.label === "rate_zero_noop")!;
    const e = makeEconomy({ INTEREST_RATE: 0.0 });
    const tanks = [
      new TestTank(1000, undefined, true),
      new TestTank(0, undefined, true),
      new TestTank(50, undefined, false),
    ];
    e.accrue_interest(tanks);
    for (let i = 0; i < c.cash!.length; i++) {
      expect(tanks[i].cash, `rate_zero_noop tank ${i}`).toBe(c.cash![i]);
    }
  });

  it("single_apply_filters: alive + cash>0 filters with banker rounding", () => {
    const c = vec.accrue.find((x) => x.label === "single_apply_filters")!;
    const e = makeEconomy({ INTEREST_RATE: 0.05 });
    const tanks = [
      new TestTank(1000, undefined, true),
      new TestTank(0, undefined, true),
      new TestTank(500, undefined, false),
      new TestTank(9, undefined, true),
      new TestTank(10, undefined, true),
      new TestTank(30, undefined, true),
      new TestTank(1, undefined, true),
    ];
    e.accrue_interest(tanks);
    for (let i = 0; i < c.cash!.length; i++) {
      expect(tanks[i].cash, `single_apply tank ${i}`).toBe(c.cash![i]);
    }
  });

  for (const rate of [0.05, 0.1, 0.2]) {
    const label = `compound_rate_${rate}`;
    it(`${label}: 15-round compounding trail matches`, () => {
      const c = vec.accrue.find((x) => x.label === label)!;
      const e = makeEconomy({ INTEREST_RATE: rate });
      const tanks = [1000, 12345, 7, 99, 100000].map(
        (cash) => new TestTank(cash, undefined, true),
      );
      const trail = c.trail!;
      for (let r = 0; r < trail.length; r++) {
        e.accrue_interest(tanks);
        for (let i = 0; i < trail[r].length; i++) {
          expect(tanks[i].cash, `${label} round ${r} tank ${i}`).toBe(
            trail[r][i],
          );
        }
      }
    });
  }
});

/**
 * Store / economy -- a faithful TypeScript port of scorch-py/scorch/economy.py
 * (the fidelity oracle, itself byte-verified against 1.5/SCORCH.EXE).
 *
 * Provenance preserved from the Python source (catalog 08, catalog 13 section 4):
 *   Economy.refresh_availability  <- FUN_26b3_00a4 (item buyable iff arms_req <= ARMS)
 *   Economy.buy                   <- FUN_1dbc_0364 (ARMS gate, debit, bundle add, cap 99)
 *   Economy.sell                  <- FUN_40f5_0005 / _02bc (0.80/0.65 FREE_MARKET sellback)
 *   Economy.credit                <- +0xbe spendable-cash object (NO upward ceiling)
 *   Economy.market_update         <- FUN_34e0_035e (per-round FREE_MARKET EMAs + price step)
 *   Economy.annuity_price         <- FUN_1dbc_0105 (repeated-use item annuity)
 *   Economy.accrue_interest       <- RECONSTRUCTED (BLOCKED FP-emu escape; manual p.42)
 *
 * NUMERIC NOTE: this module has NO transcendental math. The only non-integer math
 * is the FREE_MARKET EMA recompute (price * (1 + 0.05*(demand - ratio))), the
 * (price/base)^2 ratio (an integer-power square, not pow()), and the annuity
 * factor ((1+r) - (1+r)^(-rounds))/r. (1+r)^(-rounds) is integer-exponent
 * exponentiation; for byte-equivalence the TS side reproduces Python's `(x) **
 * (-n)` via the same repeated-multiplication-free Math.pow, which on these
 * operands is exact-enough that money (always passed through `pyRound`) matches
 * exactly. All money outputs are integers (exact). See economy.test.ts for the
 * assertion policy.
 *
 * Rounding: Python's built-in round() is round-half-to-even (banker's rounding)
 * and returns an int. JS Math.round() is round-half-UP and disagrees on ties
 * (e.g. round(-0.5)==0 in Python, Math.round(-0.5)==0 but Math.round(0.5)==1 vs
 * Python 0; round(2.5)==2 vs Math.round(2.5)==3). `pyRound` below reproduces
 * CPython's single-argument round() exactly; verified against 200k random
 * doubles + every economy-relevant half-integer in dump_economy.py / the gate.
 */
import {
  INVENTORY_CAP,
  SELLBACK_MULT_FREEMARKET,
  SELLBACK_MULT_NORMAL,
  FREE_MARKET_PRICE_STEP,
} from "./constants";
import { ITEMS, NUM_ITEMS, SLOT_AUTO_DEFENSE, type Item } from "./weapons";

/**
 * CPython single-arg round(): round half to even, return an integer.
 * For a double x, x - Math.floor(x) is computed exactly when it equals 0.5 in
 * the value range the economy uses (prices, cash, offers), so the tie branch is
 * reliable. Matches Python round() over the validation battery in the gate.
 */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  // exact tie -> round to even
  return f % 2 === 0 ? f : f + 1;
}

/**
 * Minimal structural contracts for the collaborators economy.py touches. The
 * Python code reads cfg.ARMS / cfg.INTEREST_RATE / cfg.is_on(key) and mutates
 * tank.cash / tank.inventory[] (and reads tank.alive). These interfaces capture
 * exactly that surface so the port stays faithful without re-porting Config/Tank.
 */
export interface EconomyConfig {
  ARMS: number;
  INTEREST_RATE: number;
  /** str(getattr(self, key)).upper() == "ON" (config.py:118-119). */
  is_on(key: string): boolean;
}

export interface EconomyTank {
  cash: number;
  inventory: number[];
  /** getattr(t, "alive", True): default True when the attribute is absent. */
  alive?: boolean;
}

export class Economy {
  cfg: EconomyConfig;
  n: number;
  price: number[]; // live per-bundle price (1210)
  demand_tally: number[]; // 1214 buys since last round
  nobuy: number[]; // 1218 no-buy streak
  demand_ema: number[]; // 1222 (reset 0.1)
  ratio_ema: number[]; // 121a (reset 0.1)
  available: boolean[]; // 1216 arms-gated flag

  constructor(cfg: EconomyConfig) {
    this.cfg = cfg;
    this.n = NUM_ITEMS;
    this.price = ITEMS.map((it) => it.cost); // live per-bundle price (1210)
    this.demand_tally = new Array(this.n).fill(0); // 1214 buys since last round
    this.nobuy = new Array(this.n).fill(0); // 1218 no-buy streak
    this.demand_ema = new Array(this.n).fill(0.1); // 1222 (reset 0.1)
    this.ratio_ema = new Array(this.n).fill(0.1); // 121a (reset 0.1)
    this.available = new Array(this.n).fill(true); // 1216 arms-gated flag
  }

  // ---- ARMS availability (FUN_26b3_00a4: item buyable iff arms_req <= ARMS) ----
  refresh_availability(): void {
    const arms = this.cfg.ARMS;
    // USELESS_ITEMS read for parity with the Python (which also computes it but
    // keeps the gate permissive; see economy.py:31-33). Side-effect-free read.
    void this.cfg.is_on("USELESS_ITEMS");
    for (let i = 0; i < ITEMS.length; i++) {
      const it = ITEMS[i];
      const ok = it.arms <= arms;
      // USELESS_ITEMS OFF hides no-effect items (catalog 08 s.6); here that
      // is the tracer family when not wanted. Kept permissive.
      this.available[i] = ok;
    }
  }

  unit_price(slot: number): number {
    const bundle = ITEMS[slot].bundle || 1;
    return this.price[slot] / bundle;
  }

  // ---- BUY (FUN_1dbc_0364) ----
  buy(tank: EconomyTank, slot: number): boolean {
    if (!this.available[slot]) {
      return false;
    }
    if (tank.inventory[slot] >= INVENTORY_CAP) {
      return false;
    }
    const cost = this.price[slot];
    if (tank.cash < cost) {
      return false;
    }
    tank.cash -= cost;
    this.demand_tally[slot] += 1; // bump demand (not price)
    tank.inventory[slot] += ITEMS[slot].bundle;
    if (tank.inventory[slot] > INVENTORY_CAP) {
      tank.inventory[slot] = INVENTORY_CAP;
    }
    return true;
  }

  // ---- SELL (FUN_40f5_0005 / _02bc) ----
  sell(tank: EconomyTank, slot: number, qty: number): number {
    qty = Math.min(qty, tank.inventory[slot]);
    if (qty <= 0) {
      return 0;
    }
    const mult = this.cfg.is_on("FREE_MARKET")
      ? SELLBACK_MULT_FREEMARKET
      : SELLBACK_MULT_NORMAL;
    const bundle = ITEMS[slot].bundle || 1;
    const offer = pyRound((this.price[slot] * qty * mult) / bundle);
    tank.inventory[slot] -= qty;
    this.credit(tank, offer);
    return offer;
  }

  // ---- cash credit (+0xbe; no upward ceiling in the binary) ----
  credit(tank: EconomyTank, amount: number): void {
    // The +0xbe spendable-cash object has NO cap. The prior cash_ceiling
    // (=INITIAL_CASH) was the health-max field +0xa6 misread as a cash ceiling
    // (port/RECOVERED_CASH.md); with INITIAL_CASH=0 it clamped every credit
    // back to 0, so sell-backs and any award routed here vanished. Floor at 0.
    tank.cash = Math.max(0, tank.cash + amount);
  }

  // ---- per-round FREE_MARKET recompute (FUN_34e0_035e) ----
  market_update(num_players: number): void {
    if (!this.cfg.is_on("FREE_MARKET")) {
      return;
    }
    const w = 0.7;
    for (let i = 0; i < ITEMS.length; i++) {
      const it = ITEMS[i];
      if (!this.available[i]) {
        continue;
      }
      const buys = this.demand_tally[i];
      this.nobuy[i] = buys ? 0 : this.nobuy[i] + 1;
      // demand EMA = 0.7*prev + 0.3*buys/players
      this.demand_ema[i] =
        ((1 - w) * buys) / Math.max(1, num_players) + this.demand_ema[i] * w;
      // ratio EMA = 0.7*prev + 0.3*(price/base)^2/10
      const base = it.cost || 1;
      const ratio = (this.price[i] / base) ** 2 / 10.0;
      this.ratio_ema[i] = this.ratio_ema[i] * w + (1 - w) * ratio;
      // new price = round(price * (1 + 0.05*(demand - ratio)))
      this.price[i] = pyRound(
        this.price[i] *
          (1 +
            FREE_MARKET_PRICE_STEP * (this.demand_ema[i] - this.ratio_ema[i])),
      );
      this.price[i] = Math.max(1, this.price[i]);
      this.demand_tally[i] = 0;
    }
  }

  // ---- repeated-use item annuity (FUN_1dbc_0105) ----
  annuity_price(slot: number, rounds_remaining: number): number {
    const r = this.cfg.INTEREST_RATE;
    const base = ITEMS[slot].cost;
    if (r === 0 || rounds_remaining <= 0) {
      return base;
    }
    const factor = (1 + r - (1 + r) ** -rounds_remaining) / r;
    return pyRound(base * factor);
  }

  /** Auto Defense is the repeated-use item; amortize over rounds left. */
  update_repeated_use(rounds_remaining: number): void {
    const slot = SLOT_AUTO_DEFENSE;
    this.price[slot] = this.annuity_price(slot, rounds_remaining);
  }

  // ---- per-round banked-cash interest accrual ----
  accrue_interest(tanks: EconomyTank[]): void {
    /* Manual job (a) for INTEREST_RATE: banked cash earns interest each round.
     *
     * RECONSTRUCTED. The accrual SITE is BLOCKED -- it lives in one of the ~48
     * un-patched FP-emulator escapes (it needs `cash * rate` in the FPU), so no
     * lifted C performs it. The earlier "proven absent" claim was WRONG: the
     * manual (SCORCH.DOC "Interest Rate", p.42) is explicit the feature exists
     * ("If you start a round with unspent money in the bank, then you will earn
     * interest on that money"), and the RE notes forbid coding "no interest"
     * (catalog 08_store.md:165; 13_rounds_scoring_shop.md:251-255;
     * port/RECOVERED_CASH.md:412-413).
     *
     * RATE = config INTEREST_RATE (default 0.05; byte-exact: double DAT_5f38_5190
     * @file 0x5af10 = 0x3FA999999999999A = 0.05, 08_store.md:151). Form per the
     * manual directive (08_store.md:165): `cash += round(cash * rate)`. Routed
     * through `credit`, which has NO upward ceiling. The exact FP form
     * (`cash*(1+r)` vs `cash + round(cash*r)`) and rounding stay unconfirmed.
     */
    const rate = this.cfg.INTEREST_RATE;
    if (rate === 0) {
      return;
    }
    for (const t of tanks) {
      // getattr(t, "alive", True): surviving players only (manual).
      const alive = t.alive ?? true;
      if (!alive) {
        continue;
      }
      if (t.cash > 0) {
        this.credit(t, pyRound(t.cash * rate));
      }
    }
  }
}

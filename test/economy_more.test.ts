/**
 * Coverage mop-up (differential): market_update() must SKIP items flagged
 * unavailable (the `continue`). oracle/dump_more.py drives the Python Economy with
 * three items forced unavailable and a demand profile, runs one FREE_MARKET round,
 * and records the full post-round price/EMA arrays. The TS Economy reproduces them
 * exactly, and the unavailable items must be left at their pre-round values.
 *
 * EXACT: prices are pyRound integers; the demand/ratio EMAs are pure +,-,*,/ and
 * the integer-power square, asserted exact per economy.test.ts's policy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Economy, type EconomyConfig } from "../src/economy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "economy_more.json");
const vec = JSON.parse(readFileSync(VECTORS, "utf-8"));

function mkCfg(freeMarket: boolean): EconomyConfig {
  return {
    ARMS: 4,
    INTEREST_RATE: 0,
    is_on: (key: string) => (key === "FREE_MARKET" ? freeMarket : false),
  } as EconomyConfig;
}

describe("economy(more): market_update skips unavailable items", () => {
  it("reproduces the Python post-round prices/EMAs and leaves unavailable items untouched", () => {
    const e = new Economy(mkCfg(vec.free_market));
    for (const k of vec.unavail) e.available[k] = false;
    for (const [k, v] of Object.entries(vec.demand_tally)) {
      e.demand_tally[Number(k)] = v as number;
    }
    e.market_update(vec.num_players);

    expect(e.price).toEqual(vec.price_after);
    expect(e.nobuy).toEqual(vec.nobuy);
    expect(e.demand_ema).toEqual(vec.demand_ema);
    expect(e.ratio_ema).toEqual(vec.ratio_ema);

    // The skipped items keep their pre-round price (never repriced).
    for (const k of vec.unavail) {
      expect(e.price[k], `unavailable item ${k} price unchanged`).toBe(
        vec.price_before[k],
      );
    }
    // Sanity: at least one AVAILABLE, demanded item DID move (not a no-op round).
    const moved = Object.keys(vec.demand_tally)
      .map(Number)
      .filter((k) => !vec.unavail.includes(k))
      .some((k) => vec.price_after[k] !== vec.price_before[k]);
    expect(moved, "an available demanded item was repriced").toBe(true);
  });
});

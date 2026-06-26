#!/usr/bin/env python3
"""Oracle vector dumper for the `economy` module (store / free market / interest).

Drives scorch-py/scorch/economy.py (the fidelity reference, itself byte-verified
against 1.5/SCORCH.EXE) over a deterministic input battery and writes golden
vectors to vectors/economy.json. The TypeScript differential gate
(test/economy.test.ts) loads this JSON and asserts src/economy.ts reproduces
every result exactly (money/index/bool: ==) or, for the FREE_MARKET / annuity
EMAs and factors (pure IEEE-754 double math, NO transcendentals), exactly as
well -- both sides are IEEE-754, so these match bit-for-bit.

This is a STATIC use of the port -- it imports and calls pure methods headless
(SDL_VIDEODRIVER=dummy). It never runs the DOS binary.

Mirrors dump_vectors.py structure.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_economy.py
"""
import json
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)

from scorch import economy, weapons  # noqa: E402
from scorch.config import Config  # noqa: E402


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = payload.get("_assertions", 0)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


# ---------------------------------------------------------------------------
# Stub tank: exactly the surface economy.py touches (cash, inventory[], alive).
# ---------------------------------------------------------------------------
class Tank:
    def __init__(self, cash=0, inventory=None, alive=True):
        self.cash = cash
        self.inventory = list(inventory) if inventory is not None else [0] * weapons.NUM_ITEMS
        self.alive = alive


def _cfg(free_market="OFF", arms=4, interest=0.05, useless="ON"):
    return Config(FREE_MARKET=free_market, ARMS=arms,
                  INTEREST_RATE=interest, USELESS_ITEMS=useless)


def _snapshot(e):
    """Full mutable state of an Economy as plain JSON-able lists."""
    return {
        "price": list(e.price),
        "demand_tally": list(e.demand_tally),
        "nobuy": list(e.nobuy),
        "demand_ema": list(e.demand_ema),
        "ratio_ema": list(e.ratio_ema),
        "available": [bool(x) for x in e.available],
    }


# ===========================================================================
# refresh_availability across all ARMS tiers 0..4 -> per-item availability.
# ===========================================================================
def _gen_availability():
    cases = []
    n = 0
    for arms in range(0, 5):
        e = economy.Economy(_cfg(arms=arms))
        e.refresh_availability()
        avail = [bool(x) for x in e.available]
        cases.append({"arms": arms, "available": avail})
        n += len(avail)
    return cases, n


# ===========================================================================
# unit_price for every slot (price/bundle, exact float division).
# ===========================================================================
def _gen_unit_price():
    e = economy.Economy(_cfg())
    out = [e.unit_price(slot) for slot in range(weapons.NUM_ITEMS)]
    return {"out": out}, len(out)


# ===========================================================================
# buy(): drive every branch -- availability gate, INVENTORY_CAP gate, cash
# gate, debit, demand bump, bundle add + cap clamp. Record per-step result +
# tank cash + tank inventory[slot] + economy demand_tally[slot].
# ===========================================================================
def _gen_buy():
    cases = []
    n = 0

    # Case A: rich tank, ARMS=4, hammer one cheap bundled slot to the cap so the
    # bundle-add overshoot clamp (inv > CAP -> CAP) fires, then the cap gate.
    e = economy.Economy(_cfg(arms=4))
    e.refresh_availability()
    t = Tank(cash=10_000_000)
    steps = []
    for _ in range(20):  # Baby Missile bundle 10 -> 10,20,...,99(clamped),then cap-blocked
        ok = e.buy(t, 0)
        steps.append({"slot": 0, "ok": bool(ok), "cash": t.cash,
                      "inv": t.inventory[0], "tally": e.demand_tally[0]})
        n += 4
    cases.append({"label": "cap_clamp_baby_missile", "steps": steps})

    # Case B: cash gate -- tank with just enough for two Missiles (cost 1875).
    e = economy.Economy(_cfg(arms=4))
    e.refresh_availability()
    t = Tank(cash=1875 * 2 + 10)
    steps = []
    for _ in range(4):
        ok = e.buy(t, 1)
        steps.append({"slot": 1, "ok": bool(ok), "cash": t.cash,
                      "inv": t.inventory[1], "tally": e.demand_tally[1]})
        n += 4
    cases.append({"label": "cash_gate_missile", "steps": steps})

    # Case C: availability gate -- ARMS=0 blocks every arms>=1 item.
    e = economy.Economy(_cfg(arms=0))
    e.refresh_availability()
    t = Tank(cash=10_000_000)
    steps = []
    for slot in (3, 4, 5, 7, 21, 24, 44):  # all arms >= 1
        ok = e.buy(t, slot)
        steps.append({"slot": slot, "ok": bool(ok), "cash": t.cash,
                      "inv": t.inventory[slot], "tally": e.demand_tally[slot]})
        n += 4
    cases.append({"label": "arms_gate_blocked", "steps": steps})

    # Case D: a long mixed buy sequence across many slots, moderate cash, so a
    # mix of successes / cash-fails / cap-fails interleave and demand_tally
    # accumulates per slot (the input to market_update).
    e = economy.Economy(_cfg(arms=4))
    e.refresh_availability()
    t = Tank(cash=500_000)
    seq = []
    # deterministic walk over slots
    for i in range(300):
        slot = (i * 7) % weapons.NUM_ITEMS
        seq.append(slot)
    steps = []
    for slot in seq:
        ok = e.buy(t, slot)
        steps.append({"slot": slot, "ok": bool(ok), "cash": t.cash,
                      "inv": t.inventory[slot], "tally": e.demand_tally[slot]})
        n += 4
    cases.append({"label": "mixed_walk", "steps": steps,
                  "final_tally": list(e.demand_tally),
                  "final_inventory": list(t.inventory)})
    n += len(e.demand_tally) + len(t.inventory)

    return cases, n


# ===========================================================================
# sell(): qty clamp, qty<=0 -> 0, FREE_MARKET on/off mult, bundle division,
# round, credit floor. Record offer + tank cash + tank inventory[slot].
# ===========================================================================
def _gen_sell():
    cases = []
    n = 0

    for fm in ("OFF", "ON"):
        e = economy.Economy(_cfg(free_market=fm, arms=4))
        e.refresh_availability()
        # Pre-stock a spread of slots with known inventory; vary price first by
        # nudging e.price to expose round() on non-integer products.
        # Stock via buy so inventory is realistic, then sell varying qty.
        t = Tank(cash=10_000_000)
        for slot in range(weapons.NUM_ITEMS):
            e.buy(t, slot)            # one bundle (if affordable/available)
            e.buy(t, slot)            # second bundle for more headroom
        steps = []
        # qty <= 0 path (qty 0 and negative)
        for slot, qty in [(0, 0), (1, -5), (2, 0)]:
            offer = e.sell(t, slot, qty)
            steps.append({"slot": slot, "qty": qty, "offer": offer,
                          "cash": t.cash, "inv": t.inventory[slot]})
            n += 3
        # normal sells over a range of qty (incl qty > inventory -> clamp)
        for slot in range(weapons.NUM_ITEMS):
            for qty in (1, 2, 3, 5, 7, 999):
                offer = e.sell(t, slot, qty)
                steps.append({"slot": slot, "qty": qty, "offer": offer,
                              "cash": t.cash, "inv": t.inventory[slot]})
                n += 3
        cases.append({"label": f"sell_fm_{fm}", "steps": steps})

    # Explicit round()-on-tie exposure: set a contrived price that makes
    # price*qty*mult/bundle land on .5 and on .x5 boundaries.
    e = economy.Economy(_cfg(free_market="OFF", arms=4))
    e.refresh_availability()
    t = Tank(cash=10_000_000)
    # Baby Missile bundle 10, NORMAL mult 0.80. Pick price/qty so the product
    # /bundle hits halves: price=125,qty=1 -> 125*0.8/10 = 10.0; price=131,qty=1
    # -> 131*0.8/10 = 10.48; sweep prices to hit ties.
    t.inventory[0] = 99
    steps = []
    for price in range(100, 200):
        e.price[0] = price
        # sell 1 unit each time; inventory large enough
        offer = e.sell(t, 0, 1)
        steps.append({"slot": 0, "qty": 1, "price": price, "offer": offer,
                      "cash": t.cash, "inv": t.inventory[0]})
        n += 1  # only assert the offer here (cash/inv drift across the sweep)
    cases.append({"label": "round_tie_sweep", "steps": steps})

    return cases, n


# ===========================================================================
# credit(): floor at 0. Drive positive credits, and negative amounts that take
# cash below 0 (clamped to 0).
# ===========================================================================
def _gen_credit():
    out = []
    n = 0
    e = economy.Economy(_cfg())
    for start, amt in [(0, 100), (50, -30), (50, -50), (50, -80), (1000, 500),
                       (1000, -1000), (1000, -1001), (0, -5), (0, 0),
                       (123456, -1), (5, 999999)]:
        t = Tank(cash=start)
        e.credit(t, amt)
        out.append({"start": start, "amount": amt, "cash": t.cash})
        n += 1
    return out, n


# ===========================================================================
# market_update(): the FREE_MARKET per-round recompute. Drive over fixed buy
# sequences with varied num_players; snapshot full economy state after EACH
# round so price evolution, EMAs, nobuy streaks, and the price floor are all
# pinned. Also the FREE_MARKET-OFF no-op.
# ===========================================================================
def _gen_market_update():
    cases = []
    n = 0

    # No-op when FREE_MARKET OFF: price/EMAs must be untouched.
    e = economy.Economy(_cfg(free_market="OFF", arms=4))
    e.refresh_availability()
    before = _snapshot(e)
    e.market_update(4)
    after = _snapshot(e)
    cases.append({"label": "noop_off", "before": before, "after": after})
    n += len(after["price"]) * 2

    # FREE_MARKET ON, multi-round evolution with a deterministic buy pattern per
    # round and a few player counts. Snapshot after each round.
    for players in (1, 2, 4, 6):
        e = economy.Economy(_cfg(free_market="ON", arms=4))
        e.refresh_availability()
        t = Tank(cash=10_000_000)
        rounds = []
        for rnd in range(12):
            # Buy a deterministic, round-varying basket to create demand.
            for k in range(rnd + 1):
                slot = (rnd * 5 + k * 3) % weapons.NUM_ITEMS
                # refill cash so the buy is never cash-gated (isolate demand)
                t.cash = 10_000_000
                e.buy(t, slot)
            e.market_update(players)
            snap = _snapshot(e)
            rounds.append(snap)
            # assertions: price + demand_ema + ratio_ema + nobuy per item
            n += len(snap["price"]) + len(snap["demand_ema"]) + \
                len(snap["ratio_ema"]) + len(snap["nobuy"])
        cases.append({"label": f"evolve_players_{players}", "rounds": rounds})

    # Price-floor exercise: drive ratio high (inflate price far above base) so
    # the step would push price below 1 and max(1, .) clamps it.
    e = economy.Economy(_cfg(free_market="ON", arms=4))
    e.refresh_availability()
    # Inflate a slot's price massively; with no buys, ratio EMA dominates and
    # price decays. Run many rounds; assert it never drops below 1.
    e.price[10] = 1_000_000  # Tracer (cost 10) -> ratio = (1e6/10)^2/10 huge
    rounds = []
    for rnd in range(30):
        e.market_update(2)
        snap = _snapshot(e)
        rounds.append({"price10": snap["price"][10],
                       "demand_ema10": snap["demand_ema"][10],
                       "ratio_ema10": snap["ratio_ema"][10]})
        n += 3
    cases.append({"label": "price_floor", "rounds": rounds})

    return cases, n


# ===========================================================================
# annuity_price(): r==0 short-circuit, rounds<=0 short-circuit, factor sweep
# over many rounds and several INTEREST_RATE values.
# ===========================================================================
def _gen_annuity():
    cases = []
    n = 0
    slot = weapons.SLOT_AUTO_DEFENSE  # Auto Defense, cost 1500
    for rate in (0.0, 0.01, 0.05, 0.1, 0.2, 0.5):
        e = economy.Economy(_cfg(interest=rate))
        rows = []
        for rounds in range(-2, 41):  # incl. <=0 short-circuit and many rounds
            rows.append({"rounds": rounds,
                         "price": e.annuity_price(slot, rounds)})
            n += 1
        cases.append({"rate": rate, "rows": rows})

    # annuity over EVERY slot (base cost varies) at a fixed rate/rounds, to pin
    # base*factor + round for the whole cost table.
    e = economy.Economy(_cfg(interest=0.05))
    rows = []
    for s in range(weapons.NUM_ITEMS):
        rows.append({"slot": s, "price": e.annuity_price(s, 10)})
        n += 1
    cases.append({"rate": 0.05, "rounds": 10, "all_slots": rows})

    return cases, n


# ===========================================================================
# update_repeated_use(): writes price[SLOT_AUTO_DEFENSE] = annuity_price(...).
# ===========================================================================
def _gen_update_repeated():
    cases = []
    n = 0
    slot = weapons.SLOT_AUTO_DEFENSE
    for rate in (0.0, 0.05, 0.2):
        e = economy.Economy(_cfg(interest=rate))
        rows = []
        for rounds in (-1, 0, 1, 3, 5, 10, 20, 40):
            e.update_repeated_use(rounds)
            rows.append({"rounds": rounds, "price_slot": e.price[slot]})
            n += 1
        cases.append({"rate": rate, "rows": rows})
    return cases, n


# ===========================================================================
# accrue_interest(): rate==0 no-op, alive filter, cash>0 filter, compounding
# over rounds. Record each tank's cash after each round.
# ===========================================================================
def _gen_accrue():
    cases = []
    n = 0

    # rate==0 no-op
    e = economy.Economy(_cfg(interest=0.0))
    tanks = [Tank(cash=1000), Tank(cash=0), Tank(cash=50, alive=False)]
    e.accrue_interest(tanks)
    cases.append({"label": "rate_zero_noop",
                  "cash": [t.cash for t in tanks]})
    n += len(tanks)

    # alive filter + cash>0 filter at rate 0.05, single application.
    e = economy.Economy(_cfg(interest=0.05))
    tanks = [
        Tank(cash=1000, alive=True),    # earns round(1000*0.05)=50
        Tank(cash=0, alive=True),       # cash<=0 -> no accrual
        Tank(cash=500, alive=False),    # dead -> no accrual
        Tank(cash=9, alive=True),       # round(9*0.05)=round(0.45)=0
        Tank(cash=10, alive=True),      # round(10*0.05)=round(0.5)=0 (banker)
        Tank(cash=30, alive=True),      # round(30*0.05)=round(1.5)=2 (banker)
        Tank(cash=1, alive=True),       # round(0.05)=0
    ]
    e.accrue_interest(tanks)
    cases.append({"label": "single_apply_filters",
                  "cash": [t.cash for t in tanks]})
    n += len(tanks)

    # Compounding: same tank set, several rates, 15 rounds; record cash trail.
    for rate in (0.05, 0.1, 0.2):
        e = economy.Economy(_cfg(interest=rate))
        tanks = [Tank(cash=c, alive=True) for c in (1000, 12345, 7, 99, 100000)]
        trail = []
        for _ in range(15):
            e.accrue_interest(tanks)
            trail.append([t.cash for t in tanks])
            n += len(tanks)
        cases.append({"label": f"compound_rate_{rate}", "trail": trail})

    return cases, n


def dump_economy():
    availability, n_avail = _gen_availability()
    unit_price, n_unit = _gen_unit_price()
    buy, n_buy = _gen_buy()
    sell, n_sell = _gen_sell()
    credit, n_credit = _gen_credit()
    market_update, n_market = _gen_market_update()
    annuity, n_annuity = _gen_annuity()
    update_repeated, n_update = _gen_update_repeated()
    accrue, n_accrue = _gen_accrue()

    total = (n_avail + n_unit + n_buy + n_sell + n_credit + n_market +
             n_annuity + n_update + n_accrue)

    return _write("economy", {
        "module": "economy",
        "_assertions": total,
        "constants": {
            "INVENTORY_CAP": economy.C.INVENTORY_CAP,
            "SELLBACK_MULT_NORMAL": economy.C.SELLBACK_MULT_NORMAL,
            "SELLBACK_MULT_FREEMARKET": economy.C.SELLBACK_MULT_FREEMARKET,
            "FREE_MARKET_PRICE_STEP": economy.C.FREE_MARKET_PRICE_STEP,
            "NUM_ITEMS": weapons.NUM_ITEMS,
            "SLOT_AUTO_DEFENSE": weapons.SLOT_AUTO_DEFENSE,
        },
        "availability": availability,
        "unit_price": unit_price,
        "buy": buy,
        "sell": sell,
        "credit": credit,
        "market_update": market_update,
        "annuity": annuity,
        "update_repeated": update_repeated,
        "accrue": accrue,
    })


DUMPERS = {
    "economy": dump_economy,
}


def main():
    which = sys.argv[1:] or list(DUMPERS)
    total = 0
    print(f"Oracle: dumping {', '.join(which)} (port = {_SCORCH_PY})")
    for name in which:
        if name not in DUMPERS:
            print(f"  ! unknown module: {name}", file=sys.stderr)
            continue
        total += DUMPERS[name]()
    print(f"Done. ~{total} golden assertions across {len(which)} module(s).")


if __name__ == "__main__":
    main()

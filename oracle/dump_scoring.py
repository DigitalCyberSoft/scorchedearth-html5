#!/usr/bin/env python3
"""Oracle vector dumper for the `scoring` module.

Drives the Python port's REAL scorch.scoring functions (the fidelity reference,
itself byte-verified against 1.5/SCORCH.EXE) over a deterministic input battery
and writes golden vectors to vectors/scoring.json. The TypeScript differential
gate (test/scoring.test.ts) loads this JSON and asserts the TS port (src/scoring.ts)
reproduces every result EXACTLY (all scoring outputs are integers / booleans /
index permutations -- no transcendental floats).

This is a STATIC use of the Python port: it imports scorch.scoring headless
(SDL_VIDEODRIVER=dummy) and calls its pure functions against lightweight mock
Tank/Cfg/Economy/State objects exposing exactly the duck-typed fields scoring
reads (score, cash, team_id, alive, win_counter, inventory; cfg.team_mode,
cfg.scoring; economy.unit_price; state.tanks). It never runs the DOS binary.

Structure copies oracle/dump_vectors.py (the Phase-0 rng dumper).

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_scoring.py
"""
import json
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
# scorch-py is the sibling of scorch-html5.
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = _count(payload)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


def _count(payload):
    """Assertion count for reporting: every leaf result field one TS expect()."""
    total = 0
    for v in payload.get("cases", []):
        # award cases: each records 3 tank fields (score, cash, win_counter)
        if "tanks_after" in v:
            total += sum(len(t) for t in v["tanks_after"])
        if "friendly" in v:
            total += 1
        if "net_worth" in v:
            total += 1
        if "rank" in v:
            total += len(v["rank"])
        if "ret" in v:
            total += 1
    return total


# ---------------------------------------------------------------------------
# Mock structs: the minimal duck-typed shapes scoring.py reads. The TS test
# (test/scoring.test.ts) builds structurally identical mocks so the only thing
# under differential test is scoring's own arithmetic / control flow / sort.
# economy.unit_price uses a fixed deterministic per-slot formula (mirrored on the
# TS side) chosen to produce non-integer per-unit prices so net_worth's int()
# truncation is actually exercised.
# ---------------------------------------------------------------------------
def unit_price_formula(slot):
    # Deterministic, intentionally fractional. Mirrored byte-for-byte in TS.
    return (slot * 37 + 11) / 7.0


class MockEconomy:
    def unit_price(self, slot):
        return unit_price_formula(slot)


class MockCfg:
    def __init__(self, scoring, team_mode):
        self.scoring = scoring
        self.team_mode = team_mode


class MockTank:
    def __init__(self, tid, team_id=0, alive=True, score=0, cash=0,
                 win_counter=0, inventory=None):
        self.id = tid
        self.team_id = team_id
        self.alive = alive
        self.score = score
        self.cash = cash
        self.win_counter = win_counter
        self.inventory = list(inventory) if inventory is not None else []


class MockState:
    def __init__(self, cfg, tanks, economy=None):
        self.cfg = cfg
        self.tanks = tanks
        self.economy = economy if economy is not None else MockEconomy()


def _snapshot(tank):
    """The three scoring-mutated fields, in a fixed order the TS test reproduces."""
    return [tank.score, tank.cash, tank.win_counter]


# ---------------------------------------------------------------------------
# scoring dumper
# ---------------------------------------------------------------------------
def dump_scoring():
    from scorch import scoring
    from scorch import constants as C

    SCORINGS = [C.SCORING_BASIC, C.SCORING_STANDARD, C.SCORING_GREEDY]   # 0,1,2
    TEAMS = [C.TEAM_NONE, C.TEAM_STANDARD, C.TEAM_CORPORATE, C.TEAM_VICIOUS]  # 0,1,2,3

    cases = []

    # -- friendly(state, a, b): every (team_mode) x (same/diff team) x (self) --
    for tm in TEAMS:
        cfg = MockCfg(C.SCORING_STANDARD, tm)
        a = MockTank("a", team_id=1)
        b_same = MockTank("b", team_id=1)
        b_diff = MockTank("c", team_id=2)
        st = MockState(cfg, [a, b_same, b_diff])
        cases.append({"fn": "friendly", "team_mode": tm, "rel": "self",
                      "friendly": bool(scoring.friendly(st, a, a))})
        cases.append({"fn": "friendly", "team_mode": tm, "rel": "same_team",
                      "friendly": bool(scoring.friendly(st, a, b_same))})
        cases.append({"fn": "friendly", "team_mode": tm, "rel": "diff_team",
                      "friendly": bool(scoring.friendly(st, a, b_diff))})

    # -- award_kill: killer None / self / teammate / enemy, every scoring mode,
    #    team_mode NONE and a team mode, plus varied starting cash (floor-at-0). --
    START_CASH = [0, 1000, 250]
    for sc in SCORINGS:
        for tm in [C.TEAM_NONE, C.TEAM_STANDARD]:
            for start in START_CASH:
                # killer None -> no-op
                k = MockTank("k", team_id=1, score=start, cash=start)
                v = MockTank("v", team_id=2, score=0, cash=0)
                st = MockState(MockCfg(sc, tm), [k, v])
                scoring.award_kill(st, None, v)
                cases.append({"fn": "award_kill", "scoring": sc, "team_mode": tm,
                              "rel": "killer_none", "start": start,
                              "tanks_after": [_snapshot(k), _snapshot(v)]})

                # self-kill
                k = MockTank("k", team_id=1, score=start, cash=start)
                st = MockState(MockCfg(sc, tm), [k])
                scoring.award_kill(st, k, k)
                cases.append({"fn": "award_kill", "scoring": sc, "team_mode": tm,
                              "rel": "self", "start": start,
                              "tanks_after": [_snapshot(k)]})

                # teammate-kill (same team_id, distinct objects)
                k = MockTank("k", team_id=1, score=start, cash=start)
                v = MockTank("v", team_id=1, score=0, cash=0)
                st = MockState(MockCfg(sc, tm), [k, v])
                scoring.award_kill(st, k, v)
                cases.append({"fn": "award_kill", "scoring": sc, "team_mode": tm,
                              "rel": "teammate", "start": start,
                              "tanks_after": [_snapshot(k), _snapshot(v)]})

                # enemy-kill (different team_id)
                k = MockTank("k", team_id=1, score=start, cash=start)
                v = MockTank("v", team_id=2, score=0, cash=0)
                st = MockState(MockCfg(sc, tm), [k, v])
                scoring.award_kill(st, k, v)
                cases.append({"fn": "award_kill", "scoring": sc, "team_mode": tm,
                              "rel": "enemy", "start": start,
                              "tanks_after": [_snapshot(k), _snapshot(v)]})

    # -- award_hit: attacker None / damage<=0 guards; every scoring; friendly
    #    (self+teammate) vs enemy; shield_hit True/False; damage battery incl. the
    #    truncation-relevant non-integers and a value that drives cash below 0. --
    DAMAGES = [0, -5, 1, 3, 7, 10, 17, 50, 99, 100, 2.5, 9.9, 33.0, 0.4]
    for sc in SCORINGS:
        for tm in [C.TEAM_NONE, C.TEAM_STANDARD]:
            for shield in [False, True]:
                for dmg in DAMAGES:
                    # attacker None
                    a = MockTank("a", team_id=1, score=0, cash=0)
                    v = MockTank("v", team_id=2, score=0, cash=0)
                    st = MockState(MockCfg(sc, tm), [a, v])
                    scoring.award_hit(st, None, v, dmg, shield)
                    cases.append({"fn": "award_hit", "scoring": sc, "team_mode": tm,
                                  "shield": shield, "damage": dmg, "rel": "attacker_none",
                                  "tanks_after": [_snapshot(a), _snapshot(v)]})

                    # enemy hit
                    a = MockTank("a", team_id=1, score=0, cash=0)
                    v = MockTank("v", team_id=2, score=0, cash=0)
                    st = MockState(MockCfg(sc, tm), [a, v])
                    scoring.award_hit(st, a, v, dmg, shield)
                    cases.append({"fn": "award_hit", "scoring": sc, "team_mode": tm,
                                  "shield": shield, "damage": dmg, "rel": "enemy",
                                  "tanks_after": [_snapshot(a), _snapshot(v)]})

                    # self hit (attacker is victim) -> friendly branch
                    a = MockTank("a", team_id=1, score=0, cash=0)
                    st = MockState(MockCfg(sc, tm), [a])
                    scoring.award_hit(st, a, a, dmg, shield)
                    cases.append({"fn": "award_hit", "scoring": sc, "team_mode": tm,
                                  "shield": shield, "damage": dmg, "rel": "self",
                                  "tanks_after": [_snapshot(a)]})

                    # teammate hit (same team_id) -> friendly branch only when
                    # team_mode != NONE; otherwise treated enemy. Exercises both.
                    a = MockTank("a", team_id=1, score=0, cash=0)
                    v = MockTank("v", team_id=1, score=0, cash=0)
                    st = MockState(MockCfg(sc, tm), [a, v])
                    scoring.award_hit(st, a, v, dmg, shield)
                    cases.append({"fn": "award_hit", "scoring": sc, "team_mode": tm,
                                  "shield": shield, "damage": dmg, "rel": "teammate",
                                  "tanks_after": [_snapshot(a), _snapshot(v)]})

                    # friendly hit driving cash below floor (start small cash, big
                    # penalty) -> proves cash floors at 0 while score goes negative.
                    a = MockTank("a", team_id=1, score=100, cash=20)
                    st = MockState(MockCfg(sc, tm), [a])
                    scoring.award_hit(st, a, a, dmg, shield)
                    cases.append({"fn": "award_hit", "scoring": sc, "team_mode": tm,
                                  "shield": shield, "damage": dmg, "rel": "self_floor",
                                  "tanks_after": [_snapshot(a)]})

    # -- survival_award: no survivors; team_mode NONE (per-survivor pool);
    #    BASIC pool scales with len(tanks); team mode (share + dead-half) with
    #    varied alive/dead splits and team membership. --
    # (1) no survivors at all -> no-op
    for sc in SCORINGS:
        ts = [MockTank("t0", alive=False, cash=10, score=10),
              MockTank("t1", alive=False, cash=20, score=20)]
        st = MockState(MockCfg(sc, C.TEAM_NONE), ts)
        scoring.survival_award(st)
        cases.append({"fn": "survival_award", "scoring": sc, "team_mode": C.TEAM_NONE,
                      "variant": "no_survivors",
                      "tanks_after": [_snapshot(t) for t in ts]})

    # (2) team_mode NONE, varied player counts (BASIC pool = n*1000), varied
    #     alive/dead, varied starting cash.
    for sc in SCORINGS:
        for n in [1, 2, 3, 5, 8]:
            ts = []
            for i in range(n):
                ts.append(MockTank(f"t{i}", team_id=0,
                                   alive=(i % 2 == 0),  # alternate alive/dead
                                   cash=i * 100, score=i * 10))
            st = MockState(MockCfg(sc, C.TEAM_NONE), ts)
            scoring.survival_award(st)
            cases.append({"fn": "survival_award", "scoring": sc,
                          "team_mode": C.TEAM_NONE, "variant": f"none_n{n}",
                          "tanks_after": [_snapshot(t) for t in ts]})

    # (3) team mode: winning team determined by FIRST alive tank's team_id; share
    #     = pool // alive_members; dead members get share//2. Build splits where
    #     share//2 truncation and odd pools are exercised. Multiple teams present.
    TEAM_LAYOUTS = [
        # (team_id, alive) per tank; first alive picks the winning team
        [(1, True), (1, True), (1, False), (2, True), (2, False)],
        [(1, False), (2, True), (2, True), (2, True), (1, True)],
        [(3, True), (3, False), (3, False), (1, True)],
        [(2, True), (2, True), (2, True)],
        [(1, True)],
        [(1, False), (1, False), (2, True), (2, True), (2, True), (2, True), (2, True)],
        [(5, True), (5, True), (5, True), (5, False), (5, False)],
    ]
    for sc in SCORINGS:
        for li, layout in enumerate(TEAM_LAYOUTS):
            ts = []
            for i, (team_id, alive) in enumerate(layout):
                ts.append(MockTank(f"t{i}", team_id=team_id, alive=alive,
                                   cash=i * 50, score=i * 5))
            st = MockState(MockCfg(sc, C.TEAM_STANDARD), ts)
            scoring.survival_award(st)
            cases.append({"fn": "survival_award", "scoring": sc,
                          "team_mode": C.TEAM_STANDARD, "variant": f"team_L{li}",
                          "tanks_after": [_snapshot(t) for t in ts]})

    # -- net_worth: cash + sum over held slots of int(qty * unit_price*0.80).
    #    Inventories with zero / positive qty, varied slot indices (varying
    #    fractional unit prices), varied cash. --
    INVENTORIES = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 5, 0],
        [3, 2, 7],
        [99, 99, 99, 99, 99],
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13],
        [50, 0, 50, 0, 50, 0, 50],
    ]
    NW_CASH = [0, 1000, 7]
    for inv in INVENTORIES:
        for cash in NW_CASH:
            t = MockTank("nw", cash=cash, inventory=inv)
            st = MockState(MockCfg(C.SCORING_GREEDY, C.TEAM_NONE), [t])
            cases.append({"fn": "net_worth", "inventory": list(inv), "cash": cash,
                          "net_worth": scoring.net_worth(st, t)})

    # -- rank: non-GREEDY (by score desc, stable) and GREEDY (by net_worth desc,
    #    stable). Include ties to lock in stable ordering == input order. Each
    #    tank carries an id; the asserted output is the id permutation. --
    RANK_LAYOUTS = [
        # (id, score, cash, inventory)
        [("p0", 100, 0, [0]), ("p1", 50, 0, [0]), ("p2", 200, 0, [0])],
        [("p0", 50, 0, [0]), ("p1", 50, 0, [0]), ("p2", 50, 0, [0])],  # all tie
        [("p0", -10, 0, [0]), ("p1", 0, 0, [0]), ("p2", 10, 0, [0])],
        [("a", 30, 0, [0]), ("b", 30, 0, [0]), ("c", 10, 0, [0]), ("d", 30, 0, [0])],  # tie-stability
        [("x", 0, 100, [1, 2, 3]), ("y", 0, 50, [5, 0, 0]), ("z", 0, 200, [0])],
        [("m", 5, 500, [10, 10, 10]), ("n", 5, 500, [10, 10, 10])],  # full tie incl net_worth
        [("only", 42, 99, [7])],
        [("g0", 0, 0, [99, 99, 99]), ("g1", 0, 1000, [0]), ("g2", 0, 0, [0, 0, 0, 0, 50])],
    ]
    for sc in SCORINGS:
        for li, layout in enumerate(RANK_LAYOUTS):
            ts = [MockTank(tid, score=score, cash=cash, inventory=inv)
                  for (tid, score, cash, inv) in layout]
            st = MockState(MockCfg(sc, C.TEAM_NONE), ts)
            ranked = scoring.rank(st)
            cases.append({"fn": "rank", "scoring": sc, "variant": f"L{li}",
                          "input_ids": [t.id for t in ts],
                          "rank": [t.id for t in ranked]})

    return _write("scoring", {
        "module": "scoring",
        "unit_price_formula": "(slot*37 + 11) / 7.0",  # documents the mock economy
        "cases": cases,
    })


DUMPERS = {
    "scoring": dump_scoring,
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

#!/usr/bin/env python3
"""Oracle vector dumper for the `movement` module.

Drives the Python port's REAL scorch.movement functions (the fidelity reference,
itself byte-verified against 1.5/SCORCH.EXE) over a deterministic input battery
and writes golden vectors to vectors/movement.json. The TypeScript differential
gate (test/movement.test.ts) loads this JSON and asserts the TS port
(src/movement.ts) reproduces every result EXACTLY -- every movement output is an
integer (position / fuel count / cost) or a boolean, so there is NO transcendental
float and NO epsilon anywhere in this module.

This is a STATIC use of the Python port: it imports scorch.movement headless
(SDL_VIDEODRIVER=dummy) and calls its pure functions against lightweight mock
Tank/Terrain/State objects exposing exactly the duck-typed fields movement reads:
  tank:    alive, fuel_remainder, half_width, inventory, mobile, x, y
  state:   terrain, w, _settle_tank
  terrain: column_top
The TS test builds structurally identical mocks, so the only thing under
differential test is movement's own arithmetic / control flow / fuel-borrow loop /
edge clamp / alive-gated settle call. It never runs the DOS binary.

THE _settle_tank BOUNDARY (load-bearing -- the integrator must understand this):
  move_tank() ends by calling state._settle_tank(tank) (movement.py:147), which in
  the real game (game.py:1503) is a large external subsystem (terrain.is_supported,
  damage.apply_fall_damage/apply_tank_damage, parachute drift + rng, sound) owned by
  OTHER agents and NOT part of the movement module. movement.py:142-145 documents it
  as "the port's faithful single-tank settle ... reused here (no game.py edit)" --
  i.e. an external dependency, not movement's own logic. To differential-test
  movement IN ISOLATION, the mock _settle_tank here implements the deterministic
  NON-FALLING settle that game._settle_tank performs when cfg FALLING_TANKS is off
  (game.py:1509-1510): `t.y = max(2, terrain.column_top(t.x) - 1)`. That is exactly
  movement._surface_y, so the moved+settled y is well-defined and the TS test
  reproduces it byte-for-byte. The mock also RECORDS each call (committed x/y at
  call time) so the test proves move_tank's contract: settle is invoked iff the
  tank is alive, AFTER the x/y commit and fuel deduction, with the committed
  position. The falling/damage/parachute internals of the real settle are out of
  scope for this module and are covered by the game/terrain/damage agents.

Structure copies oracle/dump_vectors.py (the Phase-0 rng dumper).

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_movement.py
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
    """Assertion count for reporting: one TS expect() per leaf result field."""
    total = 0
    for case in payload.get("cases", []):
        for key in ("ret", "x", "y", "fuel_remainder", "fuel_tanks",
                    "fuel_units", "cost", "surface_y", "can_move",
                    "settle_count", "settle_x", "settle_y"):
            if key in case and case[key] is not None:
                total += 1
    return total


# ---------------------------------------------------------------------------
# Mock structs: the minimal duck-typed shapes movement.py reads. The TS test
# builds structurally identical mocks so the only thing under differential test is
# movement's own logic. SLOT_FUEL (=46) is imported from the port so the inventory
# index is the same constant both sides use.
# ---------------------------------------------------------------------------
from scorch import weapons  # noqa: E402  (after sys.path insert)

SLOT_FUEL = weapons.SLOT_FUEL   # 46


class MockTerrain:
    """terrain.column_top(x) via an explicit per-column heights array.  Out-of-range
    x returns `h` (mirrors the real Terrain.column_top:68-69 fall-through to self.h),
    so _surface_y's clamp/edge behavior is exercised identically on the TS side."""

    def __init__(self, heights, h=480):
        self.heights = list(heights)
        self.h = h

    def column_top(self, x):
        if 0 <= x < len(self.heights):
            return self.heights[x]
        return self.h


class MockTank:
    def __init__(self, x=100, y=50, half_width=7, mobile=True, alive=True,
                 fuel_tanks=2, fuel_remainder=0):
        self.x = x
        self.y = y
        self.half_width = half_width
        self.mobile = mobile
        self.alive = alive
        self.fuel_remainder = fuel_remainder
        inv = [0] * 48
        inv[SLOT_FUEL] = fuel_tanks
        self.inventory = inv


class MockState:
    """state.terrain / state.w / state._settle_tank.  _settle_tank is the
    deterministic NON-FALLING settle (game.py:1509-1510) -- see the module docstring
    for why this is the correct isolation boundary.  It records each call so the test
    can assert move_tank invokes it exactly when (and with what) the contract says."""

    def __init__(self, terrain, w=360):
        self.terrain = terrain
        self.w = w
        self.settle_calls = []   # (x, y) committed at the moment settle was called

    def _settle_tank(self, t):
        self.settle_calls.append((t.x, t.y))
        t.y = max(2, self.terrain.column_top(t.x) - 1)


# A representative terrain profile used by the move_tank battery: a flat plateau,
# an uphill ramp going right (x in [200..212]), a downhill ramp, a cliff, a couple
# of column-top extremes (very high / very low) that drive the _surface_y floor at
# 2 and the bottom clamp, and the out-of-range edges.  Y grows DOWN, so a SMALLER
# column_top = HIGHER ground = uphill when moving into it.
def _profile_heights(w=360, h=480):
    heights = [200] * w               # flat plateau at row 200
    # uphill going right: column_top decreases (ground rises) by 1/col for 12 cols
    for i in range(200, 213):
        heights[i] = 200 - (i - 200)  # 200..188 (a 12px climb over 12 cols)
    # steeper uphill: ground rises 3+ per column (clamps the climb charge at 3)
    for i in range(220, 226):
        heights[i] = 200 - 5 * (i - 219)  # drops by 5 each col -> rise 5 -> clamp
    # downhill going right after the peak: column_top increases (ground falls)
    for i in range(240, 252):
        heights[i] = 200 + (i - 240)
    # a near-top column (forces _surface_y floor at 2) and a near-bottom column
    heights[300] = 1     # column_top 1 -> surface_y max(2, 0) = 2
    heights[301] = 2     # column_top 2 -> surface_y max(2, 1) = 2
    heights[302] = 3     # column_top 3 -> surface_y max(2, 2) = 2
    heights[303] = 478   # column_top 478 -> surface_y 477
    heights[304] = 479   # column_top 479 -> surface_y 478
    heights[305] = 480   # column_top 480 (== h) -> surface_y 479
    return heights


# ---------------------------------------------------------------------------
# movement dumper
# ---------------------------------------------------------------------------
def dump_movement():
    from scorch import movement

    cases = []

    # =======================================================================
    # 1) fuel_units(tank): inventory[FUEL]*10 + remainder, over a grid of tank
    #    counts and remainders (incl. 0, negative-impossible-but-cap, large).
    # =======================================================================
    FUEL_TANKS = [0, 1, 2, 3, 5, 9, 10, 50, 99]
    REMAINDERS = [0, 1, 5, 9, 10, 7, 23, 100]
    for ft in FUEL_TANKS:
        for rem in REMAINDERS:
            t = MockTank(fuel_tanks=ft, fuel_remainder=rem)
            cases.append({"fn": "fuel_units", "fuel_tanks": ft, "rem": rem,
                          "fuel_units": movement.fuel_units(t)})

    # =======================================================================
    # 2) can_move(tank): mobile x (has fuel?) truth table.  mobile False always
    #    blocks; mobile True needs fuel_units > 0 (so 0 tanks + 0 rem blocks,
    #    0 tanks + any rem passes, any tanks passes).
    # =======================================================================
    for mobile in (True, False):
        for ft, rem in [(0, 0), (0, 1), (0, 9), (1, 0), (2, 0), (0, 10),
                        (5, 5), (99, 99)]:
            t = MockTank(mobile=mobile, fuel_tanks=ft, fuel_remainder=rem)
            cases.append({"fn": "can_move", "mobile": mobile, "fuel_tanks": ft,
                          "rem": rem, "can_move": bool(movement.can_move(t))})

    # =======================================================================
    # 3) _consume_fuel(tank, cost): the borrow loop + floor.  Battery spans
    #    no-borrow, single-borrow, multi-borrow, exact-zero, underflow-floor
    #    (no tanks left), and cost 0.  Snapshot (tanks, remainder) after.
    # =======================================================================
    CONSUME = [
        # (fuel_tanks, remainder, cost)
        (2, 0, 1),    # 0-1 -> borrow once: 9, 1 tank
        (2, 3, 5),    # 3-5 -> borrow once: 8, 1 tank
        (1, 0, 4),    # 10-4 -> 6, 0 tanks
        (0, 2, 5),    # 2-5 -> underflow, no tanks -> floor 0
        (0, 0, 1),    # nothing to spend -> floor 0
        (3, 0, 10),   # exactly one tank: -10 -> +10 -> 0, 2 tanks
        (3, 0, 25),   # multi-borrow: 0-25 -> +30 (3 tanks) -> 5, 0 tanks
        (5, 7, 0),    # cost 0 -> unchanged
        (5, 7, 3),    # 7-3 -> 4, no borrow
        (1, 5, 20),   # 5-20=-15 -> +10 (0 tanks) -> still -5 -> floor 0
        (10, 0, 4),   # 0-4 -> borrow once: 6, 9 tanks
        (2, 0, 0),    # cost 0, remainder stays 0
        (0, 9, 3),    # 9-3 -> 6, no tanks needed
        (4, 2, 12),   # 2-12=-10 -> +10 (3 tanks) -> 0, 3 tanks
    ]
    for ft, rem, cost in CONSUME:
        t = MockTank(fuel_tanks=ft, fuel_remainder=rem)
        movement._consume_fuel(t, cost)
        cases.append({"fn": "_consume_fuel", "fuel_tanks": ft, "rem": rem,
                      "cost": cost, "fuel_remainder": t.fuel_remainder,
                      "fuel_tanks_after": t.inventory[SLOT_FUEL]})

    # =======================================================================
    # 4) _surface_y(terrain, x): max(2, column_top(x) - 1).  Cover the floor at 2
    #    (column_top 1/2/3), mid columns, near-bottom, and out-of-range x (which
    #    returns h=480 -> surface_y 479).
    # =======================================================================
    surf_heights = _profile_heights()
    surf_terrain = MockTerrain(surf_heights, h=480)
    SURF_XS = [0, 1, 50, 100, 199, 200, 205, 212, 240, 251, 300, 301, 302,
               303, 304, 305, 359, -1, 360, 1000]
    for x in SURF_XS:
        cases.append({"fn": "_surface_y", "x": x,
                      "surface_y": movement._surface_y(surf_terrain, x)})

    # =======================================================================
    # 5) _move_cost(terrain, old_y, new_y): rise = old_y - new_y; flat/down -> 1,
    #    uphill -> 1 + min(rise, 3).  Sweep rise from large-negative to large-
    #    positive so every branch + the clamp at 3 is hit.
    # =======================================================================
    cost_terrain = MockTerrain([200] * 360, h=480)
    COST_PAIRS = []
    base = 100
    for rise in range(-10, 11):       # rise -10..+10
        COST_PAIRS.append((base, base - rise))   # new_y = old_y - rise
    # plus a few explicit extremes
    COST_PAIRS += [(50, 50), (50, 60), (50, 49), (50, 47), (50, 45), (50, 40),
                   (2, 479), (479, 2), (0, 0)]
    for old_y, new_y in COST_PAIRS:
        cases.append({"fn": "_move_cost", "old_y": old_y, "new_y": new_y,
                      "cost": movement._move_cost(cost_terrain, old_y, new_y)})

    # =======================================================================
    # 6) move_tank(state, tank, direction): the full control flow end-to-end.
    #    Each case records the return, the committed x/y, the fuel
    #    (remainder + tanks), and the settle-call record (count + the x/y the
    #    settle saw).  Covers EVERY branch:
    #      a) invalid direction (0, 2, -2, 99)         -> ret False, no mutation
    #      b) immobile                                  -> ret False
    #      c) out of fuel                               -> ret False
    #      d) left-edge clamp (x == half_width, dir -1) -> ret False
    #      e) right-edge clamp (x == w-1-hw, dir +1)    -> ret False
    #      f) one inside each edge -> moves
    #      g) flat move (cost 1)
    #      h) uphill move (cost > 1, fuel borrow)
    #      i) steep uphill (cost clamps at 4)
    #      j) downhill move (cost 1)
    #      k) dead tank: moves + consumes but NO settle call
    #      l) move that exhausts fuel mid-step (underflow floor) yet still commits
    #      m) repeated steps draining a full tank (sequence)
    # =======================================================================
    heights = _profile_heights()

    def run_move(tank_kw, direction, w=360):
        terr = MockTerrain(heights, h=480)
        st = MockState(terr, w=w)
        t = MockTank(**tank_kw)
        ret = movement.move_tank(st, t, direction)
        sx = st.settle_calls[0][0] if st.settle_calls else None
        sy = st.settle_calls[0][1] if st.settle_calls else None
        return {
            "ret": bool(ret),
            "x": t.x, "y": t.y,
            "fuel_remainder": t.fuel_remainder,
            "fuel_tanks": t.inventory[SLOT_FUEL],
            "settle_count": len(st.settle_calls),
            "settle_x": sx, "settle_y": sy,
        }

    def add_move(label, tank_kw, direction, w=360):
        res = run_move(tank_kw, direction, w=w)
        res.update({"fn": "move_tank", "label": label,
                    "in": dict(tank_kw, direction=direction, w=w)})
        cases.append(res)

    # a) invalid directions
    for d in (0, 2, -2, 99, 7, -100):
        add_move(f"baddir_{d}", dict(x=100, y=199, half_width=7, fuel_tanks=2), d)
    # b) immobile (even with fuel + valid dir)
    add_move("immobile", dict(x=100, y=199, half_width=7, mobile=False,
                              fuel_tanks=9), 1)
    add_move("immobile_left", dict(x=100, y=199, half_width=7, mobile=False,
                                   fuel_tanks=9), -1)
    # c) out of fuel (mobile, valid dir, 0 units)
    add_move("nofuel", dict(x=100, y=199, half_width=7, fuel_tanks=0,
                            fuel_remainder=0), 1)
    add_move("nofuel_left", dict(x=100, y=199, half_width=7, fuel_tanks=0,
                                 fuel_remainder=0), -1)
    # d) left-edge clamp: x exactly at half_width, moving left -> new_x < hw
    add_move("left_edge", dict(x=7, y=199, half_width=7, fuel_tanks=5), -1)
    add_move("left_edge_hw3", dict(x=3, y=199, half_width=3, fuel_tanks=5), -1)
    # e) right-edge clamp: x exactly at w-1-half_width, moving right
    add_move("right_edge", dict(x=352, y=199, half_width=7, fuel_tanks=5), 1)
    add_move("right_edge_hw3", dict(x=356, y=199, half_width=3, fuel_tanks=5), 1)
    # f) one inside each edge -> moves succeed (lands exactly on the edge column)
    add_move("left_ok", dict(x=8, y=199, half_width=7, fuel_tanks=5), -1)
    add_move("right_ok", dict(x=351, y=199, half_width=7, fuel_tanks=5), 1)
    # g) flat moves both directions (cost 1)
    add_move("flat_right", dict(x=100, y=199, half_width=7, fuel_tanks=2,
                                fuel_remainder=0), 1)
    add_move("flat_left", dict(x=100, y=199, half_width=7, fuel_tanks=2,
                               fuel_remainder=5), -1)
    add_move("flat_right_rem", dict(x=150, y=199, half_width=7, fuel_tanks=3,
                                    fuel_remainder=7), 1)
    # h) uphill move (into the [200..212] ramp, rise 1 -> cost 2, borrow)
    add_move("uphill1", dict(x=200, y=199, half_width=1, fuel_tanks=5,
                             fuel_remainder=0), 1)
    add_move("uphill1_b", dict(x=205, y=194, half_width=1, fuel_tanks=2,
                               fuel_remainder=0), 1)
    # i) steep uphill (into the [220..225] ramp, rise 5 -> clamp cost 4)
    add_move("steep_up", dict(x=220, y=200, half_width=1, fuel_tanks=5,
                              fuel_remainder=0), 1)
    add_move("steep_up_b", dict(x=222, y=190, half_width=1, fuel_tanks=1,
                                fuel_remainder=0), 1)
    # j) downhill move (into the [240..251] ramp, rise < 0 -> cost 1)
    add_move("downhill", dict(x=240, y=200, half_width=1, fuel_tanks=5,
                              fuel_remainder=0), 1)
    add_move("downhill_b", dict(x=245, y=205, half_width=1, fuel_tanks=2,
                                fuel_remainder=3), 1)
    # k) dead tank: commits x/y + consumes fuel, but settle NOT called
    add_move("dead_right", dict(x=100, y=199, half_width=7, fuel_tanks=2,
                                alive=False), 1)
    add_move("dead_uphill", dict(x=200, y=199, half_width=1, fuel_tanks=5,
                                 alive=False), 1)
    # l) move that exhausts fuel: 1 tank + 0 rem, steep uphill cost 4 -> -4 ->
    #    borrow once (rem 6, 0 tanks); then a flat cost-1 with 0/0 floors at 0.
    add_move("drain_to_floor", dict(x=220, y=200, half_width=1, fuel_tanks=0,
                                    fuel_remainder=2), 1)   # 2 units, cost depends
    add_move("exact_one_unit", dict(x=100, y=199, half_width=7, fuel_tanks=0,
                                    fuel_remainder=1), 1)   # 1 unit, flat cost1 ->0

    # m) repeated-step sequence: walk a tank right across flat ground until it runs
    #    out of fuel, recording each step.  Proves the borrow loop + can_move gate
    #    over a multi-call trajectory (the real per-key drive).
    seq_terr = MockTerrain(heights, h=480)
    seq_state = MockState(seq_terr, w=360)
    seq_tank = MockTank(x=100, y=199, half_width=7, fuel_tanks=1, fuel_remainder=2)
    seq = []
    for _ in range(20):   # more than the ~12 units available -> hits the gate
        r = movement.move_tank(seq_state, seq_tank, 1)
        seq.append({
            "ret": bool(r), "x": seq_tank.x, "y": seq_tank.y,
            "fuel_remainder": seq_tank.fuel_remainder,
            "fuel_tanks": seq_tank.inventory[SLOT_FUEL],
            "settle_count": len(seq_state.settle_calls),
        })
    cases.append({"fn": "move_tank_seq", "label": "drain_walk_right",
                  "start": {"x": 100, "y": 199, "half_width": 7,
                            "fuel_tanks": 1, "fuel_remainder": 2, "w": 360},
                  "direction": 1, "steps": seq})

    return _write("movement", {
        "module": "movement",
        "slot_fuel": SLOT_FUEL,
        "units_per_tank": movement.UNITS_PER_TANK,
        # The mock terrain heights the move_tank/_surface_y batteries run against;
        # the TS test rebuilds the identical column_top lookup from this.
        "profile_heights": heights,
        "profile_h": 480,
        "cases": cases,
    })


DUMPERS = {
    "movement": dump_movement,
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

#!/usr/bin/env python3
"""Oracle vector dumper for the `hazard` module (hostile-sky lightning + cavern
ceiling).  Standalone; copies dump_vectors.py structure.

Drives scorch.hazard (the fidelity reference, itself byte-verified against the DOS
binary) over deterministic, fully-seeded input batteries and writes golden vectors
to vectors/hazard.json.  The TypeScript differential gate (test/hazard.test.ts)
loads this JSON and asserts the TS port reproduces every result EXACTLY (every
hazard output is an integer/index/pixel/boolean/string; this module has no
transcendental math, so there is no epsilon anywhere).

Determinism: every rng is scorch.rng.Rng(seed) with a fixed seed, so the TS side
(new Rng(seed)) reproduces the same MT19937 stream and therefore the same draws.

This is a STATIC use of the Python port -- it imports and calls pure functions
headless (SDL_VIDEODRIVER=dummy).  It never runs the DOS binary.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_hazard.py
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

from scorch import hazard           # noqa: E402
from scorch import rng as rngmod    # noqa: E402
from scorch import constants as C   # noqa: E402


# ---------------------------------------------------------------------------
# JSON write + assertion counter (same shape as dump_vectors.py)
# ---------------------------------------------------------------------------
def _count(payload):
    """Rough assertion count for reporting: sum the lengths of every 'out' list
    plus every scalar 'out'/'rows'/'return'/etc. result the test asserts."""
    total = 0

    def walk(v):
        nonlocal total
        if isinstance(v, dict):
            for k, item in v.items():
                if k == "out" and isinstance(item, list):
                    total += len(item)
                elif k == "out":
                    total += 1
                else:
                    walk(item)
        elif isinstance(v, list):
            for item in v:
                walk(item)

    walk(payload)
    return total


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = _count(payload)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


# ---------------------------------------------------------------------------
# Lightweight mocks mirroring exactly the duck-typed fields hazard.py touches.
# Kept minimal: damage.apply_tank_damage is reached on the strike-damage path,
# so the mocks carry every field that path (and scoring.award_hit/kill) reads.
# Scoring is neutralised by current_shooter=None + cfg.scoring=BASIC, so damage
# is observable purely as integer health/shield deltas (no scoring side effects).
# ---------------------------------------------------------------------------
class Cfg:
    def __init__(self, sky=None, sound=False, hostile_env=False,
                 scoring=C.SCORING_BASIC, team_mode=C.TEAM_NONE):
        self.SKY = sky
        self._sound = sound
        self._hostile = hostile_env
        self.scoring = scoring
        self.team_mode = team_mode

    def is_on(self, key):
        if key == "SOUND":
            return self._sound
        if key == "HOSTILE_ENVIRONMENT":
            return self._hostile
        return False


class Tank:
    def __init__(self, x, y, half_width=10, health=100, shield_hp=0,
                 shield_item=0, alive=True, player_index=0):
        self.x = x
        self.y = y
        self.half_width = half_width
        self.health = health
        self.shield_hp = shield_hp
        self.shield_item = shield_item
        self.alive = alive
        self.player_index = player_index
        self.hits_this_round = {}
        self.hits_career = {}
        # scoring fields (only written when an award fires; BASIC never awards on
        # a hit, and killer=None never awards on a kill -- present for safety).
        self.score = 0
        self.cash = 0
        self.team_id = 0


class Terrain:
    """np-free terrain stand-in: a column-major grid (cols[x][y]) matching the
    TS Grid mock and the Python terrain's grid[x, y] access on the rows
    install_cavern_ceiling writes.  Only `h` and `grid` are read by hazard."""
    def __init__(self, w, h):
        self.w = w
        self.h = h
        # numpy array so the slice assignments grid[:, a:b] = v behave EXACTLY as
        # in the real terrain (same dtype/wrap), which is what hazard writes.
        import numpy as np
        self.grid = np.zeros((w, h), dtype=np.uint8)


class State:
    def __init__(self, w=1024, h=768, seed=0, sky=None, sound=False,
                 hostile_env=False, scoring=C.SCORING_BASIC, tanks=None,
                 live_sky=None, with_flash=True, with_terrain=True):
        self.w = w
        self.h = h
        self.rng = rngmod.Rng(seed)
        self.cfg = Cfg(sky=sky, sound=sound, hostile_env=hostile_env,
                       scoring=scoring)
        self.tanks = tanks if tanks is not None else []
        self.live_sky = live_sky
        self.active_bolts = []
        self.current_shooter = None      # neutralises scoring on the damage path
        self.current_weapon = None
        self.economy = None
        self.flashes = []
        if with_terrain:
            self.terrain = Terrain(w, h)
        if with_flash:
            def add_flash(up, down, rgb, delay=0):
                self.flashes.append([up, down, list(rgb), delay])
            self.add_flash = add_flash

    def on_tank_destroyed(self, victim, weapon):
        # record but do nothing numeric (matches the no-op renderer hook).
        pass


def _poly_to_lists(bolt):
    """[[(x,y),...], ...] -> JSON-friendly [[[x,y],...], ...]."""
    return [[[int(px), int(py)] for (px, py) in poly] for poly in bolt]


def _grid_to_cols(grid):
    """numpy (w, h) -> list-of-columns cols[x] = [grid[x,0], ...]."""
    w, h = grid.shape
    return [[int(grid[x, y]) for y in range(h)] for x in range(w)]


# ---------------------------------------------------------------------------
# resolve_round_sky / is_hostile (string outputs, exact)
# ---------------------------------------------------------------------------
def dump_sky():
    SEEDS = [0, 1, 2, 7, 42, 1234, 2024, 65535, 0xDEADBEEF, 123456789012345]

    # Fixed (non-RANDOM) skies: lower/mixed case, None -> default PLAIN.  Each is
    # deterministic regardless of rng, but we still seed it.
    FIXED = [None, "", "plain", "PLAIN", "Stormy", "STORMY", "stars", "STARS",
             "shaded", "SHADED", "sunset", "SUNSET", "cavern", "CAVERN",
             "black", "BLACK", "weird-unknown"]
    fixed = []
    for s in SEEDS:
        r = rngmod.Rng(s)

        class _C:
            SKY = None

            def is_on(self, k):
                return False
        out = []
        for sky in FIXED:
            c = _C()
            c.SKY = sky
            out.append(hazard.resolve_round_sky(c, r))
        fixed.append({"seed": s, "skies": FIXED, "out": out})

    # RANDOM: each call draws rng.pick(len(pool)) -> picks from the 6-entry pool
    # (never BLACK).  Many calls per seed so the pick rejection loop is exercised.
    random_pick = []
    for s in SEEDS:
        r = rngmod.Rng(s)

        class _C:
            SKY = "RANDOM"

            def is_on(self, k):
                return False
        out = [hazard.resolve_round_sky(_C(), r) for _ in range(200)]
        random_pick.append({"seed": s, "out": out})

    # is_hostile over every sky name + case + null/empty.
    HOSTILE_IN = [None, "", "STORMY", "stormy", "Stormy", "PLAIN", "plain",
                  "STARS", "SHADED", "SUNSET", "CAVERN", "BLACK", "RANDOM", "xyz"]
    hostile = [{"sky": h, "out": bool(hazard.is_hostile(h))} for h in HOSTILE_IN]

    return _write_part("sky", {
        "fixed": fixed,
        "random_pick": random_pick,
        "hostile": hostile,
    })


# ---------------------------------------------------------------------------
# lightning_bolt (integer polylines) -- the recursive core
# ---------------------------------------------------------------------------
def dump_lightning_bolt():
    SEEDS = [0, 1, 2, 3, 7, 11, 42, 99, 1234, 2024, 65535, 0xDEADBEEF,
             0x12345678, 123456789012345]
    # geometry battery: covers downward (normal), zero-distance (y==target_y ->
    # single-point trunk), upward (target_y < y -> negative dy/step, the FLOOR-DIV
    # trap path), short spans (<=12, single segment), and large spans (deep
    # recursion + branching).  Fractional starts test the int() truncation.
    GEOM = [
        (100, 0, 60),       # mid downward
        (200, 0, 500),      # long downward (deep branching)
        (50, 0, 0),         # zero distance: trunk = [(50,0)] only
        (300, 100, 100),    # zero distance non-origin
        (80, 200, 50),      # UPWARD: target above start (negative dy)
        (400, 300, 10),     # upward long
        (10, 0, 5),         # span <=12 single short segment
        (10, 0, 12),        # span == 12 boundary
        (10, 0, 13),        # span == 13 (two segments)
        (0, 0, 700),        # x at 0, very long
        (1023, 0, 760),     # x at right edge, long
        (-30, 0, 90),       # negative start x
        (500, 0, 1),        # span 1
    ]
    out = []
    for s in SEEDS:
        recs = []
        for (x, y, ty) in GEOM:
            r = rngmod.Rng(s)
            bolt = hazard.lightning_bolt(x, y, ty, r)
            recs.append({
                "x": x, "y": y, "ty": ty,
                "out": _poly_to_lists(bolt),
            })
        out.append({"seed": s, "bolts": recs})
    return _write_part("lightning_bolt", {"runs": out})


# ---------------------------------------------------------------------------
# bolt_segments (uses state.w + state.rng) -- integer polylines
# ---------------------------------------------------------------------------
def dump_bolt_segments():
    SEEDS = [0, 1, 2, 3, 7, 42, 1234, 65535, 0xDEADBEEF, 123456789012345]
    # vary w (drives span = max(2, w//16)) incl. tiny w that floors to the min-2,
    # and targets incl. edges/out-of-range so the clamp [0, w-1] is exercised.
    CASES = [
        (1024, 500, 300),
        (1024, 0, 100),
        (1024, 1023, 700),
        (640, 320, 200),
        (16, 8, 50),        # w//16 == 1 -> span = max(2,1) = 2
        (15, 7, 40),        # w//16 == 0 -> span = max(2,0) = 2
        (32, 16, 60),       # w//16 == 2
        (320, 160, 120),
        (1024, -50, 250),   # target left of 0 -> x0 clamps to >= 0
        (1024, 2000, 250),  # target right of w -> x0 clamps to <= w-1
        (200, 100, 0),      # zero target_y
    ]
    out = []
    for s in SEEDS:
        recs = []
        for (w, tx, ty) in CASES:
            st = State(w=w, seed=s, with_flash=False, with_terrain=False)
            seg = hazard.bolt_segments(st, tx, ty)
            recs.append({"w": w, "tx": tx, "ty": ty, "out": _poly_to_lists(seg)})
        out.append({"seed": s, "segs": recs})
    return _write_part("bolt_segments", {"runs": out})


# ---------------------------------------------------------------------------
# maybe_strike -- the full per-turn hook.  Capture EVERYTHING mutated:
# returned bolt polylines, queued active_bolts, queued flashes, per-tank
# health/shield after, and the resolved live_sky.
# ---------------------------------------------------------------------------
def _snapshot_strike(st, ret):
    return {
        "return": (None if ret is None else _poly_to_lists(ret)),
        "active_bolts": [
            {"pts": [[int(a), int(b)] for (a, b) in e["pts"]], "frame": e["frame"]}
            for e in st.active_bolts
        ],
        "flashes": list(st.flashes),
        "live_sky": st.live_sky,
        "tanks": [
            {"health": t.health, "shield_hp": t.shield_hp,
             "shield_item": t.shield_item, "alive": bool(t.alive)}
            for t in st.tanks
        ],
    }


def dump_maybe_strike():
    SEEDS = [0, 1, 2, 3, 5, 7, 11, 13, 42, 99, 1234, 2024, 65535,
             0xDEADBEEF, 123456789012345]

    out = []
    for s in SEEDS:
        recs = []

        # 1) Non-hostile sky (PLAIN): resolves live_sky, returns None, no flash.
        st = State(seed=s, sky="PLAIN")
        ret = hazard.maybe_strike(st)
        recs.append({"case": "plain", **_snapshot_strike(st, ret)})

        # 2) Non-hostile RANDOM (live_sky resolved on the fly from the pool).
        st = State(seed=s, sky="RANDOM")
        ret = hazard.maybe_strike(st)
        recs.append({"case": "random", **_snapshot_strike(st, ret)})

        # 3) STORMY, no tanks: strike gate may fire but no target -> None.
        st = State(seed=s, live_sky="STORMY", tanks=[])
        ret = hazard.maybe_strike(st)
        recs.append({"case": "stormy_no_tanks", **_snapshot_strike(st, ret)})

        # 4) STORMY, HOSTILE_ENV OFF, several tanks: visual only, no damage.
        tanks = [Tank(200, 400), Tank(500, 350, shield_hp=0),
                 Tank(800, 420, half_width=14)]
        st = State(seed=s, live_sky="STORMY", hostile_env=False, tanks=tanks)
        ret = hazard.maybe_strike(st)
        recs.append({"case": "stormy_env_off", **_snapshot_strike(st, ret)})

        # 5) STORMY, HOSTILE_ENV ON, tanks incl. a shielded one: damage applies.
        tanks = [Tank(200, 400, health=100, shield_hp=0),
                 Tank(205, 402, health=80, shield_hp=25, shield_item=3),
                 Tank(800, 420, health=100)]
        st = State(seed=s, live_sky="STORMY", hostile_env=True, tanks=tanks)
        ret = hazard.maybe_strike(st)
        recs.append({"case": "stormy_env_on", **_snapshot_strike(st, ret)})

        # 6) STORMY, ENV ON, low-health tank in column -> possible kill path.
        tanks = [Tank(300, 300, health=5), Tank(303, 305, health=3),
                 Tank(900, 500, health=100)]
        st = State(seed=s, live_sky="STORMY", hostile_env=True, tanks=tanks)
        ret = hazard.maybe_strike(st)
        recs.append({"case": "stormy_kill", **_snapshot_strike(st, ret)})

        # 7) STORMY, ENV ON, SOUND on (exercises the sfx.play no-op branches).
        tanks = [Tank(640, 480, health=50)]
        st = State(seed=s, live_sky="STORMY", hostile_env=True, sound=True,
                   tanks=tanks)
        ret = hazard.maybe_strike(st)
        recs.append({"case": "stormy_sound", **_snapshot_strike(st, ret)})

        out.append({"seed": s, "runs": recs})
    return _write_part("maybe_strike", {"seeds": out})


# ---------------------------------------------------------------------------
# _thunder_flicker -- standalone flash burst (count + staggered delays)
# ---------------------------------------------------------------------------
def dump_thunder_flicker():
    SEEDS = [0, 1, 2, 3, 7, 42, 99, 1234, 2024, 65535, 0xDEADBEEF,
             123456789012345]
    out = []
    for s in SEEDS:
        recs = []
        for sound in (False, True):
            st = State(seed=s, sound=sound)
            hazard._thunder_flicker(st)
            recs.append({"sound": sound, "out": list(st.flashes)})
        # also a no-flash state (state without add_flash) -> early return, no crash
        st_noflash = State(seed=s, with_flash=False)
        before = list(st_noflash.flashes)
        hazard._thunder_flicker(st_noflash)
        recs.append({"sound": "no_add_flash", "out": before})
        out.append({"seed": s, "runs": recs})
    return _write_part("thunder_flicker", {"seeds": out})


# ---------------------------------------------------------------------------
# _strike_damage -- column-hit selection + shield/health deltas
# ---------------------------------------------------------------------------
def dump_strike_damage():
    # No rng dependence (deterministic given tanks), but seed for parity.
    CASES = []
    # aim point and a battery of tanks at varied dx and y relative to aim.
    def make():
        return [
            Tank(100, 200, half_width=10, health=100),           # under column, in y
            Tank(116, 200, half_width=10, health=100),           # dx=16 == hw+6 -> boundary IN
            Tank(117, 200, half_width=10, health=100),           # dx=17 > 16 -> OUT
            Tank(100, 200, half_width=14, health=100),           # wider hw -> boundary moves
            Tank(100, 100, half_width=10, health=100),           # high above aim (y test)
            Tank(100, 200, half_width=10, health=100, shield_hp=5, shield_item=2),  # shield < dmg
            Tank(100, 200, half_width=10, health=100, shield_hp=50, shield_item=2), # shield > dmg
            Tank(100, 200, half_width=10, health=100, alive=False),  # dead -> skipped
            Tank(100, 200, half_width=10, health=8),             # low health (overflow/kill)
        ]
    for aim in [(100, 196), (100, 250), (100, 150), (50, 196)]:
        CASES.append(aim)

    out = []
    for ai, (ax, ay) in enumerate(CASES):
        st = State(seed=ai, hostile_env=True, tanks=make())
        hazard._strike_damage(st, ax, ay)
        out.append({
            "aim_x": ax, "aim_y": ay,
            "out": [
                {"x": t.x, "y": t.y, "hw": t.half_width,
                 "health": t.health, "shield_hp": t.shield_hp,
                 "shield_item": t.shield_item, "alive": bool(t.alive)}
                for t in st.tanks
            ],
        })
    return _write_part("strike_damage", {"cases": out})


# ---------------------------------------------------------------------------
# _register_bolt / age_bolts -- visual queue management
# ---------------------------------------------------------------------------
def dump_bolt_lifecycle():
    # register: only polylines of len>=2 are queued; 1-point trunks dropped.
    sample_bolt = [
        [(10, 0), (12, 12), (9, 24)],   # len 3 -> queued
        [(50, 60)],                     # len 1 -> dropped
        [(7, 7), (8, 9)],               # len 2 -> queued
        [],                             # empty -> dropped
    ]
    st = State(seed=0, with_flash=False, with_terrain=False)
    hazard._register_bolt(st, sample_bolt)
    register = {
        "out": [
            {"pts": [[int(a), int(b)] for (a, b) in e["pts"]], "frame": e["frame"]}
            for e in st.active_bolts
        ],
    }

    # age_bolts: advance frames, expire when frame > max_frames.  Track the count
    # and the surviving frames over several ticks at default max (6) and a custom.
    def fresh_state():
        s = State(seed=0, with_flash=False, with_terrain=False)
        s.active_bolts = [
            {"pts": [[0, 0], [1, 1]], "frame": 0},
            {"pts": [[2, 2], [3, 3]], "frame": 3},
            {"pts": [[4, 4], [5, 5]], "frame": 6},
        ]
        return s

    age_default = []
    st = fresh_state()
    for _ in range(10):
        hazard.age_bolts(st)
        age_default.append([b["frame"] for b in st.active_bolts])
    age_custom = []
    st = fresh_state()
    for _ in range(5):
        hazard.age_bolts(st, max_frames=2)
        age_custom.append([b["frame"] for b in st.active_bolts])

    # age on a state with no active_bolts attribute / empty -> no-op, no crash.
    st_empty = State(seed=0, with_flash=False, with_terrain=False)
    st_empty.active_bolts = []
    hazard.age_bolts(st_empty)
    age_empty = {"out": [len(st_empty.active_bolts)]}

    return _write_part("bolt_lifecycle", {
        "register": register,
        "age_default": {"out": age_default},
        "age_custom": {"out": age_custom},
        "age_empty": age_empty,
    })


# ---------------------------------------------------------------------------
# install_cavern_ceiling -- terrain top-band stamp (rows written + grid contents)
# ---------------------------------------------------------------------------
def dump_cavern_ceiling():
    # CAVERN (writes), case-variant CAVERN (live_sky preset), non-cavern (no-op),
    # tiny terrain h that clamps rows to h, h==1 boundary, and RANDOM-resolved.
    CASES = [
        {"w": 8, "h": 20, "live_sky": "CAVERN", "sky": None},     # full 10-row ceiling
        {"w": 8, "h": 20, "live_sky": "cavern", "sky": None},     # lower-case live_sky
        {"w": 6, "h": 6, "live_sky": "CAVERN", "sky": None},      # h<10 -> rows clamps to 6
        {"w": 5, "h": 1, "live_sky": "CAVERN", "sky": None},      # h==1 boundary
        {"w": 8, "h": 20, "live_sky": "PLAIN", "sky": None},      # non-cavern -> 0 rows
        {"w": 8, "h": 20, "live_sky": None, "sky": "CAVERN"},     # resolve from cfg.SKY
        {"w": 8, "h": 20, "live_sky": None, "sky": "STORMY"},     # resolve -> not cavern
        {"w": 4, "h": 12, "live_sky": "CAVERN", "sky": None},     # exactly 10 rows < h
        {"w": 3, "h": 10, "live_sky": "CAVERN", "sky": None},     # h==10 boundary
    ]
    out = []
    for i, cs in enumerate(CASES):
        st = State(w=cs["w"], h=cs["h"], seed=i, sky=cs["sky"],
                   live_sky=cs["live_sky"], with_flash=False)
        rows = hazard.install_cavern_ceiling(st)
        out.append({
            "w": cs["w"], "h": cs["h"],
            "live_sky": cs["live_sky"], "sky": cs["sky"],
            "rows": rows,
            "grid": _grid_to_cols(st.terrain.grid),
            "fill": int(C.DIRT_SHADE_LO + 8),
            "crust": int(C.DIRT_SHADE_HI),
        })
    return _write_part("cavern_ceiling", {"cases": out})


# ---------------------------------------------------------------------------
# tuning constants exposed for an exact cross-check in the test.
# ---------------------------------------------------------------------------
def dump_constants():
    return _write_part("constants", {
        "BRANCH_DEPTH_CAP": hazard.BRANCH_DEPTH_CAP,
        "BRANCH_RNG_N": hazard.BRANCH_RNG_N,
        "BRANCH_RNG_GT": hazard.BRANCH_RNG_GT,
        "STRIKE_CADENCE": list(hazard.STRIKE_CADENCE),
        "FLICKER_CADENCE": list(hazard.FLICKER_CADENCE),
        "STRIKE_FLASH_UP": hazard.STRIKE_FLASH_UP,
        "STRIKE_FLASH_DOWN": hazard.STRIKE_FLASH_DOWN,
        "STRIKE_FLASH_RGB": list(hazard.STRIKE_FLASH_RGB),
        "FLICKER_MIN": hazard.FLICKER_MIN,
        "FLICKER_RAND": hazard.FLICKER_RAND,
        "FLICKER_UP": hazard.FLICKER_UP,
        "FLICKER_DOWN": hazard.FLICKER_DOWN,
        "FLICKER_GAP": hazard.FLICKER_GAP,
        "FLICKER_RGB": list(hazard.FLICKER_RGB),
        "LIGHTNING_DAMAGE": hazard.LIGHTNING_DAMAGE,
        "STRIKE_HALF_WIDTH": hazard.STRIKE_HALF_WIDTH,
        "CAVERN_CEILING_ROWS": hazard.CAVERN_CEILING_ROWS,
        "RANDOM_SKY_POOL": list(hazard._RANDOM_SKY_POOL),
        "HOSTILE_SKIES": list(hazard.HOSTILE_SKIES),
    })


# parts accumulate into one payload so the JSON is a single hazard.json.
_PARTS = {}


def _write_part(name, payload):
    _PARTS[name] = payload
    return _count(payload)


def main():
    print(f"Oracle: dumping hazard (port = {_SCORCH_PY})")
    total = 0
    total += dump_constants()
    total += dump_sky()
    total += dump_lightning_bolt()
    total += dump_bolt_segments()
    total += dump_maybe_strike()
    total += dump_thunder_flicker()
    total += dump_strike_damage()
    total += dump_bolt_lifecycle()
    total += dump_cavern_ceiling()
    payload = {"module": "hazard", **_PARTS}
    _write("hazard", payload)
    print(f"Done. ~{total} golden assertions for hazard.")


if __name__ == "__main__":
    main()

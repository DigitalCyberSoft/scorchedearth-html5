#!/usr/bin/env python3
"""Oracle vector dumper for the `weapon_behaviors` module.

Drives the Python port's REAL scorch.weapon_behaviors functions (the fidelity
reference, itself byte-verified against 1.5/SCORCH.EXE) over deterministic,
rng-seeded input batteries and writes golden vectors to
vectors/weapon_behaviors.json.  The TypeScript differential gate
(test/weapon_behaviors.test.ts) loads this JSON and asserts the TS port
(src/weapon_behaviors.ts) reproduces every result EXACTLY (integers / indices /
pixels / booleans / strings) or within a tight epsilon (the few trig-derived
direction floats).

This is a STATIC use of the Python port: it imports scorch.weapon_behaviors
headless (SDL_VIDEODRIVER=dummy) and calls its functions against lightweight
mock Tank/Cfg/Terrain/Rng/Projectile/State objects exposing exactly the
duck-typed fields the behaviors read (catalog 11/12).  It never runs the DOS
binary.

DETERMINISM: every battery that touches rng seeds a fresh scorch.rng.Rng(seed)
with a fixed seed, so the TS side (new Rng(seed)) reproduces the same MT19937
stream value-for-value (the rng linchpin is already a green differential gate).
The mock terrain is a real mutable pixel grid implementing read/write/is_solid/
is_dirt/column_top with the SAME algorithm scorch.terrain.Terrain uses (so the
digger-trail stamp and dirt-tower/wedge read-after-write are faithful); the bulk
destructive primitives (carve_circle/deposit_circle/carve_wedge/settle) are
LOGGED with their call args (the behaviors never read terrain back within the
same call after a bulk op, verified), and damage.explode's carve_circle/
add_explosion go through the same logging mocks.

Structure copies oracle/dump_damage.py.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_weapon_behaviors.py
"""
import json
import math
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
    """Assertion count for reporting: every leaf result field is one TS expect()."""
    total = 0
    for group in payload.values():
        if not isinstance(group, list):
            continue
        for v in group:
            if not isinstance(v, dict):
                continue
            for key, val in v.items():
                if key in ("fn", "label", "note"):
                    continue
                if isinstance(val, list):
                    total += _leaves(val)
                else:
                    total += 1
    return total


def _leaves(x):
    if isinstance(x, list):
        return sum(_leaves(i) for i in x) if x else 1
    if isinstance(x, dict):
        return sum(_leaves(i) for i in x.values()) if x else 1
    return 1


# ---------------------------------------------------------------------------
# Mock structs: the minimal duck-typed shapes weapon_behaviors.py reads. The TS
# test (test/weapon_behaviors.test.ts) builds STRUCTURALLY IDENTICAL mocks so the
# only thing under differential test is the behavior arithmetic / control flow.
# ---------------------------------------------------------------------------
import scorch.constants as C  # noqa: E402
from scorch.rng import Rng  # noqa: E402


class MockCfg:
    def __init__(self, sound=True):
        # scoring/team_mode read by damage.explode -> scoring.award_*; pin to
        # values that make the awards deterministic (STANDARD, no teams).
        self.scoring = C.SCORING_STANDARD
        self.team_mode = C.TEAM_NONE
        self._sound = sound

    def is_on(self, key):
        if key == "SOUND":
            return self._sound
        return False


class MockEconomy:
    def unit_price(self, slot):
        return float(slot)


class MockTank:
    def __init__(self, tid, x=100, y=100, half_width=7, health=100,
                 shield_hp=0, shield_item=0, shield_laserproof=False,
                 alive=True, player_index=0, team_id=0, angle=90):
        self.id = tid
        self.x = x
        self.y = y
        self.half_width = half_width
        self.health = health
        self.shield_hp = shield_hp
        self.shield_item = shield_item
        self.shield_laserproof = shield_laserproof
        self.alive = alive
        self.player_index = player_index
        self.team_id = team_id
        self.angle = angle
        self.score = 0
        self.cash = 0
        self.win_counter = 0
        self.inventory = []
        self.hits_this_round = {}
        self.hits_career = {}


class MockTerrain:
    """A real mutable pixel grid (sparse dict) implementing read/write/is_solid/
    is_dirt/column_top with the same algorithm scorch.terrain.Terrain uses, so the
    behaviors' read-after-write paths (digger trail, dirt tower/wedge, laser cut)
    are faithful.  Bulk destructive ops are LOGGED, not rasterized (the behaviors
    never read terrain back within the same call after a bulk op)."""

    def __init__(self, w=360, h=480, surface=None):
        self.w = w
        self.h = h
        # grid: dict[(x, y)] -> palette index. Absent cell == C.COL_SKY.
        self.grid = {}
        # call logs (the differential test asserts these match exactly)
        self.carve_circles = []
        self.deposit_circles = []
        self.carve_wedges = []
        self.settles = []
        # seed a deterministic surface heightmap: column x is dirt for y >=
        # surface(x), sky above. `surface` is a callable x -> top row.
        if surface is not None:
            for x in range(w):
                top = surface(x)
                top = max(0, min(h, top))
                for y in range(top, h):
                    self.grid[(x, y)] = C.COL_DIRT
        # baseline copy: _terrain_snap reports only cells the behavior CHANGES
        # from this pristine surface (so carve-only detonations emit an empty
        # delta and the full ~65k-cell flat fill is never serialized).  The TS
        # test rebuilds the identical surface and computes its own delta the same
        # way, so the differential check is delta == delta.
        self.baseline = dict(self.grid)

    # ---- pixel access ----
    def read(self, x, y):
        if 0 <= x < self.w and 0 <= y < self.h:
            return self.grid.get((x, y), C.COL_SKY)
        return C.COL_SKY

    def write(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.grid[(x, y)] = color

    def is_dirt(self, x, y):
        return C.is_dirt(self.read(x, y))

    def is_solid(self, x, y):
        return C.is_solid(self.read(x, y))

    def column_top(self, x):
        """GROUND surface row: topmost dirt with open sky above; a top-attached
        solid band (cavern ceiling) is skipped.  Returns self.h for an empty or
        fully-filled column.  Faithful re-implementation of
        scorch.terrain.Terrain.column_top (numpy argmax logic, no numpy)."""
        if not (0 <= x < self.w):
            return self.h
        solid = [self.is_solid(x, y) for y in range(self.h)]
        if not solid[0]:                       # normal: sky at the top
            for idx in range(self.h):
                if solid[idx]:
                    return idx
            return self.h
        # column starts solid (cavern ceiling): skip it + the sky gap to ground
        gap = self.h
        for y in range(self.h):
            if not solid[y]:
                gap = y
                break
        if gap >= self.h:                      # no sky at all -> fully filled
            return self.h
        for idx in range(gap, self.h):
            if solid[idx]:
                return idx
        return self.h

    # ---- bulk destructive primitives (logged) ----
    def carve_circle(self, cx, cy, r):
        self.carve_circles.append([int(cx), int(cy), int(r)])

    def deposit_circle(self, cx, cy, r):
        self.deposit_circles.append([cx, cy, r])

    def carve_wedge(self, cx, cy, r, half_angle_deg=45, aim_deg=90):
        self.carve_wedges.append([cx, cy, r, half_angle_deg, aim_deg])

    def settle(self, cfg, rng, x_lo=0, x_hi=None):
        self.settles.append([x_lo, (None if x_hi is None else x_hi)])


class MockProj:
    """The projectile-loop scratch the behaviors read/mutate.  Mirrors the used
    fields of scorch.objects.Projectile (a real Projectile is used where the MIRV
    split spawns children; the parent driving each behavior is this lighter
    mock)."""

    def __init__(self, weapon, owner=None, px=0.0, py=0.0, vx=0.0, vy=0.0,
                 energy=None):
        self.weapon = weapon
        self.owner = owner
        self.px = float(px)
        self.py = float(py)
        self.vx = float(vx)
        self.vy = float(vy)
        self.sx = int(round(px))
        self.sy = int(round(py))
        self.active = True
        self.split_done = False
        self.warheads_left = weapon.warheads
        self.state = {}
        if energy is not None:
            self.state["energy"] = energy
        self.trail = []


class MockState:
    def __init__(self, cfg=None, tanks=None, terrain=None, rng=None,
                 explosion_scale=1.0, current_shooter=None, current_weapon=None):
        self.cfg = cfg if cfg is not None else MockCfg()
        self.tanks = tanks if tanks is not None else []
        self.terrain = terrain if terrain is not None else MockTerrain()
        self.rng = rng if rng is not None else Rng(0)
        self.explosion_scale = explosion_scale
        self.current_shooter = current_shooter
        self.current_weapon = current_weapon
        self.economy = MockEconomy()
        self.projectiles = []
        # observable callback logs
        self.explosions = []
        self.plasma_rings = []
        self.beams = []
        self.destroyed = []
        self.digger_cycles = 0

    def add_explosion(self, x, y, r, dirt_only=False, nuke=False):
        self.explosions.append([int(x), int(y), int(r), bool(dirt_only), bool(nuke)])

    def add_plasma_ring(self, x, y, max_r):
        self.plasma_rings.append([x, y, max_r])

    def add_beam(self, pts):
        self.beams.append([list(p) for p in pts])

    def on_tank_destroyed(self, victim, weapon):
        self.destroyed.append([victim.id, weapon is not None])

    def start_digger_cycle(self):
        self.digger_cycles += 1


def _tank_snap(t):
    """Mutated-state snapshot of a tank, in a fixed order the TS reproduces."""
    return [t.health, t.shield_hp, t.shield_item, bool(t.alive),
            t.score, t.cash, t.win_counter]


def _proj_snap(p):
    """Mutated-state snapshot of the driving projectile."""
    return {
        "px": p.px, "py": p.py, "vx": p.vx, "vy": p.vy,
        "sx": p.sx, "sy": p.sy, "active": bool(p.active),
        "split_done": bool(p.split_done),
        "warheads_left": p.warheads_left,
        "state": _state_dict(p.state),
        "trail": [list(pt) for pt in p.trail],
    }


def _state_dict(d):
    """proj.state scratch as sorted [[k, v], ...] for stable JSON/TS comparison.
    All scratch values here are int/float/bool."""
    out = []
    for k in sorted(d):
        v = d[k]
        out.append([k, v])
    return out


def _terrain_snap(t):
    """Terrain mutation snapshot: the bulk-op call logs + the DELTA cells (every
    cell whose current value differs from the pristine surface baseline), sorted.
    A behavior that only carve_circles/deposits (no write) emits an empty delta;
    write-based behaviors (digger trail, dirt tower/wedge, laser cut) emit exactly
    the cells they changed.  This keeps the vectors small and the differential
    assertion sharp (it pins the writes, not the unchanged terrain fill)."""
    changed = []
    base = t.baseline
    # cells now present-or-changed vs baseline
    for (x, y), c in t.grid.items():
        if base.get((x, y), C.COL_SKY) != c:
            changed.append([x, y, c])
    # cells that existed in baseline but were removed from the grid (write never
    # deletes keys in this mock, so this is defensive; included for completeness)
    for (x, y), c in base.items():
        if (x, y) not in t.grid and c != C.COL_SKY:
            changed.append([x, y, C.COL_SKY])
    changed.sort()
    return {
        "carve_circles": list(t.carve_circles),
        "deposit_circles": list(t.deposit_circles),
        "carve_wedges": list(t.carve_wedges),
        "settles": list(t.settles),
        "cells": changed,
    }


def _state_snap(st):
    """Observable game-state callback logs."""
    return {
        "explosions": list(st.explosions),
        "plasma_rings": list(st.plasma_rings),
        "beams": list(st.beams),
        "destroyed": list(st.destroyed),
        "digger_cycles": st.digger_cycles,
        "current_weapon_name": (st.current_weapon.name
                                if st.current_weapon is not None else None),
    }


# Terrain surface profiles (callables x -> top row), exercised by both sides.
def _surf_flat(top):
    return lambda x: top


def _surf_valley(center, floor, rim, half):
    """A V valley: floor at center column, rising to `rim` height away from it
    within `half` columns, flat at `rim` beyond."""
    def f(x):
        d = abs(x - center)
        if d >= half:
            return rim
        # linear: floor at d=0 up to rim at d=half (rim < floor row -> higher wall)
        return int(floor - (floor - rim) * d / half)
    return f


def _surf_slope(top0, slope):
    return lambda x: int(top0 + slope * x)


def _surf_basin(center, floor, wall, half):
    """A basin (pit): a deep floor at center, high walls on both sides."""
    def f(x):
        d = abs(x - center)
        if d <= half:
            return floor
        return wall
    return f


# ---------------------------------------------------------------------------
# weapon_behaviors dumper
# ---------------------------------------------------------------------------
def dump_weapon_behaviors():
    import scorch.weapon_behaviors as wb
    import scorch.weapons as weapons

    out = {
        "module": "weapon_behaviors",
        "consts": [],
        "eff_radius": [],
        "detonate": [],
        "funky": [],
        "napalm": [],
        "pool_depth": [],
        "nearest_tank": [],
        "dirt_sphere": [],
        "dirt_slump": [],
        "dirt_wedge": [],
        "dirt_settle": [],
        "riot_sphere": [],
        "riot_wedge": [],
        "plasma": [],
        "popcorn": [],
        "dirt_tower": [],
        "single_warhead": [],
        "mirv": [],
        "roller": [],
        "digger": [],
        "sandhog": [],
        "laser": [],
        "plasma_laser": [],
        "first_enemy": [],
    }

    # -- module constants --
    out["consts"].append({
        "fn": "const",
        "LASER_BLEED": wb.LASER_BLEED,
        "RIOT_WEDGE_HALF_charge": wb.RIOT_WEDGE_HALF["Riot Charge"],
        "RIOT_WEDGE_HALF_blast": wb.RIOT_WEDGE_HALF["Riot Blast"],
    })

    # -- eff_radius: every offensive weapon x every resolution scalar --
    SCALES = [1.0, 1.5, 2.0]
    for sc in SCALES:
        st = MockState(explosion_scale=sc)
        for it in weapons.ITEMS:
            out["eff_radius"].append({
                "fn": "eff_radius", "idx": it.idx, "name": it.name,
                "scale": sc, "out": wb.eff_radius(st, it),
            })

    # ---------------------------------------------------------------------
    # detonate(): the full dispatch table.  For each behavior class, drive a
    # detonation at a fixed (x, y) over a flat terrain + a single enemy tank in
    # range, and snapshot the terrain/state/tank mutations + the latched weapon.
    # Covers: tracer (no sound, no effect), nuclear (own engine), explosive,
    # riot_sphere/wedge, dirt_*, plasma, leapfrog/mirv->explosive, digger/sandhog
    # ->dud, and the reconstructed popcorn/dirt_tower.
    # ---------------------------------------------------------------------
    # weapon indices spanning every behavior + category branch in detonate.
    DET_WEAPONS = [
        0,   # Baby Missile  explosive
        1,   # Missile       explosive
        2,   # Baby Nuke     nuclear (own engine)
        3,   # Nuke          nuclear
        4,   # LeapFrog      leapfrog -> explosive
        6,   # MIRV          mirv -> explosive
        8,   # Napalm        napalm
        10,  # Tracer        tracer (no sound, no effect)
        12,  # Baby Roller   roller -> explosive
        15,  # Riot Charge   riot_wedge
        17,  # Riot Bomb     riot_sphere
        19,  # Baby Digger   digger -> dud
        22,  # Baby Sandhog  sandhog -> dud
        25,  # Dirt Clod     dirt_sphere
        28,  # Liquid Dirt   dirt_slump
        29,  # Dirt Charge   dirt_wedge
        30,  # Earth Disrupter dirt_settle
        31,  # Plasma Blast  plasma
    ]
    for sc in (1.0, 2.0):
        for sound in (True, False):
            for widx in DET_WEAPONS:
                w = weapons.ITEMS[widx]
                terr = MockTerrain(surface=_surf_flat(300))
                # enemy tank inside any plausible blast, plus far tank
                enemy = MockTank("e", x=200, y=298, team_id=2, player_index=0)
                far = MockTank("f", x=20, y=298, team_id=2, player_index=1)
                shooter = MockTank("s", x=100, y=298, team_id=1, player_index=5,
                                   angle=70)
                st = MockState(cfg=MockCfg(sound=sound), terrain=terr,
                               tanks=[enemy, far], rng=Rng(1000 + widx),
                               explosion_scale=sc, current_shooter=shooter)
                proj = MockProj(w, owner=shooter, px=200.0, py=290.0)
                wb.detonate(st, proj, 200, 290)
                out["detonate"].append({
                    "fn": "detonate", "idx": widx, "name": w.name,
                    "behavior": w.behavior, "scale": sc, "sound": bool(sound),
                    "enemy": _tank_snap(enemy), "far": _tank_snap(far),
                    "terrain": _terrain_snap(terr), "state": _state_snap(st),
                })

    # ---------------------------------------------------------------------
    # _det_funky via detonate: rng-seeded scatter chain. Snapshot the full
    # explosion log (each scatter blast's carve via damage.explode) + tank dmg.
    # Several seeds, scales, and a near tank that the per-flame charge can hit.
    # ---------------------------------------------------------------------
    for seed in [1, 2, 7, 42, 1234]:
        for sc in (1.0, 2.0):
            w = weapons.ITEMS[5]  # Funky Bomb, blast 80, scatter 15
            terr = MockTerrain(surface=_surf_flat(300))
            near = MockTank("n", x=205, y=300, team_id=2, player_index=0,
                            health=100)
            shooter = MockTank("s", x=100, y=300, team_id=1, player_index=5)
            st = MockState(terrain=terr, tanks=[near], rng=Rng(seed),
                           explosion_scale=sc, current_shooter=shooter)
            proj = MockProj(w, owner=shooter, px=200.0, py=300.0)
            wb.detonate(st, proj, 200, 300)
            out["funky"].append({
                "fn": "funky", "seed": seed, "scale": sc,
                "near": _tank_snap(near),
                "explosions": list(st.explosions),
                "carve_circles": list(terr.carve_circles),
                "destroyed": list(st.destroyed),
            })

    # ---------------------------------------------------------------------
    # _det_napalm via detonate: pool-depth-driven heat. Vary terrain (flat,
    # basin, valley) so _pool_depth returns 0 / partial / ~1, and the heat coeff
    # interpolation + pool_r widening + per-tank round() damage all exercise.
    # ---------------------------------------------------------------------
    NAP_TERR = [
        ("flat", _surf_flat(300)),          # depth 0 -> low coeff
        ("basin", _surf_basin(200, 360, 250, 10)),
        ("valley", _surf_valley(200, 360, 300, 20)),
        ("deep", _surf_basin(200, 400, 200, 6)),   # depth ~1 -> high coeff
        # SHALLOW (walls +3 rows at center 200): a FRACTIONAL pool depth, so the
        # coeff interpolation low+(high-low)*depth lands strictly between the
        # endpoints and the pool_r widening 1+0.5*depth is a non-integer scale --
        # the midpoint of the heat law, untested by the 0/1 terrains.
        ("shallow", _surf_basin(200, 360, 357, 4)),
    ]
    for widx in (8, 9):  # Napalm, Hot Napalm
        for tname, surf in NAP_TERR:
            for sc in (1.0, 2.0):
                w = weapons.ITEMS[widx]
                terr = MockTerrain(surface=surf)
                # tanks at several distances around the pool center
                t0 = MockTank("t0", x=200, y=300, team_id=2, player_index=0)
                t1 = MockTank("t1", x=210, y=300, team_id=2, player_index=1)
                t2 = MockTank("t2", x=225, y=300, team_id=2, player_index=2)
                shooter = MockTank("s", x=100, y=300, team_id=1, player_index=5)
                st = MockState(terrain=terr, tanks=[t0, t1, t2], rng=Rng(99),
                               explosion_scale=sc, current_shooter=shooter)
                proj = MockProj(w, owner=shooter, px=200.0, py=300.0)
                wb.detonate(st, proj, 200, 300)
                out["napalm"].append({
                    "fn": "napalm", "idx": widx, "name": w.name,
                    "terr": tname, "scale": sc,
                    "t0": _tank_snap(t0), "t1": _tank_snap(t1),
                    "t2": _tank_snap(t2),
                    "explosions": list(st.explosions),
                    "carve_circles": list(terr.carve_circles),
                })

    # ---------------------------------------------------------------------
    # _pool_depth directly: a battery of terrains and radii probing the
    # min(left_rise, right_rise)/r clamp.  (Accessed via wb._pool_depth.)
    # ---------------------------------------------------------------------
    POOL_TERR = [
        ("flat", _surf_flat(300)),
        ("basin6", _surf_basin(180, 400, 200, 6)),
        ("basin10", _surf_basin(180, 360, 250, 10)),
        ("valley", _surf_valley(180, 360, 300, 20)),
        ("slope", _surf_slope(280, 1)),
        ("onewall", lambda x: 250 if x < 180 else 360),
        # SHALLOW walls rising only 3 rows: at center x=180, enclosed=3, so
        # depth = 3/r is FRACTIONAL for r in {5,10,20,40} (0.6/0.3/0.15/0.075) --
        # this pins the `enclosed / r` division and the napalm coeff
        # interpolation midpoint, which the deep basins (depth->1) do not.
        ("shallow3", _surf_basin(180, 360, 357, 4)),
        ("shallow7", _surf_basin(180, 360, 353, 4)),
    ]
    for tname, surf in POOL_TERR:
        terr = MockTerrain(surface=surf)
        for cxp in (180, 185, 200):
            for r in (5, 10, 20, 40):
                out["pool_depth"].append({
                    "fn": "pool_depth", "terr": tname, "x": cxp, "r": r,
                    "out": wb._pool_depth(MockState(terrain=terr), cxp, 300, r),
                })

    # ---------------------------------------------------------------------
    # _nearest_tank: tie-break (first in list wins on equal distance), dead skip,
    # empty list, exact integer distances.
    # ---------------------------------------------------------------------
    NT_TANKS = [
        ("a", 100, 100, True), ("b", 110, 100, True), ("c", 100, 110, True),
        ("d", 90, 100, False), ("e", 103, 104, True),
    ]
    for (qx, qy) in [(100, 100), (105, 100), (100, 105), (200, 200), (103, 104)]:
        tanks = [MockTank(n, x=x, y=y, alive=al) for (n, x, y, al) in NT_TANKS]
        st = MockState(tanks=tanks)
        best = wb._nearest_tank(st, qx, qy)
        out["nearest_tank"].append({
            "fn": "nearest_tank", "qx": qx, "qy": qy,
            "best": (best.id if best is not None else None),
        })
    # empty list
    out["nearest_tank"].append({
        "fn": "nearest_tank", "qx": 0, "qy": 0,
        "best": (lambda b: b.id if b is not None else None)(
            wb._nearest_tank(MockState(tanks=[]), 0, 0)),
    })

    # ---------------------------------------------------------------------
    # _det_dirt_sphere / slump / settle: terrain bulk-op logs + sfx (no numeric).
    # ---------------------------------------------------------------------
    for widx in (25, 26, 27):  # Dirt Clod / Ball / Ton
        for sc in (1.0, 2.0):
            w = weapons.ITEMS[widx]
            terr = MockTerrain(surface=_surf_flat(300))
            st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5))
            proj = MockProj(w, px=150.0, py=290.0)
            wb.detonate(st, proj, 150, 290)
            out["dirt_sphere"].append({
                "fn": "dirt_sphere", "idx": widx, "name": w.name, "scale": sc,
                "terrain": _terrain_snap(terr),
            })
    for sc in (1.0, 2.0):
        w = weapons.ITEMS[28]  # Liquid Dirt
        terr = MockTerrain(surface=_surf_flat(300))
        st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5))
        proj = MockProj(w, px=150.0, py=290.0)
        wb.detonate(st, proj, 150, 290)
        out["dirt_slump"].append({
            "fn": "dirt_slump", "scale": sc, "terrain": _terrain_snap(terr),
        })
    for sc in (1.0, 2.0):
        w = weapons.ITEMS[30]  # Earth Disrupter
        terr = MockTerrain(w=320, surface=_surf_flat(300))
        st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5))
        proj = MockProj(w, px=150.0, py=290.0)
        wb.detonate(st, proj, 150, 290)
        out["dirt_settle"].append({
            "fn": "dirt_settle", "scale": sc, "terrain": _terrain_snap(terr),
        })

    # ---------------------------------------------------------------------
    # _det_dirt_wedge: read-after-write tower of dirt cells (math.tan(35deg)).
    # Several scales (radius) + an existing-dirt obstruction so is_solid gates.
    # ---------------------------------------------------------------------
    for sc in (1.0, 2.0):
        for widx in (29,):  # Dirt Charge
            w = weapons.ITEMS[widx]
            # a flat floor below + a small solid lump in the wedge path
            def surf(x):
                return 300 if not (148 <= x <= 152) else 280
            terr = MockTerrain(surface=surf)
            st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5))
            proj = MockProj(w, px=150.0, py=300.0)
            wb.detonate(st, proj, 150, 300)
            out["dirt_wedge"].append({
                "fn": "dirt_wedge", "scale": sc, "name": w.name,
                "terrain": _terrain_snap(terr),
            })

    # ---------------------------------------------------------------------
    # _det_riot_sphere / _det_riot_wedge: carve logs + add_explosion(dirt_only)
    # + the turret-aim wedge over several owner angles.
    # ---------------------------------------------------------------------
    for widx in (17, 18):  # Riot Bomb, Heavy Riot Bomb
        for sc in (1.0, 1.5):
            w = weapons.ITEMS[widx]
            terr = MockTerrain(surface=_surf_flat(300))
            st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5))
            proj = MockProj(w, px=150.0, py=290.0)
            wb.detonate(st, proj, 150, 290)
            out["riot_sphere"].append({
                "fn": "riot_sphere", "idx": widx, "name": w.name, "scale": sc,
                "terrain": _terrain_snap(terr),
                "explosions": list(st.explosions),
            })
    for widx in (15, 16):  # Riot Charge (45), Riot Blast (60)
        for sc in (1.0, 2.0):
            for aim in (0, 45, 90, 135, 180):
                w = weapons.ITEMS[widx]
                terr = MockTerrain(surface=_surf_flat(300))
                shooter = MockTank("s", x=150, y=290, angle=aim, team_id=1,
                                   player_index=5)
                st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5),
                               current_shooter=shooter)
                proj = MockProj(w, owner=shooter, px=150.0, py=290.0)
                wb.detonate(st, proj, 150, 290)
                out["riot_wedge"].append({
                    "fn": "riot_wedge", "idx": widx, "name": w.name,
                    "scale": sc, "aim": aim,
                    "terrain": _terrain_snap(terr),
                })
    # riot_wedge default aim when owner has no angle / is None
    for sc in (1.0,):
        w = weapons.ITEMS[15]
        terr = MockTerrain(surface=_surf_flat(300))
        st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(5))
        proj = MockProj(w, owner=None, px=150.0, py=290.0)
        wb.detonate(st, proj, 150, 290)
        out["riot_wedge"].append({
            "fn": "riot_wedge", "idx": 15, "name": w.name, "scale": sc,
            "aim": "default", "terrain": _terrain_snap(terr),
        })

    # ---------------------------------------------------------------------
    # _det_plasma via detonate: carve + ring + latched weapon + dmg.
    # ---------------------------------------------------------------------
    for sc in (1.0, 1.5, 2.0):
        w = weapons.ITEMS[31]  # Plasma Blast
        terr = MockTerrain(surface=_surf_flat(300))
        enemy = MockTank("e", x=152, y=298, team_id=2, player_index=0)
        shooter = MockTank("s", x=100, y=298, team_id=1, player_index=5)
        st = MockState(terrain=terr, tanks=[enemy], explosion_scale=sc,
                       rng=Rng(5), current_shooter=shooter)
        proj = MockProj(w, owner=shooter, px=150.0, py=290.0)
        wb.detonate(st, proj, 150, 290)
        out["plasma"].append({
            "fn": "plasma", "scale": sc, "enemy": _tank_snap(enemy),
            "terrain": _terrain_snap(terr),
            "plasma_rings": list(st.plasma_rings),
            "explosions": list(st.explosions),
            "current_weapon_name": st.current_weapon.name,
        })

    # ---------------------------------------------------------------------
    # _det_popcorn / _det_dirt_tower: reconstructed binary-only items.  These
    # have no table behavior key, so dispatch them directly (the names map to
    # _det_popcorn/_det_dirt_tower in _DETONATORS but no ITEM uses them); build
    # a synthetic Item carrying the behavior + a params bag.
    # ---------------------------------------------------------------------
    for seed in [3, 11, 99]:
        for sc in (1.0, 2.0):
            w = weapons.Item(99, "Popcorn Bomb", 0, 1, 0, "special",
                             blast=30, behavior="popcorn",
                             params={"pops": 8})
            terr = MockTerrain(surface=_surf_flat(300))
            enemy = MockTank("e", x=150, y=300, team_id=2, player_index=0)
            shooter = MockTank("s", x=100, y=300, team_id=1, player_index=5)
            st = MockState(terrain=terr, tanks=[enemy], explosion_scale=sc,
                           rng=Rng(seed), current_shooter=shooter)
            proj = MockProj(w, owner=shooter, px=150.0, py=300.0)
            wb.detonate(st, proj, 150, 300)
            out["popcorn"].append({
                "fn": "popcorn", "seed": seed, "scale": sc,
                "enemy": _tank_snap(enemy),
                "explosions": list(st.explosions),
                "carve_circles": list(terr.carve_circles),
            })
    for sc in (1.0, 2.0):
        w = weapons.Item(98, "Dirt Tower", 0, 1, 0, "dirt",
                         blast=30, behavior="dirt_tower")
        terr = MockTerrain(surface=_surf_flat(300))
        st = MockState(terrain=terr, explosion_scale=sc, rng=Rng(7))
        proj = MockProj(w, px=150.0, py=300.0)
        wb.detonate(st, proj, 150, 300)
        out["dirt_tower"].append({
            "fn": "dirt_tower", "scale": sc, "terrain": _terrain_snap(terr),
        })

    # ---------------------------------------------------------------------
    # _single_warhead: copy.copy keeps idx/name/blast/fan; overrides behavior +
    # warheads.  Check over MIRV + Death's Head.
    # ---------------------------------------------------------------------
    for widx in (6, 7):
        w = weapons.ITEMS[widx]
        child = wb._single_warhead(w)
        out["single_warhead"].append({
            "fn": "single_warhead", "idx": widx,
            "child_idx": child.idx, "child_name": child.name,
            "child_blast": child.blast, "child_behavior": child.behavior,
            "child_warheads": child.warheads, "child_fan": child.fan,
            # parent must be untouched
            "parent_behavior": w.behavior, "parent_warheads": w.warheads,
        })

    # ---------------------------------------------------------------------
    # on_apogee (MIRV / Death's Head split): the deterministic fan.  Spawns
    # children at integer x-velocity offsets fan*(i-(n+1)//2), skipping offset 0.
    # Drive over both multi weapons + several parent velocities + a non-mirv
    # (no-op) + a split_done (no-op).
    # ---------------------------------------------------------------------
    def _children_snap(st):
        rows = []
        for c in st.projectiles:
            rows.append([
                c.weapon.behavior, c.weapon.warheads, c.weapon.blast,
                c.px, c.py, c.vx, c.vy, c.warheads_left, bool(c.split_done),
                (c.owner.id if c.owner is not None else None),
            ])
        return rows

    for widx in (6, 7):  # MIRV (5/50), Death's Head (9/20)
        for (pvx, pvy) in [(0.0, -100.0), (37.5, -80.0), (-12.0, -60.0),
                           (200.0, -10.0)]:
            w = weapons.ITEMS[widx]
            owner = MockTank("o", x=100, y=300, team_id=1, player_index=5)
            st = MockState(tanks=[owner], current_shooter=owner)
            proj = MockProj(w, owner=owner, px=250.0, py=40.0, vx=pvx, vy=pvy)
            wb.on_apogee(st, proj)
            out["mirv"].append({
                "fn": "mirv", "idx": widx, "name": w.name,
                "pvx": pvx, "pvy": pvy,
                "proj_active": bool(proj.active),
                "proj_split_done": bool(proj.split_done),
                "n_children": len(st.projectiles),
                "children": _children_snap(st),
            })
    # non-mirv -> no-op
    w = weapons.ITEMS[0]
    st = MockState()
    proj = MockProj(w, px=10.0, py=10.0, vx=5.0, vy=-5.0)
    wb.on_apogee(st, proj)
    out["mirv"].append({
        "fn": "mirv", "idx": 0, "name": w.name, "pvx": 5.0, "pvy": -5.0,
        "proj_active": bool(proj.active), "proj_split_done": bool(proj.split_done),
        "n_children": len(st.projectiles), "children": _children_snap(st),
    })
    # mirv but already split -> no-op
    w = weapons.ITEMS[6]
    st = MockState()
    proj = MockProj(w, px=10.0, py=10.0, vx=5.0, vy=-5.0)
    proj.split_done = True
    wb.on_apogee(st, proj)
    out["mirv"].append({
        "fn": "mirv", "idx": 6, "name": w.name + "_done", "pvx": 5.0, "pvy": -5.0,
        "proj_active": bool(proj.active), "proj_split_done": bool(proj.split_done),
        "n_children": len(st.projectiles), "children": _children_snap(st),
    })

    # ---------------------------------------------------------------------
    # Roller: start_roller (downhill dir + seat) then step_roller to resolution.
    # Drive over valley/slope terrains, a tank in the path, and edge bounds.
    # Run the full step loop and record the path + final detonation.
    # ---------------------------------------------------------------------
    ROLL_TERR = [
        ("valley_R", _surf_valley(250, 360, 300, 40)),   # valley to the right of start
        ("valley_L", _surf_valley(120, 360, 300, 40)),   # valley to the left
        ("slope_dn", _surf_slope(280, -1)),              # downhill to the right? slope neg
        ("slope_up", _surf_slope(200, 1)),
        ("flat", _surf_flat(300)),
        ("cliff", lambda x: 200 if x < 180 else 360),    # steep drop at x=180
    ]
    for widx in (12, 13, 14):  # Baby / Roller / Heavy Roller
        for tname, surf in ROLL_TERR:
            for startx in (160, 200):
                w = weapons.ITEMS[widx]
                terr = MockTerrain(surface=surf)
                # a tank somewhere on the field that may interrupt the roll
                tk = MockTank("t", x=235, y=298, team_id=2, player_index=0,
                              half_width=7)
                shooter = MockTank("s", x=100, y=298, team_id=1, player_index=5)
                st = MockState(terrain=terr, tanks=[tk, shooter],
                               rng=Rng(2000 + widx), explosion_scale=1.0,
                               current_shooter=shooter)
                proj = MockProj(w, owner=shooter, px=float(startx), py=100.0)
                wb.start_roller(st, proj, startx, 100)
                path = [[proj.px, proj.py, proj.state.get("dir")]]
                live = True
                steps = 0
                while live and steps < 2000:
                    live = wb.step_roller(st, proj)
                    path.append([proj.px, proj.py, proj.active])
                    steps += 1
                out["roller"].append({
                    "fn": "roller", "idx": widx, "name": w.name,
                    "terr": tname, "startx": startx,
                    "dir": proj.state.get("dir"),
                    "steps": steps, "path": path,
                    "active": bool(proj.active),
                    "tank": _tank_snap(tk),
                    "carve_circles": list(terr.carve_circles),
                    "explosions": list(st.explosions),
                    "current_weapon_name": (st.current_weapon.name
                                            if st.current_weapon else None),
                })

    # ---------------------------------------------------------------------
    # Digger: start_digger (bore_half + max_depth) then step_digger to fizzle.
    # Per tier (Baby -10 / Digger -20 / Heavy -35) the bore width + depth differ.
    # Record the per-step position + the carved/glowed cells + digger-cycle arms.
    # ---------------------------------------------------------------------
    for widx in (19, 20, 21):  # Baby / Digger / Heavy Digger
        w = weapons.ITEMS[widx]
        terr = MockTerrain(surface=_surf_flat(300))
        st = MockState(terrain=terr, rng=Rng(3000 + widx), explosion_scale=1.0)
        proj = MockProj(w, px=150.0, py=300.0)
        wb.start_digger(st, proj, 150, 300)
        positions = [[proj.px, proj.py]]
        live = True
        steps = 0
        while live and steps < 1000:
            live = wb.step_digger(st, proj)
            positions.append([proj.px, proj.py, proj.active])
            steps += 1
        out["digger"].append({
            "fn": "digger", "idx": widx, "name": w.name,
            "bore_half": proj.state["bore_half"],
            "max_depth": proj.state["max_depth"],
            "depth": proj.state["depth"],
            "steps": steps, "active": bool(proj.active),
            "positions": positions,
            "digger_cycles": st.digger_cycles,
            "terrain": _terrain_snap(terr),
        })

    # ---------------------------------------------------------------------
    # Sandhog: start_sandhog (homing pick = first enemy in order) then
    # step_sandhog: tunnels toward target_x, +1 row/step, fires the under-tank
    # charge per warhead.  Three modes:
    #   "owner_near": the owner sits in the bore column (x=150).  step_sandhog has
    #     NO self-guard (unlike the homing pick), so the FIRST step's under-tank
    #     test matches the OWNER (abs(150-151)<=7, py=301>=290) and the sandhog
    #     fires its charge on its own firing tank -- a real port quirk this case
    #     LOCKS by snapshotting the shooter.
    #   "owner_far": the owner is moved out of the bore (x=10), so the homing
    #     target = the enemy and the charge fires on the ENEMY across warheads as
    #     the sandhog tunnels under its buried column.
    #   "no_enemy": no live enemy -> tunnel straight down (target = x).
    # Vary the warhead count (Baby 1 / Sandhog 2 / Heavy 4).
    # ---------------------------------------------------------------------
    for widx in (22, 23, 24):  # Baby (1) / Sandhog (2) / Heavy (4) warheads
        for mode in ("owner_near", "owner_far", "no_enemy"):
            w = weapons.ITEMS[widx]
            terr = MockTerrain(surface=_surf_flat(300))
            owner_x = 150 if mode == "owner_near" else 10
            shooter = MockTank("s", x=owner_x, y=290, team_id=1, player_index=5)
            tanks = [shooter]
            enemy = enemy2 = None
            if mode in ("owner_near", "owner_far"):
                # a buried enemy IN the bore column (x=160 = the homing target),
                # spanning several rows so the sandhog passes under it; in
                # owner_far this enemy takes the charge once per step under it
                # (one warhead per step).
                enemy = MockTank("e", x=160, y=305, team_id=2, player_index=0,
                                 health=100, half_width=7)
                enemy2 = MockTank("e2", x=160, y=315, team_id=2, player_index=1,
                                  health=100, half_width=7)
                tanks = [shooter, enemy, enemy2]
            st = MockState(terrain=terr, tanks=tanks, rng=Rng(4000 + widx),
                           explosion_scale=1.0, current_shooter=shooter)
            proj = MockProj(w, owner=shooter, px=150.0, py=300.0)
            wb.start_sandhog(st, proj, 150, 300)
            positions = [[proj.px, proj.py]]
            live = True
            steps = 0
            while live and steps < 1000:
                live = wb.step_sandhog(st, proj)
                positions.append([proj.px, proj.py, proj.active,
                                  proj.state.get("warheads")])
                steps += 1
            rec = {
                "fn": "sandhog", "idx": widx, "name": w.name, "mode": mode,
                "has_enemy": (mode != "no_enemy"),
                "target_x": proj.state["target_x"],
                "start_y": proj.state["start_y"],
                "warheads_left": proj.state.get("warheads"),
                "depth": proj.state["depth"],
                "steps": steps, "active": bool(proj.active),
                "positions": positions,
                "digger_cycles": st.digger_cycles,
                "shooter": _tank_snap(shooter),
                "current_weapon_name": (st.current_weapon.name
                                        if st.current_weapon else None),
            }
            if mode != "no_enemy":
                rec["enemy"] = _tank_snap(enemy)
                rec["enemy2"] = _tank_snap(enemy2)
            out["sandhog"].append(rec)

    # ---------------------------------------------------------------------
    # fire_laser: Bresenham-style beam march along atan2(vy,vx).  Vary the
    # launch direction (several (vx,vy) so cos/-sin sweep), the energy, the
    # terrain (dirt to cut), tanks in the beam (damaged, with shields, with a
    # laserproof Super-Mag that STOPS the beam), and out-of-bounds clipping.
    # ---------------------------------------------------------------------
    LASER_DIRS = [
        (10.0, 0.0), (0.0, -10.0), (10.0, -10.0), (-10.0, -10.0),
        (10.0, -3.0), (3.0, -10.0), (-7.0, -4.0), (5.0, 5.0),
    ]
    for (vx, vy) in LASER_DIRS:
        for energy in (50, 120, 200):
            w = weapons.ITEMS[32]  # Laser
            # a dirt slab the beam crosses
            terr = MockTerrain(surface=_surf_flat(150))
            # tanks along plausible beam paths
            t_hit = MockTank("h", x=160, y=104, team_id=2, player_index=0,
                             health=100)
            t_shield = MockTank("sh", x=175, y=104, team_id=2, player_index=1,
                                health=100, shield_hp=200, shield_item=1)
            shooter = MockTank("s", x=150, y=120, team_id=1, player_index=5)
            st = MockState(terrain=terr, tanks=[t_hit, t_shield, shooter],
                           rng=Rng(5), current_shooter=shooter)
            proj = MockProj(w, owner=shooter, px=150.0, py=100.0,
                            vx=vx, vy=vy, energy=energy)
            wb.fire_laser(st, proj)
            out["laser"].append({
                "fn": "laser", "vx": vx, "vy": vy, "energy": energy,
                "ang": math.atan2(vy, vx),
                "cos": math.cos(math.atan2(vy, vx)),
                "neg_sin": -math.sin(math.atan2(vy, vx)),
                "n_pts": len(proj.trail),
                "trail": [list(p) for p in proj.trail],
                "active": bool(proj.active),
                "t_hit": _tank_snap(t_hit), "t_shield": _tank_snap(t_shield),
                "beams": list(st.beams),
                "current_weapon_name": st.current_weapon.name,
            })
    # laserproof Super-Mag in the beam STOPS it (energy -> 0): the trail is
    # truncated at the shield tank.
    for (vx, vy) in [(10.0, 0.0)]:
        w = weapons.ITEMS[32]
        terr = MockTerrain(surface=_surf_flat(150))
        proof = MockTank("p", x=160, y=104, team_id=2, player_index=0,
                         health=100, shield_hp=200, shield_item=1,
                         shield_laserproof=True)
        shooter = MockTank("s", x=150, y=120, team_id=1, player_index=5)
        st = MockState(terrain=terr, tanks=[proof, shooter], rng=Rng(5),
                       current_shooter=shooter)
        proj = MockProj(w, owner=shooter, px=150.0, py=100.0, vx=vx, vy=vy,
                        energy=200)
        wb.fire_laser(st, proj)
        out["laser"].append({
            "fn": "laser", "vx": vx, "vy": vy, "energy": 200,
            "ang": math.atan2(vy, vx),
            "cos": math.cos(math.atan2(vy, vx)),
            "neg_sin": -math.sin(math.atan2(vy, vx)),
            "n_pts": len(proj.trail),
            "trail": [list(p) for p in proj.trail],
            "active": bool(proj.active),
            "t_hit": _tank_snap(proof), "t_shield": _tank_snap(proof),
            "beams": list(st.beams),
            "current_weapon_name": st.current_weapon.name,
            "note": "laserproof_stop",
        })

    # ---------------------------------------------------------------------
    # fire_plasma_laser: beam then plasma burst at the last beam pixel.
    # ---------------------------------------------------------------------
    for (vx, vy) in [(10.0, 0.0), (7.0, -7.0), (0.0, -10.0)]:
        w = weapons.Item(97, "Plasma Laser", 0, 1, 0, "energy",
                         blast=40, behavior="plasma_laser")
        terr = MockTerrain(surface=_surf_flat(150))
        enemy = MockTank("e", x=180, y=104, team_id=2, player_index=0,
                         health=100)
        shooter = MockTank("s", x=150, y=120, team_id=1, player_index=5)
        st = MockState(terrain=terr, tanks=[enemy, shooter], rng=Rng(5),
                       explosion_scale=1.0, current_shooter=shooter)
        proj = MockProj(w, owner=shooter, px=150.0, py=100.0, vx=vx, vy=vy,
                        energy=200)
        wb.fire_plasma_laser(st, proj)
        out["plasma_laser"].append({
            "fn": "plasma_laser", "vx": vx, "vy": vy,
            "n_pts": len(proj.trail),
            "trail_last": (list(proj.trail[-1]) if proj.trail else None),
            "enemy": _tank_snap(enemy),
            "beams": list(st.beams),
            "plasma_rings": list(st.plasma_rings),
            "carve_circles": list(terr.carve_circles),
            "explosions": list(st.explosions),
            "current_weapon_name": st.current_weapon.name,
        })

    # ---------------------------------------------------------------------
    # _first_enemy_in_order: first alive non-owner in array order.
    # ---------------------------------------------------------------------
    FE_CASES = [
        # (tank specs as (id, alive), owner_id)
        ([("a", True), ("b", True)], "a"),       # owner is first; pick b? owner is a -> b
        ([("a", True), ("b", True)], "b"),       # owner b -> a
        ([("a", False), ("b", True)], "x"),      # owner not in list -> first alive = b
        ([("a", False), ("b", False)], "x"),     # none alive -> None
        ([("a", True), ("b", True), ("c", True)], "a"),  # -> b
    ]
    for specs, owner_id in FE_CASES:
        tanks = [MockTank(n, alive=al, player_index=i)
                 for i, (n, al) in enumerate(specs)]
        owner = None
        for t in tanks:
            if t.id == owner_id:
                owner = t
        res = wb._first_enemy_in_order(MockState(tanks=tanks), owner)
        out["first_enemy"].append({
            "fn": "first_enemy",
            "tanks": [[n, al] for (n, al) in specs],
            "owner": owner_id,
            "result": (res.id if res is not None else None),
        })

    return _write("weapon_behaviors", out)


DUMPERS = {
    "weapon_behaviors": dump_weapon_behaviors,
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

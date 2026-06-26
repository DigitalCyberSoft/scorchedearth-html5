#!/usr/bin/env python3
"""Oracle vector dumper for the AI cluster: `physics`, `guidance`, `ai`.

Drives the Python port's REAL scorch.physics / scorch.guidance / scorch.ai
functions (the fidelity reference, itself byte-verified against 1.5/SCORCH.EXE)
over deterministic input batteries and writes golden vectors to
vectors/physics.json, vectors/guidance.json, vectors/ai.json. The TypeScript
differential gate (test/physics.test.ts, test/guidance.test.ts, test/ai.test.ts)
loads these JSONs and asserts the TS ports (src/physics.ts, src/guidance.ts,
src/ai.ts) reproduce every result -- EXACT for integers/indices/pixels/booleans/
strings, within a TIGHT epsilon for transcendental-derived floats.

This is a STATIC use of the Python port: it imports the modules headless
(SDL_VIDEODRIVER=dummy) and calls their pure functions against lightweight mock
Tank/Cfg/State/Economy/Terrain objects exposing exactly the duck-typed fields the
AI reads. It never runs the DOS binary.

Seed determinism: every rng-driven path seeds scorch.rng.Rng(seed) with a fixed
seed so the TS side (new Rng(seed)) reproduces the identical MT19937 stream (that
equivalence is itself proven by test/rng.test.ts).

Structure copies oracle/dump_damage.py / oracle/dump_vectors.py.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_ai_cluster.py
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
                if key in ("fn", "label", "note", "tag"):
                    continue
                total += _leaves(val)
    return total


def _leaves(x):
    if isinstance(x, list):
        return sum(_leaves(i) for i in x)
    if isinstance(x, dict):
        return sum(_leaves(i) for i in x.values())
    return 1


# ---------------------------------------------------------------------------
# Imports of the modules under test + the real config / objects / rng.
# ---------------------------------------------------------------------------
import scorch.constants as C            # noqa: E402
from scorch import physics, guidance, ai, weapons   # noqa: E402
from scorch import config as configmod  # noqa: E402
from scorch import rng as rngmod         # noqa: E402
from scorch.objects import Projectile, Tank   # noqa: E402


# ---------------------------------------------------------------------------
# Mock state: the minimal duck-typed shape ai.py reads. The TS test
# (test/ai.test.ts) builds a STRUCTURALLY IDENTICAL mock so the only thing under
# differential test is ai's own arithmetic / control flow. Uses the REAL Config
# (so cfg.viscosity_mult / cfg.team_mode / cfg.is_on / cfg.live_elastic match
# the port exactly) and the REAL rng.Rng (CPython MT19937, proven equivalent).
# ---------------------------------------------------------------------------
class MockTerrain:
    """is_dirt over a synthetic dirt rectangle [dx0,dx1) x [dy0, +inf). The TS
    test reproduces the same predicate. Default: no dirt (clear field)."""
    def __init__(self, dirt_rect=None):
        self.dirt_rect = dirt_rect      # (x0, y0, x1) or None

    def is_dirt(self, x, y):
        if self.dirt_rect is None:
            return False
        x0, y0, x1 = self.dirt_rect
        return x0 <= x < x1 and y >= y0


class MockEconomy:
    """The slice of scorch.economy.Economy that ai.buy touches: available[],
    price[], buy(tank, slot). Re-encodes the binary buy law (FUN_1dbc_0364) so
    the TS mock can mirror it exactly."""
    def __init__(self, cfg, available=None, price=None):
        self.cfg = cfg
        self.n = weapons.NUM_ITEMS
        self.price = list(price) if price is not None else [it.cost for it in weapons.ITEMS]
        self.available = list(available) if available is not None else [True] * self.n

    def buy(self, tank, slot):
        if not self.available[slot]:
            return False
        if tank.inventory[slot] >= C.INVENTORY_CAP:
            return False
        cost = self.price[slot]
        if tank.cash < cost:
            return False
        tank.cash -= cost
        tank.inventory[slot] += weapons.ITEMS[slot].bundle
        if tank.inventory[slot] > C.INVENTORY_CAP:
            tank.inventory[slot] = C.INVENTORY_CAP
        return True


class MockState:
    def __init__(self, cfg, tanks, w=1024, h=768, seed=0, last_landing=None,
                 round_index=0, live_sky="", terrain=None, economy=None):
        self.cfg = cfg
        self.tanks = tanks
        self.w = w
        self.h = h
        self.rng = rngmod.Rng(seed)
        self.economy = economy if economy is not None else MockEconomy(cfg)
        self.terrain = terrain if terrain is not None else MockTerrain()
        self.round_index = round_index
        self.last_landing = last_landing
        self.live_sky = live_sky


def _mk_cfg(gravity=0.2, visc=0, wind=0, elastic="NONE", team="NONE",
            computers_buy=True):
    cfg = configmod.Config()
    cfg.GRAVITY = gravity
    cfg.AIR_VISCOSITY = visc
    cfg.ELASTIC = elastic
    cfg.TEAM_MODE = team
    cfg.COMPUTERS_BUY = "ON" if computers_buy else "OFF"
    cfg.__post_init__()             # re-derive wind / live_elastic from fields
    cfg.wind = wind
    return cfg


def _mk_tank(pi, x, y, ai_class=0, team_id=0, health=100, angle=45, power=500):
    t = Tank(pi, f"P{pi}", ai_class=ai_class, team_id=team_id)
    t.x, t.y = x, y
    t.health = health
    t.angle = angle
    t.power = power
    return t


def _proj_snap(p):
    """px/py/vx/vy/sx/sy/bounce_count/mode in a fixed order."""
    return {
        "px": p.px, "py": p.py, "vx": p.vx, "vy": p.vy,
        "sx": p.sx, "sy": p.sy, "bounce_count": p.bounce_count,
        "bounce_energy": p.bounce_energy, "mode": p.mode,
    }


# ---------------------------------------------------------------------------
# Shared aim/turn batteries -- placements reused across physics/ai so the test
# inputs line up with tests/test_re_equivalence.py (systems 2/3/9).
# ---------------------------------------------------------------------------
# (gravity, visc, wind, angle, power) -- the equivalence System 2 grid.
_PHYS_GRID = []
for _g in (0.05, 0.2, 1.0, 5.0):
    for _v in (0, 5, 20):
        for _wd in (-200, -60, 0, 60, 200):
            for _a in (5, 45, 90, 135, 175):
                for _p in (50, 300, 600, 1000):
                    _PHYS_GRID.append((_g, _v, _wd, _a, _p))


# ===========================================================================
# physics dumper
# ===========================================================================
def dump_physics():
    out = {
        "module": "physics",
        "consts": [],
        "launch": [],
        "step": [],
        "apogee": [],
        "handle_walls": [],
    }

    # -- module constants --
    out["consts"].append({
        "fn": "const",
        "DEG2RAD": physics.DEG2RAD,
        "TURRET_LEN": physics.TURRET_LEN,
        "POWER_SCALE": C.POWER_SCALE,
        "PHYSICS_DT": C.PHYSICS_DT,
        "PHYSICS_SUBSTEPS": C.PHYSICS_SUBSTEPS,
        "EFF_GRAVITY_FACTOR": C.EFF_GRAVITY_FACTOR,
        "EFF_WIND_FACTOR": C.EFF_WIND_FACTOR,
        "SPEED_CLAMP": C.SPEED_CLAMP,
        "SPEED_CLAMP_SQ": C.SPEED_CLAMP_SQ,
        "BOUNCE_ENERGY": C.BOUNCE_ENERGY,
    })

    # -- launch decomposition: System 3 battery (angle 0..180 x powers) -------
    w = weapons.ITEMS[0]
    cfg = _mk_cfg()
    for angle in range(0, 181, 1):
        for power in (0, 1, 30, 100, 250, 500, 750, 1000):
            t = _mk_tank(0, 123, 456)
            proj = physics.launch(t, cfg, w, power, angle)
            out["launch"].append({
                "fn": "launch", "angle": angle, "power": power,
                "tank_x": 123, "tank_y": 456,
                "vx": proj.vx, "vy": proj.vy, "px": proj.px, "py": proj.py,
                "sx": proj.sx, "sy": proj.sy,
                "bounce_energy": proj.bounce_energy, "bounce_count": proj.bounce_count,
                "mode": proj.mode, "guidance_is_none": proj.guidance is None,
            })

    # -- step: multi-step trajectories over the System 2 grid -----------------
    # Capture px/py/vx/vy/sx/sy every STRIDE steps (and the final) so the test
    # asserts both the per-step force form and the accumulated trajectory.
    STRIDE = 40
    NSTEPS = 600
    for (gravity, visc, wind, angle, power) in _PHYS_GRID:
        cfg = _mk_cfg(gravity=gravity, visc=visc, wind=wind)
        t = _mk_tank(0, 100, 400)
        proj = physics.launch(t, cfg, w, power, angle)
        proj.guidance = None
        snaps = []
        for i in range(1, NSTEPS + 1):
            physics.step(proj, cfg)
            if i % STRIDE == 0 or i == NSTEPS:
                snaps.append([proj.px, proj.py, proj.vx, proj.vy, proj.sx, proj.sy])
        out["step"].append({
            "fn": "step", "gravity": gravity, "visc": visc, "wind": wind,
            "angle": angle, "power": power, "nsteps": NSTEPS, "stride": STRIDE,
            "snaps": snaps,
        })

    # -- apogee_reached over a swept vy sign -----------------------------------
    for vy in (-100.0, -1.0, -0.0, 0.0, 1e-9, 0.5, 50.0, 353.55):
        p = Projectile(None, w, 100.0, 100.0, 10.0, vy)
        out["apogee"].append({"fn": "apogee", "vy": vy,
                              "out": bool(physics.apogee_reached(p))})

    # -- handle_walls: every wall sub-mode x boundary placement ----------------
    # Modes 0..5 (NONE/WRAP-as-1/PADDED/RUBBER/SPRING/CONCRETE-as-5 by index, but
    # physics keys on the integer; cover 0..5 directly). Field 200x150 so the
    # edges are reachable; EDGES_EXTEND from cfg (75).
    fw, fh = 200, 150
    cfg = _mk_cfg()
    ext = cfg.EDGES_EXTEND
    PLACE = [
        # (px, py, vx, vy) placed around / past each edge
        (-1.0, 75.0, -50.0, 10.0),    # left, just out
        (-(ext + 1.0), 75.0, -50.0, 10.0),   # left, past EDGES_EXTEND
        (-5.0, 75.0, -300.0, 10.0),   # left, in extend band
        (float(fw), 75.0, 50.0, 10.0),       # right, just out
        (float(fw - 1 + ext + 1), 75.0, 80.0, 10.0),  # right, past extend
        (float(fw + 3), 75.0, 200.0, 0.0),   # right, in extend band
        (100.0, -1.0, 10.0, 60.0),    # ceiling
        (100.0, -3.0, 10.0, 120.0),   # ceiling, deeper
        (100.0, float(fh - 1), 10.0, 100.0),  # floor, fast vy (>50)
        (100.0, float(fh), 10.0, 30.0),       # floor, slow vy (|vy|<50): RUBBER/SPRING stop
        (100.0, float(fh + 2), 10.0, -100.0), # floor, fast down
        (100.0, 75.0, 10.0, 10.0),    # interior: no boundary
    ]
    for mode in range(0, 6):
        for (px, py, vx, vy) in PLACE:
            cfg2 = _mk_cfg()
            cfg2.live_elastic = mode
            p = Projectile(None, w, px, py, vx, vy)
            p.guidance = None
            alive = physics.handle_walls(p, cfg2, fw, fh)
            out["handle_walls"].append({
                "fn": "handle_walls", "mode": mode,
                "px_in": px, "py_in": py, "vx_in": vx, "vy_in": vy,
                "alive": bool(alive),
                "px": p.px, "py": p.py, "vx": p.vx, "vy": p.vy,
                "sx": p.sx, "sy": p.sy, "bounce_count": p.bounce_count,
                "bounce_energy": p.bounce_energy,
            })

    # -- handle_walls: repeated bounces to cross the 6-bounce energy-decay gate.
    # RUBBER (mode 3) off the floor, fast vy, repeated -- each bounce increments
    # bounce_count and after 6 the coef decays by bounce_energy (0.8). Drive a
    # projectile that re-enters the floor each call.
    cfg3 = _mk_cfg()
    cfg3.live_elastic = 3            # RUBBER
    p = Projectile(None, w, 100.0, float(fh + 1), 5.0, -200.0)
    p.guidance = None
    bounce_log = []
    for k in range(10):
        # force it back onto the floor row with a fast downward vy each time
        p.px, p.py = 100.0, float(fh + 1)
        p.vy = -200.0
        alive = physics.handle_walls(p, cfg3, fw, fh)
        bounce_log.append([bool(alive), p.vy, p.bounce_count, p.bounce_energy])
    out["handle_walls"].append({
        "fn": "handle_walls_repeat", "mode": 3, "log": bounce_log,
    })

    return _write("physics", out)


# ===========================================================================
# guidance dumper
# ===========================================================================
def dump_guidance():
    out = {
        "module": "guidance",
        "consts": [],
        "attach": [],
        "team_mode": [],
        "apply_steer": [],
        "solve_ballistic": [],
        "solve_ballistic_launch": [],
    }

    out["consts"].append({
        "fn": "const",
        "HEAT_RANGE": guidance.HEAT_RANGE,
        "ignores": sorted(guidance._IGNORES_GUIDANCE),
    })

    w_baby = weapons.ITEMS[0]                # explosive (guidable)
    w_mirv = weapons.ITEMS[6]               # mirv (ignores guidance)
    w_riot = weapons.ITEMS[15]              # riot_wedge (ignores guidance)
    w_plasma = weapons.ITEMS[31]            # plasma (ignores guidance)
    cfg = _mk_cfg()

    # -- attach: each guidance slot type, ignore-guidance weapons, no/invalid slot.
    targ = _mk_tank(1, 800, 400)
    ATTACH = [
        # (selected_guidance, weapon, guidance_target, guidance_target_pt)
        (None, w_baby, None, None),
        (33, w_baby, targ, None),           # heat, target set
        (34, w_baby, targ, None),           # ballistic
        (35, w_baby, targ, None),           # horizontal
        (36, w_baby, None, [600, 300]),     # vertical, point only
        (37, w_baby, None, [650, 350]),     # lazyboy, point only
        (33, w_mirv, targ, None),           # heat slot + ignore weapon -> None
        (34, w_riot, targ, None),           # ballistic slot + ignore weapon -> None
        (37, w_plasma, None, [10, 10]),     # lazyboy slot + plasma -> None
        (99, w_baby, targ, None),           # invalid slot index -> None
        (32, w_baby, targ, None),           # below slot range -> None
    ]
    for (slot, weap, gt, gp) in ATTACH:
        t = _mk_tank(0, 200, 400)
        t.selected_guidance = slot
        t.guidance_target = gt
        t.guidance_target_pt = gp
        p = Projectile(t, weap, 200.0, 396.0, 100.0, 100.0)
        g = guidance.attach(t, cfg, weap, p)
        rec = {
            "fn": "attach", "slot": (-1 if slot is None else slot),
            "weapon_idx": weap.idx, "behavior": weap.behavior,
            "has_target": gt is not None, "has_point": gp is not None,
            "installed": g is not None,
            "proj_guidance_is_none": p.guidance is None,
        }
        if g is not None:
            rec["gtype"] = g["type"]
            rec["g_armed"] = bool(g["armed"])
            rec["g_target_is_none"] = g["target"] is None
            rec["g_point"] = (list(g["point"]) if g["point"] is not None else None)
        out["attach"].append(rec)

    # -- team_mode_active: pairs of team ids (0 sentinel + matching/mismatched).
    class _TM:
        def __init__(self, tid): self.team_id = tid
    for ta in (0, 1, 2, 3):
        for tb in (0, 1, 2, 3):
            out["team_mode"].append({
                "fn": "team_mode", "ta": ta, "tb": tb,
                "out": bool(guidance.team_mode_active(_TM(ta), _TM(tb))),
            })

    # -- apply: drive a guided projectile through N physics steps and capture the
    # steered vx/vy + armed latch each step. Heat/Horizontal/Vertical/LazyBoy.
    # The apply() runs inside physics.step (BEFORE the move); to exercise the
    # +0x4c predicate in isolation AND in the integrated path, we step the real
    # physics.step with tanks forwarded (Heat) and snapshot the guidance.
    def run_guided(gtype_slot, weap, gt, gp, p0, v0, steps, with_tanks,
                   gravity=0.2, wind=0):
        cfg2 = _mk_cfg(gravity=gravity, wind=wind)
        owner = _mk_tank(0, 200, 600, team_id=0)
        owner.selected_guidance = gtype_slot
        owner.guidance_target = gt
        owner.guidance_target_pt = gp
        proj = Projectile(owner, weap, float(p0[0]), float(p0[1]),
                          float(v0[0]), float(v0[1]))
        guidance.attach(owner, cfg2, weap, proj)
        tanks = with_tanks
        snaps = []
        for _ in range(steps):
            physics.step(proj, cfg2, tanks=tanks)
            g = proj.guidance
            snaps.append([proj.vx, proj.vy, proj.px, proj.py,
                          bool(g["armed"]) if g else False])
        return snaps

    # A live enemy for Heat to acquire (placed so the seeker engages within range).
    enemy = _mk_tank(1, 230, 600, team_id=0)        # within HEAT_RANGE of launch
    enemy2 = _mk_tank(2, 600, 300, team_id=0)
    APPLY = [
        # (label, slot, weapon, target, point, p0, v0, steps, tanks)
        ("heat_acquire", 33, w_baby, None, None, (200, 600), (300, 50), 40,
         [enemy]),
        ("heat_out_of_range", 33, w_baby, None, None, (200, 600), (300, 50), 20,
         [enemy2]),
        ("horizontal_pt", 35, w_baby, None, [500, 500], (200, 600), (300, 200),
         60, None),
        ("horizontal_tgt", 35, w_baby, _mk_tank(3, 700, 520), None,
         (200, 600), (250, 220), 60, None),
        ("vertical_pt", 36, w_baby, None, [500, 400], (200, 600), (300, 200),
         60, None),
        ("vertical_tgt", 36, w_baby, _mk_tank(4, 520, 450), None,
         (200, 600), (260, 240), 60, None),
        ("lazyboy_pt", 37, w_baby, None, [520, 480], (200, 600), (250, 200),
         60, None),
        ("lazyboy_tgt_fallback", 37, w_baby, _mk_tank(5, 560, 500), None,
         (200, 600), (240, 210), 60, None),
        ("ballistic_noop", 34, w_baby, _mk_tank(6, 700, 600), None,
         (200, 600), (300, 200), 30, None),
    ]
    for (label, slot, weap, gt, gp, p0, v0, steps, tanks) in APPLY:
        snaps = run_guided(slot, weap, gt, gp, p0, v0, steps, tanks)
        out["apply_steer"].append({
            "fn": "apply_steer", "label": label, "slot": slot,
            "weapon_idx": weap.idx, "p0": list(p0), "v0": list(v0),
            "steps": steps, "snaps": snaps,
        })

    # -- solve_ballistic_power (wind-correcting) + _launch (closed form) --------
    # state with world dims for the refine; targets at varied geometry.
    for (gravity, wind) in [(0.2, 0), (0.2, 120), (1.0, -150), (0.05, 60)]:
        cfg2 = _mk_cfg(gravity=gravity, wind=wind)
        st = MockState(cfg2, [], w=1024, h=768)
        for (tx_off, ty_abs, angle) in [(300, 400, 45), (300, 400, 60),
                                        (-250, 350, 120), (400, 500, 30),
                                        (150, 420, 75), (-300, 400, 135)]:
            tank = _mk_tank(0, 200, 600, angle=angle)
            tank.guidance_target = None
            tank.guidance_target_pt = [200 + tx_off, ty_abs]
            sol = guidance.solve_ballistic_power(st, tank, w_baby)
            out["solve_ballistic"].append({
                "fn": "solve_ballistic", "gravity": gravity, "wind": wind,
                "tank_x": 200, "tank_y": 600, "angle": angle,
                "pt": [200 + tx_off, ty_abs],
                "power": (-1 if sol is None else sol),
            })
            sol2 = guidance.solve_ballistic_power_launch(cfg2, tank, w_baby)
            out["solve_ballistic_launch"].append({
                "fn": "solve_ballistic_launch", "gravity": gravity, "wind": wind,
                "tank_x": 200, "tank_y": 600, "angle": angle,
                "pt": [200 + tx_off, ty_abs],
                "power": (-1 if sol2 is None else sol2),
            })
    # no-target -> None on both
    tank = _mk_tank(0, 200, 600)
    tank.guidance_target = None
    tank.guidance_target_pt = None
    st = MockState(_mk_cfg(), [], w=1024, h=768)
    out["solve_ballistic"].append({
        "fn": "solve_ballistic", "gravity": 0.2, "wind": 0,
        "tank_x": 200, "tank_y": 600, "angle": 45, "pt": None,
        "power": (-1 if guidance.solve_ballistic_power(st, tank, w_baby) is None else 0),
    })
    out["solve_ballistic_launch"].append({
        "fn": "solve_ballistic_launch", "gravity": 0.2, "wind": 0,
        "tank_x": 200, "tank_y": 600, "angle": 45, "pt": None,
        "power": (-1 if guidance.solve_ballistic_power_launch(_mk_cfg(), tank, w_baby) is None else 0),
    })

    return _write("guidance", out)


# ===========================================================================
# ai dumper
# ===========================================================================
def dump_ai():
    out = {
        "module": "ai",
        "consts": [],
        "solve_power": [],
        "nearest_enemy": [],
        "cyborg_target": [],
        "pick_weapon": [],
        "seed_angle": [],
        "scan": [],
        "aim": [],
        "simulate_landing": [],
        "wind_seed_angle": [],
        "steepen_gate": [],
        "search_aim": [],
        "turn_moron": [],
        "turn_tosser": [],
        "turn_shooter": [],
        "turn_poolshark": [],
        "turn_spoiler": [],
        "turn_cyborg": [],
        "turn_chooser": [],
        "take_turn": [],
        "buy_shared": [],
        "buy_moron": [],
    }

    out["consts"].append({
        "fn": "const",
        "AI_MORON": C.AI_MORON, "AI_SHOOTER": C.AI_SHOOTER,
        "AI_POOLSHARK": C.AI_POOLSHARK, "AI_TOSSER": C.AI_TOSSER,
        "AI_CHOOSER": C.AI_CHOOSER, "AI_SPOILER": C.AI_SPOILER,
        "AI_CYBORG": C.AI_CYBORG, "AI_UNKNOWN": C.AI_UNKNOWN,
        "SLOT_MISSILE": weapons.SLOT_MISSILE,
        "SLOT_BABY_MISSILE": weapons.SLOT_BABY_MISSILE,
        "NUM_ITEMS": weapons.NUM_ITEMS,
    })

    # -- _solve_power: the closed-form oracle over a geometry + elevation grid.
    for gravity in (0.05, 0.2, 1.0, 5.0):
        cfg = _mk_cfg(gravity=gravity)
        for (sx, sy, tx, ty) in [(200, 600, 500, 600), (200, 600, 500, 400),
                                 (200, 600, 500, 700), (500, 400, 200, 400),
                                 (200, 600, 201, 600), (200, 600, 200, 600),
                                 (100, 700, 900, 300)]:
            for elev in (5, 15, 25, 35, 45, 55, 65, 75, 85, 89):
                pw = ai._solve_power(cfg, sx, sy, tx, ty, elev)
                out["solve_power"].append({
                    "fn": "solve_power", "gravity": gravity,
                    "sx": sx, "sy": sy, "tx": tx, "ty": ty, "elev": elev,
                    "power": (None if pw is None else pw),
                    "reachable": pw is not None,
                })

    # -- nearest_enemy: team filter + nearest-by-|dx| selection. --------------
    # Build a fixed roster; vary teams.
    for team in ("NONE", "STANDARD"):
        cfg = _mk_cfg(team=team)
        a = _mk_tank(0, 500, 400, team_id=1)
        b = _mk_tank(1, 300, 400, team_id=1)    # same team as a
        c = _mk_tank(2, 700, 400, team_id=2)
        d = _mk_tank(3, 520, 400, team_id=2)
        e_dead = _mk_tank(4, 505, 400, team_id=2)
        e_dead.alive = False
        st = MockState(cfg, [a, b, c, d, e_dead])
        tgt = ai.nearest_enemy(st, a)
        out["nearest_enemy"].append({
            "fn": "nearest_enemy", "team": team,
            "target_pi": (-1 if tgt is None else tgt.player_index),
        })

    # -- cyborg_target: the weighted scorer (rng-driven). Fixed roster + seed; the
    # TS test reproduces the exact rng draw order (one rng.pick(32000) per
    # candidate, in tanks order).
    for seed in (0, 1, 7, 42, 100, 2024):
        for team in ("NONE",):
            cfg = _mk_cfg(team=team)
            tank = _mk_tank(0, 400, 400, ai_class=C.AI_CYBORG, team_id=1)
            tank.shield_hp = 0
            tank.score = 100
            e1 = _mk_tank(1, 700, 400, team_id=2)
            e1.score = 50
            e1.shield_hp = 0
            e2 = _mk_tank(2, 300, 400, team_id=2)
            e2.score = 200
            e2.shield_hp = 30
            e3 = _mk_tank(3, 900, 400, team_id=2)
            e3.score = 10
            e3.shield_hp = 0
            # seed hit history so retaliation / recent terms are exercised
            tank.hits_this_round = {1: 2, 3: 1}
            tank.hits_career = {1: 5, 2: 3}
            st = MockState(cfg, [tank, e1, e2, e3], seed=seed, round_index=2)
            tgt = ai.cyborg_target(st, tank)
            out["cyborg_target"].append({
                "fn": "cyborg_target", "seed": seed, "team": team,
                "target_pi": (-1 if tgt is None else tgt.player_index),
            })

    # -- pick_weapon: missile-present / baby-only / random over owned set. -----
    for seed in (0, 3, 9, 50):
        cfg = _mk_cfg()
        t = _mk_tank(0, 200, 400)
        st = MockState(cfg, [t], seed=seed)
        # default inventory: only baby missile (99). Missile absent.
        st.rng.seed(seed)
        det = ai.pick_weapon(st, t, random=False)
        st.rng.seed(seed)
        rnd = ai.pick_weapon(st, t, random=True)
        # now grant a Missile and a few others
        t.inventory[weapons.SLOT_MISSILE] = 5
        t.inventory[6] = 3              # MIRV (offensive)
        t.inventory[2] = 2              # Baby Nuke
        st.rng.seed(seed)
        det2 = ai.pick_weapon(st, t, random=False)
        st.rng.seed(seed)
        rnd2 = ai.pick_weapon(st, t, random=True)
        out["pick_weapon"].append({
            "fn": "pick_weapon", "seed": seed,
            "det_babyonly": det, "rnd_babyonly": rnd,
            "det_withmissile": det2, "rnd_withmissile": rnd2,
        })

    # -- _seed_angle: atan2 geometry seed over varied target placements. -------
    for (tx, ty) in [(800, 400), (200, 400), (500, 100), (500, 700),
                     (450, 405), (550, 405), (400, 400), (401, 400)]:
        tank = _mk_tank(0, 400, 400)
        target = _mk_tank(1, tx, ty)
        out["seed_angle"].append({
            "fn": "seed_angle", "tx": tx, "ty": ty,
            "angle": ai._seed_angle(tank, target),
        })

    # -- _scan: lob vs flat preference over a geometry grid. -------------------
    for prefer in ("lob", "flat"):
        for gravity in (0.05, 0.2, 1.0):
            cfg = _mk_cfg(gravity=gravity)
            for (sx, sy, tx, ty) in [(200, 600, 700, 600), (200, 600, 700, 400),
                                     (700, 400, 200, 600), (200, 600, 250, 600)]:
                sol = ai._scan(cfg, sx, sy, tx, ty, prefer)
                out["scan"].append({
                    "fn": "scan", "prefer": prefer, "gravity": gravity,
                    "sx": sx, "sy": sy, "tx": tx, "ty": ty,
                    "angle": (None if sol is None else sol[0]),
                    "power": (None if sol is None else sol[1]),
                })

    # -- aim: closed-form + sim-refine (deterministic, no rng). ----------------
    for gravity in (0.2, 1.0):
        for wind in (0, 100, -120):
            cfg = _mk_cfg(gravity=gravity, wind=wind)
            st = MockState(cfg, [], w=1024, h=768)
            for prefer in ("lob", "flat"):
                for (tx, ty) in [(700, 600), (700, 400), (300, 500)]:
                    tank = _mk_tank(0, 200, 600)
                    ang, pw = ai.aim(st, tank, tx, ty, prefer)
                    out["aim"].append({
                        "fn": "aim", "gravity": gravity, "wind": wind,
                        "prefer": prefer, "tx": tx, "ty": ty,
                        "angle": ang, "power": pw,
                    })

    # -- _simulate_landing: the real integrator landing x for a battery. -------
    for gravity in (0.2, 1.0):
        for wind in (0, 120):
            cfg = _mk_cfg(gravity=gravity, wind=wind)
            st = MockState(cfg, [], w=1024, h=768)
            for angle in (30, 45, 60, 120):
                for power in (200, 400, 600):
                    tank = _mk_tank(0, 200, 600)
                    lx = ai._simulate_landing(st, tank, angle, power, 600)
                    out["simulate_landing"].append({
                        "fn": "simulate_landing", "gravity": gravity, "wind": wind,
                        "angle": angle, "power": power, "ty": 600,
                        "land_x": (None if lx is None else lx),
                    })

    # loop-exhaust: a zero-gravity HORIZONTAL shot under bouncy walls never
    # descends through ty nor reaches the floor -- it bounces left/right forever,
    # so the integrator runs out its flight horizon and returns None via the
    # loop-exhaust tail (NOT the off-world early-out).
    cfg_ex = _mk_cfg(gravity=0.0, elastic="RUBBER")
    st_ex = MockState(cfg_ex, [], w=1024, h=768)
    lx_ex = ai._simulate_landing(st_ex, _mk_tank(0, 200, 600), 0, 500, 300)
    out["simulate_landing_exhaust"] = {
        "gravity": 0.0, "elastic": "RUBBER", "angle": 0, "power": 500, "ty": 300,
        "land_x": (None if lx_ex is None else lx_ex),
    }

    # -- _wind_seed_angle: the Spoiler/Cyborg wind blend seed. -----------------
    for wind in (-200, -100, -40, 0, 40, 100, 200):
        for visc in (0, 5, 20):
            cfg = _mk_cfg(wind=wind, visc=visc)
            st = MockState(cfg, [])
            for right in (True, False):
                out["wind_seed_angle"].append({
                    "fn": "wind_seed_angle", "wind": wind, "visc": visc,
                    "right": right, "angle": ai._wind_seed_angle(st, right),
                })

    # -- _tosser_steepen_gate: cavern vs non-cavern x landing y. ---------------
    for sky in ("", "CAVERN", "NIGHT"):
        cfg = _mk_cfg()
        st = MockState(cfg, [], h=768, live_sky=sky)
        for ly in (0, 100, 383, 384, 500, 767):
            out["steepen_gate"].append({
                "fn": "steepen_gate", "sky": sky, "ly": ly,
                "out": bool(ai._tosser_steepen_gate(st, ly)),
            })

    # -- _search_aim: the two-sided angle bracket (Spoiler/Cyborg engine). ------
    for gravity in (0.2, 1.0):
        for elastic in ("NONE", "RUBBER"):       # flatten inactive vs active
            cfg = _mk_cfg(gravity=gravity, elastic=elastic)
            st = MockState(cfg, [])
            for seed_angle in (45, 65, 85, 95, 115):
                for (tx, ty) in [(700, 600), (700, 400), (300, 500)]:
                    tank = _mk_tank(0, 200, 600, angle=seed_angle, health=100)
                    a, p = ai._search_aim(st, tank, tx, ty)
                    out["search_aim"].append({
                        "fn": "search_aim", "gravity": gravity,
                        "elastic": elastic, "seed_angle": seed_angle,
                        "tx": tx, "ty": ty, "angle": a, "power": p,
                    })

    # -- the 7 turn functions over many fixed seeds (Moron + Tosser specified by
    # the task; the rest for full coverage). A two-tank roster with the enemy to
    # the right of the AI, mirroring tests/test_re_equivalence.py systems 9a/9b.
    def turn_battery(key, ai_class, fn, seeds, with_landing=False,
                     elastic="NONE", health=100, extra_enemy=False):
        cfg = _mk_cfg(elastic=elastic)
        for seed in seeds:
            me = _mk_tank(0, 200, 400, ai_class=ai_class, health=health,
                          angle=45, power=500)
            enemy = _mk_tank(1, 800, 400)
            roster = [me, enemy]
            if extra_enemy:
                roster.append(_mk_tank(2, 350, 400))
            last = (600, 380) if with_landing else None
            st = MockState(cfg, roster, seed=seed, last_landing=last)
            st.rng.seed(seed)
            ang, pw, wp = fn(st, me)
            out[key].append({
                "fn": key, "seed": seed,
                "with_landing": with_landing, "elastic": elastic,
                "health": health,
                "angle": ang, "power": pw, "weapon": wp,
                # capture the angle the tactic stored (mutated +0x32) too
                "tank_angle_after": me.angle,
                "tank_ai_tries_after": me.ai_tries,
            })

    SEEDS = list(range(0, 60))
    # Moron: power = (rng(health)+1)*10 over varied health (System 9a).
    for hp in (1, 5, 25, 50, 99, 100):
        turn_battery("turn_moron", C.AI_MORON, ai._turn_moron,
                     list(range(0, 30)), health=hp)
    # Tosser opener (no landing) + bracket (with landing) (System 9b).
    turn_battery("turn_tosser", C.AI_TOSSER, ai._turn_tosser, list(range(0, 80)))
    turn_battery("turn_tosser", C.AI_TOSSER, ai._turn_tosser, list(range(0, 40)),
                 with_landing=True)
    # Shooter / Poolshark / Spoiler / Cyborg / Chooser.
    turn_battery("turn_shooter", C.AI_SHOOTER, ai._turn_shooter, SEEDS)
    turn_battery("turn_poolshark", C.AI_POOLSHARK, ai._turn_poolshark, SEEDS)
    turn_battery("turn_poolshark", C.AI_POOLSHARK, ai._turn_poolshark,
                 list(range(0, 30)), with_landing=True, elastic="RUBBER")
    turn_battery("turn_spoiler", C.AI_SPOILER, ai._turn_spoiler, SEEDS)
    turn_battery("turn_cyborg", C.AI_CYBORG, ai._turn_cyborg, SEEDS)
    turn_battery("turn_chooser", C.AI_CHOOSER, ai._turn_chooser, SEEDS)
    turn_battery("turn_chooser", C.AI_CHOOSER, ai._turn_chooser,
                 list(range(0, 20)), elastic="RUBBER", with_landing=True)

    # -- GEOMETRY-VARIED turn battery: exercise the angle-search bracket, the
    # Shooter recurse/exclude (multiple enemies), the Cyborg wind-blend seed, and
    # the ceiling-flatten path across gravity/wind/elastic + several rosters. The
    # full roster geometry is recorded so the TS test rebuilds the identical
    # placement. Key "turn_geo" (one list); each row carries ai_class so the test
    # dispatches through take_turn with the matching class.
    out["turn_geo"] = []
    GEO_ROSTERS = [
        # list of (player_index, x, y) -- index 0 is the acting AI.
        [(0, 200, 600), (1, 800, 400)],
        [(0, 800, 600), (1, 200, 400)],            # enemy to the LEFT (mirror)
        [(0, 500, 600), (1, 300, 300), (2, 760, 450)],   # two enemies, varied y
        [(0, 200, 700), (1, 980, 200)],            # far + high target
        [(0, 512, 650), (1, 520, 200), (2, 200, 600), (3, 900, 600)],  # crowd
        [(0, 200, 400), (1, 240, 410)],            # near, almost level
    ]
    GEO_PARAMS = [
        # (gravity, wind, visc, elastic)
        (0.2, 0, 0, "NONE"),
        (1.0, 120, 0, "NONE"),
        (0.05, -150, 5, "RUBBER"),
        (5.0, 0, 0, "SPRING"),
        (0.2, 200, 20, "PADDED"),
    ]
    GEO_CLASSES = [
        ("shooter", C.AI_SHOOTER, ai._turn_shooter),
        ("poolshark", C.AI_POOLSHARK, ai._turn_poolshark),
        ("spoiler", C.AI_SPOILER, ai._turn_spoiler),
        ("cyborg", C.AI_CYBORG, ai._turn_cyborg),
        ("chooser", C.AI_CHOOSER, ai._turn_chooser),
    ]
    for (cls_name, cls_id, fn) in GEO_CLASSES:
        for ri, roster_spec in enumerate(GEO_ROSTERS):
            for pi_idx, (gravity, wind, visc, elastic) in enumerate(GEO_PARAMS):
                for seed in (0, 7, 42):
                    for with_landing in (False, True):
                        cfg = _mk_cfg(gravity=gravity, wind=wind, visc=visc,
                                      elastic=elastic)
                        roster = []
                        for (pi, x, y) in roster_spec:
                            t = _mk_tank(pi, x, y,
                                         ai_class=(cls_id if pi == 0 else 0),
                                         health=100, angle=45, power=500)
                            roster.append(t)
                        last = (450, 380) if with_landing else None
                        st = MockState(cfg, roster, seed=seed, last_landing=last,
                                       round_index=1)
                        st.rng.seed(seed)
                        ang, pw, wp = fn(st, roster[0])
                        out["turn_geo"].append({
                            "fn": "turn_geo", "cls_name": cls_name,
                            "ai_class": cls_id, "roster_idx": ri,
                            "param_idx": pi_idx, "seed": seed,
                            "with_landing": with_landing,
                            "gravity": gravity, "wind": wind, "visc": visc,
                            "elastic": elastic,
                            "roster": [list(s) for s in roster_spec],
                            "angle": ang, "power": pw, "weapon": wp,
                            "tank_angle_after": roster[0].angle,
                            "tank_ai_tries_after": roster[0].ai_tries,
                        })

    # -- take_turn: dispatch incl. the Unknown re-roll (class 8 -> 1..7 once). --
    for seed in range(0, 40):
        cfg = _mk_cfg()
        me = _mk_tank(0, 200, 400, ai_class=C.AI_UNKNOWN, health=100)
        enemy = _mk_tank(1, 800, 400)
        st = MockState(cfg, [me, enemy], seed=seed)
        st.rng.seed(seed)
        ang, pw, wp = ai.take_turn(st, me)
        out["take_turn"].append({
            "fn": "take_turn", "seed": seed,
            "angle": ang, "power": pw, "weapon": wp,
            "ai_class_after": me.ai_class, "reveal_type_after": me.reveal_type,
        })
    # take_turn for each concrete class (no re-roll path)
    for cls in (C.AI_MORON, C.AI_SHOOTER, C.AI_POOLSHARK, C.AI_TOSSER,
                C.AI_CHOOSER, C.AI_SPOILER, C.AI_CYBORG):
        cfg = _mk_cfg()
        me = _mk_tank(0, 200, 400, ai_class=cls, health=100)
        enemy = _mk_tank(1, 800, 400)
        st = MockState(cfg, [me, enemy], seed=7)
        st.rng.seed(7)
        ang, pw, wp = ai.take_turn(st, me)
        out["take_turn"].append({
            "fn": "take_turn", "seed": 7, "ai_class_in": cls,
            "angle": ang, "power": pw, "weapon": wp,
            "ai_class_after": me.ai_class, "reveal_type_after": me.reveal_type,
        })

    # -- buy: shared (deterministic) + moron (weighted-random). ----------------
    # Shared buyer: vary cash so the shield/parachute/missile/battery ladder
    # exercises both the affordable and broke paths. Capture the full inventory.
    for cash in (0, 30000, 100000, 500000, 1000000):
        cfg = _mk_cfg(computers_buy=True)
        me = _mk_tank(0, 200, 400, ai_class=C.AI_SHOOTER)
        me.cash = cash
        st = MockState(cfg, [me])
        ai.buy(st, me)
        out["buy_shared"].append({
            "fn": "buy_shared", "cash_in": cash,
            "cash_out": me.cash,
            "inventory": list(me.inventory),
            "parachute_deployed": bool(me.parachute_deployed),
        })
    # COMPUTERS_BUY off -> no-op.
    cfg = _mk_cfg(computers_buy=False)
    me = _mk_tank(0, 200, 400, ai_class=C.AI_SHOOTER)
    me.cash = 1000000
    st = MockState(cfg, [me])
    ai.buy(st, me)
    out["buy_shared"].append({
        "fn": "buy_shared", "cash_in": 1000000, "computers_buy": False,
        "cash_out": me.cash, "inventory": list(me.inventory),
        "parachute_deployed": bool(me.parachute_deployed),
    })

    # Moron buyer: weighted-random roulette; seeded. Capture inventory + cash.
    for seed in (0, 1, 7, 42, 100, 2024, 65535):
        for cash in (10000, 50000, 200000):
            cfg = _mk_cfg(computers_buy=True)
            me = _mk_tank(0, 200, 400, ai_class=C.AI_MORON)
            me.cash = cash
            st = MockState(cfg, [me], seed=seed)
            st.rng.seed(seed)
            ai.buy(st, me)
            out["buy_moron"].append({
                "fn": "buy_moron", "seed": seed, "cash_in": cash,
                "cash_out": me.cash, "inventory": list(me.inventory),
            })

    # --- branch battery: the per-turn GUARD / fall-through paths the geo sweep
    # never hits. Each scenario is FULLY specified (roster with alive flags, cfg
    # params, optional terrain dirt rect / last_landing / live_sky / acting-tank
    # overrides) so the TS test rebuilds the identical MockState and asserts the
    # same turn output. Drives ai.take_turn (routes by ai_class). ------------------
    out["turn_branch"] = []
    # 9 near-vertical, far-overhead enemies: every shooter-refine walks its seed to
    # 90 and recurses, so the Poolshark loop exhausts its 8 tries and falls through.
    poolshark_exhaust_roster = [[0, 100, 700, True]] + [
        [k, 100 + k, 50, True] for k in range(1, 10)]
    BRANCH = [
        # Tosser: prior landing but NO live enemy -> hold current aim.
        {"label": "tosser_no_enemy", "ai_class": C.AI_TOSSER, "elastic": "NONE",
         "roster": [[0, 200, 400, True]], "last_landing": [600, 380],
         "tank0": {"angle": 60, "power": 480}},
        # Tosser: shell fell FARTHER than the target -> power -= 10.
        {"label": "tosser_fell_farther", "ai_class": C.AI_TOSSER, "elastic": "NONE",
         "roster": [[0, 200, 400, True], [1, 250, 400, True]],
         "last_landing": [600, 380], "tank0": {"angle": 60, "power": 480}},
        # Tosser: short + HIGH (ly<target.y) on the steepen gate, angle>95 -> -=2.
        {"label": "tosser_steepen_high_angle", "ai_class": C.AI_TOSSER,
         "elastic": "NONE", "roster": [[0, 200, 400, True], [1, 800, 400, True]],
         "last_landing": [790, 100], "tank0": {"angle": 100, "power": 480}},
        # Tosser: short + LOW (ly>=target.y), not-farther -> power += 10.
        {"label": "tosser_short_low", "ai_class": C.AI_TOSSER, "elastic": "NONE",
         "roster": [[0, 200, 400, True], [1, 800, 400, True]],
         "last_landing": [790, 500], "tank0": {"angle": 60, "power": 480}},
        # Spoiler: no live enemy -> _spoiler_target None -> hold current aim.
        {"label": "spoiler_no_enemy", "ai_class": C.AI_SPOILER, "elastic": "NONE",
         "roster": [[0, 200, 400, True]], "tank0": {"angle": 70, "power": 510}},
        # Cyborg: no live enemy -> cyborg_target None -> hold current aim.
        {"label": "cyborg_no_enemy", "ai_class": C.AI_CYBORG, "elastic": "NONE",
         "roster": [[0, 200, 400, True]], "tank0": {"angle": 70, "power": 510}},
        # Chooser: line of fire BLOCKED by dirt + bouncy walls -> Poolshark.
        {"label": "chooser_blocked_poolshark", "ai_class": C.AI_CHOOSER,
         "elastic": "RUBBER", "roster": [[0, 200, 400, True], [1, 800, 400, True]],
         "dirt_rect": [400, 390, 600], "tank0": {"angle": 45, "power": 500}},
        # Chooser: line of fire BLOCKED by dirt + non-bouncy walls -> Spoiler.
        {"label": "chooser_blocked_spoiler", "ai_class": C.AI_CHOOSER,
         "elastic": "NONE", "roster": [[0, 200, 400, True], [1, 800, 400, True]],
         "dirt_rect": [400, 390, 600], "tank0": {"angle": 45, "power": 500}},
        # Poolshark: bouncy walls + landing, ai_tries already 4 -> give-up + reset.
        {"label": "poolshark_walltune_giveup", "ai_class": C.AI_POOLSHARK,
         "elastic": "RUBBER", "roster": [[0, 200, 400, True], [1, 800, 400, True]],
         "last_landing": [600, 380],
         "tank0": {"angle": 45, "power": 500, "ai_tries": 4}},
        # Poolshark: bouncy walls + landing FAR, target NEAR, angle 89 -> +1 -> 90 drop.
        {"label": "poolshark_walltune_angle90", "ai_class": C.AI_POOLSHARK,
         "elastic": "RUBBER", "roster": [[0, 200, 400, True], [1, 250, 400, True]],
         "last_landing": [900, 380],
         "tank0": {"angle": 89, "power": 500, "ai_tries": 0}},
        # Poolshark: 9 overhead enemies all recurse -> 8-try loop falls through.
        {"label": "poolshark_exhaust", "ai_class": C.AI_POOLSHARK, "elastic": "NONE",
         "roster": poolshark_exhaust_roster,
         "tank0": {"angle": 45, "power": 500}},
        # Shooter: enemy directly BELOW + 1px aside -> seed angle 1, oracle returns a
        # sub-1 power (0<=r<1) -> the refine's neither-steer-nor-exit break.
        {"label": "shooter_subunit_power", "ai_class": C.AI_SHOOTER, "elastic": "NONE",
         "roster": [[0, 100, 100, True], [1, 101, 600, True]],
         "tank0": {"angle": 45, "power": 500}},
    ]
    for s in BRANCH:
        cfg = _mk_cfg(elastic=s.get("elastic", "NONE"))
        roster = []
        for entry in s["roster"]:
            pi, x, y = entry[0], entry[1], entry[2]
            alive = entry[3] if len(entry) > 3 else True
            t = _mk_tank(pi, x, y, ai_class=(s["ai_class"] if pi == 0 else 0))
            t.alive = alive
            roster.append(t)
        t0 = roster[0]
        ov = s.get("tank0", {})
        for k in ("angle", "power", "ai_tries", "health"):
            if k in ov:
                setattr(t0, k, ov[k])
        dirt = s.get("dirt_rect")
        terrain = MockTerrain(tuple(dirt) if dirt else None)
        last = tuple(s["last_landing"]) if s.get("last_landing") else None
        seed = s.get("seed", 7)
        st = MockState(cfg, roster, seed=seed, last_landing=last,
                       live_sky=s.get("live_sky", ""), terrain=terrain)
        st.rng.seed(seed)
        ang, pw, wp = ai.take_turn(st, t0)
        out["turn_branch"].append({
            "label": s["label"], "ai_class": s["ai_class"],
            "elastic": s.get("elastic", "NONE"), "roster": s["roster"],
            "tank0": ov, "last_landing": s.get("last_landing"),
            "dirt_rect": s.get("dirt_rect"), "live_sky": s.get("live_sky", ""),
            "seed": seed, "angle": ang, "power": pw, "weapon": wp,
            "tank_angle_after": t0.angle, "tank_ai_tries_after": t0.ai_tries,
        })

    # --- _score_nearest_enemy: the null-exclude WRAPPER kept for port fidelity
    # (the live dispatch only calls the _ex form). Nearest live, non-friendly enemy
    # by |dx|. Differential: target player_index, EXACT. ---------------------------
    out["score_wrapper"] = []
    for team in ("NONE", "STANDARD"):
        cfg = _mk_cfg(team=team)
        a = _mk_tank(0, 500, 400, ai_class=C.AI_SHOOTER, team_id=1)
        b = _mk_tank(1, 300, 400, team_id=1)   # friendly when teams on
        c = _mk_tank(2, 700, 400, team_id=2)
        d = _mk_tank(3, 520, 400, team_id=2)   # nearest by |dx|
        st = MockState(cfg, [a, b, c, d])
        tgt = ai._score_nearest_enemy(st, a)
        out["score_wrapper"].append({
            "team": team, "target_pi": (-1 if tgt is None else tgt.player_index)})
    # no-enemy roster -> None (the best=None return of the shared core)
    cfg = _mk_cfg()
    a = _mk_tank(0, 500, 400, ai_class=C.AI_SHOOTER)
    st = MockState(cfg, [a])
    tgt = ai._score_nearest_enemy(st, a)
    out["score_wrapper"].append({
        "team": "alone", "target_pi": (-1 if tgt is None else tgt.player_index)})

    # --- elastic fallback: _wall_flatten_active / _poolshark_bouncy_walls read
    # getattr(cfg, "live_elastic", getattr(cfg, "elastic", 0)). The live game always
    # derives live_elastic; the predicates fall back to .elastic (then 0) for a cfg
    # that lacks it. Drive that fallback with a cfg exposing ONLY .elastic, and the
    # neither-attr case (-> 0). Booleans, EXACT. -----------------------------------
    class _CfgElasticOnly:
        def __init__(self, elastic):
            self.elastic = elastic

    class _CfgNeither:
        pass

    fb = []
    for el in (0, 1, 2, 3, 4, 5):
        st = type("S", (), {"cfg": _CfgElasticOnly(el)})()
        fb.append({"shape": "elastic_only", "elastic": el,
                   "wall_flatten": ai._wall_flatten_active(st),
                   "bouncy": ai._poolshark_bouncy_walls(st)})
    stN = type("S", (), {"cfg": _CfgNeither()})()
    fb.append({"shape": "neither", "elastic": None,
               "wall_flatten": ai._wall_flatten_active(stN),
               "bouncy": ai._poolshark_bouncy_walls(stN)})
    out["elastic_fallback"] = fb

    return _write("ai", out)


DUMPERS = {
    "physics": dump_physics,
    "guidance": dump_guidance,
    "ai": dump_ai,
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

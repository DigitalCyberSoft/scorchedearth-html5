#!/usr/bin/env python3
"""Coverage-mop-up oracle: focused golden vectors for the edge/guard paths the
per-module dumpers did not exercise (the last few uncovered lines per module).

Each dumper drives the REAL Python port (the fidelity reference) over crafted
inputs that hit a specific guard/branch, and writes vectors/<module>_more.json.
The matching test/<module>_more.test.ts reconstructs the identical inputs and
asserts src/<module>.ts reproduces every result (exact for int/index/bool,
epsilon 1e-12 for the hypot/cos/sin-derived floats, per the module epsilon
policy already documented in the primary test files).

Run (from scorch-html5/oracle/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../../scorch-py" \
        "../../.venv/bin/python" dump_more.py
"""
import json
import math
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + "_more.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    print(f"  wrote vectors/{module}_more.json")


def _cfg(gravity=0.2, wind=0.0, visc=0.0):
    from scorch.config import Config
    c = Config()
    c.GRAVITY = gravity
    c.AIR_VISCOSITY = visc
    c.wind = wind
    c.live_elastic = c.elastic
    return c


def _mk_tank(spec):
    """Build a Tank from a primitive spec dict {x,y,team_id,alive,angle,power}."""
    from scorch.objects import Tank
    t = Tank(spec.get("pi", 0), spec.get("name", "T"), 0, spec.get("team_id", 0))
    t.x = spec["x"]
    t.y = spec["y"]
    t.alive = spec.get("alive", True)
    if "angle" in spec:
        t.angle = spec["angle"]
    if "power" in spec:
        t.power = spec["power"]
    return t


# ---------------------------------------------------------------------------
# guidance: per-step steering GUARD branches + solve tgt-path / confused-1000.
# ---------------------------------------------------------------------------
def dump_guidance():
    from scorch import guidance
    from scorch.objects import Projectile
    from scorch.weapons import ITEMS

    # Each scenario: build owner + proj + a hand-set guidance dict, call apply
    # ONCE, snapshot (vx, vy, px, py, armed). steps=1 isolates the guards.
    SCEN = [
        # apply() with no guidance installed -> returns True, nothing changes.
        {"label": "apply_null", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 300, "y": 600}, "g": None},
        # Heat: tanks None / empty -> no target -> no steer.
        {"label": "heat_tanks_none", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 300, "y": 600, "team_id": 0},
         "g": {"type": "heat", "tanks_specs": None}},
        {"label": "heat_tanks_empty", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 300, "y": 600, "team_id": 0},
         "g": {"type": "heat", "tanks_specs": []}},
        # Heat: only a DEAD enemy in range -> skipped.
        {"label": "heat_only_dead", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 300, "y": 600, "team_id": 0},
         "g": {"type": "heat",
               "tanks_specs": [{"x": 310, "y": 404, "team_id": 0, "alive": False}]}},
        # Heat: the owner itself is in the tank list -> skipped (t is owner).
        {"label": "heat_owner_in_tanks", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 300, "y": 404, "team_id": 0},
         "g": {"type": "heat", "tanks_specs": [], "tanks_include_owner": True}},
        # Heat: only a TEAMMATE in range (teams on) -> skipped.
        {"label": "heat_teammate", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 300, "y": 600, "team_id": 2},
         "g": {"type": "heat",
               "tanks_specs": [{"x": 310, "y": 404, "team_id": 2, "alive": True}]}},
        # Heat: target acquired but projectile has ZERO speed -> sp guard.
        {"label": "heat_zero_speed", "p0": [300, 400], "v0": [0, 0],
         "owner": {"x": 300, "y": 600, "team_id": 0},
         "g": {"type": "heat",
               "tanks_specs": [{"x": 310, "y": 404, "team_id": 0, "alive": True}]}},
        # Heat: target coincident with shell (d guard) -> no steer.
        {"label": "heat_target_at_proj", "p0": [300, 400], "v0": [12, 7],
         "owner": {"x": 300, "y": 600, "team_id": 0},
         "g": {"type": "heat",
               "tanks_specs": [{"x": 300, "y": 404, "team_id": 0, "alive": True}]}},
        # Heat: a normal acquire+steer (covers the live body, not just guards).
        {"label": "heat_acquire_steer", "p0": [300, 400], "v0": [40, 0],
         "owner": {"x": 300, "y": 600, "team_id": 0},
         "g": {"type": "heat",
               "tanks_specs": [{"x": 330, "y": 410, "team_id": 0, "alive": True}]}},
        # Horizontal: no target and no point -> early return.
        {"label": "horizontal_no_target", "p0": [400, 290], "v0": [30, 20],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "horizontal", "target": None, "point": None,
               "_last_y": 310}},
        # Horizontal: arm via altitude crossing (last_y above, py below) + fly.
        {"label": "horizontal_arm_fly", "p0": [400, 290], "v0": [30, 20],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "horizontal", "point": [500, 300], "_last_y": 310}},
        # Vertical: no target/point -> early return.
        {"label": "vertical_no_target", "p0": [510, 290], "v0": [30, 20],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "vertical", "target": None, "point": None,
               "_last_x": 490}},
        # Vertical: arm via column crossing (last_x left, px right) + drop.
        {"label": "vertical_arm_drop", "p0": [510, 290], "v0": [30, 20],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "vertical", "point": [500, 300], "_last_x": 490}},
        # Lazy Boy: neither point nor target -> early return.
        {"label": "lazyboy_none", "p0": [300, 400], "v0": [10, -5],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "lazyboy", "target": None, "point": None}},
        # Lazy Boy: point set but zero speed -> sp guard.
        {"label": "lazyboy_zero_speed", "p0": [300, 400], "v0": [0, 0],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "lazyboy", "point": [520, 480]}},
        # Lazy Boy: point coincident with shell (d guard) -> no steer.
        {"label": "lazyboy_at_point", "p0": [300, 400], "v0": [9, 4],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "lazyboy", "point": [300, 400]}},
        # Lazy Boy: point None but a target tank is stored -> fallback to tank.
        {"label": "lazyboy_tgt_fallback", "p0": [300, 400], "v0": [20, 10],
         "owner": {"x": 200, "y": 600},
         "g": {"type": "lazyboy", "point": None,
               "target": {"x": 360, "y": 430}}},
    ]

    out = []
    for s in SCEN:
        owner = _mk_tank(s["owner"]) if s["owner"] is not None else None
        proj = Projectile(owner, ITEMS[0], s["p0"][0], s["p0"][1],
                          s["v0"][0], s["v0"][1])
        g = s["g"]
        if g is None:
            proj.guidance = None
        else:
            target = _mk_tank(g["target"]) if g.get("target") else None
            tanks = None
            tspecs = g.get("tanks_specs", None)
            if tspecs is not None:
                tanks = [_mk_tank(t) for t in tspecs]
                if g.get("tanks_include_owner"):
                    tanks = [owner] + tanks
            elif g.get("tanks_include_owner"):
                tanks = [owner]
            pt = g.get("point")
            proj.guidance = {
                "type": g["type"],
                "target": target,
                "point": tuple(pt) if pt is not None else None,
                "tanks": tanks,
                "armed": g.get("armed", False),
                "_last_x": g.get("_last_x"),
                "_last_y": g.get("_last_y"),
            }
        guidance.apply(proj, None, tanks=None)
        armed = bool(proj.guidance["armed"]) if proj.guidance else False
        out.append({
            "spec": s,
            "snap": [proj.vx, proj.vy, proj.px, proj.py, armed],
        })

    # solve_ballistic / _launch: tgt-tank path + the "confused" base=None -> 1000.
    solves = []
    # target supplied as a TANK (the tgt branch), reachable -> integer power.
    sb_specs = [
        {"label": "sb_tgt_tank", "fn": "power", "gravity": 0.2, "wind": 0.0,
         "angle": 45, "tank": [200, 600], "tgt": [700, 560]},
        {"label": "sb_launch_tgt_tank", "fn": "launch", "gravity": 0.2,
         "wind": 0.0, "angle": 45, "tank": [200, 600], "tgt": [700, 560]},
        # very flat shot at a high target -> closed form has no solution -> 1000.
        {"label": "sb_confused", "fn": "power", "gravity": 0.9, "wind": 0.0,
         "angle": 3, "tank": [200, 600], "tgt": [260, 80]},
        {"label": "sb_launch_confused", "fn": "launch", "gravity": 0.9,
         "wind": 0.0, "angle": 3, "tank": [200, 600], "tgt": [260, 80]},
    ]
    for s in sb_specs:
        cfg = _cfg(s["gravity"], s["wind"])
        tank = _mk_tank({"x": s["tank"][0], "y": s["tank"][1], "angle": s["angle"]})
        tgt = _mk_tank({"x": s["tgt"][0], "y": s["tgt"][1]})
        tank.guidance_target = tgt
        tank.guidance_target_pt = None
        if s["fn"] == "power":
            st = type("S", (), {"cfg": cfg, "w": 1024, "h": 768})()
            res = guidance.solve_ballistic_power(st, tank, ITEMS[0])
        else:
            res = guidance.solve_ballistic_power_launch(cfg, tank, ITEMS[0])
        solves.append({"label": s["label"], "fn": s["fn"],
                       "gravity": s["gravity"], "wind": s["wind"],
                       "angle": s["angle"], "tank": s["tank"], "tgt": s["tgt"],
                       "power": -1 if res is None else res})
        print(f"    {s['label']}: power={res}")

    _write("guidance", {"apply": out, "solve": solves})


# ---------------------------------------------------------------------------
# physics: launch-time Ballistic power solve (selected_guidance==34) + the
# no-target / ignored-weapon skips.
# ---------------------------------------------------------------------------
def dump_physics():
    from scorch import physics
    from scorch.weapons import ITEMS, by_name

    mirv = by_name("MIRV")  # behavior "mirv" -> ignored by guidance
    SCEN = [
        # selected_guidance=34, no explicit power, reachable target -> solves power.
        {"label": "launch_ballistic_solved", "weapon_idx": 0, "angle": 45,
         "tank": [200, 600], "power": None, "guidance": 34,
         "tgt": [700, 560]},
        # selected_guidance=34 but NO target -> solve returns None -> tank.power.
        {"label": "launch_ballistic_no_target", "weapon_idx": 0, "angle": 45,
         "tank": [200, 600], "power": None, "guidance": 34, "tgt": None},
        # selected_guidance=34 with a guidance-IGNORING weapon -> skip solve.
        {"label": "launch_ballistic_ignored", "weapon_idx": mirv.idx, "angle": 45,
         "tank": [200, 600], "power": None, "guidance": 34, "tgt": [700, 560]},
    ]
    out = []
    for s in SCEN:
        cfg = _cfg(0.2, 0.0)
        tank = _mk_tank({"x": s["tank"][0], "y": s["tank"][1],
                         "angle": s["angle"], "power": 500})
        tank.selected_guidance = s["guidance"]
        tank.guidance_target = (_mk_tank({"x": s["tgt"][0], "y": s["tgt"][1]})
                                if s["tgt"] else None)
        tank.guidance_target_pt = None
        proj = physics.launch(tank, cfg, ITEMS[s["weapon_idx"]], s["power"],
                              s["angle"])
        out.append({
            "label": s["label"], "weapon_idx": s["weapon_idx"],
            "angle": s["angle"], "tank": s["tank"], "guidance": s["guidance"],
            "tgt": s["tgt"],
            "snap": [proj.vx, proj.vy, proj.px, proj.py, proj.sx, proj.sy],
        })
        print(f"    {s['label']}: vx={proj.vx:.4f} vy={proj.vy:.4f}")
    _write("physics", {"launch": out})


# ---------------------------------------------------------------------------
# rng: getrandbits(k) for k > 32 (multi-word assembly) + k <= 0 error.
# Values stay < 2**53 so JS reproduces the exact integer.
# ---------------------------------------------------------------------------
def dump_rng():
    from scorch import rng as rngmod
    SEEDS = [0, 1, 42, 1234, 0xDEADBEEF, 65535]
    KS = [33, 40, 48, 53]
    runs = []
    for s in SEEDS:
        for k in KS:
            r = rngmod.Rng(s)
            words = [r._r.getrandbits(k) for _ in range(20)]
            assert all(w < (1 << 53) for w in words), "value exceeds 2**53"
            runs.append({"seed": s, "k": k, "out": words})
    _write("rng", {"getrandbits": runs})


# ---------------------------------------------------------------------------
# economy: market_update() skips UNAVAILABLE items (the `continue`).
# ---------------------------------------------------------------------------
class _EconCfg:
    def __init__(self, free_market):
        self._fm = free_market
        self.ARMS = 4

    def is_on(self, key):
        if key == "FREE_MARKET":
            return self._fm
        return False


def dump_economy():
    from scorch import economy
    e = economy.Economy(_EconCfg(True))
    unavail = [3, 7, 30]
    for k in unavail:
        e.available[k] = False
    demand = {0: 1, 1: 2, 2: 3, 5: 1, 7: 9}  # item 7 is unavailable -> ignored
    for k, v in demand.items():
        e.demand_tally[k] = v
    price_before = list(e.price)
    e.market_update(4)
    _write("economy", {
        "free_market": True,
        "num_players": 4,
        "unavail": unavail,
        "demand_tally": {str(k): v for k, v in demand.items()},
        "price_before": price_before,
        "price_after": list(e.price),
        "nobuy": list(e.nobuy),
        "demand_ema": list(e.demand_ema),
        "ratio_ema": list(e.ratio_ema),
    })


# ---------------------------------------------------------------------------
# death: the getattr-default branches (_blast_radius scale, color fallbacks).
# ---------------------------------------------------------------------------
def dump_death():
    from scorch import death

    class _S:
        pass

    s_noscale = _S()                     # no explosion_scale attribute
    s_scale = _S()
    s_scale.explosion_scale = 2.0
    _write("death", {
        "fallback": death.DEATH_BLAST_FALLBACK,
        "blast_radius_default": death._blast_radius(s_noscale, None),
        "blast_radius_scaled": death._blast_radius(s_scale, None),
        "default_color": 15,             # getattr(tank, "color", 15) sentinel
    })


# ---------------------------------------------------------------------------
# config: float / int / str rendering via the save() token path (CPython str()).
# ---------------------------------------------------------------------------
def _enc(v):
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if v == math.inf:
            return "Infinity"
        if v == -math.inf:
            return "-Infinity"
        if v == 0.0 and math.copysign(1.0, v) < 0:
            return "-0.0"
    return v


def dump_config():
    floats = [20.0, 33.0, 0.05, 1.0 / 3.0, 123456.789, 0.0001, 1e-5, 1e-7,
              1e16, 1e20, 1.5e16, -2.5, -1e-5, 0.0, -0.0,
              math.inf, -math.inf, math.nan]
    float_cases = [{"enc": _enc(v), "str": str(v)} for v in floats]
    int_cases = [{"v": n, "str": str(n)} for n in [100, -5, 0, 1000000]]
    int_neg0 = {"v_enc": "-0", "str": "0"}     # JS -0 via int field -> "0"
    str_cases = ["ON", "OFF", "640x480", "", "hello world"]
    pystr_cases = [
        {"enc": "ON", "str": "ON", "kind": "str"},
        {"enc": 5, "str": "5", "kind": "int"},
        {"enc": 0.05, "str": "0.05", "kind": "float"},
        {"enc": 0.0001, "str": "0.0001", "kind": "float"},
        {"enc": 1e-5, "str": str(1e-5), "kind": "float"},
    ]
    _write("config", {
        "float_cases": float_cases,
        "int_cases": int_cases,
        "int_neg0": int_neg0,
        "str_cases": str_cases,
        "pystr_cases": pystr_cases,
    })


# ---------------------------------------------------------------------------
# weapons: Item built with only required fields -> dataclass defaults.
# ---------------------------------------------------------------------------
def dump_weapons():
    from scorch import weapons
    it = weapons.Item(99, "X", 0, 1, 0, "explosive")
    _write("weapons", {"defaults": {
        "idx": it.idx, "name": it.name, "cost": it.cost, "bundle": it.bundle,
        "arms": it.arms, "category": it.category, "blast": it.blast,
        "behavior": it.behavior, "warheads": it.warheads, "fan": it.fan,
        "heat": it.heat, "params": it.params, "enabled": it.enabled,
        "offensive": it.offensive,
    }})


# ---------------------------------------------------------------------------
# mtn: every reject branch -- the Python port must raise on each malformed blob.
# ---------------------------------------------------------------------------
def dump_mtn():
    import struct
    import tempfile
    from port import mtn as pmtn

    def build(width, height, columns, magic=b"MT\xbe\xef", ncolors=16,
              version=1, pal_bytes=None, trailing=b"", body_override=None):
        hdr = magic + struct.pack(">H", version) + struct.pack(
            "<9H", width, 0, height, ncolors, 0, 0, 0, 0, 0)
        pal = pal_bytes if pal_bytes is not None else (bytes([255, 255, 255]) * ncolors)
        if body_override is not None:
            body = body_override
        else:
            body = b""
            for c in columns:
                cnt = len(c)
                body += struct.pack("<H", cnt)
                bb = bytearray((cnt + 1) // 2)
                for i, idx in enumerate(c):
                    if i % 2 == 0:
                        bb[i // 2] |= idx & 0xF
                    else:
                        bb[i // 2] |= (idx & 0xF) << 4
                body += bytes(bb)
        return hdr + pal + body + trailing

    cases = []

    def add(label, data, fn, grid=None):
        with tempfile.NamedTemporaryFile(suffix=".mtn", delete=False) as f:
            f.write(data)
            path = f.name
        raised, err = False, None
        try:
            if fn == "parse_header":
                pmtn.parse_header(path)
            else:
                g = pmtn.decode(path)
                if grid is not None:
                    grid["data"] = g.reshape(-1).tolist()
                    grid["shape"] = list(g.shape)
        except Exception as e:  # noqa: BLE001 -- recording WHICH error the port raises
            raised, err = True, type(e).__name__
        os.unlink(path)
        cases.append({"label": label, "hex": data.hex(), "fn": fn,
                      "py_raises": raised, "py_err": err})

    add("bad_magic", build(1, 4, [[1, 2, 3]], magic=b"XXXX"), "parse_header")
    add("truncated_palette", build(1, 4, [[1, 2, 3]], pal_bytes=bytes(10)),
        "parse_header")
    add("underrun_count", build(2, 4, []), "decode")
    add("count_exceeds_height", build(1, 4, [], body_override=struct.pack("<H", 10)),
        "decode")
    add("underrun_pixels", build(1, 10, [], body_override=struct.pack("<H", 8) + b"\x00"),
        "decode")
    add("trailing_bytes", build(1, 4, [[1, 2, 3]], trailing=b"\x00\x00\x00"), "decode")
    valid = {}
    add("valid_minimal", build(1, 4, [[1, 2, 3]]), "decode", grid=valid)
    _write("mtn", {"cases": cases, "valid_grid": valid})


def dump_ai():
    from scorch import ai
    # _solve_power(cfg, sx, sy, tx, ty, elevation_deg): closed-form launch power
    # at a fixed elevation, or None when unreachable. Covers the reachable arc,
    # the denom<=0 reject (arc tops below target), AND the v2<=0 reject (gravity
    # 0 -> zero numerator), the last untouched by the existing battery.
    cases = [
        {"label": "reachable", "g": 0.2, "sx": 200, "sy": 600, "tx": 700,
         "ty": 590, "elev": 45},
        {"label": "denom_le0_high_target", "g": 0.2, "sx": 200, "sy": 600,
         "tx": 260, "ty": 80, "elev": 5},     # arc tops below target -> None
        {"label": "v2_le0_zero_gravity", "g": 0.0, "sx": 200, "sy": 600,
         "tx": 700, "ty": 590, "elev": 45},   # a==0 -> v2==0 -> None
    ]
    out = []
    for c in cases:
        cfg = _cfg(c["g"], 0.0)
        r = ai._solve_power(cfg, c["sx"], c["sy"], c["tx"], c["ty"], c["elev"])
        out.append({**c, "power": (None if r is None else r)})
        print(f"    _solve_power {c['label']}: {r}")
    _write("ai", {"solve_power": out})


def main():
    print(f"Oracle (more): port = {_SCORCH_PY}")
    dump_guidance()
    dump_physics()
    dump_rng()
    dump_economy()
    dump_death()
    dump_config()
    dump_weapons()
    dump_mtn()
    dump_ai()
    print("Done.")


if __name__ == "__main__":
    main()

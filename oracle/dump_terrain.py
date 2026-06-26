#!/usr/bin/env python3
"""Oracle vector dumper for the `terrain` module (destructible dirt framebuffer).

Mirrors dump_vectors.py / dump_mtn.py: imports the Python port (the fidelity
reference) headless (SDL_VIDEODRIVER=dummy), drives scorch.terrain.Terrain over a
deterministic input battery (every RNG explicitly seeded with scorch.rng.Rng so
the TS side reproduces the same stream), and writes golden vectors to
vectors/terrain.json. The TS differential gate (test/terrain.test.ts) loads this
and asserts src/terrain.ts reproduces every value.

SELF-CONTAINED INPUTS: every mutating op (carve/deposit/wedge/level/settle/...) is
applied to a constructed starting framebuffer. Each DISTINCT starting grid is
emitted ONCE into the `inputs` pool (keyed by label) and every op references its
input label and carries the resulting grid. So the TS side loads the identical
starting bytes, applies the op, and compares cell-for-cell -- it reconstructs
nothing (same pattern as dump_mtn.py shipping raw .MTN bytes).

WHAT IS COVERED (every public method + every branch of terrain.py):
  - _midpoint(cfg,rng): full generated height arrays for fixed seeds, RANDOM_LAND
    on/off and FLATLAND on/off, varied LAND1/LAND2, several (w,h). Pure double math.
  - _from_mtn(path,rng): >=3 real shipped .MTN loads in BOTH the wide-slice branch
    (mw>=w, rng.pick window) and the narrow-interp branch (mw<w, linspace+interp).
    The raw .MTN bytes travel in the JSON (hex); the TS decodes the identical bytes.
  - generate(cfg,rng,mtn_files): end-state grid for the procedural path AND the MTN
    path (MTN_PERCENT forces chance() to fire), both reproducible by seed.
  - _rasterize: exercised through the generated grids (round-half-even + shading).
  - column_top / drop_to_footprint: over ALL x (incl. OOB) of constructed grids.
  - carve_circle / deposit_circle / carve_wedge / level_under_tank /
    clear_index_band / settle / _settle_column: full resulting grid checked.
  - support_count / is_supported / is_dirt / is_solid / read / write: batteries.

NUMERIC NOTE: every emitted height/index/pixel/flag is an integer, boolean, or
pure-double float (midpoint & from_mtn arithmetic), asserted EXACT on the TS side.
carve_wedge alone uses cos/sin; its outputs are integer pixel writes, asserted
exact (the test documents the libm/V8 caveat). No epsilon is used in this module.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_terrain.py
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
_ASSETS = os.path.normpath(os.path.join(_HERE, "..", "..", "1.5"))

import numpy as np  # noqa: E402

from scorch import terrain as terrainmod  # noqa: E402
from scorch import rng as rngmod  # noqa: E402
from scorch.config import Config  # noqa: E402
from port import mtn as mtnmod  # noqa: E402

C = terrainmod.C
DIRT = C.DIRT_SHADE_LO + 8      # 0x60 mid dirt
CRUST = C.DIRT_SHADE_HI         # 0x68
DEEP = C.DIRT_SHADE_LO + 3      # 0x5b
SKY = C.COL_SKY                 # 0x00
OBJ = C.COL_TANK_BASE           # 0x69 (object pixel: solid but not dirt)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = _count(payload)
    sz = os.path.getsize(path)
    print(f"  wrote vectors/{module}.json  ({n} assertions, {sz} bytes)")
    return n


def _count(payload):
    """Approx assertion count: every numeric/boolean leaf in the payload, minus the
    `inputs` pool (those are starting fixtures the TS loads, not assertions)."""
    total = 0

    def walk(v):
        nonlocal total
        if isinstance(v, bool):
            total += 1
        elif isinstance(v, (int, float)):
            total += 1
        elif isinstance(v, list):
            for it in v:
                walk(it)
        elif isinstance(v, dict):
            for k, it in v.items():
                if k in ("name", "bytes_hex", "label", "note", "input",
                         "branch", "path"):
                    continue
                walk(it)

    for key, val in payload.items():
        if key in ("module", "inputs", "mtn_bytes"):
            continue
        walk(val)
    return total


def _grid_flat(t):
    """Column-major flat list grid[x*h + y]. numpy (w,h) C-order flatten gives
    exactly this (x outer, y inner), matching the TS Uint8Array layout."""
    return [int(v) for v in t.grid.flatten()]


def _mk_cfg(**over):
    c = Config()
    for k, v in over.items():
        setattr(c, k, v)
    return c


def _bytes_hex(path):
    with open(path, "rb") as f:
        return f.read().hex()


def _fill_col(t, x, top, bottom, val=DIRT):
    h = t.h
    top = max(0, min(h, top))
    bottom = max(0, min(h, bottom))
    for y in range(top, bottom):
        t.grid[x, y] = val


# ---------------------------------------------------------------------------
# constructed starting grids (deterministic via explicit Rng; emitted to `inputs`)
# ---------------------------------------------------------------------------
def _grid_surface(w, h, seed):
    t = terrainmod.Terrain(w, h)
    r = rngmod.Rng(seed)
    for x in range(w):
        top = 10 + r.pick(h - 20)
        _fill_col(t, x, top, h, DIRT)
        t.grid[x, top] = CRUST
        if top + 1 < h:
            t.grid[x, top + 1] = CRUST
        if top + 5 < h:
            _fill_col(t, x, top + 5, h, DEEP)
    return t


def _grid_cavern(w, h):
    t = terrainmod.Terrain(w, h)
    for x in range(w):
        _fill_col(t, x, 0, 3, DIRT)
        ground_top = 12 + (x % 7)
        _fill_col(t, x, ground_top, h, DIRT)
    for x in range(0, w, 11):
        _fill_col(t, x, 0, h, DIRT)
    for x in range(3, w, 13):
        _fill_col(t, x, 0, h, SKY)
    return t


def _grid_caves(w, h):
    t = terrainmod.Terrain(w, h)
    for x in range(w):
        a = 4 + (x % 3)
        _fill_col(t, x, a, a + 3, DIRT)
        mid = h // 2 + (x % 5)
        _fill_col(t, x, mid, mid + 4, DIRT)
        _fill_col(t, x, h - 3, h, DIRT)
    for x in range(0, w, 9):
        _fill_col(t, x, h - 6, h, DIRT)
    for x in range(2, w, 8):
        _fill_col(t, x, 0, h, SKY)
    return t


def _grid_objects(w, h):
    t = terrainmod.Terrain(w, h)
    for x in range(w):
        top = 20 + (x % 9)
        _fill_col(t, x, top, h, DIRT)
    for x in range(0, w, 4):
        t.grid[x, 18] = OBJ
    return t


def _grid_rand256(w, h, seed):
    t = terrainmod.Terrain(w, h)
    r = rngmod.Rng(seed)
    for x in range(w):
        for y in range(h):
            t.grid[x, y] = r.pick(256)
    return t


# A registry of starting grids: label -> Terrain. Emitted once into `inputs`.
def _build_inputs():
    return {
        "surface_120x110_77": _grid_surface(120, 110, 77),
        "surface_120x120_314": _grid_surface(120, 120, 314),
        "surface_120x120_271": _grid_surface(120, 120, 271),
        "surface_220x200_12345": _grid_surface(220, 200, 12345),
        "surface_60x50_4242": _grid_surface(60, 50, 4242),
        "surface_140x120_888": _grid_surface(140, 120, 888),
        "cavern_180x160": _grid_cavern(180, 160),
        "caves_160x140": _grid_caves(160, 140),
        "caves_120x110": _grid_caves(120, 110),
        "objects_140x120": _grid_objects(140, 120),
        "rand256_80x70_555": _grid_rand256(80, 70, 555),
    }


def _clone(t):
    nt = terrainmod.Terrain(t.w, t.h)
    nt.grid = t.grid.copy()
    return nt


# ---------------------------------------------------------------------------
# the dumper
# ---------------------------------------------------------------------------
def dump_terrain():
    payload = {"module": "terrain"}
    INPUTS = _build_inputs()
    payload["inputs"] = {
        label: {"w": t.w, "h": t.h, "grid": _grid_flat(t)}
        for label, t in INPUTS.items()
    }

    # ----- _midpoint -----
    SEEDS = [0, 1, 2, 42, 1234, 2024, 7, 99999, 0xDEADBEEF, 123456789]
    SIZES = [(360, 480), (640, 480), (320, 200), (200, 150), (97, 211)]
    midpoint = []
    for s in SEEDS:
        for (w, h) in SIZES:
            for cfgkw in (
                {"RANDOM_LAND": "ON"},
                {"RANDOM_LAND": "OFF", "FLATLAND": "ON", "LAND1": 20, "LAND2": 20},
                {"RANDOM_LAND": "OFF", "FLATLAND": "OFF", "LAND1": 60, "LAND2": 30},
                {"RANDOM_LAND": "OFF", "FLATLAND": "ON", "LAND1": 0, "LAND2": 0},
                {"RANDOM_LAND": "OFF", "FLATLAND": "OFF", "LAND1": 100, "LAND2": 50},
            ):
                cfg = _mk_cfg(**cfgkw)
                t = terrainmod.Terrain(w, h)
                r = rngmod.Rng(s)
                heights = t._midpoint(cfg, r)
                midpoint.append({
                    "seed": s, "w": w, "h": h,
                    "random_land": cfg.is_on("RANDOM_LAND"),
                    "flatland": cfg.is_on("FLATLAND"),
                    "land1": cfg.LAND1, "land2": cfg.LAND2,
                    "heights": [float(v) for v in heights],
                })
    payload["midpoint"] = midpoint

    # ----- _from_mtn (both branches) -----
    chosen_names = ["ROCK006.MTN", "ICE001.MTN", "ROCK002.MTN", "ICE003.MTN",
                    "ROCK001.MTN"]
    chosen = [os.path.join(_ASSETS, c) for c in chosen_names
              if os.path.exists(os.path.join(_ASSETS, c))]
    mtn_bytes = {}
    from_mtn = []
    PLAYFIELDS = [(360, 480), (720, 480), (1600, 480), (500, 400)]
    for path in chosen:
        name = os.path.basename(path)
        mtn_bytes[name] = _bytes_hex(path)
        prof = mtnmod.surface_profile(path)
        for (w, h) in PLAYFIELDS:
            branch = "slice" if prof["width"] >= w else "interp"
            for s in (0, 1, 7, 42, 2024):
                t = terrainmod.Terrain(w, h)
                r = rngmod.Rng(s)
                heights = t._from_mtn(path, r)
                from_mtn.append({
                    "name": name, "w": w, "h": h, "seed": s, "branch": branch,
                    "heights": [float(v) for v in heights],
                })
    payload["from_mtn"] = from_mtn

    # ----- generate (procedural + MTN paths) -----
    generate = []
    for s in (0, 1, 42, 2024):
        for (w, h) in [(360, 480), (200, 150)]:
            cfg = _mk_cfg(RANDOM_LAND="ON")
            t = terrainmod.Terrain(w, h)
            r = rngmod.Rng(s)
            t.generate(cfg, r, mtn_files=None)
            generate.append({
                "seed": s, "w": w, "h": h, "path": "procedural",
                "mtn_names": [], "grid": _grid_flat(t),
            })
    fixed_names = ["ROCK006.MTN", "ICE001.MTN", "ROCK001.MTN"]
    fixed_mtn = [os.path.join(_ASSETS, c) for c in fixed_names]
    for nm in fixed_names:
        if nm not in mtn_bytes:
            mtn_bytes[nm] = _bytes_hex(os.path.join(_ASSETS, nm))
    for s in (0, 1, 2, 3, 5, 8, 13, 42, 100, 2024):
        for (w, h) in [(360, 480), (720, 480)]:
            cfg = _mk_cfg(RANDOM_LAND="ON", MTN_PERCENT=100.0)
            t = terrainmod.Terrain(w, h)
            r = rngmod.Rng(s)
            t.generate(cfg, r, mtn_files=fixed_mtn)
            generate.append({
                "seed": s, "w": w, "h": h, "path": "mtn",
                "mtn_names": fixed_names, "mtn_percent": 100.0,
                "grid": _grid_flat(t),
            })
    payload["generate"] = generate
    payload["mtn_bytes"] = mtn_bytes

    # ----- column_top + drop_to_footprint over ALL x (incl OOB) -----
    coltop = []
    for label in ("surface_220x200_12345", "cavern_180x160",
                  "caves_160x140", "objects_140x120"):
        t = INPUTS[label]
        tops = [t.column_top(x) for x in range(-2, t.w + 2)]
        foot = []
        for hw in (0, 1, 5, 7, 15):
            foot.append({
                "half_width": hw,
                "out": [t.drop_to_footprint(cx, hw) for cx in range(t.w)],
            })
        coltop.append({
            "input": label, "w": t.w, "h": t.h,
            "x_lo": -2, "x_hi": t.w + 2,
            "column_top": tops, "drop_to_footprint": foot,
        })
    payload["coltop"] = coltop

    # ----- carve_circle / deposit_circle -----
    carve = []
    CIRCLES = [
        (50, 60, 0), (50, 60, 1), (50, 60, 5), (50, 60, 12), (50, 60, 30),
        (0, 0, 10), (119, 109, 8), (110, 100, 25), (-5, 50, 9), (50, -5, 9),
        (300, 300, 40),
    ]
    for (cx, cy, r) in CIRCLES:
        t = _clone(INPUTS["surface_120x110_77"])
        t.carve_circle(cx, cy, r)
        carve.append({"op": "carve", "input": "surface_120x110_77",
                      "cx": cx, "cy": cy, "r": r, "grid": _grid_flat(t)})
        t2 = _clone(INPUTS["surface_120x110_77"])
        t2.deposit_circle(cx, cy, r)
        carve.append({"op": "deposit", "input": "surface_120x110_77",
                      "cx": cx, "cy": cy, "r": r, "grid": _grid_flat(t2)})
    payload["carve"] = carve

    # ----- carve_wedge -----
    wedge = []
    WEDGES = [
        (60, 80, 40, 45, 90), (60, 80, 40, 60, 90), (60, 80, 30, 45, 60),
        (60, 80, 50, 60, 135), (60, 80, 30, 45, 0), (60, 80, 45, 45, 180),
        (10, 10, 25, 45, 90), (110, 100, 35, 60, 45), (60, 80, 0, 45, 90),
        (60, 80, 40, 1, 90), (60, 80, 40, 45, 270), (60, 80, 35, 90, 90),
    ]
    for (cx, cy, r, H, aim) in WEDGES:
        t = _clone(INPUTS["surface_120x120_314"])
        t.carve_wedge(cx, cy, r, half_angle_deg=H, aim_deg=aim)
        wedge.append({"input": "surface_120x120_314", "cx": cx, "cy": cy,
                      "r": r, "half_angle": H, "aim": aim, "grid": _grid_flat(t)})
    payload["wedge"] = wedge

    # ----- level_under_tank -----
    level = []
    LVL = [
        (60, 50, 7), (30, 80, 7), (100, 40, 7), (60, 50, 0), (60, 50, 1),
        (60, 50, 15), (5, 50, 7), (115, 50, 7), (60, 0, 7), (60, 119, 7),
        (60, -3, 7), (60, 200, 7),
    ]
    for (cx, seat, hw) in LVL:
        t = _clone(INPUTS["surface_120x120_271"])
        t.level_under_tank(cx, seat, hw)
        level.append({"input": "surface_120x120_271", "cx": cx, "seat_y": seat,
                      "half_width": hw, "grid": _grid_flat(t)})
    payload["level"] = level

    # ----- clear_index_band -----
    band = []
    for (lo, hi, fill) in [(0xAF, 0xB8, None), (0x58, 0x68, 0), (200, 239, 17),
                           (0, 0, 5), (250, 255, None)]:
        t = _clone(INPUTS["rand256_80x70_555"])
        t.clear_index_band(lo, hi, fill)
        band.append({"input": "rand256_80x70_555", "lo": lo, "hi": hi,
                     "fill": (-1 if fill is None else fill),
                     "grid": _grid_flat(t)})
    payload["band"] = band

    # ----- settle / _settle_column -----
    settle = []
    sc = _clone(INPUTS["caves_120x110"])
    for x in range(sc.w):
        sc._settle_column(x)
    settle.append({"kind": "settle_column_all", "input": "caves_120x110",
                   "grid": _grid_flat(sc)})
    for (sd, seed, xlo, xhi) in [
        (0, 0, 0, None), (0, 0, 10, 60), (100, 0, 0, None),
        (40, 0, 0, None), (40, 1, 0, None), (40, 7, 0, None),
        (40, 42, 0, None), (40, 2024, 0, None), (25, 5, 5, 80),
    ]:
        t = _clone(INPUTS["caves_120x110"])
        cfg = _mk_cfg(SUSPEND_DIRT=sd)
        r = rngmod.Rng(seed)
        t.settle(cfg, r, x_lo=xlo, x_hi=xhi)
        settle.append({"kind": "settle", "input": "caves_120x110",
                       "suspend_dirt": sd, "seed": seed, "x_lo": xlo,
                       "x_hi": (-1 if xhi is None else xhi),
                       "grid": _grid_flat(t)})
    payload["settle"] = settle

    # ----- support_count / is_supported -----
    support = []
    for label in ("objects_140x120", "surface_140x120_888"):
        t = INPUTS[label]
        rows = []
        for hw in (1, 7, 15):
            cnts, supp = [], []
            for cx in range(0, t.w, 3):
                for by in range(0, t.h, 7):
                    cnts.append(t.support_count(cx, by, hw))
                    supp.append(bool(t.is_supported(cx, by, hw)))
            rows.append({"half_width": hw, "support_count": cnts,
                         "is_supported": supp})
        support.append({"input": label, "w": t.w, "h": t.h, "rows": rows})
    payload["support"] = support

    # ----- read / is_dirt / is_solid + write battery -----
    pt = INPUTS["surface_60x50_4242"]
    coords, reads, dirt, sol = [], [], [], []
    for x in range(-2, pt.w + 2, 3):
        for y in range(-2, pt.h + 2, 3):
            coords.append([x, y])
            reads.append(pt.read(x, y))
            dirt.append(bool(pt.is_dirt(x, y)))
            sol.append(bool(pt.is_solid(x, y)))
    wr = terrainmod.Terrain(40, 30)
    rseq = rngmod.Rng(999)
    writes = []
    for _ in range(200):
        x = rseq.pick(48) - 4
        y = rseq.pick(38) - 4
        c = rseq.pick(256)
        wr.write(x, y, c)
        writes.append({"x": x, "y": y, "c": c, "back": wr.read(x, y)})
    payload["pixels"] = {
        "read": {"input": "surface_60x50_4242", "coords": coords, "read": reads,
                 "is_dirt": dirt, "is_solid": sol},
        "writes": writes, "write_seed": 999, "write_w": 40, "write_h": 30,
    }

    return _write("terrain", payload)


DUMPERS = {"terrain": dump_terrain}


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

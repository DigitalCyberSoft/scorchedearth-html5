#!/usr/bin/env python3
"""Oracle vector dumper for the `palette` module: drives the Python port (the
fidelity reference) over deterministic input batteries and writes golden vectors
to vectors/palette.json.

The TypeScript differential gate (test/palette.test.ts) loads this JSON and
asserts the TS port reproduces each result exactly (integer/index/pixel/boolean)
or, for the float32 reramp ramp, within a tight epsilon.

This is a STATIC use of the Python port -- it imports and calls the port's pure
functions headless (SDL_VIDEODRIVER=dummy). It never runs the DOS binary.

Structure copies oracle/dump_vectors.py (the rng dumper template).

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_palette.py
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
    n = payload.get("assertion_count", 0)
    print(f"  wrote vectors/{module}.json  ({n} assertions)")
    return n


def _rows(table):
    """numpy (256,3) uint8 -> list of [r,g,b] python ints (JSON-safe, exact)."""
    return [[int(table[i][0]), int(table[i][1]), int(table[i][2])] for i in range(len(table))]


# ---------------------------------------------------------------------------
# palette -- the 256-entry base palette, the index helpers, the LiveLUT
# mutation primitives, and the digger/firewall band builders.
#
# Everything here is integer/index/pixel/boolean EXCEPT LiveLUT.reramp_band,
# which runs a numpy float32 ramp; its output bytes are still integers (uint8),
# so they are asserted exactly too -- but the TS must reproduce float32
# arithmetic to land on them, so a representative reramp battery is dumped.
# ---------------------------------------------------------------------------
def dump_palette():
    from scorch import palette as P

    count = 0

    # --- 1) build_palette(): the full 256-entry RGB table, exact. -----------
    pal = P.build_palette()
    base_palette = _rows(pal)
    count += 256 * 3

    # Module-level static-table exports, exact.
    statics = {
        "TANK_COLOR_BASE": int(P.TANK_COLOR_BASE),
        "SKY_RAMP_LEN": int(P.SKY_RAMP_LEN),
        "TEAM_RGB": [list(map(int, c)) for c in P.TEAM_RGB],
        "SKY_RAMP_TOP6": list(map(int, P.SKY_RAMP_TOP6)),
        "SKY_RAMP_BOTTOM6": list(map(int, P.SKY_RAMP_BOTTOM6)),
        "SKY_RAMP_TOP": list(map(int, P.SKY_RAMP_TOP)),
        "SKY_RAMP_BOTTOM": list(map(int, P.SKY_RAMP_BOTTOM)),
        # cycling-band bounds (FACT constants the renderer/game read).
        "SKY_BAND_LO": int(P.SKY_BAND_LO), "SKY_BAND_HI": int(P.SKY_BAND_HI),
        "EXPLO_BAND_LO": int(P.EXPLO_BAND_LO), "EXPLO_BAND_HI": int(P.EXPLO_BAND_HI),
        "LIGHTNING_BAND_LO": int(P.LIGHTNING_BAND_LO), "LIGHTNING_BAND_HI": int(P.LIGHTNING_BAND_HI),
        "THUNDER_BAND_LO": int(P.THUNDER_BAND_LO), "THUNDER_BAND_HI": int(P.THUNDER_BAND_HI),
        "DIGGER_BAND_LO": int(P.DIGGER_BAND_LO), "DIGGER_BAND_HI": int(P.DIGGER_BAND_HI),
        "RANKINGS_BAND_LO": int(P.RANKINGS_BAND_LO), "RANKINGS_BAND_HI": int(P.RANKINGS_BAND_HI),
        "DIALOG_BAND_LO": int(P.DIALOG_BAND_LO), "DIALOG_BAND_HI": int(P.DIALOG_BAND_HI),
        "FIREWALL_BAND_LO": int(P.FIREWALL_BAND_LO), "FIREWALL_BAND_HI": int(P.FIREWALL_BAND_HI),
        "FIREWALL_FLAME_LO": int(P.FIREWALL_FLAME_LO), "FIREWALL_FLAME_HI": int(P.FIREWALL_FLAME_HI),
        "FIREWALL_EMBER_LO": int(P.FIREWALL_EMBER_LO), "FIREWALL_EMBER_HI": int(P.FIREWALL_EMBER_HI),
        "FIREWALL_PULSE_IDX": int(P.FIREWALL_PULSE_IDX),
    }
    count += len(statics) + sum(len(v) if isinstance(v, list) else 0 for v in statics.values())

    # --- 2) tank_color_index over the full player range incl. negatives. ----
    tci_inputs = list(range(-25, 60))
    tank_color_index = [[p, int(P.tank_color_index(p))] for p in tci_inputs]
    count += len(tank_color_index)

    # --- 3) digger glow ramps over every dirt option + the default + extremes.
    digger = []
    dirt_options = [None,
                    [38, 25, 17], [54, 36, 28], [53, 53, 47],
                    [20, 62, 20], [9, 35, 9], [36, 54, 28],
                    [0, 0, 0], [63, 63, 63], [1, 2, 3], [62, 0, 31]]
    for d in dirt_options:
        arg = None if d is None else list(d)
        r6 = P.digger_glow_ramp6(None if d is None else tuple(d))
        r8 = P.digger_glow_rgb(None if d is None else tuple(d))
        digger.append({
            "dirt": arg,
            "ramp6": [list(map(int, c)) for c in r6],
            "rgb8": [list(map(int, c)) for c in r8],
        })
        count += len(r6) * 3 + len(r8) * 3

    # --- 4) firewall_apply over a wide counter sweep. Each call mutates a fresh
    # LiveLUT (seeded from build_palette); dump the WHOLE 256-entry table after so
    # we verify nothing outside the firewall bands moved, plus rev. -----------
    firewall = []
    fw_counters = (list(range(0, 110)) +
                   [120, 150, 200, 201, 255, 256, 303, 404, 505, 606, 707, 808, 909, 1000, 1001, 65535])
    for c in fw_counters:
        lut = P.LiveLUT(pal.copy())
        P.firewall_apply(lut, c)
        firewall.append({
            "counter": int(c),
            "table": _rows(lut.table),
            "rev": int(lut.rev),
        })
        count += 256 * 3 + 1

    # --- 5) LiveLUT.rotate_band: exercise step % n == 0 (no-op + no rev bump),
    # positive, negative, and > n steps over multiple bands. Dump full table+rev.
    rotate = []
    rot_cases = [
        (0x78, 0x95, 1), (0x78, 0x95, 2), (0x78, 0x95, 5), (0x78, 0x95, 29),
        (0x78, 0x95, 30), (0x78, 0x95, 31), (0x78, 0x95, 60), (0x78, 0x95, -1),
        (0x78, 0x95, -7), (0x78, 0x95, -30), (0x78, 0x95, 0),
        (0xc8, 0xef, 3), (0xc8, 0xef, -3), (0xc8, 0xef, 40), (0xc8, 0xef, 41),
        (0xb4, 0xdb, 13), (0xaa, 0xc7, -5), (0xaf, 0xb8, 1), (0xaf, 0xb8, 10),
        (0xaf, 0xb8, 11), (0x82, 0x95, 7),
        # degenerate bands (hi <= lo): must no-op, no rev bump.
        (0x50, 0x50, 1), (0x60, 0x50, 1), (0x50, 0x50, 0),
        # full-table-ish
        (0x00, 0xff, 1), (0x00, 0xff, 256), (0x00, 0xff, 257), (0x00, 0xff, -1),
    ]
    for lo, hi, step in rot_cases:
        lut = P.LiveLUT(pal.copy())
        lut.rotate_band(lo, hi, step)
        rotate.append({
            "lo": int(lo), "hi": int(hi), "step": int(step),
            "table": _rows(lut.table), "rev": int(lut.rev),
        })
        count += 256 * 3 + 1

    # Chained rotations (rev accumulation + cumulative effect).
    rotate_chain = []
    lut = P.LiveLUT(pal.copy())
    chain_ops = [(0x78, 0x95, 1), (0x78, 0x95, 1), (0x78, 0x95, 0), (0x78, 0x95, 30),
                 (0xc8, 0xef, -2), (0x78, 0x95, 28), (0x50, 0x50, 5)]
    for lo, hi, step in chain_ops:
        lut.rotate_band(lo, hi, step)
        rotate_chain.append({
            "lo": int(lo), "hi": int(hi), "step": int(step),
            "table": _rows(lut.table), "rev": int(lut.rev),
        })
        count += 256 * 3 + 1

    # --- 6) LiveLUT.reramp_band: the FLOAT32 path. Sweep band lengths (incl. n=1)
    # and endpoint sets incl. out-of-range (tests clip). Dump full table+rev. ---
    reramp = []
    reramp_cases = [
        # (lo, hi, rgb_lo, rgb_hi)
        (0x78, 0x95, [0x1d, 0x1d, 0x3f], [0, 0, 0x3f]),     # the PLAIN sky ramp (6-bit operands)
        (0x78, 0x95, [255, 0, 0], [0, 0, 255]),             # red->blue
        (0x78, 0x95, [0, 0, 63], [63, 63, 63]),             # storm-ish
        (0xc8, 0xef, [252, 220, 120], [0, 0, 0]),           # explosion fade
        (0xaa, 0xbd, [9, 9, 31], [0, 0, 31]),               # firewall band re-ramp
        (0xaf, 0xb8, [40, 20, 10], [255, 255, 255]),
        (0x10, 0x14, [300, -50, 128], [128, 300, -50]),     # CLIP both ends
        (0x20, 0x20, [10, 20, 30], [200, 210, 220]),        # n=1 (lo==hi): all rgb_lo
        (0x30, 0x31, [1, 2, 3], [254, 253, 252]),           # n=2
        (0x40, 0x42, [0, 0, 0], [255, 255, 255]),           # n=3
        (0x00, 0x06, [10, 250, 5], [250, 10, 200]),         # n=7 (a known f32!=f64 length)
        (0x50, 0x59, [5, 15, 25], [205, 215, 225]),         # n=10 (another)
        (0x60, 0x6a, [200, 100, 50], [50, 100, 200]),       # n=11
        (0x80, 0xbf, [255, 255, 255], [0, 0, 0]),           # n=64 (long)
        (0x70, 0x50, [1, 2, 3], [4, 5, 6]),                 # hi < lo: no-op, no rev bump
    ]
    for lo, hi, lo_rgb, hi_rgb in reramp_cases:
        lut = P.LiveLUT(pal.copy())
        lut.reramp_band(lo, hi, tuple(lo_rgb), tuple(hi_rgb))
        reramp.append({
            "lo": int(lo), "hi": int(hi),
            "rgb_lo": list(map(int, lo_rgb)), "rgb_hi": list(map(int, hi_rgb)),
            "table": _rows(lut.table), "rev": int(lut.rev),
        })
        count += 256 * 3 + 1

    # Sweep EVERY band length 1..40 on a fixed band start with fixed endpoints, to
    # nail the float32 linspace at all the lengths the f32!=f64 divergence appears.
    reramp_lengths = []
    for n in range(1, 41):
        lut = P.LiveLUT(pal.copy())
        lo = 0x10
        hi = lo + n - 1
        lut.reramp_band(lo, hi, (255, 8, 1), (1, 8, 255))
        reramp_lengths.append({
            "lo": lo, "hi": hi, "n": n,
            "rows": [[int(lut.table[lo + k][0]), int(lut.table[lo + k][1]), int(lut.table[lo + k][2])]
                     for k in range(n)],
            "rev": int(lut.rev),
        })
        count += n * 3 + 1

    # --- 7) LiveLUT.set_band / set_index, incl. overlong rows + rev. ----------
    setband = []
    sb_cases = [
        (0x20, 0x23, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]),
        (0x20, 0x21, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]),  # overlong: only 2 used
        (0x00, 0x00, [[99, 98, 97]]),
        (0xfe, 0xff, [[5, 6, 7], [8, 9, 10]]),
    ]
    for lo, hi, rows in sb_cases:
        lut = P.LiveLUT(pal.copy())
        import numpy as _np
        lut.set_band(lo, hi, _np.asarray(rows, dtype=_np.uint8))
        setband.append({
            "lo": int(lo), "hi": int(hi), "rows": [list(map(int, r)) for r in rows],
            "table": _rows(lut.table), "rev": int(lut.rev),
        })
        count += 256 * 3 + 1

    setindex = []
    si_cases = [(0x42, [11, 22, 33]), (0x00, [1, 2, 3]), (0xff, [254, 253, 252]),
                (0x80, [0, 0, 0])]
    for idx, rgb in si_cases:
        lut = P.LiveLUT(pal.copy())
        lut.set_index(idx, tuple(rgb))
        setindex.append({
            "idx": int(idx), "rgb": list(map(int, rgb)),
            "row": [int(lut.table[idx][0]), int(lut.table[idx][1]), int(lut.table[idx][2])],
            "rev": int(lut.rev),
        })
        count += 4

    # --- 8) LiveLUT init + copy_table + get: round-trip the base table. -------
    lut0 = P.LiveLUT()
    init_default = {
        "rev": int(lut0.rev),
        "table": _rows(lut0.table),
        "copy": _rows(lut0.copy_table()),
        "get_samples": [[i, [int(lut0[i][0]), int(lut0[i][1]), int(lut0[i][2])]]
                        for i in (0, 0x50, 0x6e, 0x78, 0x95, 0xc8, 0xdd, 0xe6, 0xff)],
    }
    count += 256 * 3 * 2 + len(init_default["get_samples"]) * 3 + 1

    # Mixed mutation sequence: exercise the whole interface against one LUT and
    # snapshot after each step (full table + rev). This is the integration check.
    seq = []
    lut = P.LiveLUT()
    import numpy as _np
    steps = [
        ("rotate", (0x78, 0x95, 1)),
        ("firewall", (5,)),
        ("set_index", (0x42, (7, 8, 9))),
        ("reramp", (0xc8, 0xef, (252, 220, 120), (0, 0, 0))),
        ("rotate", (0xc8, 0xef, 0)),          # no-op, rev unchanged
        ("set_band", (0x20, 0x22, [[1, 1, 1], [2, 2, 2], [3, 3, 3]])),
        ("rotate", (0x78, 0x95, -3)),
        ("firewall", (8,)),                    # flame fires (ec&7==0)
        ("reramp", (0xaa, 0xbd, (9, 9, 31), (0, 0, 31))),
    ]
    for op, args in steps:
        if op == "rotate":
            lut.rotate_band(*args)
        elif op == "firewall":
            P.firewall_apply(lut, *args)
        elif op == "set_index":
            lut.set_index(*args)
        elif op == "reramp":
            lut.reramp_band(*args)
        elif op == "set_band":
            lo, hi, rows = args
            lut.set_band(lo, hi, _np.asarray(rows, dtype=_np.uint8))
        seq.append({"op": op, "args": _jsonable(args),
                    "table": _rows(lut.table), "rev": int(lut.rev)})
        count += 256 * 3 + 1

    payload = {
        "module": "palette",
        "assertion_count": count,
        "base_palette": base_palette,
        "statics": statics,
        "tank_color_index": tank_color_index,
        "digger": digger,
        "firewall": firewall,
        "rotate": rotate,
        "rotate_chain": rotate_chain,
        "reramp": reramp,
        "reramp_lengths": reramp_lengths,
        "setband": setband,
        "setindex": setindex,
        "init_default": init_default,
        "seq": seq,
    }
    return _write("palette", payload)


def _jsonable(args):
    """Best-effort JSON-safe rendering of a step's args (tuples -> lists)."""
    out = []
    for a in args:
        if isinstance(a, (tuple, list)):
            out.append([list(x) if isinstance(x, (tuple, list)) else x for x in a])
        else:
            out.append(a)
    return out


DUMPERS = {
    "palette": dump_palette,
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

#!/usr/bin/env python3
"""Oracle vector dumper for the `mtn` module (.MTN scanned-mountain decoder).

Mirrors dump_vectors.py / dump_constants.py: imports the Python port (the
fidelity reference) headless (SDL_VIDEODRIVER=dummy), drives mtn.parse_header /
mtn.decode / mtn.surface_profile / mtn.to_rgb over a deterministic battery, and
writes golden vectors to vectors/mtn.json. The TS differential gate
(test/mtn.test.ts) loads this and asserts src/mtn.ts reproduces every value.

The strongest test is byte-exact decoding of the 10 SHIPPED .MTN assets in
1.5/*.MTN: every header field, every column count, the full surface profile, and
EVERY cell of the decoded (height x width) grid are emitted and checked exactly.

A second battery of SYNTHETIC .MTN blobs exercises branches the shipped files do
not isolate cleanly in one place (count==0 empty columns, count==height full
columns, odd vs even count nibble handling, width==1, the white index-0 "hole"
pixel that to_rgb must render as palette white not sky). The synthetic blob
*bytes* are generated here (column counts drawn from scorch.rng.Rng(seed) so the
generation is deterministic and reproducible), the raw bytes are emitted as hex
in the JSON, and the TS side decodes those exact bytes -- so nothing is
reconstructed on the TS side; the bytes travel in the vector file.

NUMERIC NOTE: mtn has NO transcendental math and NO RNG on any decode path, so
EVERY emitted value is asserted with EXACT equality on the TS side. The RNG is
used only to synthesize deterministic test fixtures (counts), never inside the
decoder under test.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_mtn.py
"""
import json
import os
import struct
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
# scorch-py is the sibling of scorch-html5.
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)
# The shipped assets live in the 1.5/ tree (sibling of scorch-py / scorch-html5).
_ASSETS = os.path.normpath(os.path.join(_HERE, "..", "..", "1.5"))


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
    """Assertion count == what the TS test actually checks.

    Per file/blob: header scalar fields + len(palette)*3 + len(counts) +
    len(surface) + len(grid) + len(sky_indices) + len(ground_indices) +
    len(rgb_samples). Summed over all files and synthetic blobs.
    """
    total = 0
    for group in ("files", "synthetic"):
        for rec in payload.get(group, []):
            hdr = rec["header"]
            total += 7  # version,width,height,xoff,ncolors,sky_index,body_offset
            total += 4  # header_extra (4 words)
            total += len(hdr["palette"]) * 3
            total += len(rec["counts"])
            total += len(rec["surface"])
            total += len(rec["grid"])
            total += len(rec["sky_indices"])
            total += len(rec["ground_indices"])
            total += len(rec.get("rgb_samples", []))
    return total


def _header_json(hdr):
    """Header dict -> JSON-safe (tuples -> lists)."""
    return {
        "version": hdr["version"],
        "width": hdr["width"],
        "height": hdr["height"],
        "xoff": hdr["xoff"],
        "ncolors": hdr["ncolors"],
        "sky_index": hdr["sky_index"],
        "palette": [list(t) for t in hdr["palette"]],
        "header_extra": list(hdr["header_extra"]),
        "palette_offset": hdr["palette_offset"],
        "body_offset": hdr["body_offset"],
    }


def _rgb_sample_indices(h, w, grid):
    """Deterministic stride sample of (y, x) cells for to_rgb checking.

    Covers a coarse grid spanning the whole image PLUS, explicitly, the first
    sky cell, the first ground cell, and the first stored white (palette index 0)
    "hole" cell if one exists -- those three are the distinct to_rgb branches.
    """
    idxs = []
    # coarse stride lattice (<= ~400 points regardless of image size).
    ys = max(1, h // 20)
    xs = max(1, w // 20)
    for y in range(0, h, ys):
        for x in range(0, w, xs):
            idxs.append((y, x))
    # branch witnesses.
    found_sky = found_ground = found_hole = False
    for y in range(h):
        if found_sky and found_ground and found_hole:
            break
        for x in range(w):
            v = int(grid[y, x])
            if v < 0 and not found_sky:
                idxs.append((y, x)); found_sky = True
            elif v == 0 and not found_hole:
                idxs.append((y, x)); found_hole = True
            elif v > 0 and not found_ground:
                idxs.append((y, x)); found_ground = True
            if found_sky and found_ground and found_hole:
                break
    # de-dup, stable order.
    seen = set()
    uniq = []
    for p in idxs:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def _record_for_path(mtn, np, path, name):
    """Decode a real .MTN at `path` and emit its full vector record."""
    hdr = mtn.parse_header(path)
    sp = mtn.surface_profile(path)
    grid = mtn.decode(path)                  # (h, w) int16, -1 = sky
    h, w = grid.shape
    rgb = mtn.to_rgb(path)                    # (h, w, 3) uint8, default sky_rgb
    samples = _rgb_sample_indices(h, w, grid)
    rgb_samples = []
    for (y, x) in samples:
        r, g, b = (int(c) for c in rgb[y, x])
        rgb_samples.append([y, x, r, g, b])
    return {
        "name": name,
        "header": _header_json(hdr),
        "counts": [int(v) for v in sp["counts"]],
        "surface": [int(v) for v in sp["surface"]],
        "sky_indices": [int(v) for v in sp["sky_indices"]],
        "ground_indices": [int(v) for v in sp["ground_indices"]],
        # Full grid, C-order (row-major) flatten -- matches the TS flat layout
        # data[y*width + x]. Every cell is checked.
        "grid": [int(v) for v in grid.flatten()],
        "grid_shape": [int(h), int(w)],
        "rgb_samples": rgb_samples,
    }


def _build_mtn_bytes(width, height, ncolors, xoff, sky_index, extra, palette,
                     counts, pixel_fn):
    """Assemble a synthetic .MTN byte blob exactly per the recovered format.

    counts[x]    : stored ground-pixel count for column x (0..height).
    pixel_fn(x,i): palette index (0..ncolors-1) for the i-th stored pixel of
                   column x, i in [0, counts[x]) bottom->top.
    Two nibbles per byte: low = pixel i (even), high = pixel i+1 (odd); the
    trailing high nibble of the last byte is zero-padded when count is odd.
    """
    buf = bytearray()
    buf += b"MT\xbe\xef"
    buf += struct.pack(">H", 1)              # version (BIG-endian)
    buf += struct.pack("<H", width)
    buf += struct.pack("<H", xoff)
    buf += struct.pack("<H", height)
    buf += struct.pack("<H", ncolors)
    buf += struct.pack("<H", extra[0])       # extra0
    buf += struct.pack("<H", sky_index)
    buf += struct.pack("<H", extra[1])       # extra1
    buf += struct.pack("<H", extra[2])       # extra2
    buf += struct.pack("<H", extra[3])       # extra3
    for (r, g, b) in palette:
        buf += bytes((r & 0xFF, g & 0xFF, b & 0xFF))
    for x in range(width):
        cnt = counts[x]
        buf += struct.pack("<H", cnt)
        nbytes = (cnt + 1) // 2
        for bi in range(nbytes):
            lo_i = bi * 2
            hi_i = lo_i + 1
            lo = pixel_fn(x, lo_i) & 0x0F if lo_i < cnt else 0
            hi = pixel_fn(x, hi_i) & 0x0F if hi_i < cnt else 0
            buf += bytes(((hi << 4) | lo,))
    return bytes(buf)


def _record_for_synth(mtn, np, raw, name):
    """Decode a synthetic .MTN blob (in memory) and emit its full vector record,
    plus the raw bytes as hex so the TS side decodes the identical bytes."""
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=".mtn")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        rec = _record_for_path(mtn, np, tmp, name)
    finally:
        os.unlink(tmp)
    rec["bytes_hex"] = raw.hex()
    return rec


def dump_mtn():
    from port import mtn
    import numpy as np
    from scorch import rng as rngmod

    # ---- battery 1: the 10 shipped assets (byte-exact) -------------------
    files = sorted(f for f in os.listdir(_ASSETS) if f.upper().endswith(".MTN"))
    if len(files) != 10:
        raise SystemExit(
            f"dump_mtn: expected 10 shipped .MTN files in {_ASSETS}, found "
            f"{len(files)}: {files!r}")
    file_records = []
    for fn in files:
        rec = _record_for_path(mtn, np, os.path.join(_ASSETS, fn), fn)
        # Emit hex of the whole file too, so the TS test decodes from bytes (the
        # browser path) rather than reading the asset off disk.
        with open(os.path.join(_ASSETS, fn), "rb") as fh:
            rec["bytes_hex"] = fh.read().hex()
        file_records.append(rec)

    # ---- battery 2: synthetic edge-case blobs ----------------------------
    # A fixed 16-color palette: index 0 white (sky), then a deterministic ramp.
    palette = [(255, 255, 255)]
    for i in range(1, 16):
        palette.append((i * 16 + 8, 255 - i * 8, i * 4))
    extra = (45948, 2046, 10748, 14587)      # echo a real file's extras
    NC = 16

    def ramp_pixel(x, i):
        # Deterministic, exercises every nibble value 0..15 (incl. 0 = white
        # hole) as i and x vary.
        return (x + i) % NC

    synth = []

    # (a) All-empty: every column count 0 -> grid is all sky, ground_indices [].
    w, h = 24, 30
    counts = [0] * w
    raw = _build_mtn_bytes(w, h, NC, 5, 0, extra, palette, counts, ramp_pixel)
    synth.append(_record_for_synth(mtn, np, raw, "synth_all_empty"))

    # (b) All-full: every column count == height -> grid fully ground, no sky.
    w, h = 20, 18
    counts = [h] * w
    raw = _build_mtn_bytes(w, h, NC, h, 0, extra, palette, counts, ramp_pixel)
    synth.append(_record_for_synth(mtn, np, raw, "synth_all_full"))

    # (c) Width 1, count odd (tests trailing-nibble drop + single column).
    w, h = 1, 17
    counts = [13]
    raw = _build_mtn_bytes(w, h, NC, 0, 0, extra, palette, counts, ramp_pixel)
    synth.append(_record_for_synth(mtn, np, raw, "synth_w1_odd"))

    # (d) Width 1, count even.
    w, h = 1, 17
    counts = [12]
    raw = _build_mtn_bytes(w, h, NC, 0, 0, extra, palette, counts, ramp_pixel)
    synth.append(_record_for_synth(mtn, np, raw, "synth_w1_even"))

    # (e) Mixed counts incl. 0, 1, height, and a forced index-0 hole column so
    #     to_rgb's white-hole branch is exercised against the sky branch. Counts
    #     drawn from a SEEDED Rng so the blob is deterministic + reproducible.
    SEED = 1234
    r = rngmod.Rng(SEED)
    # Assert the RNG is the same reconstructed MT the TS side has (defensive: the
    # decoder never uses RNG, but the fixture generation does).
    w, h = 40, 25
    counts = []
    for x in range(w):
        if x == 0:
            counts.append(0)               # empty
        elif x == 1:
            counts.append(1)               # single pixel
        elif x == 2:
            counts.append(h)               # full
        else:
            counts.append(r.pick(h + 1))   # 0..h inclusive
    # A column made entirely of index-0 (white "hole") pixels.
    hole_col = w // 2

    def mixed_pixel(x, i):
        if x == hole_col:
            return 0
        return (x * 3 + i * 5) % NC

    raw = _build_mtn_bytes(w, h, NC, 3, 0, extra, palette, counts, mixed_pixel)
    synth.append(_record_for_synth(mtn, np, raw, "synth_mixed_seed1234"))

    # (f) A second mixed blob, different seed + larger, to widen coverage.
    SEED2 = 0xDEADBEEF
    r2 = rngmod.Rng(SEED2)
    w, h = 200, 120
    counts = [r2.pick(h + 1) for _ in range(w)]

    def mixed_pixel2(x, i):
        return (x + i * 7 + 3) % NC

    raw = _build_mtn_bytes(w, h, NC, 7, 0, extra, palette, counts, mixed_pixel2)
    synth.append(_record_for_synth(mtn, np, raw, "synth_mixed_deadbeef"))

    return _write("mtn", {
        "module": "mtn",
        "asset_dir": _ASSETS,
        "files": file_records,
        "synthetic": synth,
    })


DUMPERS = {
    "mtn": dump_mtn,
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

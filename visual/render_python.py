#!/usr/bin/env python3
"""Visual regression gate: PYTHON ORACLE side.

For each scenario in scenario_spec.json this builds a GameState the EXACT way the
app's "new game" flow does (App._build_game, main.py:474-487):

    random.seed(seed); grng.seed(seed)            # both RNG streams
    gs = GameState(cfg, W, H)
    gs.add_player(name, ai_class, team, tank_icon) # x2
    gs.new_game()                                  # INITIAL_CASH==0 -> start_round()

then renders ONE battlefield frame the way the running app does (GameScreen.draw,
main.py:265-266 -> renderer.render(surf, gs)) and writes, per scenario:

    out/ref_<name>.png    the rendered frame (PNG, for eyeballing)
    out/ref_<name>.rgba   raw row-major RGBA bytes (W*H*4) for the pixel diff
    out/state_<name>.json the STATE SNAPSHOT (sanity gate vs the TS side)

Headless: SDL_VIDEODRIVER=dummy. NEVER runs any DOS binary.

Run:  SDL_VIDEODRIVER=dummy <venv>/bin/python visual/render_python.py
"""
import json
import os
import struct
import sys
import zlib
from pathlib import Path

# Headless SDL BEFORE pygame import.
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

HERE = Path(__file__).resolve().parent
SPEC = HERE / "scenario_spec.json"
OUT = HERE / "out"

# Put the Python port on the path. ORACLE lives next to scorch-html5.
PY_PORT = HERE.parent.parent / "scorch-py"
sys.path.insert(0, str(PY_PORT))

import pygame  # noqa: E402

from scorch.config import Config  # noqa: E402
from scorch.game import GameState  # noqa: E402
from scorch.render import Renderer  # noqa: E402
from scorch.rng import rng as grng  # noqa: E402
import random  # noqa: E402


def build_cfg(spec):
    """Default Config with the scenario_spec overrides applied (mirrors the TS
    makeCfg in test/game.test.ts). SKY is set per-scenario by the caller."""
    cfg = Config()
    for k, v in spec["config"].items():
        setattr(cfg, k, v)
    # re-resolve elastic after any ELASTIC override (config.__post_init__ sets it
    # from the default; matches the TS makeCfg cfg.live_elastic = cfg.elastic).
    cfg.live_elastic = cfg.elastic
    return cfg


def build_state(spec, scn):
    """Construct a GameState exactly like App._build_game (main.py:474-487)."""
    cfg = build_cfg(spec)
    cfg.SKY = scn["sky"]  # PIN the sky -> resolve_round_sky returns it verbatim
    cfg.mayhem = False

    seed = int(scn["seed"])
    random.seed(seed)  # game.py uses bare random.* (e.g. random.shuffle, game.py:365)
    grng.seed(seed)    # the shared Rng GameState binds (rng.py:43 / game.py:101)

    w, h = spec["width"], spec["height"]
    gs = GameState(cfg, w, h)
    # Pin the PROCEDURAL _midpoint terrain path (mtn_ranges=[]), exactly as the
    # proven differential setup does (test/game.test.ts build()). The real .MTN
    # path (_from_mtn / port.mtn) is a DIFFERENT decoder on each port and its
    # cross-port byte-equivalence is a separate question from RENDER parity; the
    # gate's job is to compare rendering on IDENTICAL states, so we eliminate the
    # terrain-source divergence here rather than let it leak into the pixel diff.
    gs.mtn_ranges = []
    for (name, ai_class, team, tank_icon) in spec["roster"]:
        gs.add_player(name, ai_class, team, tank_icon)
    gs.new_game()  # INITIAL_CASH==0 -> start_round(): terrain + place + wind + sky
    return cfg, gs


def grid_hash(gs):
    """Stable hash of the terrain index grid. numpy grid is [x, y]; tobytes() is
    C-order row-major over (W, H) i.e. x-major. The TS side hashes its column-major
    grid[x*h+y] in the SAME x-major/then-y order, so the two hashes match iff the
    grids are logically identical."""
    return zlib.crc32(gs.terrain.grid.tobytes()) & 0xFFFFFFFF


def state_snapshot(spec, cfg, gs):
    """The fields the sanity gate compares byte-for-byte against the TS side."""
    cur = gs.current_shooter
    cur_idx = gs.tanks.index(cur) if cur in gs.tanks else -1
    return {
        "phase": gs.phase,
        "live_sky": gs.live_sky,
        "wind": int(cfg.wind),
        "fire_index": int(getattr(gs, "fire_index", -1)),
        "current_shooter": cur_idx,
        "terrain_w": gs.terrain.w,
        "terrain_h": gs.terrain.h,
        "grid_crc32": grid_hash(gs),
        "tanks": [
            {
                "x": int(t.x),
                "y": int(t.y),
                "angle": int(t.angle),
                "power": int(t.power),
                "color": int(t.color),
                "half_width": int(t.half_width),
                "alive": bool(t.alive),
            }
            for t in gs.tanks
        ],
    }


def surf_to_rgba(surf):
    """Row-major RGBA bytes (W*H*4). pygame.image.tostring with "RGBA" yields
    row-major (y outer, x inner) which is the standard ImageData layout the TS
    canvas getImageData also uses."""
    return pygame.image.tostring(surf, "RGBA")


def write_png(path, w, h, rgba):
    """Minimal zlib PNG writer (RGBA8). Avoids a Pillow dependency."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type 0 (None) per scanline
        raw.extend(rgba[y * stride:(y + 1) * stride])
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit, color type 6 (RGBA)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))


def main():
    spec = json.loads(SPEC.read_text())
    OUT.mkdir(parents=True, exist_ok=True)

    pygame.init()  # SysFont (Renderer ctor) + draw ops need the subsystems up
    w, h = spec["width"], spec["height"]

    index = []
    for scn in spec["scenarios"]:
        name = scn["name"]
        cfg, gs = build_state(spec, scn)
        renderer = Renderer(cfg, w, h)
        surf = pygame.Surface((w, h))
        renderer.render(surf, gs)

        rgba = surf_to_rgba(surf)
        assert len(rgba) == w * h * 4, f"{name}: rgba len {len(rgba)} != {w*h*4}"
        (OUT / f"ref_{name}.rgba").write_bytes(rgba)
        write_png(OUT / f"ref_{name}.png", w, h, rgba)

        snap = state_snapshot(spec, cfg, gs)
        (OUT / f"state_{name}.json").write_text(json.dumps(snap, indent=2, sort_keys=True))

        index.append({"name": name, "sky": scn["sky"], "seed": scn["seed"],
                      "exact": scn["exact"]})
        print(f"[py] {name:12s} sky={scn['sky']:7s} seed={scn['seed']:<5} "
              f"grid_crc={snap['grid_crc32']:08x} tanks={len(snap['tanks'])} "
              f"phase={snap['phase']} shooter={snap['current_shooter']}")

    (OUT / "index.json").write_text(json.dumps({"width": w, "height": h,
                                                "scenarios": index}, indent=2))
    print(f"[py] wrote {len(index)} reference frames + snapshots to {OUT}")


if __name__ == "__main__":
    main()

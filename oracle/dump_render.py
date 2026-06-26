#!/usr/bin/env python3
"""Oracle vector dumper for the `render` module (the Renderer).

Drives scorch.render headless (SDL_VIDEODRIVER=dummy) and records the NUMERIC
substrate the TS port must reproduce EXACTLY -- the arrays and the math that feed
the pixel draws, not the rasterized pixels themselves (those are the Phase-3
visual gate's job):

  * _vertical_gradient(w,h,top,bot)        -> the (w,h,3) title-backdrop gradient,
                                              dumped COLUMN-MAJOR (numpy C-order
                                              ravel of (W,H,3) == data[(x*h+y)*3+c]).
  * Renderer._gradient_index_plane()       -> the (W,H) sky band-index plane.
  * Renderer._banded_vertical_ramp(t,b)    -> the 30-step quantised sunset ramp.
  * Renderer._make_sky baked planes        -> BLACK/SUNSET/STORMY/CAVERN sky_rgb.
  * Renderer._composite_terrain (REAL)     -> the composited terrain buffer, read
                                              back from the Surface via array3d,
                                              for gradient-sky AND baked-sky rounds.
  * Renderer._explosion_rgb ring INDEX     -> int(0xDD - r*20/maxR) clamped.
  * Renderer._hud_angle / _shield_pct      -> the HUD elevation + shield %.
  * weapon_icon_name / WEAPON_ICON         -> the category->sprite map.
  * Renderer._PARACHUTE / _DEATH_TILE      -> the geometry tables (exact tuples).
  * make_title_backdrop layout             -> the aspect-preserving scale/anchor.

STARS sky is deliberately NOT dumped: _make_sky("STARS") uses np.random, so its
pixels are not reproducible against the JS Math.random port (the binary itself
seeds a fresh starfield each round).  Documented in render.ts; excluded here.

Every recorded datum is an integer / index / pixel byte / bool / string, asserted
with strict equality by test/render.test.ts.  This is a STATIC use of the port --
it imports and calls the port's functions headless; it never runs the DOS binary.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_render.py
"""
import json
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import numpy as np
import pygame

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)


def _flat_u8(arr):
    """COLUMN-MAJOR flat list for an (W,H,3) uint8 array: numpy C-order ravel of
    (W,H,3) IS the surfarray contract's data[(x*h+y)*3+c]."""
    a = np.ascontiguousarray(arr, dtype=np.uint8)
    return [int(v) for v in a.ravel()]


def _flat_i(arr):
    """COLUMN-MAJOR flat int list for an (W,H) index plane (C-order ravel = x*h+y)."""
    a = np.ascontiguousarray(arr)
    return [int(v) for v in a.ravel()]


def dump_render():
    from scorch import render, palette, constants as C
    from scorch import config as cfgmod

    pygame.init()
    pygame.font.init()

    payload = {"module": "render"}

    # --- module constants the test pins --------------------------------------
    payload["consts"] = {
        "SKY_BAND_LO": int(palette.SKY_BAND_LO),
        "SKY_BAND_HI": int(palette.SKY_BAND_HI),
        "SKY_RAMP_LEN": int(palette.SKY_RAMP_LEN),
        "DIGGER_BAND_LO": int(palette.DIGGER_BAND_LO),
        "DIGGER_BAND_HI": int(palette.DIGGER_BAND_HI),
        "EXPLOSION_LO": int(C.EXPLOSION_LO),
        "EXPLOSION_HI": int(C.EXPLOSION_HI),
        "EXPLOSION_RING_BASE": int(C.EXPLOSION_RING_BASE),
        "DIRT_SHADE_LO": int(C.DIRT_SHADE_LO),
        "DIRT_SHADE_HI": int(C.DIRT_SHADE_HI),
        "COL_DIRT": int(C.COL_DIRT),
        "BAR_H": int(render.Renderer.BAR_H),
        "SHIELD_SWATCH": int(render.Renderer.SHIELD_SWATCH),
        "FLASH_OVERLAY_PEAK": int(render.Renderer.FLASH_OVERLAY_PEAK),
        "TITLE_SKY_TOP": [int(c) for c in render.TITLE_SKY_TOP],
        "TITLE_SKY_BOTTOM": [int(c) for c in render.TITLE_SKY_BOTTOM],
        "SUNSET_TOP_RGB": [int(c) for c in render.Renderer._SUNSET_TOP_RGB],
        "SUNSET_BOTTOM_RGB": [int(c) for c in render.Renderer._SUNSET_BOTTOM_RGB],
        "SHIELD_RING_RGB": [int(c) for c in render.Renderer.SHIELD_RING_RGB],
        "PLASMA_RING_RGB": [int(c) for c in render.Renderer.PLASMA_RING_RGB],
        "NUKE_CORE": [int(c) for c in render.Renderer.NUKE_CORE],
        "NUKE_MID": [int(c) for c in render.Renderer.NUKE_MID],
        "NUKE_EDGE": [int(c) for c in render.Renderer.NUKE_EDGE],
    }

    # --- WEAPON_ICON map ------------------------------------------------------
    payload["weapon_icon"] = {k: v for k, v in render.WEAPON_ICON.items()}
    # weapon_icon_name over a battery (incl. an unknown category -> default).
    from scorch import weapons

    class _I:
        def __init__(self, cat):
            self.category = cat
    cats = sorted(set(render.WEAPON_ICON.keys()) | {"__unknown__", "explosive"})
    payload["weapon_icon_name"] = [
        {"category": c, "name": render.weapon_icon_name(_I(c))} for c in cats
    ]

    # --- geometry tables (exact tuples) --------------------------------------
    payload["parachute"] = [[int(dx), int(dy)] for (dx, dy) in render.Renderer._PARACHUTE]
    payload["death_tile"] = [[int(dx), int(dy), int(k)] for (dx, dy, k) in render.Renderer._DEATH_TILE]
    payload["death_tile_grey"] = {str(k): [int(c) for c in v]
                                  for k, v in render.Renderer._DEATH_TILE_GREY.items()}

    # --- _vertical_gradient ---------------------------------------------------
    GRADS = [
        (4, 3, (40, 24, 96), (208, 96, 150)),
        (8, 6, (40, 24, 96), (208, 96, 150)),
        (5, 1, (10, 20, 30), (200, 100, 50)),
        (3, 32, (0, 0, 0), (255, 255, 255)),
        (7, 17, (252, 252, 0), (150, 40, 60)),
        (2, 49, (123, 45, 67), (12, 211, 9)),
    ]
    vgrad = []
    for (w, h, top, bot) in GRADS:
        g = render._vertical_gradient(w, h, top, bot)
        assert g.shape == (w, h, 3) and g.dtype == np.uint8
        vgrad.append({"w": w, "h": h, "top": list(top), "bottom": list(bot),
                      "flat": _flat_u8(g)})
    payload["vertical_gradient"] = vgrad

    # --- _gradient_index_plane (via a Renderer at fixed sizes) ----------------
    cfg = cfgmod.Config()
    gip = []
    for (w, h) in [(8, 6), (24, 16), (10, 1), (3, 30), (16, 33)]:
        r = render.Renderer(cfg, w, h)
        plane = r._gradient_index_plane()
        assert plane.shape == (w, h)
        gip.append({"w": w, "h": h, "flat": _flat_i(plane)})
    payload["gradient_index_plane"] = gip

    # --- _banded_vertical_ramp ------------------------------------------------
    BANDS = [
        (16, (252, 252, 0), (150, 40, 60)),
        (6, (252, 252, 0), (150, 40, 60)),
        (30, (0, 0, 0), (255, 255, 255)),
        (33, (116, 116, 252), (0, 0, 252)),
        (1, (10, 20, 30), (200, 100, 50)),
        (60, (252, 252, 0), (150, 40, 60)),
    ]
    rb = render.Renderer(cfg, 8, 8)
    banded = []
    for (h, top, bot) in BANDS:
        rb.h = h  # _banded_vertical_ramp reads self.h
        ramp = rb._banded_vertical_ramp(top, bot)
        assert ramp.shape == (h, 3) and ramp.dtype == np.uint8
        banded.append({"h": h, "top": list(top), "bottom": list(bot),
                       "flat": [int(v) for v in np.ascontiguousarray(ramp).ravel()]})
    payload["banded_ramp"] = banded

    # --- _make_sky baked planes (BLACK/SUNSET/STORMY/CAVERN) ------------------
    baked = []
    for mode in ["BLACK", "SUNSET", "STORMY", "CAVERN"]:
        cfg2 = cfgmod.Config()
        cfg2.SKY = mode
        r = render.Renderer(cfg2, 8, 6)
        assert r.sky_idx is None and r.sky_rgb is not None, f"{mode} should bake"
        baked.append({"mode": mode, "w": r.w, "h": r.h, "flat": _flat_u8(r.sky_rgb)})
    payload["baked_sky"] = baked

    # --- _composite_terrain (REAL method, read back from the Surface) --------
    # A small terrain grid exercising: sky, plain dirt 0x50, the shaded-dirt band
    # ends 0x58/0x68 and a middle 0x60, a digger-trail index 0xAF/0xB8, a tank/
    # object band index 0x6e (NOT composited -> shows sky), and an out-of-band
    # high index.  Composited through a fresh LiveLUT (at-rest table) for a
    # GRADIENT sky (sky_idx) and a BAKED sky (SUNSET).
    class _T:
        def __init__(self, grid):
            self.grid = grid

    class _S:
        def __init__(self, grid, lut):
            self.terrain = _T(grid)
            self.lut = lut

    def build_grid(w, h):
        g = np.zeros((w, h), dtype=np.int32)
        # scatter a representative set
        g[0, h - 1] = C.COL_DIRT
        g[1, h - 1] = C.DIRT_SHADE_LO
        g[2, h - 1] = 0x60
        g[3, h - 1] = C.DIRT_SHADE_HI
        g[4, h - 2] = palette.DIGGER_BAND_LO
        g[5, h - 2] = palette.DIGGER_BAND_HI
        g[6, h - 3] = 0x6E       # tank/object band -> NOT composited (sky shows)
        g[7, h - 3] = 0xF0       # out of every composited band -> sky shows
        return g

    comp = []
    # gradient-sky round: default cfg (RANDOM -> SHADED, sky_idx set)
    for (label, mode, w, h) in [("gradient", None, 8, 6), ("sunset", "SUNSET", 8, 6),
                                ("gradient_big", None, 12, 9)]:
        cfg3 = cfgmod.Config()
        if mode is not None:
            cfg3.SKY = mode
        r = render.Renderer(cfg3, w, h)
        lut = palette.LiveLUT()
        grid = build_grid(w, h)
        st = _S(grid, lut)
        # latch the frame LUT exactly as render() does
        r._lut = lut
        r._active = lut
        r.sync_sky(type("X", (), {"live_sky": None})())  # keep the init-built sky
        surf = pygame.Surface((w, h))
        r._composite_terrain(surf, st)
        back = pygame.surfarray.array3d(surf)  # (W,H,3)
        comp.append({
            "label": label,
            "w": w, "h": h,
            "sky_idx_set": r.sky_idx is not None,
            "grid_flat": _flat_i(grid),
            "rgb_flat": _flat_u8(back),
        })
    payload["composite"] = comp

    # --- _explosion_rgb ring INDEX (int(0xDD - r*20/maxR) clamped) -----------
    # We dump the recovered INDEX (pure integer math), not the LUT colour: the
    # colour is just the at-rest table lookup of that index, which palette.test
    # already covers byte-for-byte.  The index is the render-specific quantity.
    rexp = render.Renderer(cfg, 8, 8)
    EXP = []
    maxrs = [1, 5, 10, 20, 40, 75, 100]
    for maxr in maxrs:
        for r in range(0, maxr + 1):
            idx = int(C.EXPLOSION_RING_BASE - r * 20 / max(1, maxr))
            idx = max(C.EXPLOSION_LO, min(C.EXPLOSION_HI, idx))
            EXP.append({"r": r, "maxr": maxr, "idx": idx})
    payload["explosion_ring_index"] = EXP

    # --- _hud_angle -----------------------------------------------------------
    hud = []
    for a in list(range(0, 181, 1)):
        elev, side = rexp._hud_angle(a)
        hud.append({"angle": a, "elev": int(elev), "side": side})
    payload["hud_angle"] = hud

    # --- _shield_pct ----------------------------------------------------------
    # Build minimal tank-likes over a battery of (shield_hp, shield_item).
    class _Tk:
        def __init__(self, shp, sit):
            self.shield_hp = shp
            self.shield_item = sit
    shp = []
    SLOTS = [0, weapons.SLOT_MAG_DEFLECTOR, weapons.SLOT_SHIELD,
             weapons.SLOT_FORCE_SHIELD, weapons.SLOT_HEAVY_SHIELD, weapons.SLOT_SUPER_MAG]
    for sit in SLOTS:
        for hp in [-5, 0, 1, 25, 50, 99, 100, 150, 200, 1000]:
            pct = rexp._shield_pct(_Tk(hp, sit))
            full = weapons.ITEMS[sit].params.get("hp", 100) if sit else None
            shp.append({"shield_hp": hp, "shield_item": int(sit),
                        "full": (int(full) if full is not None else None),
                        "pct": int(pct)})
    payload["shield_pct"] = shp

    # --- make_title_backdrop layout (aspect-preserving scale/anchor) ----------
    # The scale block is pure number math.  Drive it via make_title_backdrop with
    # a fake mountain surface so the REAL method computes the placement; capture
    # the blit dest by monkeypatching Surface.blit on a throwaway surface.
    layout = []
    MTN = [(640, 480), (200, 100), (100, 300), (1, 1), (50, 480), (1024, 200)]
    for (mw, mh) in MTN:
        for (w, h) in [(1024, 768), (400, 300), (320, 240)]:
            # replicate the recovered formula (also verified against the live
            # transform.smoothscale target below).
            max_h = int(h * 0.62)
            scale = w / mw
            if mh * scale > max_h:
                scale = max_h / mh
            sw = max(1, int(round(mw * scale)))
            sh = max(1, int(round(mh * scale)))
            layout.append({"w": w, "h": h, "mw": mw, "mh": mh,
                           "sw": sw, "sh": sh, "dx": w - sw, "dy": h - sh})
    payload["title_layout"] = layout

    # Cross-check the replicated formula against the REAL make_title_backdrop by
    # feeding a fake mountain (patched sprites.load_title_mountain) and capturing
    # the smoothscale TARGET size the method requests -- which is exactly the
    # scaled (sw, sh).  (pygame.Surface.blit is a C method and cannot be patched;
    # the anchor is (w-sw, h-sh) by construction, validated via title_layout.)
    import scorch.sprites as spr
    captured = {}

    class _FakeMtn:
        def __init__(self, w, h):
            self._w, self._h = w, h
        def get_size(self):
            return (self._w, self._h)
    real_load = spr.load_title_mountain
    real_smooth = render.pygame.transform.smoothscale

    def fake_smooth(s, size):
        captured["size"] = (int(size[0]), int(size[1]))
        return pygame.Surface((max(1, int(size[0])), max(1, int(size[1]))))
    try:
        spr.load_title_mountain = lambda name=None: _FakeMtn(640, 480)
        render.pygame.transform.smoothscale = fake_smooth
        render.make_title_backdrop(1024, 768)
    finally:
        spr.load_title_mountain = real_load
        render.pygame.transform.smoothscale = real_smooth
    sw, sh = captured.get("size", (0, 0))
    payload["title_backdrop_real"] = {
        "w": 1024, "h": 768, "mw": 640, "mh": 480,
        "scaled_size": [sw, sh],
        "blit_dest": [1024 - sw, 768 - sh],
    }

    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "render.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    n = (len(vgrad) + len(gip) + len(banded) + len(baked) + len(comp)
         + len(EXP) + len(hud) + len(shp) + len(layout)
         + len(payload["parachute"]) + len(payload["death_tile"]))
    print(f"  wrote vectors/render.json  ({n} numeric vectors)")
    return n


def main():
    print(f"Oracle: dumping render (port = {_SCORCH_PY})")
    total = dump_render()
    print(f"Done. ~{total} golden vectors for render.")


if __name__ == "__main__":
    main()

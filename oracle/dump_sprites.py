#!/usr/bin/env python3
"""Differential dump: drive REAL scorch.sprites headless and emit golden pixel
arrays for the TS port to reproduce EXACTLY.

Every sprite Surface is read back through pygame.surfarray in the COLUMN-MAJOR
layout the HTML5 pygame shim (src/pygame.ts) uses and that the TS sprite core
emits:
    rgb   : array3d(surf).reshape(-1)        -> rgb[(x*h + y)*3 + c]
    alpha : array_alpha(surf).reshape(-1)    -> alpha[x*h + y]
(Pinned empirically: set_at((3,1)) -> flat alpha index 3*h+1.)

Covered (table+index for EVERY record, a draw_tank angle/color/design battery,
draw_tank_icon_cell, the full weapon_icon_palette, the font, the cursor, the
window icon, and load_title_mountain for real shipped .MTN files):

Run (from scorch-html5/):
  SDL_VIDEODRIVER=dummy PYTHONPATH="/abs/scorch-py" /abs/.venv/bin/python \
      oracle/dump_sprites.py
"""
import json
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

import numpy as np  # noqa: E402
import pygame  # noqa: E402

pygame.init()

from scorch import sprites  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "vectors", "sprites.json")
# The shipped 1.5/ data dir (sprites._data_dir resolves the same place).
DATA_DIR = sprites._data_dir()


def surf_arrays(surf):
    """(w, h, rgb_flat, alpha_flat) in the column-major surfarray contract."""
    w, h = surf.get_size()
    rgb = pygame.surfarray.array3d(surf)  # (w, h, 3), col-major
    al = pygame.surfarray.array_alpha(surf)  # (w, h)
    assert rgb.shape == (w, h, 3), rgb.shape
    assert al.shape == (w, h), al.shape
    return {
        "w": int(w),
        "h": int(h),
        "rgb": rgb.reshape(-1).astype(np.uint8).tolist(),
        "alpha": al.reshape(-1).astype(np.uint8).tolist(),
    }


def main():
    out = {"module": "sprites", "WEAPON_ICON_BASE": int(sprites.WEAPON_ICON_BASE)}

    # --- 1. Every sprite record, Table A and B, default (VIS_RGB) decode. ---
    out["table_a"] = [surf_arrays(sprites.get_sprite("A", i)) for i in range(48)]
    out["table_b"] = [surf_arrays(sprites.get_sprite("B", i)) for i in range(12)]

    # --- 1b. A scaled sprite, and a real-palette REMAP path (color+pal). ---
    pal = sprites.weapon_icon_palette()
    out["table_a_scale2"] = [
        surf_arrays(sprites.get_sprite("A", i, scale=2)) for i in (0, 5, 9)
    ]
    out["table_a_remap"] = [
        surf_arrays(
            sprites.get_sprite("A", i, color=sprites.WEAPON_ICON_BASE, pal=pal)
        )
        for i in range(48)
    ]

    # --- 2. weapon_icon_palette: the FULL (256,3) table. ---
    out["weapon_icon_palette"] = np.asarray(pal, dtype=np.uint8).tolist()

    # --- 3. draw_tank battery: every design x several angles x several colors,
    #        drawn onto a fixed target surface; dump the whole surface. ---
    TANK_SURF = (48, 48)
    COLORS = [
        (255, 64, 64),
        (64, 128, 255),
        (0, 224, 224),
        (160, 160, 160),
        (255, 255, 255),
    ]
    ANGLES = [0, 30, 45, 60, 90, 120, 135, 150, 180]
    tank_cases = []
    for design in range(sprites.NUM_TANK_DESIGNS):
        for color in COLORS:
            for angle in ANGLES:
                for facing in (1, -1):
                    s = pygame.Surface(TANK_SURF, pygame.SRCALPHA)
                    s.fill((0, 0, 0, 0))
                    sprites.draw_tank(
                        s, 24, 30, design, color, angle, facing=facing
                    )
                    tank_cases.append(
                        {
                            "design": design,
                            "color": list(color),
                            "angle": angle,
                            "facing": facing,
                            "x": 24,
                            "y": 30,
                            **surf_arrays(s),
                        }
                    )
    out["draw_tank"] = tank_cases

    # --- 3b. draw_tank with an int color index + pal (the resolveColor path). ---
    s = pygame.Surface(TANK_SURF, pygame.SRCALPHA)
    s.fill((0, 0, 0, 0))
    sprites.draw_tank(s, 24, 30, 0, 0x6E, 90, pal=pal)  # palette index path
    out["draw_tank_palidx"] = {
        "design": 0,
        "color_index": 0x6E,
        "angle": 90,
        **surf_arrays(s),
    }

    # --- 3c. draw_tank with an INT color and NO pal -> _VIS_RGB fallback path
    #        (the resolveColor branch the palidx case does not reach). ---
    s = pygame.Surface(TANK_SURF, pygame.SRCALPHA)
    s.fill((0, 0, 0, 0))
    sprites.draw_tank(s, 24, 30, 0, 3, 90)  # int color 3, no pal -> _VIS_RGB[3]
    out["draw_tank_intcolor_nopal"] = {
        "design": 0,
        "color_index": 3,
        "angle": 90,
        **surf_arrays(s),
    }

    # --- 4. draw_tank_icon_cell: every design, grayed and not, in a real box. ---
    cell_cases = []
    box = pygame.Rect(4, 4, 40, 32)
    for design in range(sprites.NUM_TANK_DESIGNS):
        for grayed in (False, True):
            s = pygame.Surface((48, 40), pygame.SRCALPHA)
            s.fill((0, 0, 0, 0))
            sprites.draw_tank_icon_cell(
                s, box, (255, 64, 64), design_index=design, grayed=grayed
            )
            cell_cases.append(
                {
                    "design": design,
                    "grayed": grayed,
                    "box": [box.x, box.y, box.w, box.h],
                    "color": [255, 64, 64],
                    **surf_arrays(s),
                }
            )
    out["draw_tank_icon_cell"] = cell_cases

    # --- 5. The proportional font: a representative glyph battery + a string. ---
    font_cases = []
    glyph_codes = sprites.font_codes()
    for code in glyph_codes:
        font_cases.append(
            {
                "code": code,
                "width": sprites.font_glyph_width(code),
                **surf_arrays(sprites.get_font_glyph(code)),
            }
        )
    out["font_glyphs"] = font_cases
    out["font_text"] = {
        "s": "Scorched Earth 1.5!",
        "width": sprites.font_text_width("Scorched Earth 1.5!"),
        **surf_arrays(sprites.render_text("Scorched Earth 1.5!")),
    }
    # font_text_width over strings WITH the `~` colour-escape (consumes no width,
    # FUN_5589_0b87) and font_glyph_width over codes WITHOUT a glyph (absent -> 0,
    # faithful to the binary's blank stubs).
    out["font_text_width_cases"] = [
        [s, sprites.font_text_width(s)]
        for s in ["", "~", "a~b", "ab", "Scorched~Earth", "S", "c"]
    ]
    out["font_glyph_width_cases"] = [
        [code, sprites.font_glyph_width(code)] for code in [1, 7, 34, 65, 300, 0]
    ]

    # --- 6. The default mouse cursor (geometry + a scaled variant). ---
    cur, hot = sprites.get_cursor()
    out["cursor"] = {"hotspot": list(hot), **surf_arrays(cur)}
    cur2, hot2 = sprites.get_cursor(scale=2)
    out["cursor_scale2"] = {"hotspot": list(hot2), **surf_arrays(cur2)}

    # --- 7. The window icon. ---
    out["window_icon"] = surf_arrays(sprites.get_window_icon())

    # --- 8. load_title_mountain for real shipped .MTN files (read the raw bytes
    #        so the TS test feeds the IDENTICAL bytes through src/mtn.ts). ---
    mtn_cases = []
    for name in ("ROCK001.MTN", "ICE001.MTN", "SNOW001.MTN"):
        path = os.path.join(DATA_DIR, name)
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            raw = fh.read()
        surf = sprites.load_title_mountain(name)
        if surf is None:
            continue
        mtn_cases.append(
            {
                "name": name,
                "bytes_hex": raw.hex(),
                **surf_arrays(surf),
            }
        )
    out["title_mountain"] = mtn_cases

    # --- 9. get_tank_icons: the default-color batteries (appearance previews).
    #        Drives the sizing math (padTop/w/h/px/py) + tankBodyPixels per color. ---
    icon_batteries = []
    for idx in (0, 6):
        surfs = sprites.get_tank_icons(idx=idx)
        icon_batteries.append(
            {
                "idx": idx,
                "count": len(surfs),
                "icons": [surf_arrays(su) for su in surfs],
            }
        )
    out["get_tank_icons"] = icon_batteries

    # --- 10. Pure (non-Surface) introspection helpers (DOM-free; assert direct). ---
    out["tank_design_wheels"] = [
        [i, bool(sprites.tank_design_wheels(i))] for i in range(-1, 8)
    ]
    sil_cases = []
    for i in list(range(sprites.NUM_TANK_DESIGNS)) + [99]:
        w, h, local = sprites.tank_silhouette(i)
        sil_cases.append(
            {
                "idx": i,
                "w": int(w),
                "h": int(h),
                "local": sorted("%d,%d" % (x, y) for (x, y) in local),
            }
        )
    out["tank_silhouette"] = sil_cases
    out["font_codes"] = list(sprites.font_codes())

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(out, fh)

    # Report counts (a regression in the dump is visible).
    print("wrote", OUT)
    print("  table_a:", len(out["table_a"]), "table_b:", len(out["table_b"]))
    print("  table_a_remap:", len(out["table_a_remap"]))
    print("  draw_tank cases:", len(out["draw_tank"]))
    print("  icon cells:", len(out["draw_tank_icon_cell"]))
    print("  font glyphs:", len(out["font_glyphs"]))
    print("  title_mountain:", len(out["title_mountain"]))
    total_px = sum(c["w"] * c["h"] for c in out["table_a"])
    total_px += sum(c["w"] * c["h"] for c in out["table_b"])
    total_px += sum(c["w"] * c["h"] for c in out["draw_tank"])
    total_px += sum(c["w"] * c["h"] for c in out["draw_tank_icon_cell"])
    total_px += sum(c["w"] * c["h"] for c in out["font_glyphs"])
    total_px += sum(c["w"] * c["h"] for c in out["title_mountain"])
    print("  approx pixels dumped (RGBA cells):", total_px)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Oracle vector dumper for the `main` module (the App integrator).

Drives scorch.main (the fidelity reference) HEADLESS (SDL_VIDEODRIVER=dummy) over
the parts that are NUMERICALLY testable without a live GameState or a real display:

  1. _wants_zoom_wipe(screen): the opaque/panel-rect predicate (main.py:62) over a
     battery of stub screens (every opaque x has-panel x has-rect combination).
  2. _ZoomWipe ANIMATION math (main.py:81-150): TRANSITION_FRAMES / _FRAME_DT /
     _FLASH_PEAK, and a step-by-step record of frame / done / _scale() /
     _flash_level() / the additive flash amount as advance(dt) consumes a dt
     sequence -- for OPEN and CLOSE, plus a skip() case.
  3. The run-loop dt clamp dt = min(elapsed_s, 1/30) (main.py:649).

What is NOT dumped (and why): App.run / _act / _build_game / the shop+round
sequencing all require scorch.game.GameState + scorch.sprites, whose outputs are
either pixels (Phase-3 visual gate) or full-engine state already covered by the
game/render/ingame/screens oracles.  This module's own numeric surface is the wipe
math + the predicate + the dt clamp, which is exactly what is dumped here.

The _ZoomWipe surface side (subsurface/smoothscale/BLEND_RGB_ADD) IS constructed
here (pygame under the dummy driver builds surfaces fine), but only its pure math
methods are recorded; the composited pixels defer to Phase 3.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_main.py
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

import pygame  # noqa: E402

pygame.init()
# A real display surface so display/Surface ops are valid under the dummy driver.
pygame.display.set_mode((64, 64))

from scorch import main as M  # noqa: E402


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    print(f"  wrote vectors/{module}.json")


# ---------------------------------------------------------------------------
# 1. _wants_zoom_wipe predicate (main.py:62)
# ---------------------------------------------------------------------------
class _Stub:
    """A stand-in screen with the attributes _wants_zoom_wipe probes."""

    def __init__(self, opaque=None, has_panel=False, has_rect=False):
        if opaque is not None:
            self.opaque = opaque
        if has_panel:
            self.panel = type("P", (), {})()
            if has_rect:
                self.panel.rect = pygame.Rect(10, 20, 30, 40)


def dump_wants():
    cases = []
    # every (opaque in {default(None), True, False}) x (panel?) x (rect?) combo.
    for opaque in (None, True, False):
        for has_panel in (False, True):
            for has_rect in (False, True):
                if has_rect and not has_panel:
                    continue  # a rect only exists when a panel does
                s = _Stub(opaque=opaque, has_panel=has_panel, has_rect=has_rect)
                cases.append({
                    "opaque": opaque,                # None means "attr absent"
                    "has_panel": has_panel,
                    "has_rect": has_rect,
                    "want": bool(M._wants_zoom_wipe(s)),
                })
    return {"cases": cases}


# ---------------------------------------------------------------------------
# 2. _ZoomWipe animation math (main.py:81-150)
# ---------------------------------------------------------------------------
# Drive a real _ZoomWipe (with dummy-driver surfaces) and record the pure-math
# outputs after each advance(dt).  Two rect sizes exercise the 1/rect.w scale
# floor differently; OPEN and CLOSE exercise both scale directions.

def _drive_wipe(rect_wh, opening, dt_seq):
    bg = pygame.Surface((64, 64))
    fg = pygame.Surface((64, 64))
    rect = pygame.Rect(5, 5, rect_wh[0], rect_wh[1])
    w = M._ZoomWipe(bg, fg, rect, opening=opening)
    steps = []
    # initial (frame 0) sample
    steps.append({
        "frame": w.frame,
        "done": bool(w.done),
        "scale": w._scale(),
        "flash": w._flash_level(),
        "amt": int(w._FLASH_PEAK * w._flash_level()) if w._flash_level() > 0.0 else 0,
    })
    for dt in dt_seq:
        w.advance(dt)
        lvl = w._flash_level()
        steps.append({
            "frame": w.frame,
            "done": bool(w.done),
            "scale": w._scale(),
            "flash": lvl,
            "amt": int(w._FLASH_PEAK * lvl) if lvl > 0.0 else 0,
        })
    return steps


def dump_wipe():
    fdt = M._FRAME_DT
    # A dt sequence that lands exactly on frame boundaries, plus sub-frame
    # accumulation and an over-shoot that clamps at TRANSITION_FRAMES.
    one = [fdt] * 25                       # 25 single steps (clamps at 20)
    sub = [fdt / 2.0] * 10                 # ten half-steps -> 5 frames
    mixed = [fdt * 2.0, fdt * 0.5, fdt * 0.5, fdt * 3.0, fdt * 10.0]
    runs = []
    for rect_wh in ((30, 20), (1, 1), (200, 120)):
        for opening in (True, False):
            for label, seq in (("one", one), ("sub", sub), ("mixed", mixed)):
                runs.append({
                    "rect": list(rect_wh),
                    "opening": opening,
                    "label": label,
                    "dt": list(seq),
                    "steps": _drive_wipe(rect_wh, opening, seq),
                })

    # A skip() case: jump straight to the last frame from a partial state.
    bg = pygame.Surface((64, 64))
    fg = pygame.Surface((64, 64))
    w = M._ZoomWipe(bg, fg, pygame.Rect(0, 0, 40, 30), opening=True)
    w.advance(fdt * 3.0)                    # frame 3
    pre = {"frame": w.frame, "done": bool(w.done)}
    w.skip()
    post = {"frame": w.frame, "done": bool(w.done),
            "scale": w._scale(), "flash": w._flash_level()}

    return {
        "TRANSITION_FRAMES": M.TRANSITION_FRAMES,
        "FRAME_DT": fdt,
        "FLASH_PEAK": M._ZoomWipe._FLASH_PEAK if hasattr(M._ZoomWipe, "_FLASH_PEAK")
        else 60,
        "runs": runs,
        "skip": {"pre": pre, "post": post},
    }


# ---------------------------------------------------------------------------
# 3. run-loop dt clamp (main.py:649): dt = min(elapsed_s, 1/30)
# ---------------------------------------------------------------------------
def dump_dt_clamp():
    cap = 1.0 / 30.0
    samples = []
    for elapsed_ms in (0, 1, 8, 16, 16.6667, 17, 33, 33.3334, 50, 100, 250, 1000):
        elapsed_s = elapsed_ms / 1000.0
        samples.append({"elapsed_s": elapsed_s, "dt": min(elapsed_s, cap)})
    return {"cap": cap, "samples": samples}


def main():
    print("dumping main vectors:")
    payload = {
        "wants": dump_wants(),
        "wipe": dump_wipe(),
        "dt_clamp": dump_dt_clamp(),
    }
    _write("main", payload)
    n = (len(payload["wants"]["cases"])
         + sum(len(r["steps"]) for r in payload["wipe"]["runs"])
         + len(payload["dt_clamp"]["samples"]))
    print(f"  ~{n} primary assertions")


if __name__ == "__main__":
    main()

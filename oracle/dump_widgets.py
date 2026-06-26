#!/usr/bin/env python3
"""Oracle vector dumper for the `widgets` module (the gray beveled dialog toolkit).

Drives the REAL scorch.widgets classes headless (SDL_VIDEODRIVER=dummy) over
deterministic input batteries and writes golden vectors to vectors/widgets.json.
The TS gate (test/widgets.test.ts) reproduces every result EXACTLY.

WHAT IS DUMPED (the numeric substrate -- DOM-free, so the Node test reproduces it
byte-for-byte):
  * helpers     : accel_of / plain over a string battery.
  * geom        : constructor rects + sub-rects (Spinner/Selector/Toggle/TextField/
                  IconStrip/Slider/RadioGroup/Frame). Label/Button are EXCLUDED:
                  their ctors measure a font, which the Node test (no DOM) cannot
                  reproduce; their pixels defer to Phase 3.
  * hit         : Widget.hit / Rect.collidepoint and RadioGroup._cell_rect hits over
                  a point grid.
  * spinner     : _clamp + adjust(+/-) + on_click(left/right/centre) value walks.
  * selector    : cycle(+/-) + on_click index transitions (Python modulo).
  * toggle      : on_click / on_accel boolean flips.
  * slider      : _x_to_index (incl. exact-half banker's-rounding x), _thumb_x,
                  _cur_index (first-wins tie), _set_index clamp, on_click (thumb
                  grab vs jump), on_drag.
  * radiogroup  : accel_hit + on_click cell selection + left/right wrap.
  * panel       : Panel.handle over scripted MOUSEBUTTONDOWN/MOTION/UP + KEYDOWN
                  sequences -> (returned action, focus index, bound state, transient
                  flags) snapshot after each event. Covers focus walk (TAB/UP/DOWN),
                  value stepping (LEFT/RIGHT on Spinner/Selector/Slider/RadioGroup),
                  Esc/cancel + no_cancel, click-outside cancel, accel match, text
                  capture, frame key-capture. (Button-only branches -- the
                  Enter=default-button path and Button accel -- need a font-measured
                  widget the Node test cannot build; see test notes.)

The Python `widgets` module is NOT modified.  This never runs the DOS binary.

Run (from scorch-html5):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_widgets.py
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

import pygame  # noqa: E402

pygame.font.init()
from scorch import widgets as W  # noqa: E402


# A mutable binding cell shared by getter/setter, so a snapshot is just its value.
class Cell:
    __slots__ = ("v",)

    def __init__(self, v):
        self.v = v

    def get(self):
        return self.v

    def set(self, x):
        self.v = x


def _rect(r):
    return [r.x, r.y, r.w, r.h]


# ---------------------------------------------------------------------------
# helpers: accel_of / plain
# ---------------------------------------------------------------------------
def dump_helpers():
    LABELS = [
        "~Done", "No~ne", "trailing~", "plain", "", "~", "~~x", "a~Bc",
        "~Quit Game", "Inventor~y", "~1", "x~ ", "MULTI ~Word ~Two",
        "~A~B~C", "lower~CASE", "UPPER~case",
    ]
    out = []
    for s in LABELS:
        out.append({"s": s, "accel": W.accel_of(s), "plain": W.plain(s)})
    return out


# ---------------------------------------------------------------------------
# geom: constructor rects (DOM-free widgets only)
# ---------------------------------------------------------------------------
def dump_geom():
    out = []

    def rec(name, w, extra=None):
        d = {"name": name, "rect": _rect(w.rect)}
        if extra:
            d.update(extra)
        out.append(d)

    rec("spinner_default", W.Spinner(10, 20, "P", Cell(0).get, Cell(0).set, 0, 10))
    rec("spinner_w", W.Spinner(3, 4, "P", Cell(0).get, Cell(0).set, 0, 10, w=120))
    rec("selector_default", W.Selector(0, 0, "S", ["a", "b"], Cell(0).get, Cell(0).set))
    rec("selector_w", W.Selector(7, 9, "S", ["a"], Cell(0).get, Cell(0).set, w=200))
    rec("toggle_default", W.Toggle(0, 0, "T", Cell(False).get, Cell(False).set))
    rec("toggle_w", W.Toggle(11, 13, "T", Cell(False).get, Cell(False).set, w=180))
    rec("textfield_default",
        W.TextField(0, 0, "Name", Cell("").get, Cell("").set))
    tf = W.TextField(2, 3, "N", Cell("").get, Cell("").set, maxlen=4, w=140, label_w=40)
    rec("textfield_custom", tf, {"maxlen": tf.maxlen, "label_w": tf.label_w})

    ic = W.IconStrip(50, 60, [0, 1, 2, 3, 4], Cell(0).get, Cell(0).set)
    rec("iconstrip_default", ic, {"cell": ic.cell})
    ic2 = W.IconStrip(0, 0, ["x", "y"], Cell(0).get, Cell(0).set, cell=20)
    rec("iconstrip_cell", ic2, {"cell": ic2.cell})

    sl = W.Slider(0, 0, "S", [0, 5, 10, 15, 20], Cell(0).get, Cell(0).set)
    rec("slider_default", sl, {"track_x": sl.track_x, "track_w": sl.track_w})
    sl2 = W.Slider(8, 9, "S", [1, 2, 3], Cell(1).get, Cell(1).set, w=100)
    rec("slider_w", sl2, {"track_x": sl2.track_x, "track_w": sl2.track_w})

    rg = W.RadioGroup(100, 50, ["~A", "~B", "~C", "~D", "~E"], Cell(0).get, Cell(0).set,
                      cols=2, cell_w=80, cell_h=18)
    rec("radio_grid", rg, {"cells": [_rect(rg._cell_rect(i)) for i in range(5)],
                           "accels": rg.cell_accels})
    rg2 = W.RadioGroup(0, 0, ["~One", "~Two", "~Three"], Cell(0).get, Cell(0).set)
    rec("radio_col", rg2, {"cells": [_rect(rg2._cell_rect(i)) for i in range(3)],
                           "accels": rg2.cell_accels})

    rec("frame_plain", W.Frame(5, 6, 40, 30, title="Hello"))
    rec("frame_capture", W.Frame(5, 6, 40, 30, capture=True))
    return out


# ---------------------------------------------------------------------------
# hit: Widget.hit / collidepoint over a point grid (incl. RadioGroup cells)
# ---------------------------------------------------------------------------
def dump_hit():
    out = []
    grid = [(x, y) for x in (-1, 0, 5, 9, 10, 49, 50, 100, 269, 270, 271)
            for y in (-1, 0, 5, 19, 20, 39, 40)]

    # plain Widget box
    w = W.Widget(10, 5, 60, 20, "x")
    out.append({"name": "widget_box", "rect": _rect(w.rect),
                "hits": [w.hit(p) for p in grid], "grid": grid})

    # disabled widget never hits
    wd = W.Widget(10, 5, 60, 20, "x")
    wd.enabled = False
    out.append({"name": "widget_disabled", "rect": _rect(wd.rect),
                "hits": [wd.hit(p) for p in grid], "grid": grid})

    # RadioGroup: whole-rect hit + which cell each point lands in
    rg = W.RadioGroup(20, 10, ["a", "b", "c", "d"], Cell(0).get, Cell(0).set,
                      cols=2, cell_w=40, cell_h=15)
    rgrid = [(x, y) for x in (19, 20, 30, 59, 60, 99, 100)
             for y in (9, 10, 17, 24, 25, 39, 40)]
    cell_of = []
    for p in rgrid:
        idx = None
        for i in range(4):
            if rg._cell_rect(i).collidepoint(p):
                idx = i
                break
        cell_of.append(idx)
    out.append({"name": "radio_hit", "rect": _rect(rg.rect),
                "hits": [rg.hit(p) for p in rgrid], "cell_of": cell_of, "grid": rgrid})

    # Frame capture vs non-capture hit
    fc = W.Frame(0, 0, 30, 20, capture=True)
    fn = W.Frame(0, 0, 30, 20, capture=False)
    fgrid = [(-1, -1), (0, 0), (15, 10), (29, 19), (30, 20)]
    out.append({"name": "frame_capture_hit", "hits": [fc.hit(p) for p in fgrid], "grid": fgrid})
    out.append({"name": "frame_plain_hit", "hits": [fn.hit(p) for p in fgrid], "grid": fgrid})
    return out


# ---------------------------------------------------------------------------
# spinner: clamp + adjust + on_click value walks
# ---------------------------------------------------------------------------
def dump_spinner():
    out = []
    CONFIGS = [
        {"start": 5, "lo": 0, "hi": 10, "step": 1},
        {"start": 0, "lo": 0, "hi": 10, "step": 3},
        {"start": 50, "lo": 0, "hi": 200, "step": 25},
        {"start": -5, "lo": -10, "hi": 10, "step": 4},
        {"start": 100, "lo": 100, "hi": 100, "step": 1},  # degenerate range
    ]
    # adjust deltas / on_click scripts
    for cfg in CONFIGS:
        cell = Cell(cfg["start"])
        sp = W.Spinner(0, 0, "P", cell.get, cell.set, cfg["lo"], cfg["hi"], cfg["step"], w=260)
        clamps = [sp._clamp(v) for v in (-100, cfg["lo"] - 1, cfg["lo"], 0, cfg["hi"], cfg["hi"] + 1, 100)]
        seq = []
        # batteries of adjust then on_click at left/centre/right with each button
        for d in (+1, +1, +1, +1, +1, +1, -1, -1, -1, -1, -1, -1, +1, -1):
            sp.adjust(d)
            seq.append(cell.v)
        clicks = []
        for (px, button) in [(0, 1), (130, 1), (200, 1), (139, 1), (140, 1), (141, 1),
                             (5, 3), (250, 3), (140, 3)]:
            r = sp.on_click((px, 0), button)
            clicks.append({"px": px, "button": button, "ret": r, "val": cell.v})
        accel = []
        for _ in range(3):
            r = sp.on_accel()
            accel.append({"ret": r, "val": cell.v})
        out.append({"cfg": cfg, "clamps": clamps, "adjust_seq": seq,
                    "clicks": clicks, "accel": accel, "centerx": sp.rect.centerx})
    return out


# ---------------------------------------------------------------------------
# selector / toggle
# ---------------------------------------------------------------------------
def dump_selector():
    out = []
    OPTSETS = [["A", "B", "C"], ["only"], ["x", "y", "z", "w", "v"], ["p", "q"]]
    for opts in OPTSETS:
        cell = Cell(0)
        sel = W.Selector(0, 0, "S", opts, cell.get, cell.set)
        cyc = []
        for d in (+1, +1, +1, +1, -1, -1, -1, -1, -1, +1):
            sel.cycle(d)
            cyc.append(cell.v)
        clicks = []
        for button in (1, 1, 3, 3, 1):
            r = sel.on_click((0, 0), button)
            clicks.append({"button": button, "ret": r, "val": cell.v})
        accel = []
        for _ in range(2):
            r = sel.on_accel()
            accel.append({"ret": r, "val": cell.v})
        out.append({"opts": opts, "cycle": cyc, "clicks": clicks, "accel": accel})
    return out


def dump_toggle():
    out = []
    for start in (False, True):
        cell = Cell(start)
        tg = W.Toggle(0, 0, "T", cell.get, cell.set)
        seq = []
        for _ in range(5):
            r = tg.on_click((0, 0), 1)
            seq.append({"ret": r, "val": cell.v})
        for _ in range(3):
            r = tg.on_accel()
            seq.append({"ret": r, "val": cell.v})
        out.append({"start": start, "seq": seq})
    return out


# ---------------------------------------------------------------------------
# slider: x<->index mapping (incl. exact-half banker's rounding), thumb, drag
# ---------------------------------------------------------------------------
def dump_slider():
    out = []
    VALSETS = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [0, 50, 100, 150, 200],
        [5],                       # single value (track collapses)
        [10, 20, 30],
        [0.0, 2.5, 5.0, 7.5, 10.0],  # float ticks: nearest-index uses abs()
    ]
    # x sweep includes exact-half products: for the 11-tick w=240 slider,
    # frac*(n-1)=0.5 at x=19.2 (->0 even) and =1.5 at x=41.6 (->2 even).
    XS = [-10, 0, 8, 14, 19.2, 20, 41.6, 100, 116, 120, 224, 232, 300, 7, 9]
    for values in VALSETS:
        cell = Cell(values[0])
        sl = W.Slider(0, 0, "S", values, cell.get, cell.set, w=240)
        x2i = [{"x": x, "i": sl._x_to_index(x)} for x in XS]
        # _cur_index over a battery of bound values (including ties + out-of-range)
        cur = []
        probe_vals = ([-5, 0, 1, 2.4, 2.5, 5, 9.9, 10, 100]
                      if len(values) > 1 else [0, 5, 99])
        for pv in probe_vals:
            cell.v = pv
            cur.append({"v": pv, "cur": sl._cur_index(), "thumb": sl._thumb_x()})
        # _set_index clamp
        cell.v = values[0]
        seti = []
        for i in (-3, -1, 0, 1, len(values) - 1, len(values), 99):
            sl._set_index(i)
            seti.append({"i": i, "val": cell.v})
        # on_click: thumb-grab vs jump, plus right-click step-back, plus drag
        cell.v = values[0]
        sl.dragging = False
        click_log = []
        # script: right-click prev, click far (jump), click near thumb (grab),
        # then a motion drag while grabbed, then another, then release-equivalent.
        script = [
            ("click", (0, 0), 3),
            ("click", (224, 0), 1),
            ("click", (sl._thumb_x(), 0), 1),  # grab at current thumb
            ("drag", (8, 0), None),
            ("drag", (224, 0), None),
            ("drag", (116, 0), None),
            ("release", None, None),
            ("drag", (0, 0), None),            # drag after release: no-op
            ("click", (60, 0), 1),
        ]
        for (kind, pos, button) in script:
            if kind == "click":
                r = sl.on_click(pos, button)
                click_log.append({"kind": kind, "pos": list(pos), "button": button,
                                   "ret": r, "val": cell.v, "dragging": sl.dragging})
            elif kind == "drag":
                sl.on_drag(pos)
                click_log.append({"kind": kind, "pos": list(pos),
                                  "val": cell.v, "dragging": sl.dragging})
            elif kind == "release":
                sl.on_release()
                click_log.append({"kind": kind, "val": cell.v, "dragging": sl.dragging})
        # on_accel steps forward
        cell.v = values[0]
        accel = []
        for _ in range(len(values) + 1):
            r = sl.on_accel()
            accel.append({"ret": r, "val": cell.v})
        out.append({"values": values, "x2i": x2i, "cur": cur, "set_index": seti,
                    "clicks": click_log, "accel": accel})
    return out


# ---------------------------------------------------------------------------
# radiogroup: accel_hit + on_click cell selection
# ---------------------------------------------------------------------------
def dump_radio():
    out = []
    LABELSETS = [
        (["~Alpha", "~Beta", "~Gamma"], 1, 150, 20),
        (["~Aa", "~Bb", "~Cc", "~Dd", "~Ee"], 2, 80, 18),
        (["No~ne", "Plain", "~Last"], 1, 100, 16),  # middle has no accel
    ]
    for (labels, cols, cw, ch) in LABELSETS:
        cell = Cell(0)
        rg = W.RadioGroup(20, 10, labels, cell.get, cell.set, cols=cols, cell_w=cw, cell_h=ch)
        # accel_hit over every letter a..z plus a couple of misses
        ah = []
        for c in "abcdefghijklmnopqrstuvwxyz0":
            cell.v = -1
            hit = rg.accel_hit(c)
            ah.append({"ch": c, "hit": hit, "val": cell.v})
        # on_click each cell centre + a miss point
        cell.v = 0
        clicks = []
        pts = []
        for i in range(len(labels)):
            cr = rg._cell_rect(i)
            pts.append((cr.x + 3, cr.y + 3))
        pts.append((20 + cw * cols + 50, 10))  # outside
        for p in pts:
            r = rg.on_click(p, 1)
            clicks.append({"p": list(p), "ret": r, "val": cell.v})
        out.append({"labels": labels, "cols": cols, "accel_hit": ah, "clicks": clicks})
    return out


# ---------------------------------------------------------------------------
# panel: the event router. Build panels of DOM-free widgets, replay scripted
# events, snapshot (action, focus, cells, transient flags) after each event.
# ---------------------------------------------------------------------------
def _ev(t, **kw):
    e = pygame.event.Event(t, **kw)
    return e


def _panel_snapshot(panel, cells):
    flags = {}
    for i, w in enumerate(panel.widgets):
        if isinstance(w, W.Slider):
            flags[f"w{i}_dragging"] = w.dragging
        if isinstance(w, W.Frame):
            flags[f"w{i}_arming"] = w.arming
        if isinstance(w, W.TextField):
            flags[f"w{i}_editing"] = w.editing
    return {
        "focus": panel.focus,
        "cells": [c.v for c in cells],
        "flags": flags,
        "text_widget": panel.widgets.index(panel.text_widget) if panel.text_widget else -1,
        "capture_widget": panel.widgets.index(panel.capture_widget) if panel.capture_widget else -1,
    }


def _run_panel(build, script):
    """build() -> (panel, cells); replay script of event dicts; return per-step log."""
    panel, cells = build()
    log = [{"step": -1, "ret": None, **_panel_snapshot(panel, cells)}]
    for step in script:
        e = _ev(step["type"], **{k: v for k, v in step.items() if k != "type"})
        ret = panel.handle(e)
        log.append({"step": script.index(step), "ret": ret, **_panel_snapshot(panel, cells)})
    return log


def dump_panel():
    scenarios = []

    KD = pygame.KEYDOWN
    MD = pygame.MOUSEBUTTONDOWN
    MM = pygame.MOUSEMOTION
    MU = pygame.MOUSEBUTTONUP

    # --- Scenario 1: focus walk (TAB/DOWN/UP) over a mixed widget set + value
    #     stepping via LEFT/RIGHT on the focused widget; Esc -> cancel. ---
    def build1():
        p = W.Panel(0, 0, 400, 300, "Cfg", no_cancel=False, cancel_action="back")
        c0 = Cell(5)   # spinner
        c1 = Cell(0)   # selector
        c2 = Cell(False)  # toggle
        c3 = Cell(0)   # radiogroup index
        cells = [c0, c1, c2, c3]
        p.add(W.Spinner(0, 0, "P", c0.get, c0.set, 0, 10, 2, w=260))
        p.add(W.Selector(0, 30, "S", ["x", "y", "z"], c1.get, c1.set))
        p.add(W.Toggle(0, 60, "T", c2.get, c2.set))
        p.add(W.RadioGroup(0, 90, ["~A", "~B", "~C"], c3.get, c3.set))
        return p, cells

    s1 = [
        {"type": KD, "key": pygame.K_TAB, "unicode": "\t"},
        {"type": KD, "key": pygame.K_DOWN, "unicode": ""},
        {"type": KD, "key": pygame.K_DOWN, "unicode": ""},
        {"type": KD, "key": pygame.K_DOWN, "unicode": ""},   # wrap
        {"type": KD, "key": pygame.K_UP, "unicode": ""},
        {"type": KD, "key": pygame.K_UP, "unicode": ""},      # wrap back up
        # focus now at spinner(0): RIGHT/LEFT step it
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},
        {"type": KD, "key": pygame.K_LEFT, "unicode": ""},
        {"type": KD, "key": pygame.K_TAB, "unicode": "\t"},   # -> selector(1)
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},   # cycle selector +1
        {"type": KD, "key": pygame.K_LEFT, "unicode": ""},    # cycle -1
        {"type": KD, "key": pygame.K_TAB, "unicode": "\t"},   # -> toggle(2)
        {"type": KD, "key": pygame.K_SPACE, "unicode": " "},  # on_accel toggle flip
        {"type": KD, "key": pygame.K_TAB, "unicode": "\t"},   # -> radio(3)
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},   # radio +1
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},   # wrap
        {"type": KD, "key": pygame.K_LEFT, "unicode": ""},    # wrap back
        {"type": KD, "key": pygame.K_ESCAPE, "unicode": "\x1b"},  # cancel -> "back"
    ]
    scenarios.append({"name": "focus_walk_step_esc", "log": _run_panel(build1, s1)})

    # --- Scenario 2: mouse clicks -> hit/focus/on_click, click-outside cancel,
    #     right vs left button on Spinner/Selector, accelerator keys. ---
    def build2():
        p = W.Panel(50, 40, 300, 200, "M", cancel_action="back")
        c0 = Cell(5)
        c1 = Cell(0)
        c2 = Cell(False)
        cells = [c0, c1, c2]
        # positions are panel-local-agnostic (widgets carry absolute coords)
        p.add(W.Spinner(60, 50, "~Power", c0.get, c0.set, 0, 10, 1, w=260))   # accel 'p'
        p.add(W.Selector(60, 80, "~Type", ["x", "y", "z"], c1.get, c1.set))   # accel 't'
        p.add(W.Toggle(60, 110, "~Sound", c2.get, c2.set))                    # accel 's'
        return p, cells

    s2 = [
        # click spinner left half (< centerx) -> -1 ; centerx for x=60,w=260 -> 60+130=190
        {"type": MD, "pos": (100, 55), "button": 1},
        {"type": MD, "pos": (250, 55), "button": 1},   # right half -> +1
        {"type": MD, "pos": (100, 55), "button": 3},   # right-button -> -1
        {"type": MD, "pos": (70, 85), "button": 1},    # selector left-click -> +1
        {"type": MD, "pos": (70, 85), "button": 3},    # selector right-click -> -1
        {"type": MD, "pos": (70, 115), "button": 1},   # toggle flip
        {"type": MD, "pos": (5, 5), "button": 1},      # outside panel -> cancel "back"
        # accelerators
        {"type": KD, "key": pygame.K_p, "unicode": "p"},   # spinner +1
        {"type": KD, "key": pygame.K_t, "unicode": "t"},   # selector +1
        {"type": KD, "key": pygame.K_s, "unicode": "s"},   # toggle flip
        {"type": KD, "key": pygame.K_z, "unicode": "z"},   # no match -> None
    ]
    scenarios.append({"name": "mouse_click_outside_accel", "log": _run_panel(build2, s2)})

    # --- Scenario 3: no_cancel panel: Esc + click-outside do NOT dismiss. ---
    def build3():
        p = W.Panel(10, 10, 200, 100, "NC", no_cancel=True, cancel_action="back")
        c0 = Cell(0)
        cells = [c0]
        p.add(W.Selector(20, 20, "S", ["a", "b"], c0.get, c0.set))
        return p, cells

    s3 = [
        {"type": KD, "key": pygame.K_ESCAPE, "unicode": "\x1b"},  # -> None
        {"type": MD, "pos": (0, 0), "button": 1},                  # outside -> None
        {"type": MD, "pos": (25, 25), "button": 1},                # selector +1
    ]
    scenarios.append({"name": "no_cancel", "log": _run_panel(build3, s3)})

    # --- Scenario 4: Slider drag through the panel (MOTION while dragging) +
    #     MOUSEBUTTONUP releases; LEFT/RIGHT step the focused slider. ---
    def build4():
        p = W.Panel(0, 0, 300, 120, "SL")
        c0 = Cell(0)
        cells = [c0]
        p.add(W.Slider(0, 0, "S", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], c0.get, c0.set, w=240))
        return p, cells

    s4 = [
        {"type": MD, "pos": (8, 20), "button": 1},     # click at thumb (val0) -> grab
        {"type": MM, "pos": (116, 20)},                 # drag to mid -> index 5
        {"type": MM, "pos": (224, 20)},                 # drag to far -> index 10
        {"type": MU, "pos": (224, 20), "button": 1},   # release
        {"type": MM, "pos": (8, 20)},                   # motion after release -> no move
        {"type": KD, "key": pygame.K_LEFT, "unicode": ""},   # focused slider step -1
        {"type": KD, "key": pygame.K_RIGHT, "unicode": ""},  # +1
        {"type": MD, "pos": (60, 20), "button": 3},    # right-click -> step back
    ]
    scenarios.append({"name": "slider_drag", "log": _run_panel(build4, s4)})

    # --- Scenario 5: TextField line editor capture (focus_text), typing,
    #     backspace, maxlen guard, Enter ends editing. ---
    def build5():
        p = W.Panel(0, 0, 300, 80, "TF")
        c0 = Cell("")
        cells = [c0]
        p.add(W.TextField(0, 0, "N", c0.get, c0.set, maxlen=3, w=240, label_w=40))
        return p, cells

    s5 = [
        {"type": MD, "pos": (50, 5), "button": 1},               # focus_text -> editing
        {"type": KD, "key": pygame.K_a, "unicode": "a"},
        {"type": KD, "key": pygame.K_b, "unicode": "b"},
        {"type": KD, "key": pygame.K_c, "unicode": "c"},
        {"type": KD, "key": pygame.K_d, "unicode": "d"},          # maxlen 3 -> dropped
        {"type": KD, "key": pygame.K_BACKSPACE, "unicode": "\b"}, # -> "ab"
        {"type": KD, "key": pygame.K_RETURN, "unicode": "\r"},    # end editing
        {"type": KD, "key": pygame.K_a, "unicode": "a"},          # not editing -> accel path (no match) None
    ]
    scenarios.append({"name": "textfield_edit", "log": _run_panel(build5, s5)})

    # --- Scenario 6: Frame key-capture (Simultaneous block): click arms, next
    #     KEYDOWN is stored (upper()'d unicode); Esc while arming cancels capture. ---
    def build6():
        p = W.Panel(0, 0, 200, 120, "KEY")
        c0 = Cell("?")  # captured key holder
        cells = [c0]
        p.add(W.Frame(0, 0, 60, 30, capture=True, get_key=c0.get, set_key=c0.set))
        p.add(W.Frame(0, 40, 60, 30, capture=True, get_key=c0.get, set_key=c0.set))
        return p, cells

    s6 = [
        {"type": MD, "pos": (10, 10), "button": 1},              # arm frame 0
        {"type": KD, "key": pygame.K_g, "unicode": "g"},          # capture -> "G"
        {"type": MD, "pos": (10, 50), "button": 1},              # arm frame 1
        {"type": KD, "key": pygame.K_ESCAPE, "unicode": "\x1b"}, # cancel capture (no store)
        {"type": MD, "pos": (10, 10), "button": 1},              # arm frame 0 again
        {"type": KD, "key": pygame.K_5, "unicode": "5"},          # capture -> "5"
    ]
    scenarios.append({"name": "frame_capture", "log": _run_panel(build6, s6)})

    # --- Scenario 7: RadioGroup accelerator routing through the panel (the
    #     tag-8 per-cell key list short-circuits before the generic accel loop). ---
    def build7():
        p = W.Panel(0, 0, 200, 120, "RG")
        c0 = Cell(0)
        c1 = Cell(False)
        cells = [c0, c1]
        p.add(W.RadioGroup(0, 0, ["~Red", "~Green", "~Blue"], c0.get, c0.set))
        p.add(W.Toggle(0, 70, "~Done", c1.get, c1.set))  # accel 'd'
        return p, cells

    s7 = [
        {"type": KD, "key": pygame.K_g, "unicode": "g"},   # radio -> Green (idx1)
        {"type": KD, "key": pygame.K_b, "unicode": "b"},   # radio -> Blue (idx2)
        {"type": KD, "key": pygame.K_r, "unicode": "r"},   # radio -> Red (idx0)
        {"type": KD, "key": pygame.K_d, "unicode": "d"},   # toggle 'd' flip
        {"type": KD, "key": pygame.K_x, "unicode": "x"},   # no match
    ]
    scenarios.append({"name": "panel_radio_accel", "log": _run_panel(build7, s7)})

    return scenarios


def main():
    payload = {
        "module": "widgets",
        "helpers": dump_helpers(),
        "geom": dump_geom(),
        "hit": dump_hit(),
        "spinner": dump_spinner(),
        "selector": dump_selector(),
        "toggle": dump_toggle(),
        "slider": dump_slider(),
        "radio": dump_radio(),
        "panel": dump_panel(),
    }
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "widgets.json")
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=0)
    # rough assertion count for reporting
    n = 0
    n += len(payload["helpers"]) * 2
    n += sum(len(g.get("cells", [1])) + 1 for g in payload["geom"])
    for h in payload["hit"]:
        n += len(h.get("hits", [])) + len(h.get("cell_of", []))
    for s in payload["spinner"]:
        n += len(s["clamps"]) + len(s["adjust_seq"]) + len(s["clicks"]) * 2 + len(s["accel"])
    for s in payload["selector"]:
        n += len(s["cycle"]) + len(s["clicks"]) * 2 + len(s["accel"])
    for s in payload["toggle"]:
        n += len(s["seq"]) * 2
    for s in payload["slider"]:
        n += len(s["x2i"]) + len(s["cur"]) * 2 + len(s["set_index"]) + len(s["clicks"]) * 2 + len(s["accel"])
    for s in payload["radio"]:
        n += len(s["accel_hit"]) * 2 + len(s["clicks"]) * 2
    for sc in payload["panel"]:
        n += sum(2 + len(step["cells"]) + len(step["flags"]) for step in sc["log"])
    print(f"  wrote vectors/widgets.json  (~{n} assertions across "
          f"{len(payload)-1} sections)")
    return n


if __name__ == "__main__":
    main()

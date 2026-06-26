#!/usr/bin/env python3
"""Oracle vector dumper for the `screen` module (the Screen base class).

Drives scorch.screen.Screen headless (SDL_VIDEODRIVER=dummy) and records the
base-class contract the TS port must reproduce:
  - the class default `opaque` (True),
  - the return value of handle(event) over a battery of event-shaped inputs
    (the base ignores the event and returns None for every one),
  - the return value of update(dt) over a battery of dt values (None),
  - that draw(surf) returns None.

screen.py is a pure base/interface: no math, no state mutation, no pixels in the
base class (subclasses in screens.py/main.py/ingame.py do the drawing).  So the
vector battery is small and every recorded value is an exact (None/bool) datum,
asserted with strict equality by test/screen.test.ts.  This is a STATIC use of
the port -- it never runs the DOS binary.

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_screen.py
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


def dump_screen():
    from scorch.screen import Screen

    s = Screen()

    # `opaque` default (Python class attribute -> instance attribute via the
    # class; the driver reads getattr(screen, "opaque", True)).  Record both the
    # class attribute and an instance read so the TS field/inheritance mapping is
    # pinned to the exact recovered default.
    opaque_class = bool(Screen.opaque)
    opaque_instance = bool(s.opaque)

    # handle(event): the base ignores the event and returns None for everything.
    # Feed a battery of event-shaped dicts (the real driver passes pygame Event
    # objects, but the base never reads a field, so dicts exercise the same code
    # path).  Record the return for each.
    EVENTS = [
        {"type": 1025, "pos": [10, 20], "button": 1},   # MOUSEBUTTONDOWN left
        {"type": 1025, "pos": [0, 0], "button": 3},     # MOUSEBUTTONDOWN right
        {"type": 1026, "pos": [5, 5], "button": 1},     # MOUSEBUTTONUP
        {"type": 1024, "pos": [100, 200]},              # MOUSEMOTION
        {"type": 768, "key": 27, "mod": 0, "unicode": "\x1b"},   # KEYDOWN Esc
        {"type": 768, "key": 13, "mod": 0, "unicode": "\r"},     # KEYDOWN Enter
        {"type": 769, "key": 97, "mod": 0},             # KEYUP 'a'
        {"type": 256},                                  # QUIT
        {},                                             # empty (no fields read)
    ]
    handle = []
    for ev in EVENTS:
        r = s.handle(ev)
        handle.append({"event": ev, "out": r})  # r is None for the base

    # update(dt): None for the base over a battery of dt values.
    DTS = [0.0, 1.0 / 60.0, 1.0 / 30.0, 0.5, 1.0, 2.5, -0.1]
    update = []
    for dt in DTS:
        update.append({"dt": dt, "out": s.update(dt)})  # None

    # draw(surf): returns None.  Build a tiny real pygame Surface so the call is
    # exercised exactly as the driver would (the base draws nothing onto it).
    import pygame
    if not pygame.get_init():
        pygame.init()
    surf = pygame.Surface((8, 8))
    draw_out = s.draw(surf)  # None

    payload = {
        "module": "screen",
        "opaque_class": opaque_class,
        "opaque_instance": opaque_instance,
        "opaque_default": True,   # the getattr default the driver uses
        "handle": handle,
        "update": update,
        "draw_returns_none": draw_out is None,
    }

    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "screen.json")
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=0)
    n = len(handle) + len(update) + 4  # +opaque(2) +draw +default
    print(f"  wrote vectors/screen.json  ({n} base-contract assertions)")
    return n


def main():
    print(f"Oracle: dumping screen (port = {_SCORCH_PY})")
    total = dump_screen()
    print(f"Done. ~{total} golden assertions for screen.")


if __name__ == "__main__":
    main()

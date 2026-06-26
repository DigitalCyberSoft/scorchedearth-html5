#!/usr/bin/env python3
"""Oracle vector dumper for the scorch.screens STATE MACHINES (handle/update/
commit routing) -- the real-game paths the per-method screens.json dump did not
drive.  Writes vectors/screens_flow.json for test/screens_flow.test.ts.

This complements oracle/dump_screens.py (which dumps the pure value-logic).  Here
we drive the REAL Python Screen objects' event handlers headless (SDL dummy
measures the font-built widgets, exactly as dump_screens.py does) and snapshot the
observable outcome (action string + selection/scroll/cash/sell-slot state) after a
scripted event sequence, so the Node side can reproduce the SAME routing through
the Object.create(proto) seam.

It never runs the DOS binary.

Run (from scorch-html5):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorch.../scorch-py" \
        "/home/user/Scorch.../.venv/bin/python" oracle/dump_screens_flow.py
"""
import json
import os
import sys
import tempfile

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)

import pygame  # noqa: E402

pygame.init()
pygame.display.set_mode((1, 1))

from scorch import screens  # noqa: E402
from scorch import weapons  # noqa: E402
from scorch import economy as econ_mod  # noqa: E402
from scorch import config as cfgmod  # noqa: E402
from scorch import constants as C  # noqa: E402
from scorch import rng as rngmod  # noqa: E402

rngmod.Rng(12345)  # explicit seed for determinism (no RNG on any tested path)

W, H = 1024, 768


class MockTank:
    def __init__(self, player_index=0, name="P1", cash=0, inv=None,
                 selected_weapon=0, selected_guidance=None):
        self.player_index = player_index
        self.name = name
        self.cash = cash
        self.inventory = inv if inv is not None else [0] * weapons.NUM_ITEMS
        self.selected_weapon = selected_weapon
        self.selected_guidance = selected_guidance

    def has_ammo(self, slot):
        if slot == weapons.SLOT_BABY_MISSILE:
            return True
        return self.inventory[slot] > 0


class MockShopState:
    def __init__(self, cfg, economy, round_index=0):
        self.cfg = cfg
        self.economy = economy
        self.round_index = round_index


class FakePanel:
    """Stub the already-tested Panel.handle so we exercise ONLY the screen's
    action dispatch (the unit under test), feeding it a scripted action -- the
    same isolation the Node seam uses (symmetric)."""
    def __init__(self, act):
        self.act = act

    def handle(self, e):
        return self.act


def _make_econ(arms=4, price_overrides=None):
    cfg = cfgmod.Config()
    cfg.ARMS = arms
    e = econ_mod.Economy(cfg)
    e.refresh_availability()
    if price_overrides:
        for slot, p in price_overrides.items():
            e.price[slot] = p
    return cfg, e


def _new_shop(arms=4, cash=1_000_000, category=0, inv=None):
    cfg, e = _make_econ(arms=arms)
    t = MockTank(cash=cash, inv=inv if inv is not None else [0] * weapons.NUM_ITEMS)
    st = MockShopState(cfg, e)
    sc = screens.ShopScreen(st, t, W, H)
    sc.category = category
    sc._refresh_items()
    return sc, t, e


# ---------------------------------------------------------------------------
# Event scripting DSL -- portable across Python pygame / TS pygame.  Each spec is
# converted to the real pygame.event.Event here; the Node test rebuilds the same
# event from the same spec.  ROW clicks compute the pixel from the dumped geometry
# so both sides hit-test the identical Rect.
# ---------------------------------------------------------------------------
_KEYMAP = {
    "DOWN": pygame.K_DOWN, "UP": pygame.K_UP,
    "PGDN": pygame.K_PAGEDOWN, "PGUP": pygame.K_PAGEUP,
}


def _ev_for(spec, geom):
    t = spec["t"]
    if t == "key":
        return pygame.event.Event(pygame.KEYDOWN, key=_KEYMAP[spec["k"]],
                                  mod=0, unicode="")
    if t == "wheel":
        btn = 4 if spec["d"] < 0 else 5
        return pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=btn, pos=(0, 0))
    if t == "click":  # click screen-row r -> hits items[scroll + r]
        x = geom["list_x"] + 5
        y = geom["grid_top"] + spec["row"] * 18 + 2
        return pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=1, pos=(x, y))
    raise ValueError(t)


def dump_shop_handle():
    """ShopScreen.handle() EARLY-RETURN routing (mouse + keyboard; the panel is
    not reached on these events).  rows_visible forced small so paging scrolls."""
    sc, t, e = _new_shop(arms=4, cash=1_000_000, category=0)
    geom = {"grid_top": sc._grid_top, "list_x": sc._list_x,
            "list_right": sc._list_right}
    n_items = len(sc.items)
    items = list(sc.items)
    ROWS_VISIBLE = 5

    SCRIPT = [
        {"t": "key", "k": "DOWN"},
        {"t": "key", "k": "DOWN"},
        {"t": "key", "k": "DOWN"},
        {"t": "key", "k": "DOWN"},
        {"t": "key", "k": "DOWN"},   # crosses the viewport bottom -> scroll
        {"t": "key", "k": "DOWN"},
        {"t": "key", "k": "UP"},
        {"t": "key", "k": "PGDN"},   # page down
        {"t": "key", "k": "PGDN"},
        {"t": "key", "k": "PGUP"},   # page up
        {"t": "wheel", "d": 1},      # wheel down
        {"t": "wheel", "d": 1},
        {"t": "wheel", "d": -1},     # wheel up
        {"t": "click", "row": 0},    # select top visible -> items[scroll+0]
        {"t": "click", "row": 3},    # select items[scroll+3]
    ]
    sc.rows_visible = ROWS_VISIBLE
    sc.scroll = 0
    sc.sel_row = 0
    trace = []
    for spec in SCRIPT:
        ev = _ev_for(spec, geom)
        ret = sc.handle(ev)
        trace.append({"sel_row": sc.sel_row, "scroll": sc.scroll, "ret": ret})

    return {
        "geom": geom, "n_items": n_items, "items": items,
        "rows_visible": ROWS_VISIBLE, "script": SCRIPT, "trace": trace,
    }


def dump_shop_dispatch():
    """ShopScreen.handle() PANEL-action dispatch (buy / inventory / sell_req /
    __scroll__ / passthrough).  The panel is stubbed (FakePanel) on BOTH sides so
    only the screen's dispatch runs."""
    out = []

    # buy: a real buy that drops cash and recompacts the affordable list.
    sc, t, e = _new_shop(arms=4, cash=900, category=0)  # only cheap weapons
    sc.rows_visible = 35
    sc.sel_row = 0
    sc.scroll = 0
    slot = sc._selected_slot()
    cash_before = t.cash
    items_before = list(sc.items)
    sc.panel = FakePanel("buy")
    ret = sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))
    out.append({
        "case": "buy", "ret": ret, "slot": slot,
        "cash_before": cash_before, "cash_after": t.cash,
        "owned_after": t.inventory[slot], "items_before": items_before,
        "items_after": list(sc.items), "sel_row": sc.sel_row,
        "arms": 4, "start_cash": 900, "category": 0,
    })

    # inventory: returns 'shop_inventory'.
    sc, t, e = _new_shop()
    sc.panel = FakePanel("inventory")
    out.append({"case": "inventory",
                "ret": sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))})

    # sell_req with owned > 0 on the selected row -> sell_slot set, 'push:sell'.
    inv = [0] * weapons.NUM_ITEMS
    sc, t, e = _new_shop(arms=4, cash=1_000_000, category=0, inv=inv)
    sc.sel_row = 2
    sel = sc._selected_slot()
    t.inventory[sel] = 4
    sc.panel = FakePanel("sell_req")
    ret = sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))
    out.append({"case": "sell_req_owned", "ret": ret, "sel_row": 2,
                "sell_slot": sc.sell_slot, "owned": 4})

    # sell_req with owned == 0 -> no sell, ret None, sell_slot stays None.
    sc, t, e = _new_shop(arms=4, cash=1_000_000, category=0)
    sc.sel_row = 2
    sc.panel = FakePanel("sell_req")
    ret = sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))
    out.append({"case": "sell_req_unowned", "ret": ret, "sel_row": 2,
                "sell_slot": sc.sell_slot})

    # __scroll__ page: scroll moves by d * rows_visible.
    sc, t, e = _new_shop(arms=4, cash=1_000_000, category=0)
    sc.rows_visible = 5
    sc.scroll = 0
    sc.panel = FakePanel(("__scroll__", 1))
    sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))
    out.append({"case": "scroll_page_down", "scroll": sc.scroll,
                "rows_visible": 5, "n_items": len(sc.items)})

    # passthrough: an unknown action is returned verbatim.
    sc, t, e = _new_shop()
    sc.panel = FakePanel("pop")
    out.append({"case": "passthrough",
                "ret": sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))})

    return out


def dump_shop_guards():
    """ShopScreen guard branches not hit by the value-logic dump: _selected_slot
    None, _move_selection empty-list, _buy_selected with no selection / a failed
    affordability gate (no cash change), and update() with dt below one tick."""
    out = {}

    # empty items -> _selected_slot None, _move_selection no-op, _buy_selected no-op.
    sc, t, e = _new_shop(arms=4, cash=0, category=0)  # broke -> nothing affordable
    sc.sel_row = 0
    sc.scroll = 0
    out["empty_selected_slot"] = sc._selected_slot()   # None
    sc._move_selection(1)
    out["empty_move_sel_row"] = sc.sel_row             # unchanged 0
    cash_before = t.cash
    sc._buy_selected()                                 # slot None -> early return
    out["empty_buy_cash"] = t.cash                     # unchanged
    out["empty_n_items"] = len(sc.items)

    # buy with a selection the tank cannot afford (price set above cash): gate
    # fails, NO cash change, NO inventory change (the beep path).
    cfg, e2 = _make_econ(arms=4)
    e2.price[weapons.SLOT_BABY_MISSILE] = 5
    inv = [0] * weapons.NUM_ITEMS
    t2 = MockTank(cash=3, inv=inv)               # cash 3 < price 5
    st2 = MockShopState(cfg, e2)
    sc2 = screens.ShopScreen(st2, t2, W, H)
    sc2.category = 0
    sc2._refresh_items()
    # force the selection onto Baby Missile even though the filter dropped it.
    sc2.items = [weapons.SLOT_BABY_MISSILE]
    sc2.sel_row = 0
    cash_before2 = t2.cash
    sc2._buy_selected()
    out["unafford_cash_before"] = cash_before2
    out["unafford_cash_after"] = t2.cash         # unchanged 3
    out["unafford_owned_after"] = t2.inventory[weapons.SLOT_BABY_MISSILE]  # 0

    # update() with dt so small that int(accum) == 0 -> early return, counter stays.
    sc3, _, _ = _new_shop()
    sc3._cycle_counter = 0
    sc3._cycle_accum = 0.0
    tiny = 0.5 / C.PALETTE_CYCLE_HZ   # < one tick
    sc3.update(tiny)
    out["update_tiny_counter"] = sc3._cycle_counter   # 0 (no tick yet)
    out["update_tiny_dt"] = tiny

    return out


def dump_sell_accept():
    """SellScreen.handle() accept routing: dispatch 'accept' -> commit via
    economy.sell, return 'pop'; '~Reject' / other passes through."""
    out = []
    for (slot, price, qty, owned, fm) in [
        (0, 400, 5, 50, False), (1, 1875, 2, 10, False),
        (6, 10000, 3, 9, True),
    ]:
        cfg = cfgmod.Config()
        cfg.FREE_MARKET = "ON" if fm else "OFF"
        e = econ_mod.Economy(cfg)
        e.price[slot] = price
        t = MockTank(cash=100, inv=[0] * weapons.NUM_ITEMS)
        t.inventory[slot] = owned
        st = MockShopState(cfg, e)
        sc = screens.SellScreen(st, t, slot, W, H)
        sc.qty = qty
        sc.panel = FakePanel("accept")
        ret = sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))
        out.append({"slot": slot, "price": price, "qty": qty, "owned": owned,
                    "free_market": fm, "ret": ret, "committed": sc.committed,
                    "cash_after": t.cash, "owned_after": t.inventory[slot]})

    # passthrough (e.g. ~Reject -> 'pop' straight from the panel, no commit).
    cfg = cfgmod.Config()
    e = econ_mod.Economy(cfg)
    e.price[0] = 400
    t = MockTank(cash=100, inv=[0] * weapons.NUM_ITEMS)
    t.inventory[0] = 5
    st = MockShopState(cfg, e)
    sc = screens.SellScreen(st, t, 0, W, H)
    sc.qty = 3
    sc.panel = FakePanel("pop")
    ret = sc.handle(pygame.event.Event(pygame.KEYDOWN, key=0, unicode=""))
    out.append({"case": "reject", "ret": ret, "committed": sc.committed,
                "cash_after": t.cash, "owned_after": t.inventory[0]})
    return out


def dump_options_weapons():
    """OptionsScreen('weapons') weapon-list scroll: each wheel event moves
    self.scroll one row (clamped) and the 8-row toggle window maps to the next
    8 weapon slots.  Snapshot scroll + the visible slot window after each."""
    cfg = cfgmod.Config()
    sc = screens.OptionsScreen(cfg, W, H, "weapons")
    wl_h = sc._wl_h
    n_items = len(sc.weapon_items)

    def visible_slots():
        return [sc.weapon_items[sc.scroll + r]
                for r in range(wl_h) if sc.scroll + r < n_items]

    # wheel down (5) ten times then up (4) three times, recording the window.
    SCRIPT = ([{"d": 1}] * 50) + ([{"d": -1}] * 3) + [{"d": 1}] * 2
    trace = []
    for s in SCRIPT:
        btn = 4 if s["d"] < 0 else 5
        sc.handle(pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=btn, pos=(0, 0)))
        # the visible toggle labels must equal the items in the window
        labels = [w.label for w in sc._wl_toggles]
        trace.append({"d": s["d"], "scroll": sc.scroll,
                      "visible_slots": visible_slots(), "labels": labels})

    return {"wl_h": wl_h, "n_items": n_items, "script": SCRIPT, "trace": trace,
            "slot_names": [weapons.ITEMS[i].name for i in range(weapons.NUM_ITEMS)]}


def dump_calibrate_registration():
    """CalibrateScreen: any KEYDOWN -> 'pop'; a non-key event forwards the panel
    result; update() -> None.  RegistrationScreen.update() -> None."""
    cfg = cfgmod.Config()
    cal = screens.CalibrateScreen(cfg, W, H)
    key_ret = cal.handle(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_a,
                                            unicode="a"))
    upd_ret = cal.update(0.016)

    # non-key forward: click OUTSIDE the panel -> panel cancel_action 'pop'.
    far = (cal.panel.rect.right + 50, cal.panel.rect.bottom + 50)
    nonkey_ret = cal.handle(pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=1,
                                               pos=far))

    reg = screens.RegistrationScreen(cfg, W, H)
    reg_upd = reg.update(0.016)

    return {"key_ret": key_ret, "update_ret": upd_ret,
            "nonkey_ret": nonkey_ret, "reg_update_ret": reg_upd}


def dump_saves_extra():
    """_list_saves over leading-dot / multi-dot .sav names (hits the splitext
    dotfile branch) + a few more .sav-filter cases; differential vs os.path.
    splitext.  Driven through the REAL _list_saves (temp dir)."""
    LISTINGS = [
        [".sav", "real.sav"],
        ["..two.sav", ".hidden.sav", "plain.sav"],
        ["a.b.c.sav", "x.sav"],
        ["dot..sav", "z.sav"],
    ]
    cases = []
    for listing in LISTINGS:
        with tempfile.TemporaryDirectory() as d:
            for fn in listing:
                open(os.path.join(d, fn), "w").close()
            out = screens._list_saves(d)
        cases.append({"listing": list(listing), "out": list(out)})
    return cases


def dump_save_strings():
    """Verbatim Save/Restore class strings + primary labels/actions -- the TS
    port must reproduce these byte-for-byte (they drive the status line)."""
    return {
        "filelist_primary_label": screens._FileListScreen.PRIMARY_LABEL,
        "filelist_primary_action": screens._FileListScreen.PRIMARY_ACTION,
        "save_primary_label": screens.SaveScreen.PRIMARY_LABEL,
        "save_primary_action": screens.SaveScreen.PRIMARY_ACTION,
        "save_err_create": screens.SaveScreen.ERR_CREATE,
        "save_confirm_tmpl": screens.SaveScreen.CONFIRM_TMPL,
        "restore_primary_label": screens.RestoreScreen.PRIMARY_LABEL,
        "restore_primary_action": screens.RestoreScreen.PRIMARY_ACTION,
        "restore_err_missing": screens.RestoreScreen.ERR_MISSING,
        "save_ext": screens.SAVE_EXT,
    }


def _write(payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "screens_flow.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    return path


def main():
    payload = {
        "module": "screens_flow",
        "shop_handle": dump_shop_handle(),
        "shop_dispatch": dump_shop_dispatch(),
        "shop_guards": dump_shop_guards(),
        "sell_accept": dump_sell_accept(),
        "options_weapons": dump_options_weapons(),
        "calibrate_registration": dump_calibrate_registration(),
        "saves_extra": dump_saves_extra(),
        "save_strings": dump_save_strings(),
        "palette_cycle_hz": C.PALETTE_CYCLE_HZ,
    }
    path = _write(payload)
    print(f"  wrote {os.path.relpath(path, _HERE)}")


if __name__ == "__main__":
    main()

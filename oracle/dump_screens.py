#!/usr/bin/env python3
"""Oracle vector dumper for scorch.screens -- drives the REAL Python screens
module headless and writes golden vectors to vectors/screens.json for the TS
differential gate (test/screens.test.ts).

STATIC use of the port: imports and calls screens.py's module data + value-logic
over a real config.Config / economy.Economy and lightweight mock Tank / State
objects.  It never runs the DOS binary.

WHAT IS NUMERICALLY DUMPED (the DOM-free, mouse-free logic the Node test
reproduces byte-for-byte):
  * module data tables   -- ENUM_LABELS, SUBMENUS shape, AI_TYPE_LABELS,
                            TANK_ICONS, NUM_*/TANK_ICON_CPU_ONLY, REGISTRATION_LINES,
                            SHOP_ICON_RGB6/BASE/COUNT/CYCLE_COUNT.
  * tank_icon_mobile     -- per-index mobility flag.
  * _build_shop_lut      -- the 21-entry icon band (low slots 0..0x14 + DAC 0xAA..)
                            RGB values after 6->8-bit expansion.
  * _save_path/_list_saves -- filename normalisation (basename/ext/traversal),
                            splitext + sort over a synthetic listing.
  * TankInit             -- _build_shades ramp, _set_icon/_set_player_type/
                            _set_sim_key/_team_for value logic, update() palette
                            cycle phase walk.
  * Shop FLOW            -- _refresh_items (category + arms + affordability filter),
                            _affordable, _buy_selected (cash/inventory mutation +
                            list compaction), _move_selection/_scroll_by/_max_scroll,
                            _category_click, update() palette-cycle counter walk.
  * SellScreen._offer    -- 0.80/0.65 sellback pricing (Python round).
  * Inventory            -- _GUIDANCE_SLOTS, _count_str, _weapon_array_index,
                            _owned_offensive set + guidance owned filter.
  * option cycling       -- Selector get_idx/set_idx round-trip over ENUM_LABELS
                            (the _enum_selector binding) via the real Config.

The Screen CONSTRUCTORS build font-measured widgets.Panel (DOM under pygame), so
the full Panel.handle routing + drawn pixels defer to the Phase-3 visual gate; the
Node test reaches the value-logic method bodies through the Object.create(proto)
seam (the same seam ingame._BatteryDischargeScreen / ui established).  The Python
side here CAN construct the real Screen objects (SDL_VIDEODRIVER=dummy measures
fonts), so it drives the real method bodies and snapshots their state.

Run (from scorch-html5):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorch.../scorch-py" \
        "/home/user/Scorch.../.venv/bin/python" oracle/dump_screens.py
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

# Full init + a dummy display so font measurement (the Screen constructors build
# font-measured Label/Button widgets) works under SDL_VIDEODRIVER=dummy.
pygame.init()
pygame.display.set_mode((1, 1))

from scorch import screens  # noqa: E402
from scorch import weapons  # noqa: E402
from scorch import economy as econ_mod  # noqa: E402
from scorch import config as cfgmod  # noqa: E402
from scorch import rng as rngmod  # noqa: E402
from scorch import constants as C  # noqa: E402

# Seed the RNG explicitly for determinism even though screens has no RNG on any
# tested path (the brief requires an explicit seed; this pins reproducibility).
rngmod.Rng(12345)

W, H = 1024, 768


def _round_py(x):
    """CPython round() (banker's) -- mirror so the recorded offer matches."""
    return round(x)


# ---------------------------------------------------------------------------
# Mocks -- structurally identical to test/screens.test.ts (same fields/methods).
# ---------------------------------------------------------------------------
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


def _make_econ(arms=4, price_overrides=None, available_overrides=None):
    cfg = cfgmod.Config()
    cfg.ARMS = arms
    e = econ_mod.Economy(cfg)
    e.refresh_availability()
    if price_overrides:
        for slot, p in price_overrides.items():
            e.price[slot] = p
    if available_overrides:
        for slot, a in available_overrides.items():
            e.available[slot] = a
    return cfg, e


# ===========================================================================
# 1. module data tables (verbatim; the TS exports must match index-for-index)
# ===========================================================================
def dump_data():
    enum_labels = {k: [list(toks), list(disp)]
                   for k, (toks, disp) in screens.ENUM_LABELS.items()}
    # SUBMENUS: record the (title, [row kinds + string/number fields]) shape.  fmt
    # callables and the None placeholders are not portable, so only the structural
    # fields (kind + the cfg key / label / numeric range) are recorded.
    submenus = {}
    for spec, (title, fields) in screens.SUBMENUS.items():
        rows = []
        for row in fields:
            kind = row[0]
            rec = {"kind": kind}
            # row[1] cfg-key/action (str or None); row[2] label (str or None)
            rec["a"] = row[1] if isinstance(row[1], str) else None
            rec["b"] = row[2] if isinstance(row[2], str) else None
            # numeric range for int/float rows
            nums = [v for v in row[3:] if isinstance(v, (int, float))
                    and not isinstance(v, bool)]
            rec["nums"] = nums
            rows.append(rec)
        submenus[spec] = {"title": title, "rows": rows}

    return {
        "enum_labels": enum_labels,
        "submenu_keys": list(screens.SUBMENUS.keys()),
        "submenus": submenus,
        "ai_type_labels": list(screens.AI_TYPE_LABELS),
        "tank_icons": [[bool(a), bool(b)] for (a, b) in screens.TANK_ICONS],
        "num_tank_icons": screens.NUM_TANK_ICONS,
        "tank_icon_cpu_only": screens.TANK_ICON_CPU_ONLY,
        "num_appearance_icons": screens.NUM_APPEARANCE_ICONS,
        "tank_icon_mobile": [bool(screens.tank_icon_mobile(i)) for i in range(-1, 9)],
        "registration_lines": list(screens.REGISTRATION_LINES),
        "shop_icon_base": screens.SHOP_ICON_BASE,
        "shop_icon_count": screens.SHOP_ICON_COUNT,
        "shop_cycle_count": screens.SHOP_CYCLE_COUNT,
        "shop_icon_rgb6": [list(c) for c in screens.SHOP_ICON_RGB6],
    }


# ===========================================================================
# 2. _build_shop_lut -- the installed icon band (post 6->8-bit expansion)
# ===========================================================================
def dump_shop_lut():
    lut = screens._build_shop_lut()
    table = lut.table
    # record the low staging slots 0..0x14 and the DAC band 0xAA.. they mirror to.
    low = [[int(table[i][0]), int(table[i][1]), int(table[i][2])]
           for i in range(screens.SHOP_ICON_COUNT)]
    band = [[int(table[screens.SHOP_ICON_BASE + i][0]),
             int(table[screens.SHOP_ICON_BASE + i][1]),
             int(table[screens.SHOP_ICON_BASE + i][2])]
            for i in range(screens.SHOP_ICON_COUNT)]
    return {"low": low, "band": band}


# ===========================================================================
# 3. _save_path / _list_saves -- filename normalisation + listing
# ===========================================================================
def dump_saves():
    SAVE_NAMES = [
        "game1", "Game1", "game1.sav", "  spaced  ", "", "   ",
        "weird name", "with.dots.sav", "..hidden", ".sav",
        "../escape", "../../etc/passwd", "sub/dir/file", "back\\slash\\name",
        "UPPER.SAV", "trail.SaV", "noext", "two.parts", "dot.", "a.b.c",
    ]
    save_path = []
    for n in SAVE_NAMES:
        # Python _save_path returns a full join path; record only the BASENAME so
        # the TS port (which returns the normalised basename) can be compared.
        p = screens._save_path(n)
        base = os.path.basename(p) if p is not None else None
        save_path.append({"name": n, "base": base})

    # _list_saves over a synthetic directory listing (mixed case ext + non-.sav).
    # NOTE: every listing here is a PHYSICALLY POSSIBLE os.listdir result -- all
    # names within a listing are distinct (a real directory cannot hold two files
    # of the same name; a duplicate would silently collapse to one when written to
    # the temp dir, so it is not a meaningful input).  The case-ordering /
    # .sav-filter / splitext behaviour is exercised by the distinct names below.
    LISTINGS = [
        ["b.sav", "a.sav", "c.sav"],
        ["x.SAV", "y.sav", "notes.txt", "z.Sav"],
        ["only.txt", "readme"],
        [],
        ["Alpha.sav", "alpha.sav", "beta.sav", "BETA.txt"],
        ["weird.name.sav", "plain.sav"],
    ]
    list_saves = []
    for listing in LISTINGS:
        # Drive the REAL _list_saves by pointing it at a temp dir we populate, so
        # the os.listdir/splitext/sort path is the genuine one.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            for fn in listing:
                open(os.path.join(d, fn), "w").close()
            out = screens._list_saves(d)
        list_saves.append({"listing": list(listing), "out": list(out)})

    return {"save_path": save_path, "list_saves": list_saves}


# ===========================================================================
# 4. TankInitScreen -- shade ramp + selector/sim-key/team value logic + cycle
# ===========================================================================
def dump_tank_init():
    # _build_shades (static, pure) over several player colors + ramp sizes.
    shade_cases = []
    COLORS = [(255, 0, 0), (0, 128, 64), (200, 200, 50), (10, 20, 30), (255, 255, 255)]
    for col in COLORS:
        for n in (1, 2, 40):
            out = screens.TankInitScreen._build_shades(col, n)
            shade_cases.append({"color": list(col), "n": n,
                                "out": [list(c) for c in out]})

    # _set_icon clamp over the full input range incl. out-of-range + fractional.
    set_icon = []
    for raw in [-5, -1, 0, 1, 3, 6, 7, 10, 2.9, 6.9, 100]:
        sc = _new_tank_init(player_index=0)
        sc._set_icon(raw)
        set_icon.append({"in": raw, "icon_index": sc.icon_index})

    # _set_player_type (0=Person, 1=Computer) incl. fractional.
    set_type = []
    for raw in [0, 1, 2, 0.0, 1.0, 1.9]:
        sc = _new_tank_init(player_index=0)
        sc._set_player_type(raw)
        set_type.append({"in": raw, "is_computer": bool(sc.is_computer)})

    # _set_sim_key uniqueness rejection (manual L264-266 dup -> beep/reject).
    sim_key = []
    sc = _new_tank_init(player_index=0)
    SEQ = [(0, "a"), (1, "b"), (2, "a"), (2, "c"), (1, "c"), (3, "d"), (0, "")]
    for (i, v) in SEQ:
        sc._set_sim_key(i, v)
        sim_key.append({"i": i, "v": v, "keys": list(sc.sim_keys)})

    # _team_for: 0 when TEAM_NONE else player_index.
    team_for = []
    for tm, pidx in [("NONE", 0), ("NONE", 3), ("STANDARD", 0), ("STANDARD", 2),
                     ("CORPORATE", 4), ("VICIOUS", 1)]:
        cfg = cfgmod.Config()
        cfg.TEAM_MODE = tm
        sc = _new_tank_init(player_index=pidx, cfg=cfg)
        team_for.append({"team_mode": tm, "player_index": pidx,
                         "team": sc._team_for()})

    # handle()-equivalent result tuple after ~Done (name/ai/team/icon), via the
    # state the result is composed from (no event routing needed: replicate the
    # _team_for + ai_class composition directly off the real fields).
    result_cases = []
    for (is_cpu, ai_idx, nm, icon, tm, pidx) in [
        (False, 3, "Alice", 2, "NONE", 0),
        (True, 0, "  ", 6, "NONE", 1),       # blank name -> "Player N"
        (True, 6, "Hal", 5, "STANDARD", 2),
        (False, 3, "Bob", 0, "VICIOUS", 3),
    ]:
        cfg = cfgmod.Config()
        cfg.TEAM_MODE = tm
        sc = _new_tank_init(player_index=pidx, cfg=cfg)
        sc.is_computer = is_cpu
        sc.ai_index = ai_idx
        sc.name = nm
        sc.icon_index = icon
        ai_class = (sc.ai_index + 1) if sc.is_computer else C.AI_HUMAN
        name_out = sc.name.strip() or f"Player {sc.player_index + 1}"
        result_cases.append({
            "is_computer": is_cpu, "ai_index": ai_idx, "name": nm,
            "icon_index": icon, "team_mode": tm, "player_index": pidx,
            "ai_class": ai_class, "name_out": name_out, "team": sc._team_for(),
        })

    # update() palette-cycle phase walk (continuous; epsilon float).
    cycle = []
    sc = _new_tank_init(player_index=0)
    DT = 1.0 / 60.0
    for step in range(120):
        sc.update(DT)
        cycle.append(sc._cycle_phase)

    return {
        "shades": shade_cases,
        "set_icon": set_icon,
        "set_type": set_type,
        "sim_key": sim_key,
        "team_for": team_for,
        "result": result_cases,
        "ramp": screens.TankInitScreen._build_shades((255, 0, 0), 40) and 40,
        "cycle_rate": 55.0,
        "cycle": cycle,
        "cycle_dt": DT,
    }


def _new_tank_init(player_index=0, cfg=None):
    cfg = cfg if cfg is not None else cfgmod.Config()
    return screens.TankInitScreen(cfg, W, H, player_index)


# ===========================================================================
# 5. ShopScreen FLOW (the screen-level use of economy)
# ===========================================================================
def dump_shop():
    out = {}

    # _refresh_items: category (Weapons vs Misc) + ARMS + affordability filter.
    refresh = []
    REFRESH_CASES = [
        # (arms, cash, category, inv_overrides)
        (4, 1_000_000, 0, {}),      # all weapons affordable
        (4, 1_000_000, 1, {}),      # all misc affordable
        (0, 1_000_000, 0, {}),      # arms-0 weapons only
        (2, 1_000_000, 0, {}),
        (4, 5000, 0, {}),           # cash-limited: only cheap weapons
        (4, 0, 0, {}),              # broke: nothing (price>0)
        (4, 12000, 1, {}),          # misc affordability boundary
        (4, 1_000_000, 0, {}),
    ]
    for (arms, cash, cat, inv_ov) in REFRESH_CASES:
        cfg, e = _make_econ(arms=arms)
        inv = [0] * weapons.NUM_ITEMS
        for s, n in inv_ov.items():
            inv[s] = n
        t = MockTank(cash=cash, inv=inv)
        st = MockShopState(cfg, e)
        sc = screens.ShopScreen(st, t, W, H)
        sc.category = cat
        sc._refresh_items()
        refresh.append({"arms": arms, "cash": cash, "category": cat,
                        "items": list(sc.items), "rows_visible": sc.rows_visible})

    # _affordable per-slot (price/cash/cap gate) -- exact economy.buy mirror.
    affordable = []
    cfg, e = _make_econ(arms=4)
    AFF_CASES = [
        (0, 1000, 0),     # Baby Missile $400, cash $1000, owned 0 -> True
        (0, 100, 0),      # cash < price -> False
        (0, 1000, 99),    # at cap -> False
        (3, 100000, 0),   # Nuke $12000 -> True
        (3, 100000, 99),  # cap -> False
        (2, 100000, 50),  # Baby Nuke -> True (below cap)
    ]
    for (slot, cash, owned) in AFF_CASES:
        inv = [0] * weapons.NUM_ITEMS
        inv[slot] = owned
        t = MockTank(cash=cash, inv=inv)
        st = MockShopState(cfg, e)
        sc = screens.ShopScreen(st, t, W, H)
        affordable.append({"slot": slot, "cash": cash, "owned": owned,
                           "out": bool(sc._affordable(slot))})

    # _buy_selected: full buy flow -- cash debit, inventory add, list compaction,
    # cursor follow.  Walk a sequence of buys on the selected row.
    buy_flow = []
    cfg, e = _make_econ(arms=4)
    t = MockTank(cash=3000, inv=[0] * weapons.NUM_ITEMS)
    st = MockShopState(cfg, e)
    sc = screens.ShopScreen(st, t, W, H)
    sc.category = 0
    sc._refresh_items()
    # buy the first (cheapest) weapon a few times, snapshotting after each.
    for step in range(6):
        slot = sc._selected_slot()
        before_cash = t.cash
        sc.sel_row = 0
        sc._buy_selected()
        buy_flow.append({
            "step": step, "slot_before": slot, "cash": t.cash,
            "cash_delta": before_cash - t.cash,
            "items": list(sc.items), "sel_row": sc.sel_row, "scroll": sc.scroll,
            "baby_missile_owned": t.inventory[weapons.SLOT_BABY_MISSILE],
        })

    # _move_selection + _scroll_by + _max_scroll over a forced long list.
    nav = []
    cfg, e = _make_econ(arms=4)
    t = MockTank(cash=1_000_000, inv=[0] * weapons.NUM_ITEMS)
    st = MockShopState(cfg, e)
    sc = screens.ShopScreen(st, t, W, H)
    sc.category = 0
    sc._refresh_items()
    # force a small viewport so scrolling is exercised even on a tall window
    sc.rows_visible = 5
    sc.scroll = 0
    sc.sel_row = 0
    MOVES = [1, 1, 1, 1, 1, 1, 1, -1, -3, 1, 100, -100, 2]
    for d in MOVES:
        sc._move_selection(d)
        nav.append({"move": d, "sel_row": sc.sel_row, "scroll": sc.scroll,
                    "max_scroll": sc._max_scroll()})
    # _scroll_by directly
    scroll_by = []
    sc.scroll = 0
    for d in [1, 1, 5, 100, -3, -100, 2]:
        sc._scroll_by(d)
        scroll_by.append({"d": d, "scroll": sc.scroll})

    # _category_click: toggle + cursor/scroll reset + relist.
    cat_click = []
    cfg, e = _make_econ(arms=4)
    t = MockTank(cash=1_000_000, inv=[0] * weapons.NUM_ITEMS)
    st = MockShopState(cfg, e)
    sc = screens.ShopScreen(st, t, W, H)
    sc.sel_row = 3
    sc.scroll = 2
    for click in [1, 1, 0, 0, 1]:
        sc._category_click(click)
        cat_click.append({"click": click, "category": sc.category,
                          "sel_row": sc.sel_row, "scroll": sc.scroll,
                          "n_items": len(sc.items)})

    # update() palette-cycle COUNTER walk (the integer counter; deterministic).
    cycle = []
    cfg, e = _make_econ(arms=4)
    t = MockTank(cash=1000, inv=[0] * weapons.NUM_ITEMS)
    st = MockShopState(cfg, e)
    sc = screens.ShopScreen(st, t, W, H)
    DT = 1.0 / 60.0
    for step in range(150):
        sc.update(DT)
        cycle.append({"counter": sc._cycle_counter})

    return {
        "refresh": refresh,
        "affordable": affordable,
        "buy_flow": buy_flow,
        "nav": nav,
        "scroll_by": scroll_by,
        "cat_click": cat_click,
        "cycle": cycle,
        "cycle_dt": DT,
        "palette_cycle_hz": C.PALETTE_CYCLE_HZ,
    }


# ===========================================================================
# 6. SellScreen._offer (0.80 / 0.65 sellback; Python round)
# ===========================================================================
def dump_sell():
    offers = []
    OFFER_CASES = [
        # (slot, price, qty, free_market)
        (0, 400, 1, False), (0, 400, 5, False), (0, 400, 10, False),
        (1, 1875, 3, False), (3, 12000, 1, False),
        (0, 400, 1, True), (1, 1875, 3, True), (3, 12000, 1, True),
        (6, 10000, 2, False), (6, 10000, 2, True),  # MIRV bundle 3
        (47, 1000, 25, False),  # Contact Trigger bundle 25
    ]
    for (slot, price, qty, fm) in OFFER_CASES:
        cfg = cfgmod.Config()
        cfg.FREE_MARKET = "ON" if fm else "OFF"
        e = econ_mod.Economy(cfg)
        e.price[slot] = price
        t = MockTank(cash=0, inv=[0] * weapons.NUM_ITEMS)
        t.inventory[slot] = 99
        st = MockShopState(cfg, e)
        sc = screens.SellScreen(st, t, slot, W, H)
        offers.append({"slot": slot, "price": price, "qty": qty,
                       "free_market": fm, "offer": sc._offer(qty),
                       "bundle": weapons.ITEMS[slot].bundle})

    # accept commits via economy.sell -> committed + tank cash/inventory mutate.
    accept = []
    for (slot, price, qty, owned, fm) in [
        (0, 400, 5, 50, False), (1, 1875, 2, 10, False),
        (0, 400, 5, 50, True), (6, 10000, 3, 9, False),
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
        committed = sc.econ.sell(sc.tank, sc.slot, sc.qty)
        accept.append({"slot": slot, "price": price, "qty": qty, "owned": owned,
                       "free_market": fm, "committed": committed,
                       "cash_after": t.cash, "owned_after": t.inventory[slot]})

    return {"offers": offers, "accept": accept}


# ===========================================================================
# 7. InventoryScreen logic (slot sets + count strings + array index)
# ===========================================================================
def dump_inventory():
    guidance_slots = list(screens.InventoryScreen._GUIDANCE_SLOTS)

    # _owned_offensive + guidance owned filter + _weapon_array_index + _count_str.
    cases = []
    INV_CASES = [
        # inv overrides, selected_weapon
        ({}, 0),                               # only Baby Missile (always owned)
        ({1: 5, 3: 2}, 1),                     # Missile + Nuke owned, sel Missile
        ({1: 5, 3: 2, 33: 4, 35: 1}, 3),       # + guidance owned, sel Nuke
        ({2: 3}, 99),                          # sel not in owned set -> idx -1
        ({1: 1, 6: 2, 7: 1, 8: 5}, 8),         # several offensive
    ]
    for (inv_ov, sel) in INV_CASES:
        inv = [0] * weapons.NUM_ITEMS
        for s, n in inv_ov.items():
            inv[s] = n
        t = MockTank(cash=0, inv=inv, selected_weapon=sel)
        sc = screens.InventoryScreen(None, t, W, H)
        cnt = {str(s): sc._count_str(s) for s in sc.weapon_slots}
        cases.append({
            "inv_ov": {str(k): v for k, v in inv_ov.items()},
            "selected_weapon": sel,
            "weapon_slots": list(sc.weapon_slots),
            "array_slots": list(sc._array_slots),
            "guidance_slots": list(sc.guidance_slots),
            "array_index": sc._weapon_array_index(),
            "count_str": cnt,
        })

    return {"guidance_slots": guidance_slots, "cases": cases}


# ===========================================================================
# 8. option cycling -- the _enum_selector Selector binding round-trip
# ===========================================================================
def dump_option_cycle():
    # For each ENUM key, build the Selector (via OptionsScreen's _enum_selector
    # path) bound to a real Config, then walk left/right cycles and record the
    # (index, cfg token, displayed label) at each step -- the menu value cycling.
    out = []
    KEYS = ["SCORING", "TEAM_MODE", "PLAY_MODE", "PLAY_ORDER", "ELASTIC",
            "EXPLOSION_SCALE", "SKY", "GRAPHICS_MODE", "FLY_SOUND",
            "TALKING_TANKS", "BOMB_ICON"]
    for key in KEYS:
        cfg = cfgmod.Config()
        tokens, display = screens.ENUM_LABELS[key]
        panel = screens.W.Panel(0, 0, 400, 400, "")
        sel = screens._enum_selector(panel, 0, 0, cfg, key, "L")
        steps = []
        # start index, then +1 x (len+1) to wrap, then -1 x 2
        seq = [0] + [1] * (len(tokens) + 1) + [-1, -1]
        idx = sel.get_idx()
        steps.append({"idx": idx, "token": str(getattr(cfg, key)),
                      "label": display[idx % len(display)]})
        for d in seq[1:]:
            sel.cycle(d)
            idx = sel.get_idx()
            steps.append({"idx": idx, "token": str(getattr(cfg, key)),
                          "label": display[idx % len(display)]})
        out.append({"key": key, "tokens": list(tokens), "display": list(display),
                    "steps": steps})
    return out


# ---------------------------------------------------------------------------
def _write(payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "screens.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    return path


def main():
    payload = {
        "module": "screens",
        "data": dump_data(),
        "shop_lut": dump_shop_lut(),
        "saves": dump_saves(),
        "tank_init": dump_tank_init(),
        "shop": dump_shop(),
        "sell": dump_sell(),
        "inventory": dump_inventory(),
        "option_cycle": dump_option_cycle(),
    }
    path = _write(payload)
    print(f"  wrote {os.path.relpath(path, _HERE)}")


if __name__ == "__main__":
    main()

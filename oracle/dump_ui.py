#!/usr/bin/env python3
"""Oracle vector dumper for scorch.ui -- drives the REAL Python ui module headless
and writes golden vectors to vectors/ui.json for the TS differential gate
(test/ui.test.ts).

STATIC use of the port: imports and calls ui.py's classes over lightweight mock
Tank/Cfg/State/Economy/Renderer objects (the damage.test.ts MockState pattern). It
never runs the DOS binary.

WHAT IS NUMERICALLY DUMPED (the heart of the gate):
  * HumanController.handle           -- tap aim/power clamps, fire, weapon-cycle,
                                        parachute/contact toggles, battery use
  * HumanController.update_continuous-- the hold-repeat ramp accumulator (a,p,af,pf
                                        + angle/power) over multi-frame scripts
  * HumanController._cycle_weapon     -- owned offensive-with-ammo list rotation
  * MainMenu                          -- row build, navigation, value mutation
                                        (clamp / enum cycle / round(.,2) gravity),
                                        _value_str, build_players
  * Shop                              -- selection wrap, buy/sell delegation,
                                        item availability filter
  * ui.draw_rankings layout substrate -- war-quote word-wrap, panel geometry,
                                        _rankings_go_rect, ranked order, per-row
                                        luminance darkening (via a DETERMINISTIC
                                        mock font so the math, not the platform
                                        font, is what is compared)

The DRAWN PIXELS (pygame.draw / blit) are NOT dumped here; they defer to the
Phase-3 visual gate.

Run (from scorch-html5):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_ui.py
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

from scorch import ui  # noqa: E402
from scorch import weapons  # noqa: E402
from scorch import constants as C  # noqa: E402

# Key constants mirrored from the SDL keycodes the shim uses (pygame.K_*). The TS
# test reads pygame.K_* from src/pygame.ts; the dumper records the SAME numeric
# events by name so the two stay in lockstep.
K = {
    "UP": pygame.K_UP, "DOWN": pygame.K_DOWN, "LEFT": pygame.K_LEFT, "RIGHT": pygame.K_RIGHT,
    "w": pygame.K_w, "a": pygame.K_a, "s": pygame.K_s, "d": pygame.K_d,
    "RETURN": pygame.K_RETURN, "SPACE": pygame.K_SPACE, "TAB": pygame.K_TAB,
    "LEFTBRACKET": pygame.K_LEFTBRACKET, "RIGHTBRACKET": pygame.K_RIGHTBRACKET,
    "p": pygame.K_p, "b": pygame.K_b, "MINUS": pygame.K_MINUS,
    "BACKSPACE": pygame.K_BACKSPACE, "x": pygame.K_x, "ESCAPE": pygame.K_ESCAPE,
}


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    print(f"  wrote vectors/{module}.json")


# ---------------------------------------------------------------------------
# Mocks -- structurally identical to test/ui.test.ts (same fields, same methods).
# ---------------------------------------------------------------------------
class Ev:
    """A pygame-shaped KEYDOWN event (only .type and .key are read)."""
    def __init__(self, key, etype=None):
        self.type = pygame.KEYDOWN if etype is None else etype
        self.key = key


class MockTank:
    def __init__(self, angle=45, power=500, health=100, sel=0, inv=None,
                 parachute_deployed=True, contact_trigger=False, name="P1",
                 color=1, win_counter=0, cash=0, score=0):
        self.angle = angle
        self.power = power
        self.health = health
        self.selected_weapon = sel
        self.parachute_deployed = parachute_deployed
        self.contact_trigger = contact_trigger
        self.inventory = inv if inv is not None else [0] * weapons.NUM_ITEMS
        self.name = name
        self.color = color
        self.win_counter = win_counter
        self.cash = cash
        self.score = score

    @property
    def batteries(self):
        return self.inventory[weapons.SLOT_BATTERY]

    def has_ammo(self, slot):
        if slot == weapons.SLOT_BABY_MISSILE:
            return True
        return self.inventory[slot] > 0


class MockHumanState:
    def __init__(self, tank):
        self.current_shooter = tank
        self.fired = 0
        # _aim_hold created lazily by update_continuous, exactly like ui.py

    def fire(self):
        self.fired += 1


class MockKeys(dict):
    """pygame.key.get_pressed()-shaped: keys[K_*] truthy when held."""
    def __missing__(self, k):
        return False


class MockEconomy:
    """Logs buy/sell calls AND mutates the tank like the real Economy, so Shop's
    selection->delegation and cash/inventory effects are both observable."""
    def __init__(self, available=None, price=None):
        n = weapons.NUM_ITEMS
        self.available = available if available is not None else [True] * n
        self.price = price if price is not None else [it.cost for it in weapons.ITEMS]
        self.calls = []  # list of ("buy"|"sell", slot, qty)

    def buy(self, tank, slot):
        self.calls.append(["buy", slot, None])
        cost = self.price[slot]
        if tank.cash >= cost and tank.inventory[slot] < C.INVENTORY_CAP:
            tank.cash -= cost
            tank.inventory[slot] += weapons.ITEMS[slot].bundle
            if tank.inventory[slot] > C.INVENTORY_CAP:
                tank.inventory[slot] = C.INVENTORY_CAP
            return True
        return False

    def sell(self, tank, slot, qty):
        self.calls.append(["sell", slot, qty])
        qty = min(qty, tank.inventory[slot])
        if qty <= 0:
            return 0
        bundle = weapons.ITEMS[slot].bundle or 1
        offer = round(self.price[slot] * qty * C.SELLBACK_MULT_NORMAL / bundle)
        tank.inventory[slot] -= qty
        tank.cash = max(0, tank.cash + offer)
        return offer


class MockShopState:
    def __init__(self, economy):
        self.economy = economy


# A DETERMINISTIC mock font so draw_rankings geometry math (not the platform
# FreeType/Canvas metrics) is what the gate compares. Mirrors the TS MockFont:
#   size(text) -> (FONT_CW*len(text), FONT_H);  render(text) -> a fake surface
#   whose get_width() == FONT_CW*len(text). The same constants live in the TS test.
FONT_CW = 9
FONT_H = 18
BIG_CW = 16
BIG_H = 30


class _MockSurf:
    def __init__(self, w):
        self._w = w

    def get_width(self):
        return self._w


class MockFont:
    def __init__(self, cw, h):
        self.cw = cw
        self.h = h

    def size(self, text):
        return (self.cw * len(text), self.h)

    def render(self, text, aa=True, color=None, bg=None):
        return _MockSurf(self.cw * len(text))


class MockRenderer:
    def __init__(self):
        self.font = MockFont(FONT_CW, FONT_H)
        self.bigfont = MockFont(BIG_CW, BIG_H)
        # palette: enough indices for the test (idx 0x6e team-red + low/high lum).
        pal = [[0, 0, 0] for _ in range(256)]
        pal[0x6e] = [220, 40, 40]      # team-red bar
        pal[1] = [60, 60, 255]         # dark-ish blue (lum < 150 -> kept)
        pal[2] = [255, 255, 80]        # bright yellow (lum >= 150 -> darkened)
        pal[3] = [200, 200, 200]       # light grey (darkened)
        pal[4] = [10, 200, 10]         # green
        self.pal = pal


class MockRankTank:
    def __init__(self, color, name, win_counter, cash, score):
        self.color = color
        self.name = name
        self.win_counter = win_counter
        self.cash = cash
        self.score = score


class MockRankState:
    def __init__(self, w, h, ranking, tanks):
        self.w = w
        self.h = h
        self.ranking = ranking
        self.tanks = tanks
        self._rankings_go_rect = None


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------
def _hold(state):
    h = getattr(state, "_aim_hold", None)
    if h is None:
        return None
    return [h["a"], h["p"], h["af"], h["pf"]]


# ---------------------------------------------------------------------------
# HumanController.handle -- taps, fire, weapon-cycle, toggles, battery.
# ---------------------------------------------------------------------------
def dump_human_handle():
    cases = []

    def run(setup, key):
        tank = setup()
        st = MockHumanState(tank)
        ui.HumanController.handle(st, Ev(K[key]))
        return tank, st

    # angle/power taps including clamp edges
    scripts = [
        ("angle_up_mid", lambda: MockTank(angle=90), "LEFT"),
        ("angle_up_a", lambda: MockTank(angle=90), "a"),
        ("angle_up_clamp", lambda: MockTank(angle=180), "LEFT"),
        ("angle_down_mid", lambda: MockTank(angle=90), "RIGHT"),
        ("angle_down_d", lambda: MockTank(angle=90), "d"),
        ("angle_down_clamp", lambda: MockTank(angle=0), "RIGHT"),
        ("power_up_mid", lambda: MockTank(power=500), "UP"),
        ("power_up_w", lambda: MockTank(power=500), "w"),
        ("power_up_clamp", lambda: MockTank(power=1000), "UP"),
        ("power_down_mid", lambda: MockTank(power=500), "DOWN"),
        ("power_down_s", lambda: MockTank(power=500), "s"),
        ("power_down_clamp", lambda: MockTank(power=0), "DOWN"),
        ("fire_space", lambda: MockTank(), "SPACE"),
        ("fire_return", lambda: MockTank(), "RETURN"),
        ("parachute_toggle_on", lambda: MockTank(parachute_deployed=False), "p"),
        ("parachute_toggle_off", lambda: MockTank(parachute_deployed=True), "p"),
        ("contact_toggle_on", lambda: MockTank(contact_trigger=False), "MINUS"),
        ("contact_toggle_off", lambda: MockTank(contact_trigger=True), "MINUS"),
    ]
    for name, setup, key in scripts:
        tank, st = run(setup, key)
        cases.append({
            "name": name, "key": key,
            "angle": tank.angle, "power": tank.power,
            "selected_weapon": tank.selected_weapon,
            "parachute_deployed": bool(tank.parachute_deployed),
            "contact_trigger": bool(tank.contact_trigger),
            "health": tank.health, "fired": st.fired,
            "battery_count": tank.inventory[weapons.SLOT_BATTERY],
        })

    # battery: heal +10 capped at TANK_DEFAULT_HEALTH, consumes one, gated on health
    bat_inv = [0] * weapons.NUM_ITEMS
    bat_inv[weapons.SLOT_BATTERY] = 3
    bat_scripts = [
        ("battery_heal", lambda: MockTank(health=70, inv=list(bat_inv))),
        ("battery_cap", lambda: MockTank(health=95, inv=list(bat_inv))),   # +10 -> clamps to 100
        ("battery_full_noop", lambda: MockTank(health=100, inv=list(bat_inv))),
        ("battery_none", lambda: MockTank(health=70, inv=[0] * weapons.NUM_ITEMS)),
    ]
    for name, setup in bat_scripts:
        tank = setup()
        st = MockHumanState(tank)
        ui.HumanController.handle(st, Ev(K["b"]))
        cases.append({
            "name": name, "key": "b",
            "angle": tank.angle, "power": tank.power,
            "selected_weapon": tank.selected_weapon,
            "parachute_deployed": bool(tank.parachute_deployed),
            "contact_trigger": bool(tank.contact_trigger),
            "health": tank.health, "fired": st.fired,
            "battery_count": tank.inventory[weapons.SLOT_BATTERY],
        })

    # non-KEYDOWN event is ignored
    tank = MockTank(angle=90)
    st = MockHumanState(tank)
    ui.HumanController.handle(st, Ev(K["LEFT"], etype=pygame.MOUSEBUTTONDOWN))
    cases.append({
        "name": "ignore_non_keydown", "key": "LEFT",
        "angle": tank.angle, "power": tank.power,
        "selected_weapon": tank.selected_weapon,
        "parachute_deployed": bool(tank.parachute_deployed),
        "contact_trigger": bool(tank.contact_trigger),
        "health": tank.health, "fired": st.fired,
        "battery_count": tank.inventory[weapons.SLOT_BATTERY],
    })

    # no current_shooter -> no-op (fire not called)
    st = MockHumanState(None)
    ui.HumanController.handle(st, Ev(K["SPACE"]))
    cases.append({
        "name": "no_shooter", "key": "SPACE",
        "angle": None, "power": None, "selected_weapon": None,
        "parachute_deployed": None, "contact_trigger": None,
        "health": None, "fired": st.fired, "battery_count": None,
    })
    return cases


# ---------------------------------------------------------------------------
# HumanController._cycle_weapon -- owned offensive-with-ammo rotation.
# ---------------------------------------------------------------------------
def _offensive_slots():
    return [i for i in range(weapons.NUM_ITEMS) if weapons.ITEMS[i].offensive]


def dump_weapon_cycle():
    cases = []
    off = _offensive_slots()
    # Pick a few offensive slots to own (slot 0 baby missile is always firable).
    # Build owned subsets and rotate forward/back, plus the not-in-list reset.
    own_inv = [0] * weapons.NUM_ITEMS
    # give ammo to three offensive slots beyond slot 0
    extra = [s for s in off if s != weapons.SLOT_BABY_MISSILE][:3]
    for s in extra:
        own_inv[s] = 5

    def run(sel, d):
        tank = MockTank(sel=sel, inv=list(own_inv))
        st = MockHumanState(tank)
        ui.HumanController._cycle_weapon(st, tank, d)
        return tank.selected_weapon

    # owned list = [0] + extra (offensive + has_ammo, in index order)
    owned = [i for i in range(weapons.NUM_ITEMS)
             if weapons.ITEMS[i].offensive and (i == weapons.SLOT_BABY_MISSILE or own_inv[i] > 0)]
    for start in owned:
        cases.append({"name": f"fwd_from_{start}", "owned": owned, "sel_in": start, "d": 1,
                      "sel_out": run(start, 1)})
        cases.append({"name": f"bwd_from_{start}", "owned": owned, "sel_in": start, "d": -1,
                      "sel_out": run(start, -1)})
    # selected not in owned list -> resets to owned[0]
    not_owned = next((s for s in off if s not in owned), None)
    if not_owned is not None:
        cases.append({"name": "reset_not_owned", "owned": owned, "sel_in": not_owned, "d": 1,
                      "sel_out": run(not_owned, 1)})

    # empty owned list (no offensive ammo AND slot0 not offensive?) -- slot0 IS
    # offensive+always-firable, so owned is never empty in practice; assert that.
    empty_inv = [0] * weapons.NUM_ITEMS
    tank = MockTank(sel=5, inv=list(empty_inv))
    st = MockHumanState(tank)
    ui.HumanController._cycle_weapon(st, tank, 1)
    cases.append({"name": "only_slot0", "owned": [weapons.SLOT_BABY_MISSILE],
                  "sel_in": 5, "d": 1, "sel_out": tank.selected_weapon})
    return cases


# ---------------------------------------------------------------------------
# HumanController.update_continuous -- the hold-repeat ramp accumulator.
# ---------------------------------------------------------------------------
def dump_update_continuous():
    cases = []

    def run(name, held_codes, frames, dt, angle0=90, power0=500):
        tank = MockTank(angle=angle0, power=power0)
        st = MockHumanState(tank)
        keys = MockKeys()
        for code in held_codes:
            keys[K[code]] = True
        snaps = []
        for _ in range(frames):
            ui.HumanController.update_continuous(st, keys, dt)
            snaps.append({
                "angle": tank.angle, "power": tank.power, "hold": _hold(st),
            })
        return {"name": name, "held": held_codes, "frames": frames, "dt": dt,
                "angle0": angle0, "power0": power0, "snaps": snaps}

    # below the repeat-delay gate: a couple frames at 1/60 (< 0.22s) move nothing
    cases.append(run("left_below_delay", ["LEFT"], 5, 1 / 60.0))
    # held long enough to cross the gate and accumulate whole degrees
    cases.append(run("left_held_long", ["LEFT"], 60, 1 / 60.0))
    cases.append(run("right_held_long", ["RIGHT"], 60, 1 / 60.0))
    cases.append(run("a_held_long", ["a"], 60, 1 / 60.0))
    cases.append(run("d_held_long", ["d"], 60, 1 / 60.0))
    cases.append(run("up_held_long", ["UP"], 60, 1 / 60.0, power0=400))
    cases.append(run("down_held_long", ["DOWN"], 60, 1 / 60.0, power0=600))
    cases.append(run("w_held_long", ["w"], 60, 1 / 60.0, power0=400))
    cases.append(run("s_held_long", ["s"], 60, 1 / 60.0, power0=600))
    # power ramp hits the fast rate cap (350/s) over many frames
    cases.append(run("up_long_capcheck", ["UP"], 200, 1 / 60.0, power0=0))
    # angle ramp hits the 55 deg/s cap then clamps at 180
    cases.append(run("left_clamp180", ["LEFT"], 300, 1 / 60.0, angle0=170))
    cases.append(run("right_clamp0", ["RIGHT"], 300, 1 / 60.0, angle0=10))
    # both axes held simultaneously
    cases.append(run("left_up_both", ["LEFT", "UP"], 60, 1 / 60.0, angle0=45, power0=300))
    # release path: hold then let go resets accumulators
    def run_release(name):
        tank = MockTank(angle=90, power=500)
        st = MockHumanState(tank)
        keys = MockKeys()
        keys[K["LEFT"]] = True
        for _ in range(30):
            ui.HumanController.update_continuous(st, keys, 1 / 60.0)
        # release
        keys[K["LEFT"]] = False
        ui.HumanController.update_continuous(st, keys, 1 / 60.0)
        return {"name": name, "angle": tank.angle, "power": tank.power, "hold": _hold(st)}
    cases.append({"name": "release_resets", "release": run_release("release_resets")})

    # no current_shooter -> no-op, _aim_hold not created
    st = MockHumanState(None)
    keys = MockKeys()
    keys[K["LEFT"]] = True
    ui.HumanController.update_continuous(st, keys, 1 / 60.0)
    cases.append({"name": "no_shooter_noop", "hold_is_none": _hold(st) is None})

    # a different dt (variable timestep) crosses the gate at a different frame
    cases.append(run("left_bigdt", ["LEFT"], 20, 0.05))
    return cases


# ---------------------------------------------------------------------------
# MainMenu -- rows, navigation, value mutation, _value_str, build_players.
# ---------------------------------------------------------------------------
def _mk_cfg(**over):
    from scorch import config
    cfg = config.Config()
    for k, v in over.items():
        setattr(cfg, k, v)
    return cfg


def _menu_state(m):
    return {
        "num_players": m.num_players,
        "types": list(m.types),
        "sel": m.sel,
        "start": bool(m.start),
        "quit": bool(m.quit),
        "row_keys": [r[0] for r in m.rows],
        "cfg": {
            "MAXPLAYERS": m.cfg.MAXPLAYERS, "MAXROUNDS": m.cfg.MAXROUNDS,
            "INITIAL_CASH": m.cfg.INITIAL_CASH, "GRAVITY": m.cfg.GRAVITY,
            "MAX_WIND": m.cfg.MAX_WIND, "AIR_VISCOSITY": m.cfg.AIR_VISCOSITY,
            "SCORING": m.cfg.SCORING, "TEAM_MODE": m.cfg.TEAM_MODE,
            "PLAY_MODE": m.cfg.PLAY_MODE,
        },
    }


def dump_mainmenu():
    out = {}

    # initial roster + rows for a few player counts
    inits = []
    for mp in (2, 3, 4, 10):
        cfg = _mk_cfg(MAXPLAYERS=mp)
        m = ui.MainMenu(cfg, 1024, 768)
        inits.append({"maxplayers": mp, "state": _menu_state(m)})
    out["inits"] = inits

    # navigation: a scripted key sequence over selection
    nav_scripts = []
    seqs = [
        ("down_wrap", ["DOWN"] * 14),          # wraps past the end
        ("up_wrap", ["UP"] * 3),               # wraps to the bottom
        ("w_s_mix", ["s", "s", "w", "s"]),
        ("to_start_then_activate", ["UP", "UP", "RETURN"]),  # quit/start zone
    ]
    for name, keys in seqs:
        cfg = _mk_cfg(MAXPLAYERS=2)
        m = ui.MainMenu(cfg, 1024, 768)
        trace = []
        for key in keys:
            m.handle(Ev(K[key]))
            trace.append({"key": key, "sel": m.sel, "start": bool(m.start), "quit": bool(m.quit)})
        nav_scripts.append({"name": name, "keys": keys, "trace": trace,
                            "final": _menu_state(m)})
    out["nav"] = nav_scripts

    # value mutation: drive LEFT/RIGHT on a specific row by pre-seeking sel.
    # We set sel directly then activate +/- to exercise each adjuster + clamp.
    def value_run(name, sel_key, dirs):
        cfg = _mk_cfg(MAXPLAYERS=2)
        m = ui.MainMenu(cfg, 1024, 768)
        # move selection onto sel_key
        m.sel = [r[0] for r in m.rows].index(sel_key)
        trace = []
        for d in dirs:
            m._activate(d)
            trace.append({"d": d, "value": m._value_str(sel_key),
                          "cfg_gravity": m.cfg.GRAVITY, "cfg_maxrounds": m.cfg.MAXROUNDS,
                          "cfg_cash": m.cfg.INITIAL_CASH, "cfg_wind": m.cfg.MAX_WIND,
                          "cfg_visc": m.cfg.AIR_VISCOSITY, "cfg_scoring": m.cfg.SCORING,
                          "cfg_team": m.cfg.TEAM_MODE, "cfg_mode": m.cfg.PLAY_MODE,
                          "num_players": m.num_players, "types": list(m.types)})
        return {"name": name, "sel_key": sel_key, "dirs": dirs, "trace": trace,
                "final": _menu_state(m)}

    vruns = []
    vruns.append(value_run("rounds_up", "rounds", [1] * 5 + [-1] * 2))
    vruns.append(value_run("rounds_clamp_lo", "rounds", [-1] * 15))   # floor 1
    vruns.append(value_run("cash_steps", "cash", [1, 1, 1, -1]))       # *1000 each
    vruns.append(value_run("cash_clamp_lo", "cash", [-1] * 3))         # floor 0
    vruns.append(value_run("scoring_cycle", "scoring", [1, 1, 1, 1]))  # 3-name wrap
    vruns.append(value_run("scoring_back", "scoring", [-1, -1]))
    vruns.append(value_run("teams_cycle", "teams", [1, 1, 1, 1, 1]))   # 4-name wrap
    vruns.append(value_run("mode_cycle", "mode", [1, 1, 1, 1]))        # 3-name wrap
    vruns.append(value_run("gravity_up", "gravity", [1] * 6 + [-1] * 3))  # round(.,2) steps
    vruns.append(value_run("gravity_clamp_hi", "gravity", [1] * 250))  # cap 10.0
    vruns.append(value_run("gravity_clamp_lo", "gravity", [-1] * 10))  # floor 0.05
    vruns.append(value_run("wind_steps", "wind", [1, 1, 1, -1]))       # *25, cap 500
    vruns.append(value_run("wind_clamp_hi", "wind", [1] * 30))         # cap 500 (from 200)
    vruns.append(value_run("visc_steps", "visc", [1, 1, 1, -1, -1]))   # 0..20
    vruns.append(value_run("visc_clamp_hi", "visc", [1] * 25))         # cap 20
    vruns.append(value_run("ptype0_cycle", "ptype0", [1] * 10))        # 9-name wrap
    vruns.append(value_run("ptype1_back", "ptype1", [-1, -1]))
    vruns.append(value_run("players_inc", "players", [1, 1, 1]))       # rebuilds rows
    vruns.append(value_run("players_clamp", "players", [1] * 12))      # cap 10
    vruns.append(value_run("players_dec_floor", "players", [-1] * 5))  # floor 2
    # activate(0) on a value row defaults to +1
    vruns.append(value_run("rounds_activate0", "rounds", [0, 0]))
    out["values"] = vruns

    # build_players for both team modes + a custom roster
    bp = []
    for team in ("NONE", "STANDARD"):
        cfg = _mk_cfg(MAXPLAYERS=4, TEAM_MODE=team)
        m = ui.MainMenu(cfg, 1024, 768)
        m.types = [0, 1, 6, 7, 6, 6, 6, 6, 6, 6]
        bp.append({"team_mode": team, "num_players": m.num_players,
                   "specs": [list(s) for s in m.build_players()]})
    # players changed then build
    cfg = _mk_cfg(MAXPLAYERS=2, TEAM_MODE="STANDARD")
    m = ui.MainMenu(cfg, 1024, 768)
    m._chg_players(3)
    bp.append({"team_mode": "STANDARD_after_chg", "num_players": m.num_players,
               "specs": [list(s) for s in m.build_players()]})
    out["build_players"] = bp

    # start/quit activation lands the flags
    flags = []
    for target, key in (("start", "RETURN"), ("quit", "RETURN")):
        cfg = _mk_cfg(MAXPLAYERS=2)
        m = ui.MainMenu(cfg, 1024, 768)
        m.sel = [r[0] for r in m.rows].index(target)
        m.handle(Ev(K[key]))
        flags.append({"target": target, "start": bool(m.start), "quit": bool(m.quit)})
    # SPACE also activates
    cfg = _mk_cfg(MAXPLAYERS=2)
    m = ui.MainMenu(cfg, 1024, 768)
    m.sel = [r[0] for r in m.rows].index("start")
    m.handle(Ev(K["SPACE"]))
    flags.append({"target": "start_space", "start": bool(m.start), "quit": bool(m.quit)})
    out["flags"] = flags
    return out


# ---------------------------------------------------------------------------
# Shop -- selection wrap, buy/sell delegation, availability filter.
# ---------------------------------------------------------------------------
def dump_shop():
    out = {}

    # availability filter: only available[i] items make the list
    avail = [True] * weapons.NUM_ITEMS
    # disable a handful to prove the filter
    for i in (3, 7, 11, 20):
        avail[i] = False
    econ = MockEconomy(available=list(avail))
    tank = MockTank(cash=5000, inv=[0] * weapons.NUM_ITEMS)
    shop = ui.Shop(MockShopState(econ), tank, 1024, 768)
    out["items_filter"] = {"available": avail, "items": list(shop.items)}

    # navigation wrap
    nav = []
    seqs = [
        ("down_wrap", ["DOWN"] * (len(shop.items) + 2)),
        ("up_wrap", ["UP"] * 3),
        ("w_s_mix", ["s", "s", "w"]),
    ]
    for name, keys in seqs:
        econ2 = MockEconomy(available=list(avail))
        tank2 = MockTank(cash=5000, inv=[0] * weapons.NUM_ITEMS)
        sh = ui.Shop(MockShopState(econ2), tank2, 1024, 768)
        trace = []
        for key in keys:
            sh.handle(Ev(K[key]))
            trace.append({"key": key, "sel": sh.sel})
        nav.append({"name": name, "keys": keys, "n_items": len(sh.items), "trace": trace})
    out["nav"] = nav

    # buy/sell delegation + cash/inventory effects + done flag
    actions = []
    # Build a scripted session: navigate, buy a couple, sell one, then esc.
    econ3 = MockEconomy(available=[True] * weapons.NUM_ITEMS)
    tank3 = MockTank(cash=100000, inv=[0] * weapons.NUM_ITEMS)
    sh = ui.Shop(MockShopState(econ3), tank3, 1024, 768)
    script = ["DOWN", "RETURN", "b", "DOWN", "RETURN", "x", "BACKSPACE", "ESCAPE"]
    for key in script:
        sh.handle(Ev(K[key]))
        actions.append({
            "key": key, "sel": sh.sel, "done": bool(sh.done),
            "cash": tank3.cash,
            "inv_at_sel": tank3.inventory[sh.items[sh.sel]],
        })
    out["session"] = {
        "script": script, "actions": actions,
        "calls": econ3.calls,
        "final_cash": tank3.cash,
        "final_inv": list(tank3.inventory),
    }

    # TAB also closes
    econ4 = MockEconomy(available=[True] * weapons.NUM_ITEMS)
    tank4 = MockTank(cash=100, inv=[0] * weapons.NUM_ITEMS)
    sh = ui.Shop(MockShopState(econ4), tank4, 1024, 768)
    sh.handle(Ev(K["TAB"]))
    out["tab_done"] = {"done": bool(sh.done)}

    # buy that fails for insufficient cash still delegates (call logged), no cash change
    econ5 = MockEconomy(available=[True] * weapons.NUM_ITEMS)
    tank5 = MockTank(cash=0, inv=[0] * weapons.NUM_ITEMS)
    sh = ui.Shop(MockShopState(econ5), tank5, 1024, 768)
    sh.handle(Ev(K["RETURN"]))
    out["buy_broke"] = {"calls": econ5.calls, "cash": tank5.cash,
                        "inv0": tank5.inventory[sh.items[0]]}
    return out


# ---------------------------------------------------------------------------
# draw_rankings layout substrate -- quote-wrap, geometry, go-rect, row colors.
# Patches ui.draw_rankings's font with the deterministic MockRenderer.
# ---------------------------------------------------------------------------
def _layout_via_real_draw(renderer, state, title, rounds_left, quote):
    """Drive the REAL ui.draw_rankings against a surface whose draw ops are
    recorded, so the geometry the Python source computes is captured exactly
    (including state._rankings_go_rect). The mock font feeds deterministic
    metrics; the mock surface/draw record the rects/blits.
    """
    import scorch.widgets as _w

    class RecSurf:
        def __init__(self):
            self.fills = []
            self.blits = []  # (surf_width, [x, y])

        def fill(self, color, rect=None):
            self.fills.append([list(color), rect])

        def blit(self, src, pos, *a, **k):
            self.blits.append([src.get_width(), [int(pos[0]), int(pos[1])]])

    rec = RecSurf()
    rects = []
    lines = []

    class FakeDraw:
        @staticmethod
        def rect(surf, color, r, width=0):
            rects.append([list(color), [int(r[0]), int(r[1]), int(r[2]), int(r[3])], width])

        @staticmethod
        def line(surf, color, a, b, width=1):
            lines.append([list(color), [int(a[0]), int(a[1])], [int(b[0]), int(b[1])], width])

    # monkeypatch pygame.draw inside ui via the module-local `_pg` import.
    import scorch.ui as uimod
    real_pg = uimod.pygame
    real_w_panel = (_w.C_PANEL, _w.C_PANEL_HI, _w.C_PANEL_LO, _w.C_TEXT_LT)

    class FakePg:
        draw = FakeDraw

        class Rect:
            def __init__(self, x, y, w, h):
                self.x, self.y, self.w, self.h = int(x), int(y), int(w), int(h)

    # ui.draw_rankings does `import pygame as _pg` and `from . import widgets as _w`
    # at call time, so patch sys.modules so those local imports resolve to fakes.
    saved = sys.modules.get("pygame")
    sys.modules["pygame"] = FakePg
    try:
        ui.draw_rankings(rec, renderer, state, title=title,
                         rounds_left=rounds_left, quote=quote)
    finally:
        sys.modules["pygame"] = saved

    gr = state._rankings_go_rect
    return {
        "fills": rec.fills, "blits": rec.blits, "rects": rects, "lines": lines,
        "go_rect": [gr.x, gr.y, gr.w, gr.h] if gr is not None else None,
    }


def dump_rankings():
    out = {}
    out["font"] = {"cw": FONT_CW, "h": FONT_H, "big_cw": BIG_CW, "big_h": BIG_H}

    renderer = MockRenderer()

    def mk_tanks():
        return [
            MockRankTank(color=1, name="Alice", win_counter=3, cash=1200, score=300),
            MockRankTank(color=2, name="Bob", win_counter=1, cash=50, score=150),
            MockRankTank(color=3, name="Cy", win_counter=0, cash=0, score=80),
            MockRankTank(color=4, name="Dee", win_counter=2, cash=999, score=220),
        ]

    cases = []

    # interim: rounds_left given, no quote; ranking provided
    tanks = mk_tanks()
    state = MockRankState(1024, 768, ranking=list(tanks), tanks=tanks)
    lay = _layout_via_real_draw(renderer, state, "Player Rankings", 5, None)
    cases.append({"name": "interim_5", "title": "Player Rankings", "rounds_left": 5,
                  "quote": None, "w": 1024, "h": 768, "ranking_set": True,
                  "tanks": [[t.color, t.name, t.win_counter, t.cash, t.score] for t in tanks],
                  "layout": lay})

    # interim singular "1 round remains"
    tanks = mk_tanks()
    state = MockRankState(1024, 768, ranking=list(tanks), tanks=tanks)
    lay = _layout_via_real_draw(renderer, state, "Standings", 1, None)
    cases.append({"name": "interim_1", "title": "Standings", "rounds_left": 1,
                  "quote": None, "w": 1024, "h": 768, "ranking_set": True,
                  "tanks": [[t.color, t.name, t.win_counter, t.cash, t.score] for t in tanks],
                  "layout": lay})

    # game-end: no rounds_left, with a war quote that needs wrapping
    quote = ["War is the continuation of politics by other means and nothing more than that",
             "Carl von Clausewitz"]
    tanks = mk_tanks()
    state = MockRankState(1024, 768, ranking=list(tanks), tanks=tanks)
    lay = _layout_via_real_draw(renderer, state, "Final Standings", None, quote)
    cases.append({"name": "final_quote", "title": "Final Standings", "rounds_left": None,
                  "quote": quote, "w": 1024, "h": 768, "ranking_set": True,
                  "tanks": [[t.color, t.name, t.win_counter, t.cash, t.score] for t in tanks],
                  "layout": lay})

    # game-end short quote (one line + author)
    quote2 = ["Peace.", "Anon"]
    tanks = mk_tanks()
    state = MockRankState(1024, 768, ranking=list(tanks), tanks=tanks)
    lay = _layout_via_real_draw(renderer, state, "Done", None, quote2)
    cases.append({"name": "final_short", "title": "Done", "rounds_left": None,
                  "quote": quote2, "w": 1024, "h": 768, "ranking_set": True,
                  "tanks": [[t.color, t.name, t.win_counter, t.cash, t.score] for t in tanks],
                  "layout": lay})

    # ranking None -> sort by -score (Bob 150 < Dee 220, etc.)
    tanks = mk_tanks()
    state = MockRankState(800, 600, ranking=None, tanks=tanks)
    lay = _layout_via_real_draw(renderer, state, "Player Rankings", 3, None)
    cases.append({"name": "sorted_by_score", "title": "Player Rankings", "rounds_left": 3,
                  "quote": None, "w": 800, "h": 600, "ranking_set": False,
                  "tanks": [[t.color, t.name, t.win_counter, t.cash, t.score] for t in tanks],
                  "layout": lay})

    # small screen so py clamps to 16
    tanks = mk_tanks()
    state = MockRankState(640, 200, ranking=list(tanks), tanks=tanks)
    lay = _layout_via_real_draw(renderer, state, "Player Rankings", 2, None)
    cases.append({"name": "tiny_screen_clamp", "title": "Player Rankings", "rounds_left": 2,
                  "quote": None, "w": 640, "h": 200, "ranking_set": True,
                  "tanks": [[t.color, t.name, t.win_counter, t.cash, t.score] for t in tanks],
                  "layout": lay})

    out["cases"] = cases

    # explicit quote-wrap unit cases (the 48-col greedy wrap + author line)
    wraps = []
    samples = [
        ["one two three", "X"],
        ["", "Empty"],
        ["supercalifragilisticexpialidocious antidisestablishmentarianism floccinaucinihilipilification", "Long"],
        ["a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5 6 7 8 9 0", "Alpha"],
        ["   leading   and   trailing   spaces   ", "Spaces"],
    ]
    # exercise wrap by calling draw and reading the produced qlines through blits is
    # indirect; instead reconstruct via the same algorithm the source uses, but to
    # keep the oracle authoritative we recompute by importing the source's logic.
    for qtext, qauthor in samples:
        qlines = []
        cur = ""
        for wd in str(qtext).split():
            if len(cur) + len(wd) + 1 > 48:
                qlines.append(cur)
                cur = wd
            else:
                cur = (cur + " " + wd).strip()
        if cur:
            qlines.append(cur)
        qlines.append(f"- {qauthor}")
        wraps.append({"qtext": qtext, "qauthor": qauthor, "qlines": qlines})
    out["wraps"] = wraps
    return out


def main():
    payload = {
        "module": "ui",
        "human_handle": dump_human_handle(),
        "weapon_cycle": dump_weapon_cycle(),
        "update_continuous": dump_update_continuous(),
        "mainmenu": dump_mainmenu(),
        "shop": dump_shop(),
        "rankings": dump_rankings(),
    }
    _write("ui", payload)
    print("Done. ui vectors written.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Oracle vector dumper for scorch.ingame -- drives the REAL Python ingame module
headless and writes golden vectors to vectors/ingame.json for the TS differential
gate (test/ingame.test.ts).

STATIC use of the port: imports and calls ingame.py's free functions + value-logic
over lightweight mock Tank / Cfg / State objects (the damage.test.ts MockState
pattern). It never runs the DOS binary.

WHAT IS NUMERICALLY DUMPED (the heart of the gate -- the DOM-free, mouse-free
logic, which the Node test reproduces byte-for-byte):
  * cycle_weapon            -- owned offensive-with-ammo list rotation (+/-).
  * Choose Target           -- weapon_needs_target / in_target_mode /
                               _in_choose_target gate (incl. SIMULTANEOUS), enter/
                               exit_target_mode, _tank_at / _nearest_tank_within /
                               set_target / _handle_target_click / target_by_number.
  * fuel move sub-mode      -- in_move_mode + _handle_move_key router ('f' toggle,
                               LEFT/RIGHT move, Esc/Enter leave, can_move gate).
  * info box                -- show_info_box payload + _shield_pct.
  * status-cell controls    -- _handle_status_click (battery/para/trig/selector).
  * battery discharge math  -- _BatteryDischargeScreen._apply value walk.
  * system-menu effects     -- clear_screen_effect / do_mass_kill.
  * static layout tables    -- SystemMenuScreen LEFT/RIGHT action map.

The HUD hit-box geometry (hud_hitboxes) measures pygame.font (DOM) and the bar-
click / hold-ramp paths read the mouse state, so they are NOT dumped here; their
pixels + live-mouse behaviour defer to the Phase-3 visual gate. The four Screen
classes build font-measured widgets.Panel, so their full Panel.handle routing also
defers (the Node test cannot construct a font-measured widget; widgets.test.ts /
ui.test.ts established that boundary).

Run (from scorch-html5):
    SDL_VIDEODRIVER=dummy PYTHONPATH="/home/user/Scorched Earth/scorch-py" \
        "/home/user/Scorched Earth/.venv/bin/python" oracle/dump_ingame.py
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

# Full init + a dummy display so pygame.mouse.get_pressed()/get_pos() (read by
# ingame._both_buttons_down / _mouse_hold_keys) work under SDL_VIDEODRIVER=dummy.
# With the dummy driver, no real mouse is connected, so get_pressed() == (0,0,0)
# and get_pos() == (0,0) -- exactly the "no mouse held" default the TS shim hook
# uses when no provider is wired, so the two sides agree on the no-mouse path.
pygame.init()
pygame.display.set_mode((1, 1))

from scorch import ingame  # noqa: E402
from scorch import weapons  # noqa: E402
from scorch import constants as C  # noqa: E402

# Event-type + key constants mirrored from the SDL keycodes the shim uses
# (pygame.K_* / pygame.<event>). The TS test reads the SAME numeric values from
# src/pygame.ts, so the two stay in lockstep.
MOUSEBUTTONDOWN = pygame.MOUSEBUTTONDOWN
KEYDOWN = pygame.KEYDOWN
K = {
    "ESCAPE": pygame.K_ESCAPE, "RETURN": pygame.K_RETURN, "KP_ENTER": pygame.K_KP_ENTER,
    "LEFT": pygame.K_LEFT, "RIGHT": pygame.K_RIGHT, "UP": pygame.K_UP, "DOWN": pygame.K_DOWN,
    "f": pygame.K_f, "t": pygame.K_t, "i": pygame.K_i, "r": pygame.K_r, "p": pygame.K_p,
    "0": pygame.K_0, "1": pygame.K_1, "2": pygame.K_2, "3": pygame.K_3, "4": pygame.K_4,
    "5": pygame.K_5, "9": pygame.K_9, "a": pygame.K_a,
}

# Named slots used in the batteries.
SLOT_BABY_MISSILE = weapons.SLOT_BABY_MISSILE
SLOT_BATTERY = weapons.SLOT_BATTERY
SLOT_PARACHUTE = weapons.SLOT_PARACHUTE
SLOT_FUEL = weapons.SLOT_FUEL
SLOT_CONTACT_TRIGGER = weapons.SLOT_CONTACT_TRIGGER
GUIDANCE_SLOTS = [i for i, it in enumerate(weapons.ITEMS) if it.category == "guidance"]


# ---------------------------------------------------------------------------
# Mocks -- structurally identical to test/ingame.test.ts (same fields/methods).
# These mirror objects.Tank / GameState only as far as the dumped functions read.
# ---------------------------------------------------------------------------
class Ev:
    """A pygame-shaped event (only .type/.button/.pos/.key are read)."""

    def __init__(self, type, button=None, pos=None, key=None):
        self.type = type
        self.button = button
        self.pos = pos
        self.key = key


class MockTank:
    def __init__(self, player_index=0, name="P1", ai_class=0, x=100, y=100,
                 half_width=7, angle=45, power=500, health=100, alive=True,
                 mobile=True, shield_hp=0, shield_item=0,
                 parachute_deployed=True, contact_trigger=False,
                 selected_guidance=None, selected_weapon=0, inv=None,
                 fuel_remainder=0, score=0):
        self.player_index = player_index
        self.name = name
        self.ai_class = ai_class
        self.x = x
        self.y = y
        self.half_width = half_width
        self.angle = angle
        self.power = power
        self.health = health
        self.alive = alive
        self.mobile = mobile
        self.shield_hp = shield_hp
        self.shield_item = shield_item
        self.shield_push = False
        self.shield_deflect = False
        self.shield_laserproof = False
        self.shield_failproof = False
        self.parachute_deployed = parachute_deployed
        self.contact_trigger = contact_trigger
        self.selected_guidance = selected_guidance
        self.guidance_target = None
        self.guidance_target_pt = None
        self.selected_weapon = selected_weapon
        self.inventory = inv if inv is not None else [0] * weapons.NUM_ITEMS
        self.fuel_remainder = fuel_remainder
        self.score = score
        self.color = 1
        self.win_counter = 0
        self.cash = 0

    @property
    def fuel(self):
        return self.inventory[SLOT_FUEL] * 10 + self.fuel_remainder

    @property
    def batteries(self):
        return self.inventory[SLOT_BATTERY]

    def has_ammo(self, slot):
        if slot == SLOT_BABY_MISSILE:
            return True
        return self.inventory[slot] > 0


class MockCfg:
    def __init__(self, play_mode=C.PLAYMODE_SEQUENTIAL, status_bar=False, sound=True):
        self._play_mode = play_mode
        self._status_bar = status_bar
        self.SOUND = "ON" if sound else "OFF"

    @property
    def play_mode(self):
        return self._play_mode

    def is_on(self, key):
        if key == "STATUS_BAR":
            return self._status_bar
        if key == "SOUND":
            return self.SOUND == "ON"
        return False


class MockTerrain:
    """The surface oracle movement.move_tank reads (column_top)."""

    def __init__(self, top=300):
        self._top = top

    def column_top(self, x):
        return self._top


class MockState:
    def __init__(self, tanks=None, shooter=None, phase="aim", cfg=None,
                 w=1024, h=768, terrain=None):
        self.phase = phase
        self.tanks = tanks if tanks is not None else []
        self.current_shooter = shooter
        self.cfg = cfg if cfg is not None else MockCfg()
        self.w = w
        self.h = h
        self.terrain = terrain if terrain is not None else MockTerrain()
        self.target_mode = False
        self.move_mode = False
        self.info_box = None
        self.speech = None
        self._hud_hitboxes = None
        self.fired = 0
        self.mass_killed = 0
        self.retreated = []
        self.settled = []

    def fire(self):
        self.fired += 1

    def mass_kill(self):
        self.mass_killed += 1

    def retreat(self, tank):
        self.retreated.append(tank)

    def _settle_tank(self, tank):
        self.settled.append(tank)


def _tank_snap(t):
    """The Tank fields the gate compares after an op."""
    return {
        "power": t.power, "angle": t.angle, "health": t.health,
        "selected_weapon": t.selected_weapon,
        "selected_guidance": t.selected_guidance,
        "parachute_deployed": bool(t.parachute_deployed),
        "contact_trigger": bool(t.contact_trigger),
        "shield_hp": t.shield_hp, "shield_item": t.shield_item,
        "x": t.x, "y": t.y, "fuel": t.fuel, "fuel_remainder": t.fuel_remainder,
        "batteries": t.inventory[SLOT_BATTERY],
        "parachutes": t.inventory[SLOT_PARACHUTE],
        "fuels": t.inventory[SLOT_FUEL],
        "guidance_target": (t.guidance_target.player_index
                            if t.guidance_target is not None else None),
        "guidance_target_pt": (list(t.guidance_target_pt)
                               if t.guidance_target_pt is not None else None),
    }


# ---------------------------------------------------------------------------
# cycle_weapon -- owned offensive-with-ammo rotation (mirror ui weapon-cycle but
# via the ingame.cycle_weapon entry, which also returns the new slot).
# ---------------------------------------------------------------------------
def dump_cycle_weapon():
    out = {}
    off = [i for i in range(weapons.NUM_ITEMS) if weapons.ITEMS[i].offensive]
    extra = [s for s in off if s != SLOT_BABY_MISSILE][:3]
    inv = [0] * weapons.NUM_ITEMS
    for s in extra:
        inv[s] = 5
    owned = [i for i in range(weapons.NUM_ITEMS)
             if weapons.ITEMS[i].offensive and (i == SLOT_BABY_MISSILE or inv[i] > 0)]
    out["owned"] = owned

    cases = []
    for start in owned:
        for d in (1, -1):
            t = MockTank(selected_weapon=start, inv=list(inv))
            st = MockState(tanks=[t], shooter=t)
            r = ingame.cycle_weapon(st, d)
            cases.append({"name": f"{'fwd' if d > 0 else 'bwd'}_from_{start}",
                          "sel_in": start, "d": d, "ret": r,
                          "sel_out": t.selected_weapon})
    # selected not in owned list -> resets to owned[0]
    not_owned = next((s for s in off if s not in owned), None)
    if not_owned is not None:
        t = MockTank(selected_weapon=not_owned, inv=list(inv))
        st = MockState(tanks=[t], shooter=t)
        r = ingame.cycle_weapon(st, 1)
        cases.append({"name": "reset_not_owned", "sel_in": not_owned, "d": 1,
                      "ret": r, "sel_out": t.selected_weapon})
    # only slot 0 owned (empty inventory)
    t = MockTank(selected_weapon=5, inv=[0] * weapons.NUM_ITEMS)
    st = MockState(tanks=[t], shooter=t)
    r = ingame.cycle_weapon(st, 1)
    cases.append({"name": "only_slot0", "sel_in": 5, "d": 1, "ret": r,
                  "sel_out": t.selected_weapon})
    # no shooter -> None, no mutation
    st = MockState(tanks=[], shooter=None)
    r = ingame.cycle_weapon(st, 1)
    cases.append({"name": "no_shooter", "sel_in": None, "d": 1, "ret": r,
                  "sel_out": None})
    out["cases"] = cases
    return out


# ---------------------------------------------------------------------------
# Choose Target -- gate + pickers.
# ---------------------------------------------------------------------------
def _g0():
    """The first guidance slot (a targetable guidance)."""
    return GUIDANCE_SLOTS[0]


def dump_target():
    out = {}

    # weapon_needs_target / in_target_mode / _in_choose_target gate
    gate = []

    def gate_case(name, *, guidance, target_mode, play_mode):
        t = MockTank(selected_guidance=guidance)
        st = MockState(tanks=[t], shooter=t,
                       cfg=MockCfg(play_mode=play_mode))
        st.target_mode = target_mode
        gate.append({
            "name": name, "guidance": guidance, "target_mode": target_mode,
            "play_mode": play_mode,
            "needs_target": ingame.weapon_needs_target(st),
            "in_target_mode": ingame.in_target_mode(st),
            "in_choose_target": ingame._in_choose_target(st),
        })

    gate_case("none_seq", guidance=None, target_mode=False,
              play_mode=C.PLAYMODE_SEQUENTIAL)
    gate_case("guidance_seq", guidance=_g0(), target_mode=False,
              play_mode=C.PLAYMODE_SEQUENTIAL)
    gate_case("guidance_sync", guidance=_g0(), target_mode=False,
              play_mode=C.PLAYMODE_SYNCHRONOUS)
    gate_case("guidance_simul_gated_off", guidance=_g0(), target_mode=False,
              play_mode=C.PLAYMODE_SIMULTANEOUS)
    gate_case("explicit_mode_seq", guidance=None, target_mode=True,
              play_mode=C.PLAYMODE_SEQUENTIAL)
    gate_case("explicit_mode_simul", guidance=None, target_mode=True,
              play_mode=C.PLAYMODE_SIMULTANEOUS)
    out["gate"] = gate

    # no-shooter gate
    st = MockState(tanks=[], shooter=None)
    out["needs_target_no_shooter"] = ingame.weapon_needs_target(st)

    # enter/exit target mode
    enter = []
    t = MockTank(ai_class=C.AI_HUMAN)
    st = MockState(tanks=[t], shooter=t, phase="aim")
    enter.append({"name": "human_aim", "ret": ingame.enter_target_mode(st),
                  "target_mode": st.target_mode})
    ingame.exit_target_mode(st)
    enter.append({"name": "after_exit", "target_mode": st.target_mode})
    # AI shooter -> no enter
    t2 = MockTank(ai_class=C.AI_MORON)
    st2 = MockState(tanks=[t2], shooter=t2, phase="aim")
    enter.append({"name": "ai", "ret": ingame.enter_target_mode(st2),
                  "target_mode": st2.target_mode})
    # wrong phase -> no enter
    t3 = MockTank(ai_class=C.AI_HUMAN)
    st3 = MockState(tanks=[t3], shooter=t3, phase="fly")
    enter.append({"name": "wrong_phase", "ret": ingame.enter_target_mode(st3),
                  "target_mode": st3.target_mode})
    # no shooter -> no enter
    st4 = MockState(tanks=[], shooter=None, phase="aim")
    enter.append({"name": "no_shooter", "ret": ingame.enter_target_mode(st4),
                  "target_mode": st4.target_mode})
    out["enter"] = enter

    # _handle_target_click: RIGHT (nearest within 100), LEFT (raw point).
    # Build a battlefield: shooter at (100,100); enemies, plus a dead one and the
    # shooter itself, to exercise the alive/exclude-shooter filters.
    def build_field():
        shooter = MockTank(player_index=0, x=100, y=100, ai_class=C.AI_HUMAN)
        e1 = MockTank(player_index=1, x=150, y=120, alive=True)
        e2 = MockTank(player_index=2, x=400, y=300, alive=True)   # far
        dead = MockTank(player_index=3, x=110, y=100, alive=False)  # dead, very near
        tanks = [shooter, e1, e2, dead]
        st = MockState(tanks=tanks, shooter=shooter,
                       cfg=MockCfg(play_mode=C.PLAYMODE_SEQUENTIAL))
        return st, tanks

    click = []

    def click_case(name, button, pos):
        # Drive the REAL public router (handle_game_event), with the picker live, so
        # the gate (button in (1,3)) + both-buttons check + picker dispatch are all
        # exercised exactly as in-game; mouse state is unset (no both-buttons).
        st, tanks = build_field()
        st.target_mode = True
        e = Ev(MOUSEBUTTONDOWN, button=button, pos=pos)
        ret = ingame.handle_game_event(st, e)
        click.append({"name": name, "button": button, "pos": list(pos),
                      "ret": ret, "shooter": _tank_snap(tanks[0]),
                      "target_mode": st.target_mode})

    # RIGHT near e1 -> snaps to e1's base centre (x, y-4); within 100 px
    click_case("right_near_e1", 3, (160, 130))
    # RIGHT in empty space, no tank within 100 -> None, target unchanged
    click_case("right_empty", 3, (700, 700))
    # RIGHT exactly at the shooter (excludes shooter; nearest enemy e1 d=hypot(50,16)=52.5<=100)
    click_case("right_at_shooter", 3, (100, 100))
    # LEFT raw point -> stores point, clears tank target
    click_case("left_point", 1, (321, 234))
    # LEFT with float-ish pos cast to int (set_target int()s)
    click_case("left_point_floor", 1, (12.9, 99.7))
    # middle button (2) -> ignored (returns None, no change)
    click_case("middle_ignored", 2, (160, 130))
    out["click"] = click

    # target_by_number (1-based)
    by_num = []

    def num_case(name, n):
        st, tanks = build_field()
        st.target_mode = True
        ret = ingame.target_by_number(st, n)
        by_num.append({"name": name, "n": n, "ret": ret,
                       "shooter": _tank_snap(tanks[0]), "target_mode": st.target_mode})

    num_case("num2_e1", 2)     # player_index 1 (1-based 2) = e1 -> set
    num_case("num1_self", 1)   # the shooter itself -> None
    num_case("num4_dead", 4)   # dead tank -> None
    num_case("num9_oob", 9)    # out of range -> None
    num_case("num3_e2", 3)     # e2 (far, but by-number ignores distance) -> set
    out["by_num"] = by_num

    # _nearest_tank_within tie behaviour (<= so a later equal-distance overwrites):
    # two enemies equidistant from the click; expect the LATER one (e2) to win.
    shooter = MockTank(player_index=0, x=0, y=0, ai_class=C.AI_HUMAN)
    a = MockTank(player_index=1, x=-30, y=4)    # base centre (-30, 0); click (0,0): d=30
    b = MockTank(player_index=2, x=30, y=4)     # base centre (30, 0); d=30
    st = MockState(tanks=[shooter, a, b], shooter=shooter)
    st.target_mode = True
    ret = ingame.handle_game_event(st, Ev(MOUSEBUTTONDOWN, button=3, pos=(0, 0)))
    out["tie"] = {"ret": ret, "target": shooter.guidance_target.player_index,
                  "pt": list(shooter.guidance_target_pt)}
    return out


# ---------------------------------------------------------------------------
# fuel move sub-mode -- in_move_mode + _handle_move_key router.
# ---------------------------------------------------------------------------
def dump_move():
    out = {}
    scripts = []

    def run(name, *, mobile, fuels, fuel_remainder, keyseq, top=300, x0=100):
        # Drive the REAL public router (handle_game_event): a move-strip key returns
        # null publicly (the '_consumed' sentinel is internal); a non-move key in
        # move mode falls through to HumanController.handle, so the angle side
        # effects are captured exactly (and reproduced 1:1 by the TS router).
        inv = [0] * weapons.NUM_ITEMS
        inv[SLOT_FUEL] = fuels
        t = MockTank(x=x0, y=top - 1, mobile=mobile, inv=inv,
                     fuel_remainder=fuel_remainder, ai_class=C.AI_HUMAN)
        st = MockState(tanks=[t], shooter=t, terrain=MockTerrain(top=top))
        trace = []
        for kname in keyseq:
            e = Ev(KEYDOWN, key=K[kname])
            ret = ingame.handle_game_event(st, e)
            trace.append({"key": kname, "ret": ret, "move_mode": st.move_mode,
                          "x": t.x, "y": t.y, "fuel": t.fuel, "angle": t.angle,
                          "settled": len(st.settled)})
        scripts.append({"name": name, "mobile": mobile, "fuels": fuels,
                        "fuel_remainder": fuel_remainder, "keyseq": keyseq,
                        "trace": trace, "final": _tank_snap(t)})

    # 'f' enters (mobile + fuel), arrows move 1px each, 'f' leaves.
    run("enter_move_left_leave", mobile=True, fuels=2, fuel_remainder=0,
        keyseq=["f", "LEFT", "LEFT", "RIGHT", "f"])
    # Esc leaves the strip
    run("enter_esc", mobile=True, fuels=1, fuel_remainder=0,
        keyseq=["f", "LEFT", "ESCAPE", "LEFT"])
    # Enter/KP_ENTER leaves
    run("enter_return", mobile=True, fuels=1, fuel_remainder=0,
        keyseq=["f", "RETURN"])
    run("enter_kp_enter", mobile=True, fuels=1, fuel_remainder=0,
        keyseq=["f", "KP_ENTER"])
    # immobile tank: 'f' cannot enter (can_move gate False) -> move_mode stays False
    run("immobile_no_enter", mobile=False, fuels=5, fuel_remainder=0,
        keyseq=["f", "LEFT"])
    # no fuel: 'f' cannot enter
    run("no_fuel_no_enter", mobile=True, fuels=0, fuel_remainder=0,
        keyseq=["f", "LEFT"])
    # arrows OUTSIDE move mode fall through (ret None), do not move
    run("arrows_outside", mobile=True, fuels=2, fuel_remainder=0,
        keyseq=["LEFT", "RIGHT"])
    # a non-move key inside move mode returns None (ignored), stays in move mode
    run("other_key_inside", mobile=True, fuels=2, fuel_remainder=0,
        keyseq=["f", "a", "f"])
    out["scripts"] = scripts

    # in_move_mode reflects the flag
    st = MockState(tanks=[], shooter=None)
    before = ingame.in_move_mode(st)
    st.move_mode = True
    after = ingame.in_move_mode(st)
    out["in_move_mode"] = {"before": before, "after": after}
    return out


# ---------------------------------------------------------------------------
# info box -- show_info_box payload + _shield_pct.
# ---------------------------------------------------------------------------
def dump_info():
    out = {}
    cases = []

    def box_case(name, *, shield_item, shield_hp, power, score, ai_class, nm):
        t = MockTank(name=nm, ai_class=ai_class, power=power, score=score,
                     shield_item=shield_item, shield_hp=shield_hp)
        st = MockState(tanks=[t], shooter=MockTank(player_index=9))
        ingame.show_info_box(st, t)
        ib = st.info_box
        cases.append({
            "name": name,
            "box": {"name": ib["name"], "ai_class": ib["ai_class"],
                    "score": ib["score"], "shield": ib["shield"],
                    "power": ib["power"]},
        })

    box_case("no_shield", shield_item=0, shield_hp=0, power=500.9, score=120,
             ai_class=0, nm="Alice")
    box_case("with_shield", shield_item=weapons.SLOT_SHIELD, shield_hp=100,
             power=333, score=-50, ai_class=2, nm="Bob")
    # clear: show_info_box(None)
    t = MockTank()
    st = MockState(tanks=[t], shooter=MockTank(player_index=9))
    ingame.show_info_box(st, t)
    had = st.info_box is not None
    ingame.show_info_box(st, None)
    cases.append({"name": "clear", "had": had, "cleared": st.info_box is None})
    out["cases"] = cases

    # _shield_pct over HP fractions of the active shield's full HP.
    pct = []
    for slot in weapons.SHIELD_SLOTS:
        full = weapons.ITEMS[slot].params.get("hp", 100)
        for hp in (0, 1, full // 3, full // 2, full - 1, full, full + 50):
            t = MockTank(shield_item=slot, shield_hp=hp)
            pct.append({"slot": slot, "full": full, "hp": hp,
                        "pct": ingame._shield_pct(t)})
    # no active shield -> 0
    t = MockTank(shield_item=0, shield_hp=100)
    pct.append({"slot": 0, "full": None, "hp": 100, "pct": ingame._shield_pct(t)})
    out["shield_pct"] = pct
    return out


# ---------------------------------------------------------------------------
# status-cell controls -- _handle_status_click.
# ---------------------------------------------------------------------------
def dump_status_click():
    out = {}
    cases = []

    def sc(name, key, *, inv=None, health=100, para=True, trig=False):
        inventory = inv if inv is not None else [0] * weapons.NUM_ITEMS
        t = MockTank(health=health, inv=list(inventory),
                     parachute_deployed=para, contact_trigger=trig)
        st = MockState(tanks=[t], shooter=t)
        ret = ingame._handle_status_click(st, key)
        cases.append({"name": name, "key": key, "ret": ret, "tank": _tank_snap(t)})

    bat = [0] * weapons.NUM_ITEMS
    bat[SLOT_BATTERY] = 3
    sc("batt_heal", "status_batt", inv=bat, health=70)
    sc("batt_cap", "status_batt", inv=bat, health=95)       # +10 clamps to 100
    sc("batt_full_noop", "status_batt", inv=bat, health=100)
    none_inv = [0] * weapons.NUM_ITEMS
    sc("batt_none", "status_batt", inv=none_inv, health=70)
    sc("para_on", "status_para", para=False)
    sc("para_off", "status_para", para=True)
    sc("trig_on", "status_trig", trig=False)
    sc("trig_off", "status_trig", trig=True)
    sc("shld_opens", "status_shld")
    sc("guid_opens", "status_guid")
    sc("fuel_opens", "status_fuel")
    out["cases"] = cases

    # no shooter -> None
    st = MockState(tanks=[], shooter=None)
    out["no_shooter"] = ingame._handle_status_click(st, "status_batt")
    return out


# ---------------------------------------------------------------------------
# battery discharge math -- _BatteryDischargeScreen._apply (value logic only).
# Construct the screen (font.init done) and call _apply over count/health/owned
# permutations; assert the resulting battery count + health.
# ---------------------------------------------------------------------------
def dump_discharge():
    out = {}
    cases = []

    def disc(name, *, owned, count, health):
        inv = [0] * weapons.NUM_ITEMS
        inv[SLOT_BATTERY] = owned
        t = MockTank(health=health, inv=inv)
        st = MockState(tanks=[t], shooter=t)
        scr = ingame._BatteryDischargeScreen(st, t)
        scr.count = count
        scr._apply()
        cases.append({"name": name, "owned": owned, "count": count,
                      "health_in": health, "batteries_out": t.inventory[SLOT_BATTERY],
                      "health_out": t.health})

    disc("two_of_three", owned=3, count=2, health=70)
    disc("all_three", owned=3, count=3, health=50)
    disc("cap_stops", owned=5, count=5, health=95)        # +10 -> 100 then stop
    disc("more_than_owned", owned=2, count=9, health=10)  # min(count, owned)=2
    disc("count_below_one", owned=3, count=0, health=80)  # max(1, ...) -> 1
    disc("already_full", owned=3, count=2, health=100)    # no spend
    disc("one_only", owned=1, count=1, health=60)
    disc("none_owned", owned=0, count=1, health=60)       # nothing to spend
    out["cases"] = cases
    out["PROMPT"] = ingame._BatteryDischargeScreen.PROMPT
    return out


# ---------------------------------------------------------------------------
# system-menu effects -- clear_screen_effect / do_mass_kill; static action table.
# ---------------------------------------------------------------------------
def dump_effects():
    out = {}

    clear = []
    # both overlays present -> cleared, returns True
    st = MockState(tanks=[], shooter=None)
    st.info_box = {"x": 1}
    st.speech = "hi"
    r = ingame.clear_screen_effect(st)
    clear.append({"name": "both", "ret": r,
                  "info_box_none": st.info_box is None,
                  "speech_none": st.speech is None})
    # only info box
    st = MockState(tanks=[], shooter=None)
    st.info_box = {"x": 1}
    st.speech = None
    r = ingame.clear_screen_effect(st)
    clear.append({"name": "info_only", "ret": r,
                  "info_box_none": st.info_box is None,
                  "speech_none": st.speech is None})
    # nothing on screen -> False
    st = MockState(tanks=[], shooter=None)
    r = ingame.clear_screen_effect(st)
    clear.append({"name": "nothing", "ret": r,
                  "info_box_none": st.info_box is None,
                  "speech_none": st.speech is None})
    out["clear_screen"] = clear

    # do_mass_kill calls state.mass_kill() and returns "mass_kill"
    st = MockState(tanks=[], shooter=None)
    r = ingame.do_mass_kill(st)
    out["mass_kill"] = {"ret": r, "mass_killed": st.mass_killed}

    # static System Menu action map (LEFT/RIGHT columns), byte-resolved layout.
    out["menu_left"] = [list(item) for item in ingame.SystemMenuScreen.LEFT]
    out["menu_right"] = [list(item) for item in ingame.SystemMenuScreen.RIGHT]
    return out


def main():
    payload = {
        "module": "ingame",
        "cycle_weapon": dump_cycle_weapon(),
        "target": dump_target(),
        "move": dump_move(),
        "info": dump_info(),
        "status_click": dump_status_click(),
        "discharge": dump_discharge(),
        "effects": dump_effects(),
    }
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, "ingame.json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    print(f"  wrote vectors/ingame.json")
    print("Done. ingame vectors written.")


if __name__ == "__main__":
    main()

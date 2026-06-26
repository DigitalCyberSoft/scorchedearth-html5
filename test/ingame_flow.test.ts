/**
 * Real-path gate for src/ingame.ts: the in-round control panel + system menu +
 * the HUD mouse router + the press-and-hold aim ramp.
 *
 * WHY THIS EXISTS (vs test/ingame.test.ts):
 *   test/ingame.test.ts is the differential gate for ingame's DOM-free NUMERIC
 *   substrate (cycle_weapon / choose-target / fuel-move / status-cell math /
 *   discharge _apply). It deliberately does NOT construct the four Screen classes
 *   or call hud_hitboxes / _handle_hud_click, because widgets.Label and a
 *   width-less widgets.Button MEASURE pygame.font in their constructors (a Canvas2D
 *   / DOM op), and the Node test environment has no DOM. So those bodies -- the
 *   ControlPanelScreen / SystemMenuScreen / RetreatScreen / ReassignPlayersScreen
 *   dispatch, the HUD hit-box geometry, the bar-click router, and the mouse
 *   hold-ramp -- sat uncovered (ingame.ts was at ~43% lines).
 *
 *   This gate drives those REAL paths headless using the SAME seam ui_flow.test.ts
 *   established: pygame.font.SysFont is swapped for a deterministic MockFont (fixed
 *   char width + height), so the font-measured widget layout runs without a DOM and
 *   the geometry is reproducible. The mouse-state provider hook (the integrator
 *   seam ingame exposes) is wired to a controllable mock so _both_buttons_down /
 *   _mouse_hold_keys / update_game_input run. NO Canvas / pixel is touched (the
 *   .draw() methods build an overlay Surface, which needs a real canvas -- those
 *   stay deferred to the Phase-3 visual gate; see notes at the bottom).
 *
 * WHAT IS ASSERTED:
 *   This is a UI state machine, not a transcendental-math path, so (per the task's
 *   oracle policy) every assertion is against the DOCUMENTED action-string contract
 *   in ingame.ts's header + the behaviour read directly from the Python oracle
 *   scorch/ingame.py (the TS is a line-for-line port of it). Each test asserts a
 *   concrete RESULT: the action string returned AND the exact state mutation (tank
 *   fields, cfg, state.fired / state.retreated / state.info_box, shield arming,
 *   discharge math). No assertion is a bare "it ran"; coverage is the byproduct.
 *
 * EPSILON POLICY: every asserted value is an integer, a string, a boolean, null, or
 *   an exact rect -- all .toBe / .toEqual. The only geometry is integer //-layout
 *   measured with the deterministic MockFont, so there are no floats to approximate.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as pygame from "../src/pygame";
import * as ingame from "../src/ingame";
import * as widgets from "../src/widgets";
import * as movement from "../src/movement";
import * as C from "../src/constants";
import * as weapons from "../src/weapons";
import type { GameState, Tank, Cfg, IngameEvent, MouseState, InfoBox } from "../src/ingame";

// ---------------------------------------------------------------------------
// Deterministic font seam -- swap pygame.font.SysFont for a MockFont so the
// font-measured widgets (Label / width-less Button) + hud_hitboxes build headless
// with reproducible metrics. Done at module scope, BEFORE any test constructs a
// screen, so the first widgets.font()/_hud_font() call caches the mock. This is
// NOT mocking the system-under-test: it supplies a deterministic font metric so the
// real layout/handle logic (the code under test) runs, exactly as ui_flow.test.ts
// supplies a MockFont for the rankings draw walk.
// ---------------------------------------------------------------------------
const CW = 8; // px per character
const FH = 14; // line height (< 22 button h, < 26 panel row, so rows never overlap)
const mw = (s: string): number => CW * s.length;

class MockSurf {
  constructor(private _w: number) {}
  get_width(): number {
    return this._w;
  }
  get_height(): number {
    return FH;
  }
}
class MockFont {
  size(text: string): [number, number] {
    return [mw(text), FH];
  }
  get_height(): number {
    return FH;
  }
  render(text: string): MockSurf {
    return new MockSurf(mw(text));
  }
}
const _origSysFont = pygame.font.SysFont;
(pygame.font as { SysFont: unknown }).SysFont = (): MockFont => new MockFont();
afterAll(() => {
  (pygame.font as { SysFont: unknown }).SysFont = _origSysFont;
});

// ---------------------------------------------------------------------------
// Mouse-state provider seam -- one controllable mock the ingame hook reads.
// ---------------------------------------------------------------------------
const NEUTRAL: MouseState = { pressed: [false, false, false], pos: [0, 0] };
let mouse: MouseState = { pressed: [false, false, false], pos: [0, 0] };
ingame.setMouseStateProvider(() => mouse);
beforeEach(() => {
  mouse = { pressed: [...NEUTRAL.pressed] as [boolean, boolean, boolean], pos: [...NEUTRAL.pos] as [number, number] };
});

// ---------------------------------------------------------------------------
// Mocks -- the subset of objects.Tank / GameState the in-round layer reads,
// structurally identical to oracle/dump_ingame.py + test/ingame.test.ts.
// ---------------------------------------------------------------------------
interface TankOpts {
  player_index?: number;
  name?: string;
  ai_class?: number;
  x?: number;
  y?: number;
  half_width?: number;
  angle?: number;
  power?: number;
  health?: number;
  alive?: boolean;
  mobile?: boolean;
  shield_item?: number;
  shield_hp?: number;
  parachute_deployed?: boolean;
  contact_trigger?: boolean;
  selected_guidance?: number | null;
  selected_weapon?: number;
  inv?: number[];
  fuel_remainder?: number;
  score?: number;
}

class MockTank implements Tank {
  player_index: number;
  name: string;
  ai_class: number;
  x: number;
  y: number;
  half_width: number;
  angle: number;
  power: number;
  health: number;
  alive: boolean;
  mobile: boolean;
  shield_hp: number;
  shield_item: number;
  shield_push = false;
  shield_deflect = false;
  shield_laserproof = false;
  shield_failproof = false;
  parachute_deployed: boolean;
  contact_trigger: boolean;
  selected_guidance: number | null;
  guidance_target: Tank | null = null;
  guidance_target_pt: [number, number] | null = null;
  selected_weapon: number;
  inventory: number[];
  fuel_remainder: number;
  score: number;
  color = 1;
  win_counter = 0;
  cash = 0;

  constructor(o: TankOpts = {}) {
    this.player_index = o.player_index ?? 0;
    this.name = o.name ?? "P1";
    this.ai_class = o.ai_class ?? C.AI_HUMAN;
    this.x = o.x ?? 100;
    this.y = o.y ?? 100;
    this.half_width = o.half_width ?? 7;
    this.angle = o.angle ?? 45;
    this.power = o.power ?? 500;
    this.health = o.health ?? 100;
    this.alive = o.alive ?? true;
    this.mobile = o.mobile ?? true;
    this.shield_hp = o.shield_hp ?? 0;
    this.shield_item = o.shield_item ?? 0;
    this.parachute_deployed = o.parachute_deployed ?? true;
    this.contact_trigger = o.contact_trigger ?? false;
    this.selected_guidance = o.selected_guidance ?? null;
    this.selected_weapon = o.selected_weapon ?? 0;
    this.inventory = o.inv ? o.inv.slice() : new Array<number>(weapons.NUM_ITEMS).fill(0);
    this.fuel_remainder = o.fuel_remainder ?? 0;
    this.score = o.score ?? 0;
  }
  get fuel(): number {
    return this.inventory[weapons.SLOT_FUEL] * 10 + this.fuel_remainder;
  }
  get batteries(): number {
    return this.inventory[weapons.SLOT_BATTERY];
  }
  has_ammo(slot: number): boolean {
    return slot === weapons.SLOT_BABY_MISSILE || this.inventory[slot] > 0;
  }
}

class MockCfg implements Cfg {
  private _play_mode: number;
  private _status_bar: boolean;
  SOUND: string;
  [key: string]: unknown;
  constructor(play_mode = C.PLAYMODE_SEQUENTIAL, status_bar = false, sound = true) {
    this._play_mode = play_mode;
    this._status_bar = status_bar;
    this.SOUND = sound ? "ON" : "OFF";
  }
  get play_mode(): number {
    return this._play_mode;
  }
  is_on(key: string): boolean {
    if (key === "STATUS_BAR") return this._status_bar;
    if (key === "SOUND") return this.SOUND === "ON";
    return false;
  }
}

class MockTerrain implements movement.MovementTerrain {
  constructor(private _top = 300) {}
  column_top(_x: number): number {
    return this._top;
  }
}

class MockState implements GameState {
  phase: string;
  tanks: Tank[];
  current_shooter: Tank | null;
  cfg: Cfg;
  w: number;
  h: number;
  terrain: movement.MovementTerrain;
  target_mode = false;
  move_mode = false;
  info_box: InfoBox | null = null;
  speech: unknown = null;
  _hud_hitboxes: { [k: string]: pygame.Rect } | null = null;
  fired = 0;
  mass_killed = 0;
  retreated: Tank[] = [];
  settled: Tank[] = [];
  constructor(o: {
    tanks?: Tank[];
    shooter?: Tank | null;
    phase?: string;
    cfg?: Cfg;
    w?: number;
    h?: number;
    terrain?: movement.MovementTerrain;
  } = {}) {
    this.phase = o.phase ?? "aim";
    this.tanks = o.tanks ?? [];
    this.current_shooter = o.shooter ?? null;
    this.cfg = o.cfg ?? new MockCfg();
    this.w = o.w ?? 1024;
    this.h = o.h ?? 768;
    this.terrain = o.terrain ?? new MockTerrain();
  }
  fire(): void {
    this.fired += 1;
  }
  mass_kill(): void {
    this.mass_killed += 1;
  }
  retreat(tank: Tank): void {
    this.retreated.push(tank);
  }
  _settle_tank(tank: Tank): void {
    this.settled.push(tank);
  }
}

// ---------------------------------------------------------------------------
// Event + widget-driver helpers (drive REAL Panel.handle, never reimplement it).
// ---------------------------------------------------------------------------
const MD = pygame.MOUSEBUTTONDOWN;
const KD = pygame.KEYDOWN;

function md(pos: [number, number], button = 1): IngameEvent {
  return { type: MD, button, pos };
}
function kd(key: number, unicode?: string): IngameEvent {
  return { type: KD, key, unicode };
}

/** First widget in a panel whose `action` equals `a` (throws if absent so a
 *  layout regression is loud, not a silent no-op). */
function byAction(p: widgets.Panel, a: string): widgets.Widget {
  const w = p.widgets.find((x) => x.action === a);
  if (!w) throw new Error(`no widget with action ${a}`);
  return w;
}
/** First widget whose label contains `sub`. */
function byLabel(p: widgets.Panel, sub: string): widgets.Widget {
  const w = p.widgets.find((x) => x.label.includes(sub));
  if (!w) throw new Error(`no widget with label ~ ${sub}`);
  return w;
}
/** The center point of a widget's rect (always inside its half-open collide box). */
function center(w: widgets.Widget): [number, number] {
  const c = w.rect.center;
  return [c[0], c[1]];
}

const GUIDANCE: number[] = [];
for (let i = 0; i < weapons.NUM_ITEMS; i++) {
  if (weapons.ITEMS[i].category === "guidance") GUIDANCE.push(i);
}
const FIRST_GUID = GUIDANCE[0];
const FIRST_SHIELD = weapons.SHIELD_SLOTS[0];

// ===========================================================================
// hud_hitboxes -- the in-round HUD layout (font-measured; formula-faithful).
// ===========================================================================
describe("ingame_flow: hud_hitboxes geometry (render.py formula, deterministic font)", () => {
  it("no shooter -> empty box set", () => {
    const st = new MockState({ tanks: [], shooter: null });
    expect(ingame.hud_hitboxes(st)).toEqual({});
  });

  it("STATUS_BAR off: power/angle/name/weapon rects match the formula exactly", () => {
    const t = new MockTank({ name: "P1", angle: 45, power: 500, selected_weapon: weapons.SLOT_BABY_MISSILE });
    const st = new MockState({ tanks: [t], shooter: t, w: 1024 });
    const b = ingame.hud_hitboxes(st);
    expect(Object.keys(b).sort()).toEqual(["angle", "name", "power", "weapon"]);
    // power: "Power: 500" at (6,4)
    expect([b["power"].x, b["power"].y, b["power"].w, b["power"].h]).toEqual([6, 4, mw("Power: 500"), FH]);
    // angle: elev 45, side R -> "Angle: 45R" at (150,4)
    expect([b["angle"].x, b["angle"].y, b["angle"].w, b["angle"].h]).toEqual([150, 4, mw("Angle: 45R"), FH]);
    // name: centered. nx = w//2 - nameW//2
    const nameW = mw("P1");
    expect([b["name"].x, b["name"].y, b["name"].w, b["name"].h]).toEqual([
      Math.floor(1024 / 2) - Math.floor(nameW / 2),
      4,
      nameW,
      FH,
    ]);
    // weapon: slot 0 -> name alone; x_icon = w-8-tw-icon_w-4, rect to w-8
    const label = weapons.ITEMS[weapons.SLOT_BABY_MISSILE].name;
    const xIcon = 1024 - 8 - mw(label) - 14 - 4;
    expect([b["weapon"].x, b["weapon"].y, b["weapon"].w, b["weapon"].h]).toEqual([
      xIcon,
      2,
      1024 - 8 - xIcon,
      FH + 2,
    ]);
  });

  it("angle word flips to the L side for angle > 90 (elev = 180 - angle)", () => {
    const t = new MockTank({ angle: 130 });
    const st = new MockState({ tanks: [t], shooter: t });
    const b = ingame.hud_hitboxes(st);
    expect(b["angle"].w).toBe(mw("Angle: 50L")); // 180-130 = 50, side L
  });

  it("non-slot-0 weapon readout uses the '<count>: <name>' label width", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[6] = 4; // MIRV slot, give ammo
    const t = new MockTank({ selected_weapon: 6, inv });
    const st = new MockState({ tanks: [t], shooter: t });
    const b = ingame.hud_hitboxes(st);
    const label = `${4}: ${weapons.ITEMS[6].name}`;
    const xIcon = 1024 - 8 - mw(label) - 14 - 4;
    expect(b["weapon"].x).toBe(xIcon);
  });

  it("STATUS_BAR on: the six status cells appear, y=BAR_H+2, in left-to-right order", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = 2;
    inv[weapons.SLOT_PARACHUTE] = 1;
    const t = new MockTank({ inv });
    const st = new MockState({ tanks: [t], shooter: t, cfg: new MockCfg(C.PLAYMODE_SEQUENTIAL, true) });
    const b = ingame.hud_hitboxes(st);
    for (const k of ["status_batt", "status_para", "status_shld", "status_guid", "status_trig", "status_fuel"]) {
      expect(b[k], `${k} present`).toBeDefined();
      expect(b[k].y, `${k} y`).toBe(22 + 2); // _BAR_H(22)+2
    }
    // cells march left-to-right (x strictly increases in draw order)
    const xs = ["status_batt", "status_para", "status_shld", "status_guid", "status_trig", "status_fuel"].map(
      (k) => b[k].x,
    );
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i], `cell ${i} x advances`).toBeGreaterThan(xs[i - 1]);
    }
    // the battery cell width is its text's measured width ("2 [batt]")
    expect(b["status_batt"].w).toBe(mw("2 [batt]"));
  });

  it("a recorded _hud_hitboxes frame is returned verbatim (render.py live rects win)", () => {
    const t = new MockTank();
    const st = new MockState({ tanks: [t], shooter: t });
    const recorded = { name: new pygame.Rect(1, 2, 3, 4) };
    st._hud_hitboxes = recorded;
    expect(ingame.hud_hitboxes(st)).toBe(recorded); // identity: no recompute
  });
});

// ===========================================================================
// handle_game_event mouse routing -- the real HUD bar router (steps 0-3).
// ===========================================================================
describe("ingame_flow: handle_game_event HUD click router (_handle_hud_click via the public entry)", () => {
  function shooterState(over: TankOpts = {}): { st: MockState; t: MockTank } {
    const t = new MockTank({ ai_class: C.AI_HUMAN, ...over });
    const st = new MockState({ tanks: [t], shooter: t, w: 1024 });
    return { st, t };
  }

  it("LEFT/RIGHT on the Power word steps power -/+1; clamped to 0..1000", () => {
    const { st, t } = shooterState({ power: 500 });
    const p = center(byBox(st, "power"));
    expect(ingame.handle_game_event(st, md(p, 1))).toBeNull(); // _consumed -> null
    expect(t.power).toBe(499); // LEFT = -1
    expect(ingame.handle_game_event(st, md(p, 3))).toBeNull();
    expect(t.power).toBe(500); // RIGHT = +1
  });

  it("LEFT/RIGHT on the Angle word steps the internal angle +/-1", () => {
    const { st, t } = shooterState({ angle: 90 });
    const p = center(byBox(st, "angle"));
    ingame.handle_game_event(st, md(p, 1)); // LEFT = CCW = +1 internal
    expect(t.angle).toBe(91);
    ingame.handle_game_event(st, md(p, 3)); // RIGHT = CW = -1
    expect(t.angle).toBe(90);
  });

  it("clicking the weapon readout cycles the owned offensive set (RIGHT=next, LEFT=prev)", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[6] = 3; // a second owned offensive slot (MIRV) so the cycle has somewhere to go
    const { st, t } = shooterState({ selected_weapon: weapons.SLOT_BABY_MISSILE, inv });
    const p = center(byBox(st, "weapon"));
    ingame.handle_game_event(st, md(p, 3)); // next
    expect(t.selected_weapon).toBe(6);
    ingame.handle_game_event(st, md(p, 1)); // prev -> back to slot 0
    expect(t.selected_weapon).toBe(weapons.SLOT_BABY_MISSILE);
  });

  it("LEFT on the name opens the control panel, RIGHT opens inventory", () => {
    const { st } = shooterState();
    expect(ingame.handle_game_event(st, md(center(byBox(st, "name")), 1))).toBe("open_control_panel");
    expect(ingame.handle_game_event(st, md(center(byBox(st, "name")), 3))).toBe("open_inventory");
  });

  it("status-bar battery cell discharges +10 health; para/trig toggle; shld/guid/fuel open the panel", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = 2;
    const t = new MockTank({ ai_class: C.AI_HUMAN, health: 70, inv, parachute_deployed: false, contact_trigger: false });
    const st = new MockState({ tanks: [t], shooter: t, cfg: new MockCfg(C.PLAYMODE_SEQUENTIAL, true) });
    expect(ingame.handle_game_event(st, md(center(byBox(st, "status_batt")), 1))).toBeNull();
    expect(t.health).toBe(80);
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(1);
    expect(ingame.handle_game_event(st, md(center(byBox(st, "status_para")), 1))).toBeNull();
    expect(t.parachute_deployed).toBe(true);
    expect(ingame.handle_game_event(st, md(center(byBox(st, "status_trig")), 1))).toBeNull();
    expect(t.contact_trigger).toBe(true);
    // selector-backed cells open the panel
    expect(ingame.handle_game_event(st, md(center(byBox(st, "status_shld")), 1))).toBe("open_control_panel");
    expect(ingame.handle_game_event(st, md(center(byBox(st, "status_guid")), 1))).toBe("open_control_panel");
    expect(ingame.handle_game_event(st, md(center(byBox(st, "status_fuel")), 1))).toBe("open_control_panel");
  });

  it("LEFT on a tank body opens its info box; LEFT on empty ground dismisses it (TABLE B)", () => {
    const shooter = new MockTank({ player_index: 0, ai_class: C.AI_HUMAN, x: 100, y: 100 });
    const enemy = new MockTank({ player_index: 1, name: "Enemy", x: 400, y: 400, score: 42 });
    const st = new MockState({ tanks: [shooter, enemy], shooter, w: 1024 });
    // click the enemy body (below the HUD bar, off every control)
    ingame.handle_game_event(st, md([enemy.x, enemy.y - 2], 1));
    expect(st.info_box).not.toBeNull();
    expect((st.info_box as InfoBox).name).toBe("Enemy");
    expect((st.info_box as InfoBox).score).toBe(42);
    // click empty ground -> dismiss
    ingame.handle_game_event(st, md([700, 500], 1));
    expect(st.info_box).toBeNull();
  });

  it("both mouse buttons held = FIRE (mask 3), checked before any aim handling", () => {
    const { st } = shooterState();
    mouse = { pressed: [true, false, true], pos: [10, 8] };
    expect(ingame.handle_game_event(st, md([10, 8], 1))).toBeNull();
    expect(st.fired).toBe(1); // state.fire() ran
  });

  it("ignores events when not the human's aim turn (phase/shooter/ai_class guards)", () => {
    const { st, t } = shooterState({ power: 500 });
    st.phase = "fly";
    expect(ingame.handle_game_event(st, md(center(byBox(st, "power")), 1))).toBeNull();
    expect(t.power).toBe(500); // untouched
    st.phase = "aim";
    t.ai_class = C.AI_MORON; // AI shooter -> not routed
    expect(ingame.handle_game_event(st, md(center(byBox(st, "power")), 1))).toBeNull();
    expect(t.power).toBe(500);
  });
});

/** hud_hitboxes box lookup helper (after the font swap it is browser-safe). */
function byBox(st: MockState, key: string): widgets.Widget {
  const r = ingame.hud_hitboxes(st)[key];
  if (!r) throw new Error(`no hud box ${key}`);
  // wrap the rect so center() works uniformly
  return { rect: r } as unknown as widgets.Widget;
}

// ===========================================================================
// update_game_input -- the press-and-hold aim ramp via the mouse-over-bar proxy.
// The proxy maps RIGHT-over-Power to UP and must ramp IDENTICALLY to the keyboard.
// ===========================================================================
describe("ingame_flow: update_game_input hold-ramp (mouse-over-bar == keyboard, gating)", () => {
  const DT = 1 / 60;
  function freshShooter(): { st: MockState; t: MockTank } {
    const t = new MockTank({ ai_class: C.AI_HUMAN, power: 500, angle: 90 });
    const st = new MockState({ tanks: [t], shooter: t, w: 1024 });
    return { st, t };
  }
  function run(st: MockState, keys: { [k: number]: boolean }, frames: number): void {
    for (let i = 0; i < frames; i++) ingame.update_game_input(st, DT, keys);
  }

  it("RIGHT button held over Power ramps power up by the SAME amount as holding UP", () => {
    // keyboard reference: UP held
    const kb = freshShooter();
    run(kb.st, { [pygame.K_UP]: true }, 90);
    expect(kb.t.power).toBeGreaterThan(500); // the ramp actually moved

    // mouse: RIGHT held with the cursor over the Power word, empty keyboard
    const ms = freshShooter();
    mouse = { pressed: [false, false, true], pos: [10, 8] }; // over power rect (6,4,..)
    run(ms.st, {}, 90);
    expect(ms.t.power).toBe(kb.t.power); // proxy == keyboard, exactly
  });

  it("LEFT button over Power ramps power DOWN like holding DOWN", () => {
    const ms = freshShooter();
    mouse = { pressed: [true, false, false], pos: [10, 8] };
    run(ms.st, {}, 90);
    expect(ms.t.power).toBeLessThan(500);
  });

  it("RIGHT/LEFT over the Angle word ramps the angle (CW/CCW)", () => {
    const cw = freshShooter();
    mouse = { pressed: [false, false, true], pos: [160, 8] }; // over angle rect (150,4,..)
    run(cw.st, {}, 90);
    expect(cw.t.angle).toBeLessThan(90); // RIGHT = CW = angle down

    const ccw = freshShooter();
    mouse = { pressed: [true, false, false], pos: [160, 8] };
    run(ccw.st, {}, 90);
    expect(ccw.t.angle).toBeGreaterThan(90);
  });

  it("no ramp when cursor is off the words, when neither button is down, or when BOTH are down", () => {
    for (const m of [
      { pressed: [false, false, true] as [boolean, boolean, boolean], pos: [500, 400] as [number, number] }, // off the bar
      { pressed: [false, false, false] as [boolean, boolean, boolean], pos: [10, 8] as [number, number] }, // neither
      { pressed: [true, false, true] as [boolean, boolean, boolean], pos: [10, 8] as [number, number] }, // both = fire, not ramp
    ]) {
      const s = freshShooter();
      mouse = m;
      run(s.st, {}, 90);
      expect(s.t.power, JSON.stringify(m)).toBe(500);
      expect(s.t.angle).toBe(90);
    }
  });

  it("does nothing outside the human's aim turn", () => {
    const s = freshShooter();
    s.st.phase = "settle";
    mouse = { pressed: [false, false, true], pos: [10, 8] };
    run(s.st, {}, 90);
    expect(s.t.power).toBe(500);
  });
});

// ===========================================================================
// ControlPanelScreen -- the real modal: value widgets mutate the live tank,
// discharge (direct + count-modal), move strip, fire/back/esc, wants_target.
// ===========================================================================
describe("ingame_flow: ControlPanelScreen dispatch (real widgets.Panel routing)", () => {
  function panelFor(over: TankOpts = {}): { cp: ingame.ControlPanelScreen; st: MockState; t: MockTank } {
    const t = new MockTank({ ai_class: C.AI_HUMAN, ...over });
    const st = new MockState({ tanks: [t], shooter: t, w: 1024, h: 768, terrain: new MockTerrain(300) });
    return { cp: new ingame.ControlPanelScreen(st, t), st, t };
  }

  it("the Remaining Power spinner steps the tank power by 5 (left/right click + right-button)", () => {
    const { cp, t } = panelFor({ power: 500 });
    const sp = byLabel(cp.panel, "Remaining Power") as widgets.Spinner;
    cp.handle(md([sp.rect.x + 5, sp.rect.center[1]], 1)); // left half -> -5
    expect(t.power).toBe(495);
    cp.handle(md([sp.rect.right - 5, sp.rect.center[1]], 1)); // right half -> +5
    expect(t.power).toBe(500);
    cp.handle(md(center(sp), 3)); // right button -> -5
    expect(t.power).toBe(495);
  });

  it("the Guidance selector arms the first guidance slot", () => {
    const { cp, t } = panelFor({ selected_guidance: null });
    cp.handle(md(center(byLabel(cp.panel, "~Guidance")), 1)); // cycle +1: None -> first guidance
    expect(t.selected_guidance).toBe(FIRST_GUID);
  });

  it("the Shields selector arms the first owned shield and copies its HP + push flag", () => {
    const { cp, t } = panelFor({ shield_item: 0, shield_hp: 0 });
    cp.handle(md(center(byLabel(cp.panel, "Shields")), 1)); // None -> first shield
    expect(t.shield_item).toBe(FIRST_SHIELD);
    const params = weapons.ITEMS[FIRST_SHIELD].params;
    expect(t.shield_hp).toBe(typeof params["hp"] === "number" ? params["hp"] : 100);
    expect(t.shield_push).toBe(Boolean(params["push"]));
  });

  it("Parachutes / Triggers toggles flip the tank flags", () => {
    const { cp, t } = panelFor({ parachute_deployed: false, contact_trigger: false });
    cp.handle(md(center(byLabel(cp.panel, "~Parachutes")), 1));
    expect(t.parachute_deployed).toBe(true);
    cp.handle(md(center(byLabel(cp.panel, "~Triggers")), 1));
    expect(t.contact_trigger).toBe(true);
  });

  it("Batteries with exactly one owned discharges directly (+10 health, no modal)", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = 1;
    const { cp, t } = panelFor({ health: 70, inv });
    expect(cp.handle(md(center(byAction(cp.panel, "discharge")), 1))).toBeNull();
    expect(cp.discharge_modal).toBeNull();
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(0);
    expect(t.health).toBe(80);
  });

  it("Batteries with none owned and full battery is a no-op (caller-visible: nothing changes)", () => {
    const { cp, t } = panelFor({ health: 70 }); // 0 batteries
    cp.handle(md(center(byAction(cp.panel, "discharge")), 1));
    expect(cp.discharge_modal).toBeNull();
    expect(t.health).toBe(70);
  });

  it("Batteries with >1 owned opens the count modal; Ok applies, Cancel reverts", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = 3;
    const { cp, t } = panelFor({ health: 70, inv });
    // open the modal
    expect(cp.handle(md(center(byAction(cp.panel, "discharge")), 1))).toBeNull();
    expect(cp.discharge_modal).not.toBeNull();
    expect(t.health).toBe(70); // nothing spent yet
    // while the modal is open, the panel routes ALL events to it (returns null)
    expect(cp.handle(kd(pygame.K_g, "g"))).toBeNull();
    // set the count to 2 and click Ok -> spends 2 (health 70 -> 90), modal closes + rebuild
    (cp.discharge_modal as ingame._BatteryDischargeScreen).count = 2;
    const ok = byAction((cp.discharge_modal as ingame._BatteryDischargeScreen).panel, "ok");
    cp.handle(md(center(ok), 1));
    expect(cp.discharge_modal).toBeNull();
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(1);
    expect(t.health).toBe(90);
  });

  it("the count modal Cancel button closes it and spends nothing", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = 3;
    const { cp, t } = panelFor({ health: 70, inv });
    cp.handle(md(center(byAction(cp.panel, "discharge")), 1)); // >1 -> opens modal
    expect(cp.discharge_modal).not.toBeNull();
    const cancel = byAction((cp.discharge_modal as ingame._BatteryDischargeScreen).panel, "back");
    cp.handle(md(center(cancel), 1));
    expect(cp.discharge_modal).toBeNull();
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(3); // untouched
    expect(t.health).toBe(70);
  });

  it("a mobile tank with fuel gets Move buttons that step it 1px and burn fuel", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_FUEL] = 2; // 20 fuel units
    const { cp, t } = panelFor({ x: 100, y: 299, mobile: true, inv });
    const fuel0 = t.fuel;
    expect(cp.handle(md(center(byAction(cp.panel, "move_left")), 1))).toBeNull();
    expect(t.x).toBe(99); // moved 1px left
    expect(t.fuel).toBeLessThan(fuel0); // fuel consumed
    cp.handle(md(center(byAction(cp.panel, "move_right")), 1));
    expect(t.x).toBe(100); // back 1px right
  });

  it("an immobile tank shows NO move buttons (can_move gate false)", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_FUEL] = 2;
    const { cp } = panelFor({ mobile: false, inv });
    expect(cp.panel.widgets.find((w) => w.action === "move_left")).toBeUndefined();
  });

  it("~Launch returns 'fire' and records action; ~Quit/Engage/Esc return 'back'", () => {
    const { cp } = panelFor();
    expect(cp.handle(md(center(byLabel(cp.panel, "~Launch")), 1))).toBe("fire");
    expect(cp.action).toBe("fire");

    const q = panelFor();
    expect(q.cp.handle(md(center(byLabel(q.cp.panel, "~Quit")), 1))).toBe("back");
    expect(q.cp.action).toBe("back");

    const e = panelFor();
    expect(e.cp.handle(md(center(byLabel(e.cp.panel, "Engage")), 1))).toBe("back");

    const esc = panelFor();
    expect(esc.cp.handle(kd(pygame.K_ESCAPE))).toBe("back");
  });

  it("wants_target is set on close iff a guidance is armed with no target chosen", () => {
    // armed guidance, no target -> wants_target true after fire
    const armed = panelFor({ selected_guidance: FIRST_GUID });
    armed.cp.handle(md(center(byLabel(armed.cp.panel, "~Launch")), 1));
    expect(armed.cp.wants_target).toBe(true);

    // no guidance -> false
    const none = panelFor({ selected_guidance: null });
    none.cp.handle(md(center(byLabel(none.cp.panel, "~Launch")), 1));
    expect(none.cp.wants_target).toBe(false);

    // guidance armed but a target already chosen -> false
    const done = panelFor({ selected_guidance: FIRST_GUID });
    done.t.guidance_target = new MockTank({ player_index: 7 });
    done.cp.handle(md(center(byLabel(done.cp.panel, "~Launch")), 1));
    expect(done.cp.wants_target).toBe(false);
  });

  it("update(dt) is an inert no-op (static modal)", () => {
    const { cp, t } = panelFor({ power: 321 });
    cp.update(0.016);
    expect(t.power).toBe(321);
  });
});

// ===========================================================================
// _BatteryDischargeScreen -- standalone Ok/Cancel routing over the real Spinner.
// ===========================================================================
describe("ingame_flow: _BatteryDischargeScreen standalone (Ok applies, Cancel/Esc backs out)", () => {
  function screen(owned: number, health: number): { scr: ingame._BatteryDischargeScreen; t: MockTank } {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = owned;
    const t = new MockTank({ health, inv });
    const st = new MockState({ tanks: [t], shooter: t });
    return { scr: new ingame._BatteryDischargeScreen(st, t), t };
  }

  it("Ok spends `count` batteries (+10 each, capped) and returns 'done'", () => {
    const { scr, t } = screen(3, 70);
    scr.count = 2;
    expect(scr.handle(md(center(byAction(scr.panel, "ok")), 1))).toBe("done");
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(1);
    expect(t.health).toBe(90);
  });

  it("Cancel returns 'back' and spends nothing", () => {
    const { scr, t } = screen(3, 70);
    expect(scr.handle(md(center(byAction(scr.panel, "back")), 1))).toBe("back");
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(3);
    expect(t.health).toBe(70);
  });

  it("Esc backs out (panel cancel_action)", () => {
    const { scr, t } = screen(3, 70);
    expect(scr.handle(kd(pygame.K_ESCAPE))).toBe("back");
    expect(t.inventory[weapons.SLOT_BATTERY]).toBe(3);
  });
});

// ===========================================================================
// SystemMenuScreen -- the two-column dropdown: action dispatch + confirm gates.
// ===========================================================================
describe("ingame_flow: SystemMenuScreen dispatch + confirm sub-flow", () => {
  function menu(): { sm: ingame.SystemMenuScreen; st: MockState } {
    const st = new MockState({ tanks: [], shooter: null, cfg: new MockCfg() });
    return { sm: new ingame.SystemMenuScreen(st), st };
  }
  function clickItem(sm: ingame.SystemMenuScreen, label: string, button = 1): string | null {
    return sm.handle(md(center(byAction(sm.panel, label)), button));
  }
  function clickConfirmYes(sm: ingame.SystemMenuScreen): string | null {
    const yes = byAction((sm.confirm as ingame._ConfirmScreen).panel, "yes");
    return sm.handle(md(center(yes), 1));
  }

  it("unconfirmed items return their action string straight away", () => {
    expect(clickItem(menu().sm, "~Clear Screen")).toBe("clear_screen");
    expect(clickItem(menu().sm, "Reassign ~Players")).toBe("reassign_players");
    expect(clickItem(menu().sm, "Reassign ~Teams")).toBe("reassign_teams");
    expect(clickItem(menu().sm, "Save ~Game")).toBe("save_game");
    expect(clickItem(menu().sm, "~Restore Game")).toBe("restore_game");
  });

  it("the '~C' accelerator routes Clear Screen too (Panel accel path)", () => {
    const { sm } = menu();
    expect(sm.handle(kd(pygame.K_c, "c"))).toBe("clear_screen");
  });

  it("Mass Kill / New Game / Quit Game raise a ~Yes confirm; Yes yields the action", () => {
    for (const [label, action] of [
      ["~Mass Kill", "mass_kill"],
      ["~New Game", "new_game"],
      ["~Quit Game", "quit_game"],
    ] as Array<[string, string]>) {
      const { sm } = menu();
      expect(clickItem(sm, label), `${label} opens confirm`).toBeNull();
      expect(sm.confirm, `${label} confirm built`).not.toBeNull();
      expect(clickConfirmYes(sm), `${label} confirmed`).toBe(action);
      expect(sm.confirm, `${label} confirm cleared`).toBeNull();
    }
  });

  it("cancelling a confirm (Esc) stays in the menu and clears the box", () => {
    const { sm } = menu();
    clickItem(sm, "~Mass Kill");
    expect(sm.confirm).not.toBeNull();
    expect(sm.handle(kd(pygame.K_ESCAPE))).toBeNull(); // back -> stay
    expect(sm.confirm).toBeNull();
  });

  it("the Sound toggle flips cfg.SOUND in place and returns null", () => {
    const { sm, st } = menu();
    expect(st.cfg.is_on("SOUND")).toBe(true);
    const toggle = sm.panel.widgets.find((w) => w instanceof widgets.Toggle) as widgets.Toggle;
    expect(sm.handle(md(center(toggle), 1))).toBeNull();
    expect(st.cfg.is_on("SOUND")).toBe(false);
  });

  it("Esc on the menu itself returns 'back'", () => {
    expect(menu().sm.handle(kd(pygame.K_ESCAPE))).toBe("back");
  });

  it("a state-less menu still confirms via the _SizeStub sizing path", () => {
    const sm = new ingame.SystemMenuScreen(null); // no GameState -> _SizeStub for the confirm
    expect(sm.handle(md(center(byAction(sm.panel, "~Mass Kill")), 1))).toBeNull();
    expect(clickConfirmYes(sm)).toBe("mass_kill");
  });
});

// ===========================================================================
// RetreatScreen -- the two-step humiliation confirm.
// ===========================================================================
describe("ingame_flow: RetreatScreen two-step confirm", () => {
  function retreat(): { rs: ingame.RetreatScreen; st: MockState; t: MockTank } {
    const t = new MockTank({ ai_class: C.AI_HUMAN });
    const st = new MockState({ tanks: [t], shooter: t });
    return { rs: new ingame.RetreatScreen(st), st, t };
  }
  function yes(rs: ingame.RetreatScreen): string | null {
    return rs.handle(md(center(byAction(rs.confirm.panel, "yes")), 1));
  }

  it("two confirmations call state.retreat(shooter) and return 'retreat_done'", () => {
    const { rs, st, t } = retreat();
    expect(yes(rs)).toBeNull(); // step 0 -> 1 (second prompt)
    expect(rs.step).toBe(1);
    expect(yes(rs)).toBe("retreat_done"); // step 1 -> retreat
    expect(st.retreated).toEqual([t]);
  });

  it("Esc at the first prompt aborts with 'back' (no retreat)", () => {
    const { rs, st } = retreat();
    expect(rs.handle(kd(pygame.K_ESCAPE))).toBe("back");
    expect(st.retreated).toEqual([]);
  });
});

// ===========================================================================
// ReassignPlayersScreen -- live edit of tank controller + name.
// ===========================================================================
describe("ingame_flow: ReassignPlayersScreen live edits", () => {
  function reassign(): { rp: ingame.ReassignPlayersScreen; tanks: MockTank[] } {
    const tanks = [
      new MockTank({ player_index: 0, name: "AA", ai_class: C.AI_HUMAN }),
      new MockTank({ player_index: 1, name: "BB", ai_class: C.AI_HUMAN }),
    ];
    const st = new MockState({ tanks, shooter: tanks[0] });
    return { rp: new ingame.ReassignPlayersScreen(st), tanks };
  }

  it("the controller selector changes a tank's ai_class in place (Human -> first AI)", () => {
    const { rp, tanks } = reassign();
    const sel = rp.panel.widgets.filter((w) => w instanceof widgets.Selector)[0] as widgets.Selector;
    rp.handle(md(center(sel), 1)); // cycle +1 -> ai_class 1
    expect(tanks[0].ai_class).toBe(1);
    expect(C.AI_NAMES[1]).toBeDefined(); // the option label exists (Human + 8 AIs)
  });

  it("the name field accepts typed characters into the live tank name", () => {
    const { rp, tanks } = reassign();
    const tf = rp.panel.widgets.filter((w) => w instanceof widgets.TextField)[0] as widgets.TextField;
    rp.handle(md(center(tf), 1)); // focus the field
    rp.handle(kd(pygame.K_x, "X"));
    rp.handle(kd(pygame.K_y, "Y"));
    expect(tanks[0].name).toBe("AAXY");
  });

  it("~Done returns 'back' (edits already applied live)", () => {
    const { rp } = reassign();
    expect(rp.handle(md(center(byAction(rp.panel, "back")), 1))).toBe("back");
  });
});

// ===========================================================================
// Keyboard router + the remaining real branches (gates, closures, no-ops).
// ===========================================================================
describe("ingame_flow: keyboard router + remaining real branches", () => {
  function human(over: TankOpts = {}): { st: MockState; t: MockTank } {
    const t = new MockTank({ ai_class: C.AI_HUMAN, ...over });
    const st = new MockState({ tanks: [t], shooter: t, w: 1024 });
    return { st, t };
  }

  it("'t'/'i'/'r' keys map to control-panel / inventory / retreat actions", () => {
    expect(ingame.handle_game_event(human().st, kd(pygame.K_t))).toBe("open_control_panel");
    expect(ingame.handle_game_event(human().st, kd(pygame.K_i))).toBe("open_inventory");
    expect(ingame.handle_game_event(human().st, kd(pygame.K_r))).toBe("retreat");
  });

  it("Esc closes an open info box (identify window)", () => {
    const { st, t } = human();
    ingame.show_info_box(st, t);
    expect(st.info_box).not.toBeNull();
    expect(ingame.handle_game_event(st, kd(pygame.K_ESCAPE))).toBeNull();
    expect(st.info_box).toBeNull();
  });

  it("in Choose Target mode, a digit targets that tank by number; Esc cancels", () => {
    const shooter = new MockTank({ player_index: 0, ai_class: C.AI_HUMAN, x: 100, y: 100 });
    const enemy = new MockTank({ player_index: 1, x: 150, y: 120, alive: true });
    const st = new MockState({ tanks: [shooter, enemy], shooter });
    st.target_mode = true;
    expect(ingame.handle_game_event(st, kd(pygame.K_2))).toBe("target_set"); // tank #2 = tanks[1]
    expect((shooter.guidance_target as MockTank).player_index).toBe(1);
    expect(st.target_mode).toBe(false);
    st.target_mode = true;
    expect(ingame.handle_game_event(st, kd(pygame.K_ESCAPE))).toBe("target_cancel");
    expect(st.target_mode).toBe(false);
  });

  it("in Choose Target mode, digit '0' means tank #10 and a non-digit key is ignored", () => {
    const shooter = new MockTank({ player_index: 0, ai_class: C.AI_HUMAN });
    const enemy = new MockTank({ player_index: 1, x: 150, y: 120 });
    const st = new MockState({ tanks: [shooter, enemy], shooter });
    st.target_mode = true;
    // '0' -> tank #10; only 2 tanks here, so nothing is targeted (null), picker stays
    expect(ingame.handle_game_event(st, kd(pygame.K_0))).toBeNull();
    expect(shooter.guidance_target).toBeNull();
    expect(st.target_mode).toBe(true);
    // a non-digit, non-Esc key inside the picker is swallowed (returns null, no pick)
    expect(ingame.handle_game_event(st, kd(pygame.K_z))).toBeNull();
    expect(shooter.guidance_target).toBeNull();
    expect(st.target_mode).toBe(true);
  });

  it("update_game_input ignores a non-human shooter (ai_class guard)", () => {
    const { st, t } = human({ ai_class: C.AI_MORON, power: 500 });
    mouse = { pressed: [false, false, true], pos: [10, 8] };
    for (let i = 0; i < 90; i++) ingame.update_game_input(st, 1 / 60, {});
    expect(t.power).toBe(500);
  });

  it("SIMULTANEOUS mode disables the auto Choose-Target gate (a HUD click is NOT captured)", () => {
    const t = new MockTank({ ai_class: C.AI_HUMAN, selected_guidance: FIRST_GUID, power: 500 });
    const st = new MockState({ tanks: [t], shooter: t, cfg: new MockCfg(C.PLAYMODE_SIMULTANEOUS), w: 1024 });
    // a guided weapon is armed, but in SIMULTANEOUS the picker is off, so a click on
    // the Power word steps power instead of being eaten by the target picker.
    ingame.handle_game_event(st, md(center(byBox(st, "power")), 1));
    expect(t.power).toBe(499);
    expect(t.guidance_target).toBeNull();
  });

  it("set_target with no shooter is a safe no-op", () => {
    const st = new MockState({ tanks: [], shooter: null });
    const t = new MockTank();
    expect(() => ingame.set_target(st, t, [5, 6])).not.toThrow();
    expect(t.guidance_target).toBeNull();
  });

  it("the discharge-count Spinner get/set closures bind to screen.count", () => {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    inv[weapons.SLOT_BATTERY] = 3;
    const t = new MockTank({ health: 70, inv });
    const scr = new ingame._BatteryDischargeScreen(new MockState({ tanks: [t], shooter: t }), t);
    const sp = scr.panel.widgets.find((w) => w instanceof widgets.Spinner) as widgets.Spinner;
    scr.handle(md([sp.rect.right - 5, sp.rect.center[1]], 1)); // right half -> +1
    expect(scr.count).toBe(2);
    scr.update(0.016);
    expect(scr.count).toBe(2); // update() is an inert no-op
  });

  it("ControlPanel Shields selector can cycle back to None (clears shield_item/hp)", () => {
    const t = new MockTank({ ai_class: C.AI_HUMAN, shield_item: FIRST_SHIELD, shield_hp: 55 });
    const st = new MockState({ tanks: [t], shooter: t, w: 1024, h: 768 });
    const cp = new ingame.ControlPanelScreen(st, t);
    cp.handle(md(center(byLabel(cp.panel, "Shields")), 3)); // right-click cycle -1 -> None
    expect(t.shield_item).toBe(0);
    expect(t.shield_hp).toBe(0);
  });

  it("_ConfirmScreen: Yes -> action, neutral event -> null, Esc -> back", () => {
    const mk = (): ingame._ConfirmScreen => new ingame._ConfirmScreen(new MockState(), "Sure?", "do_it");
    const cs = mk();
    expect(cs.handle(md(center(byAction(cs.panel, "yes")), 1))).toBe("do_it");
    const cs2 = mk();
    expect(cs2.handle({ type: pygame.MOUSEMOTION, pos: [0, 0] })).toBeNull();
    cs2.update(0.016); // inert: the box still resolves Yes afterwards
    expect(cs2.handle(md(center(byAction(cs2.panel, "yes")), 1))).toBe("do_it");
    const cs3 = mk();
    expect(cs3.handle(kd(pygame.K_ESCAPE))).toBe("back");
  });

  it("an open confirm swallows neutral events (SystemMenu + Retreat stay put)", () => {
    const sm = new ingame.SystemMenuScreen(new MockState({ tanks: [], shooter: null, cfg: new MockCfg() }));
    sm.handle(md(center(byAction(sm.panel, "~Mass Kill")), 1)); // open confirm
    expect(sm.handle({ type: pygame.MOUSEMOTION, pos: [0, 0] })).toBeNull();
    expect(sm.confirm).not.toBeNull();
    sm.update(0.016);
    expect(sm.confirm).not.toBeNull(); // update() is inert: the confirm stays open

    const t = new MockTank({ ai_class: C.AI_HUMAN });
    const rs = new ingame.RetreatScreen(new MockState({ tanks: [t], shooter: t }));
    expect(rs.handle({ type: pygame.MOUSEMOTION, pos: [0, 0] })).toBeNull();
    rs.update(0.016);
    expect(rs.step).toBe(0);
  });

  it("ReassignPlayersScreen.update is inert", () => {
    const t = new MockTank({ name: "ZZ" });
    const rp = new ingame.ReassignPlayersScreen(new MockState({ tanks: [t], shooter: t }));
    rp.update(0.016);
    expect(t.name).toBe("ZZ");
  });
});

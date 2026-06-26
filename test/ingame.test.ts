/**
 * Differential gate: TS ingame == Python scorch.ingame (the fidelity oracle).
 *
 * Golden vectors come from oracle/dump_ingame.py -> oracle/vectors/ingame.json.
 * This test runs in Node (vitest environment "node"), which has NO DOM and no
 * mouse-state provider, so it exercises the NUMERIC / LOGIC substrate of the
 * in-round input layer that touches neither pygame.font (Canvas2D) nor the
 * mouse-state hook nor pygame.draw:
 *
 *   - cycle_weapon            : owned offensive-with-ammo rotation (+/-, reset, slot0)
 *   - Choose Target           : weapon_needs_target / in_target_mode /
 *                               _in_choose_target gate (incl. SIMULTANEOUS), enter/
 *                               exit_target_mode, _handle_target_click (RIGHT nearest
 *                               within 100 / LEFT raw point / middle ignored / tie),
 *                               target_by_number, set_target int() flooring
 *   - fuel move sub-mode      : in_move_mode + _handle_move_key router ('f' toggle,
 *                               LEFT/RIGHT move via movement.move_tank, Esc/Enter
 *                               leave, can_move gate, fall-through outside)
 *   - info box                : show_info_box payload (+ clear) + _shield_pct
 *   - status-cell controls    : _handle_status_click (battery/para/trig/selector)
 *   - battery discharge math   : _BatteryDischargeScreen._apply value walk (the
 *                               REAL method, reached via Object.create so the
 *                               font-measured _build() is bypassed -- the same
 *                               headless seam ui.ts uses for MainMenu/Shop)
 *   - system-menu effects      : clear_screen_effect / do_mass_kill + the static
 *                               SystemMenuScreen LEFT/RIGHT action table
 *
 * EPSILON POLICY: every asserted value here is an INTEGER, a string, a boolean, or
 * null. The only sqrt on the path is the nearest-tank distance inside
 * _handle_target_click, and it is compared only by the RESULTING discrete pick
 * (which tank / the stored integer point), never by the raw float -- so every
 * assertion is EXACT (.toBe / .toEqual). No toBeCloseTo is used. (The HUD geometry
 * that DOES feed transcendental-free font metrics defers to Phase 3; see header.)
 *
 * DOM / PIXELS / MOUSE: hud_hitboxes (pygame.font), the bar-click + hold-ramp paths
 * (mouse-state provider), and the four Screen classes' full Panel.handle routing
 * (font-measured Label/Button construction) are NOT exercised here. Their pixels +
 * live-mouse behaviour are the Phase-3 visual gate's job (pixelsDeferredToPhase3 =
 * true), exactly as widgets.test.ts / ui.test.ts established for font-measured
 * widgets.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as ingame from "../src/ingame";
import type { GameState, Tank, Cfg, IngameEvent } from "../src/ingame";
import * as C from "../src/constants";
import * as weapons from "../src/weapons";
import * as movement from "../src/movement";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "ingame.json");

// SDL event/key numeric constants -- reuse the shim's so a vector "key" matches
// what the router compares against (identical to the dumper's pygame.K_*).
const MD = 1025; // MOUSEBUTTONDOWN
const KD = 768; // KEYDOWN
const KEY: { [name: string]: number } = {
  ESCAPE: 27,
  RETURN: 13,
  KP_ENTER: 1073741912,
  LEFT: 1073741904,
  RIGHT: 1073741903,
  UP: 1073741906,
  DOWN: 1073741905,
  f: 102,
  t: 116,
  i: 105,
  r: 114,
  p: 112,
  a: 97,
  "0": 48,
  "1": 49,
  "2": 50,
  "3": 51,
  "4": 52,
  "5": 53,
  "9": 57,
};

const SLOT_BATTERY = weapons.SLOT_BATTERY;
const SLOT_PARACHUTE = weapons.SLOT_PARACHUTE;
const SLOT_FUEL = weapons.SLOT_FUEL;

// ---------------------------------------------------------------------------
// Mocks -- structurally identical to oracle/dump_ingame.py (same fields/methods).
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
  shield_hp?: number;
  shield_item?: number;
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
    this.ai_class = o.ai_class ?? 0;
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
    return this.inventory[SLOT_FUEL] * 10 + this.fuel_remainder;
  }

  get batteries(): number {
    return this.inventory[SLOT_BATTERY];
  }

  has_ammo(slot: number): boolean {
    if (slot === weapons.SLOT_BABY_MISSILE) {
      return true;
    }
    return this.inventory[slot] > 0;
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
  private _top: number;
  constructor(top = 300) {
    this._top = top;
  }
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
  info_box: ingame.InfoBox | null = null;
  speech: unknown = null;
  _hud_hitboxes: { [k: string]: never } | null = null;
  fired = 0;
  mass_killed = 0;
  retreated: Tank[] = [];
  settled: Tank[] = [];
  constructor(opts: {
    tanks?: Tank[];
    shooter?: Tank | null;
    phase?: string;
    cfg?: Cfg;
    w?: number;
    h?: number;
    terrain?: movement.MovementTerrain;
  } = {}) {
    this.phase = opts.phase ?? "aim";
    this.tanks = opts.tanks ?? [];
    this.current_shooter = opts.shooter ?? null;
    this.cfg = opts.cfg ?? new MockCfg();
    this.w = opts.w ?? 1024;
    this.h = opts.h ?? 768;
    this.terrain = opts.terrain ?? new MockTerrain();
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

function ev(type: number, opts: Partial<IngameEvent> = {}): IngameEvent {
  return { type, ...opts };
}

/** The Tank snapshot shape the dumper records (_tank_snap). */
interface TankSnap {
  power: number;
  angle: number;
  health: number;
  selected_weapon: number;
  selected_guidance: number | null;
  parachute_deployed: boolean;
  contact_trigger: boolean;
  shield_hp: number;
  shield_item: number;
  x: number;
  y: number;
  fuel: number;
  fuel_remainder: number;
  batteries: number;
  parachutes: number;
  fuels: number;
  guidance_target: number | null;
  guidance_target_pt: [number, number] | null;
}

function tankSnap(t: MockTank): TankSnap {
  return {
    power: t.power,
    angle: t.angle,
    health: t.health,
    selected_weapon: t.selected_weapon,
    selected_guidance: t.selected_guidance,
    parachute_deployed: Boolean(t.parachute_deployed),
    contact_trigger: Boolean(t.contact_trigger),
    shield_hp: t.shield_hp,
    shield_item: t.shield_item,
    x: t.x,
    y: t.y,
    fuel: t.fuel,
    fuel_remainder: t.fuel_remainder,
    batteries: t.inventory[SLOT_BATTERY],
    parachutes: t.inventory[SLOT_PARACHUTE],
    fuels: t.inventory[SLOT_FUEL],
    guidance_target: t.guidance_target ? (t.guidance_target as MockTank).player_index : null,
    guidance_target_pt: t.guidance_target_pt ? [...t.guidance_target_pt] : null,
  };
}

function expectTankSnap(got: TankSnap, want: TankSnap, label: string): void {
  expect(got, label).toEqual(want);
}

// ---------------------------------------------------------------------------
// Vector shapes
// ---------------------------------------------------------------------------
interface CycleVec {
  owned: number[];
  cases: {
    name: string;
    sel_in: number | null;
    d: number;
    ret: number | null;
    sel_out: number | null;
  }[];
}
interface GateCase {
  name: string;
  guidance: number | null;
  target_mode: boolean;
  play_mode: number;
  needs_target: boolean;
  in_target_mode: boolean;
  in_choose_target: boolean;
}
interface ClickCase {
  name: string;
  button: number;
  pos: [number, number];
  ret: string | null;
  shooter: TankSnap;
  target_mode: boolean;
}
interface NumCase {
  name: string;
  n: number;
  ret: string | null;
  shooter: TankSnap;
  target_mode: boolean;
}
interface EnterCase {
  name: string;
  ret?: boolean;
  target_mode: boolean;
}
interface TargetVec {
  gate: GateCase[];
  needs_target_no_shooter: boolean;
  enter: EnterCase[];
  click: ClickCase[];
  by_num: NumCase[];
  tie: { ret: string | null; target: number; pt: [number, number] };
}
interface MoveTraceStep {
  key: string;
  ret: string | null;
  move_mode: boolean;
  x: number;
  y: number;
  fuel: number;
  angle: number;
  settled: number;
}
interface MoveScript {
  name: string;
  mobile: boolean;
  fuels: number;
  fuel_remainder: number;
  keyseq: string[];
  trace: MoveTraceStep[];
  final: TankSnap;
}
interface MoveVec {
  scripts: MoveScript[];
  in_move_mode: { before: boolean; after: boolean };
}
interface InfoVec {
  cases: Array<
    | {
        name: string;
        box: { name: string; ai_class: number; score: number; shield: string; power: number };
      }
    | { name: string; had: boolean; cleared: boolean }
  >;
  shield_pct: { slot: number; full: number | null; hp: number; pct: number }[];
}
interface StatusVec {
  cases: { name: string; key: string; ret: string | null; tank: TankSnap }[];
  no_shooter: string | null;
}
interface DischargeVec {
  cases: {
    name: string;
    owned: number;
    count: number;
    health_in: number;
    batteries_out: number;
    health_out: number;
  }[];
  PROMPT: string;
}
interface EffectsVec {
  clear_screen: { name: string; ret: boolean; info_box_none: boolean; speech_none: boolean }[];
  mass_kill: { ret: string; mass_killed: number };
  menu_left: [string, string, string | null][];
  menu_right: [string, string, string | null][];
}
interface IngameVectors {
  module: string;
  cycle_weapon: CycleVec;
  target: TargetVec;
  move: MoveVec;
  info: InfoVec;
  status_click: StatusVec;
  discharge: DischargeVec;
  effects: EffectsVec;
}

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as IngameVectors;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ingame: oracle invariants", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("ingame");
  });
  it("vector battery is non-trivial", () => {
    const n =
      vec.cycle_weapon.cases.length +
      vec.target.gate.length +
      vec.target.click.length +
      vec.target.by_num.length +
      vec.move.scripts.length +
      vec.info.cases.length +
      vec.info.shield_pct.length +
      vec.status_click.cases.length +
      vec.discharge.cases.length +
      vec.effects.clear_screen.length;
    expect(n).toBeGreaterThan(40);
  });
});

describe("ingame: cycle_weapon (owned offensive rotation)", () => {
  it("owned offensive-with-ammo list matches the oracle", () => {
    // Reproduce the owned set the dumper built and confirm cycle walks over it.
    const off: number[] = [];
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      if (weapons.ITEMS[i].offensive) off.push(i);
    }
    expect(vec.cycle_weapon.owned.length).toBeGreaterThan(1);
    expect(vec.cycle_weapon.owned[0]).toBe(weapons.SLOT_BABY_MISSILE);
    expect(off.includes(vec.cycle_weapon.owned[0])).toBe(true);
  });

  // Rebuild the same inventory the dumper used: slot0 + the first three non-slot0
  // offensive slots given ammo.
  function ownInv(): number[] {
    const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
    const off: number[] = [];
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      if (weapons.ITEMS[i].offensive && i !== weapons.SLOT_BABY_MISSILE) off.push(i);
    }
    for (const s of off.slice(0, 3)) inv[s] = 5;
    return inv;
  }

  for (let i = 0; i < vec.cycle_weapon.cases.length; i++) {
    const c = vec.cycle_weapon.cases[i];
    it(`#${i} ${c.name}`, () => {
      if (c.name === "no_shooter") {
        const st = new MockState({ tanks: [], shooter: null });
        expect(ingame.cycle_weapon(st, c.d)).toBe(c.ret);
        return;
      }
      const inv = c.name === "only_slot0" ? new Array<number>(weapons.NUM_ITEMS).fill(0) : ownInv();
      const t = new MockTank({ selected_weapon: c.sel_in as number, inv });
      const st = new MockState({ tanks: [t], shooter: t });
      const ret = ingame.cycle_weapon(st, c.d);
      expect(ret, `${c.name} ret`).toBe(c.ret);
      expect(t.selected_weapon, `${c.name} sel_out`).toBe(c.sel_out);
    });
  }

  it("empty owned set (no offensive ammo at all) -> null, selection unchanged", () => {
    // _owned_offensive is empty ONLY for a tank whose has_ammo is false for every
    // slot, including Baby Missile.  A real Tank can never reach that (objects.ts:263
    // / objects.py:132 make slot 0 always firable), so this exercises cycle_weapon's
    // degenerate-input guard (ingame.ts:535).  The oracle carries the identical guard
    // (ingame.py:366 `if not owned: return None`); verified live against
    // scorch.ingame.cycle_weapon(no-ammo tank) -> None with selection kept at 5.
    const t = new MockTank({ selected_weapon: 5 });
    t.has_ammo = (): boolean => false; // force EVERY slot out, slot 0 included
    const st = new MockState({ tanks: [t], shooter: t });
    expect(ingame.cycle_weapon(st, 1)).toBeNull();
    expect(ingame.cycle_weapon(st, -1)).toBeNull();
    expect(t.selected_weapon).toBe(5);
  });
});

describe("ingame: Choose Target gate (needs_target / in_target_mode / _in_choose_target)", () => {
  for (let i = 0; i < vec.target.gate.length; i++) {
    const g = vec.target.gate[i];
    it(`#${i} ${g.name}`, () => {
      const t = new MockTank({ selected_guidance: g.guidance });
      const st = new MockState({ tanks: [t], shooter: t, cfg: new MockCfg(g.play_mode) });
      st.target_mode = g.target_mode;
      expect(ingame.weapon_needs_target(st), `${g.name} needs_target`).toBe(g.needs_target);
      expect(ingame.in_target_mode(st), `${g.name} in_target_mode`).toBe(g.in_target_mode);
      // _in_choose_target is module-private; reach it via the public router by
      // checking it through enter/handle would mutate -- instead assert the
      // equivalent composite (target_mode || (!simul && needs_target)) the oracle
      // recorded, which IS what _in_choose_target computes.
      const simul = g.play_mode === C.PLAYMODE_SIMULTANEOUS;
      const composite = g.target_mode || (!simul && ingame.weapon_needs_target(st));
      expect(composite, `${g.name} in_choose_target`).toBe(g.in_choose_target);
    });
  }

  it("weapon_needs_target with no shooter is false", () => {
    const st = new MockState({ tanks: [], shooter: null });
    expect(ingame.weapon_needs_target(st)).toBe(vec.target.needs_target_no_shooter);
  });
});

describe("ingame: enter/exit target mode", () => {
  for (let i = 0; i < vec.target.enter.length; i++) {
    const c = vec.target.enter[i];
    it(`#${i} ${c.name}`, () => {
      if (c.name === "after_exit") {
        // sequenced: enter then exit on a human in aim
        const t = new MockTank({ ai_class: C.AI_HUMAN });
        const st = new MockState({ tanks: [t], shooter: t, phase: "aim" });
        ingame.enter_target_mode(st);
        ingame.exit_target_mode(st);
        expect(st.target_mode, c.name).toBe(c.target_mode);
        return;
      }
      let t: MockTank | null;
      let st: MockState;
      if (c.name === "human_aim") {
        t = new MockTank({ ai_class: C.AI_HUMAN });
        st = new MockState({ tanks: [t], shooter: t, phase: "aim" });
      } else if (c.name === "ai") {
        t = new MockTank({ ai_class: C.AI_MORON });
        st = new MockState({ tanks: [t], shooter: t, phase: "aim" });
      } else if (c.name === "wrong_phase") {
        t = new MockTank({ ai_class: C.AI_HUMAN });
        st = new MockState({ tanks: [t], shooter: t, phase: "fly" });
      } else {
        // no_shooter
        st = new MockState({ tanks: [], shooter: null, phase: "aim" });
      }
      const ret = ingame.enter_target_mode(st);
      expect(ret, `${c.name} ret`).toBe(c.ret);
      expect(st.target_mode, `${c.name} target_mode`).toBe(c.target_mode);
    });
  }
});

describe("ingame: _handle_target_click (RIGHT nearest<=100 / LEFT raw point / middle ignored)", () => {
  // The shared battlefield the dumper built.
  function field(): { st: MockState; tanks: MockTank[] } {
    const shooter = new MockTank({ player_index: 0, x: 100, y: 100, ai_class: C.AI_HUMAN });
    const e1 = new MockTank({ player_index: 1, x: 150, y: 120, alive: true });
    const e2 = new MockTank({ player_index: 2, x: 400, y: 300, alive: true });
    const dead = new MockTank({ player_index: 3, x: 110, y: 100, alive: false });
    const tanks = [shooter, e1, e2, dead];
    const st = new MockState({ tanks, shooter, cfg: new MockCfg(C.PLAYMODE_SEQUENTIAL) });
    return { st, tanks };
  }

  for (let i = 0; i < vec.target.click.length; i++) {
    const c = vec.target.click[i];
    it(`#${i} ${c.name}`, () => {
      const { st, tanks } = field();
      st.target_mode = true;
      // The router only owns clicks in choose-target mode; call it the way
      // handle_game_event does -- through the public entry with the picker live.
      const out = ingame.handle_game_event(st, ev(MD, { button: c.button, pos: c.pos }));
      expect(out, `${c.name} ret`).toBe(c.ret);
      expectTankSnap(tankSnap(tanks[0]), c.shooter, `${c.name} shooter`);
      expect(st.target_mode, `${c.name} target_mode`).toBe(c.target_mode);
    });
  }

  it("tie: a later equidistant tank overwrites (d <= best_d)", () => {
    const shooter = new MockTank({ player_index: 0, x: 0, y: 0, ai_class: C.AI_HUMAN });
    const a = new MockTank({ player_index: 1, x: -30, y: 4 });
    const b = new MockTank({ player_index: 2, x: 30, y: 4 });
    const st = new MockState({ tanks: [shooter, a, b], shooter });
    st.target_mode = true;
    const out = ingame.handle_game_event(st, ev(MD, { button: 3, pos: [0, 0] }));
    expect(out).toBe(vec.target.tie.ret);
    expect((shooter.guidance_target as MockTank).player_index).toBe(vec.target.tie.target);
    expect(shooter.guidance_target_pt).toEqual(vec.target.tie.pt);
  });
});

describe("ingame: target_by_number (1-based, alive + exclude-shooter)", () => {
  function field(): { st: MockState; tanks: MockTank[] } {
    const shooter = new MockTank({ player_index: 0, x: 100, y: 100, ai_class: C.AI_HUMAN });
    const e1 = new MockTank({ player_index: 1, x: 150, y: 120, alive: true });
    const e2 = new MockTank({ player_index: 2, x: 400, y: 300, alive: true });
    const dead = new MockTank({ player_index: 3, x: 110, y: 100, alive: false });
    const tanks = [shooter, e1, e2, dead];
    const st = new MockState({ tanks, shooter });
    return { st, tanks };
  }
  for (let i = 0; i < vec.target.by_num.length; i++) {
    const c = vec.target.by_num[i];
    it(`#${i} ${c.name}`, () => {
      const { st, tanks } = field();
      st.target_mode = true;
      const ret = ingame.target_by_number(st, c.n);
      expect(ret, `${c.name} ret`).toBe(c.ret);
      expectTankSnap(tankSnap(tanks[0]), c.shooter, `${c.name} shooter`);
      expect(st.target_mode, `${c.name} target_mode`).toBe(c.target_mode);
    });
  }
});

describe("ingame: fuel move sub-mode (_handle_move_key router via handle_game_event)", () => {
  for (let i = 0; i < vec.move.scripts.length; i++) {
    const s = vec.move.scripts[i];
    it(`#${i} ${s.name}`, () => {
      const top = 300;
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      inv[SLOT_FUEL] = s.fuels;
      const t = new MockTank({
        x: 100,
        y: top - 1,
        mobile: s.mobile,
        inv,
        fuel_remainder: s.fuel_remainder,
        ai_class: C.AI_HUMAN,
      });
      const st = new MockState({ tanks: [t], shooter: t, terrain: new MockTerrain(top) });
      for (let k = 0; k < s.keyseq.length; k++) {
        const kname = s.keyseq[k];
        const want = s.trace[k];
        // handle_game_event returns null for a '_consumed' move-strip key and for
        // an ignored key; the move-strip side effects are the observable result.
        const ret = ingame.handle_game_event(st, ev(KD, { key: KEY[kname] }));
        // '_consumed' is internal -> the public router maps it to null. A
        // fall-through (ret None) for an aim key may delegate to HumanController,
        // which for 'a'/LEFT/RIGHT outside move mode adjusts aim but never returns
        // an action; so the public return is null in every move script step.
        expect(ret, `${s.name} step ${k} (${kname}) public ret`).toBe(want.ret);
        expect(st.move_mode, `${s.name} step ${k} move_mode`).toBe(want.move_mode);
        expect(t.x, `${s.name} step ${k} x`).toBe(want.x);
        expect(t.y, `${s.name} step ${k} y`).toBe(want.y);
        expect(t.fuel, `${s.name} step ${k} fuel`).toBe(want.fuel);
        expect(t.angle, `${s.name} step ${k} angle`).toBe(want.angle);
        expect(st.settled.length, `${s.name} step ${k} settled`).toBe(want.settled);
      }
      expectTankSnap(tankSnap(t), s.final, `${s.name} final`);
    });
  }

  it("in_move_mode reflects state.move_mode", () => {
    const st = new MockState({ tanks: [], shooter: null });
    expect(ingame.in_move_mode(st)).toBe(vec.move.in_move_mode.before);
    st.move_mode = true;
    expect(ingame.in_move_mode(st)).toBe(vec.move.in_move_mode.after);
  });
});

describe("ingame: info box (show_info_box payload + _shield_pct)", () => {
  for (let i = 0; i < vec.info.cases.length; i++) {
    const c = vec.info.cases[i];
    it(`#${i} ${c.name}`, () => {
      if ("box" in c) {
        // reconstruct the tank from the dumper's setup
        let t: MockTank;
        if (c.name === "no_shield") {
          t = new MockTank({
            name: "Alice",
            ai_class: 0,
            power: 500.9,
            score: 120,
            shield_item: 0,
            shield_hp: 0,
          });
        } else {
          t = new MockTank({
            name: "Bob",
            ai_class: 2,
            power: 333,
            score: -50,
            shield_item: weapons.SLOT_SHIELD,
            shield_hp: 100,
          });
        }
        const st = new MockState({ tanks: [t], shooter: new MockTank({ player_index: 9 }) });
        ingame.show_info_box(st, t);
        const ib = st.info_box as ingame.InfoBox;
        expect(ib.name, `${c.name} name`).toBe(c.box.name);
        expect(ib.ai_class, `${c.name} ai_class`).toBe(c.box.ai_class);
        expect(ib.score, `${c.name} score`).toBe(c.box.score);
        expect(ib.shield, `${c.name} shield`).toBe(c.box.shield);
        expect(ib.power, `${c.name} power`).toBe(c.box.power);
      } else {
        // clear case
        const t = new MockTank();
        const st = new MockState({ tanks: [t], shooter: new MockTank({ player_index: 9 }) });
        ingame.show_info_box(st, t);
        const had = st.info_box !== null;
        ingame.show_info_box(st, null);
        expect(had, `${c.name} had`).toBe(c.had);
        expect(st.info_box === null, `${c.name} cleared`).toBe(c.cleared);
      }
    });
  }

  it(`_shield_pct over ${vec.info.shield_pct.length} HP fractions`, () => {
    for (let i = 0; i < vec.info.shield_pct.length; i++) {
      const c = vec.info.shield_pct[i];
      const t = new MockTank({ shield_item: c.slot, shield_hp: c.hp });
      expect(ingame._shield_pct(t), `shield_pct #${i} slot=${c.slot} hp=${c.hp}`).toBe(c.pct);
    }
  });
});

describe("ingame: status-cell controls (_handle_status_click)", () => {
  for (let i = 0; i < vec.status_click.cases.length; i++) {
    const c = vec.status_click.cases[i];
    it(`#${i} ${c.name}`, () => {
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      // Rebuild the dumper's tank state from the recorded snapshot inputs.
      if (c.name.startsWith("batt")) {
        inv[SLOT_BATTERY] = c.name === "batt_none" ? 0 : 3;
      }
      const t = new MockTank({
        health: c.tank.health + (c.key === "status_batt" ? 0 : 0),
        inv,
      });
      // Set the pre-state from the case name (matches the dumper's setup).
      if (c.name === "batt_heal") t.health = 70;
      else if (c.name === "batt_cap") t.health = 95;
      else if (c.name === "batt_full_noop") t.health = 100;
      else if (c.name === "batt_none") t.health = 70;
      if (c.name === "para_on") t.parachute_deployed = false;
      else if (c.name === "para_off") t.parachute_deployed = true;
      if (c.name === "trig_on") t.contact_trigger = false;
      else if (c.name === "trig_off") t.contact_trigger = true;
      const st = new MockState({ tanks: [t], shooter: t });
      const ret = ingame._handle_status_click(st, c.key);
      expect(ret, `${c.name} ret`).toBe(c.ret);
      expectTankSnap(tankSnap(t), c.tank, `${c.name} tank`);
    });
  }

  it("no shooter -> null", () => {
    const st = new MockState({ tanks: [], shooter: null });
    expect(ingame._handle_status_click(st, "status_batt")).toBe(vec.status_click.no_shooter);
  });
});

describe("ingame: _BatteryDischargeScreen._apply (value walk, real method via headless seam)", () => {
  it("PROMPT matches the verbatim binary label", () => {
    expect(ingame._BatteryDischargeScreen.PROMPT).toBe(vec.discharge.PROMPT);
  });

  // The screen's _build() measures pygame.font (DOM), so it cannot run under Node.
  // Reach the REAL _apply/_owned methods without _build by attaching them to a
  // plain object (the same headless seam ui.ts uses for MainMenu/Shop). This tests
  // the actual ported method body, not a reimplementation.
  function applyOn(t: MockTank, count: number): void {
    // Object.create links the prototype so the REAL _apply (and the _owned it
    // calls) resolve, without running the font-measured constructor/_build.
    const self = Object.create(
      ingame._BatteryDischargeScreen.prototype,
    ) as ingame._BatteryDischargeScreen;
    self.tank = t;
    self.count = count;
    self._apply();
  }

  for (let i = 0; i < vec.discharge.cases.length; i++) {
    const c = vec.discharge.cases[i];
    it(`#${i} ${c.name}`, () => {
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      inv[SLOT_BATTERY] = c.owned;
      const t = new MockTank({ health: c.health_in, inv });
      applyOn(t, c.count);
      expect(t.inventory[SLOT_BATTERY], `${c.name} batteries_out`).toBe(c.batteries_out);
      expect(t.health, `${c.name} health_out`).toBe(c.health_out);
    });
  }
});

describe("ingame: system-menu effects (clear_screen_effect / do_mass_kill) + static table", () => {
  for (let i = 0; i < vec.effects.clear_screen.length; i++) {
    const c = vec.effects.clear_screen[i];
    it(`clear_screen #${i} ${c.name}`, () => {
      const st = new MockState({ tanks: [], shooter: null });
      if (c.name === "both") {
        st.info_box = { x: 1 } as unknown as ingame.InfoBox;
        st.speech = "hi";
      } else if (c.name === "info_only") {
        st.info_box = { x: 1 } as unknown as ingame.InfoBox;
        st.speech = null;
      }
      const ret = ingame.clear_screen_effect(st);
      expect(ret, `${c.name} ret`).toBe(c.ret);
      expect(st.info_box === null, `${c.name} info_box_none`).toBe(c.info_box_none);
      expect(st.speech === null, `${c.name} speech_none`).toBe(c.speech_none);
    });
  }

  it("do_mass_kill calls state.mass_kill() and returns 'mass_kill'", () => {
    const st = new MockState({ tanks: [], shooter: null });
    const ret = ingame.do_mass_kill(st);
    expect(ret).toBe(vec.effects.mass_kill.ret);
    expect(st.mass_killed).toBe(vec.effects.mass_kill.mass_killed);
  });

  it("SystemMenuScreen LEFT/RIGHT action table matches the byte-resolved layout", () => {
    const left = ingame.SystemMenuScreen.LEFT.map((it) => [it[0], it[1], it[2]]);
    const right = ingame.SystemMenuScreen.RIGHT.map((it) => [it[0], it[1], it[2]]);
    expect(left).toEqual(vec.effects.menu_left);
    expect(right).toEqual(vec.effects.menu_right);
  });
});

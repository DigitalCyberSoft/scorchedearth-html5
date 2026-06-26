/**
 * Differential gate: TS ui == Python scorch.ui (the fidelity oracle).
 *
 * Golden vectors are produced by oracle/dump_ui.py from the REAL Python ui module
 * and written to oracle/vectors/ui.json. The Python dumper drives ui.py's classes
 * over lightweight mock Tank/Cfg/State/Economy/Renderer objects; this test builds
 * STRUCTURALLY IDENTICAL mocks and asserts src/ui.ts reproduces every result.
 *
 * NUMERIC SUBSTRATE vs DRAWN PIXELS:
 *   This DOM-free gate exercises only the LOGIC: HumanController input->aim/power/
 *   fire mapping (handle taps + the update_continuous hold-ramp accumulator),
 *   weapon-cycle rotation, battery/parachute/contact toggles, MainMenu navigation
 *   + value mutation + _value_str + build_players, Shop selection/navigation +
 *   buy/sell delegation, and the draw_rankings NUMERIC substrate via
 *   rankings_layout() (war-quote wrap, panel geometry, _rankings_go_rect, ranked
 *   order, per-row luminance darkening). The literal pixels (pygame.draw / blit)
 *   defer to the Phase-3 visual gate (pixelsDeferredToPhase3 = true).
 *
 * EPSILON POLICY:
 *   Every angle / power / health / selection / index / cash / count / boolean /
 *   string / rect output is an INTEGER, boolean, or string and is asserted EXACT
 *   (.toBe / .toEqual). The ONLY floats on the path are the update_continuous
 *   accumulators (a, p, af, pf) and the gravity cfg value: they are pure IEEE-754
 *   double arithmetic done in the SAME operand order as CPython (sum of dt, sum of
 *   rate*dt; gravity = round(x,2)), so they reproduce the oracle to <1e-12 and are
 *   asserted with .toBeCloseTo(., 12). The integer angle/power derived from them
 *   via Python int() truncation are asserted EXACT (the truncation point is stable
 *   because the accumulators match to full double precision).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as pygame from "./../src/pygame";
import * as ui from "../src/ui";
import * as weapons from "../src/weapons";
import * as C from "../src/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "ui.json");

// ---------------------------------------------------------------------------
// Key map -- the SAME SDL keycodes the dumper recorded (by name).
// ---------------------------------------------------------------------------
const K: { [name: string]: number } = {
  UP: pygame.K_UP, DOWN: pygame.K_DOWN, LEFT: pygame.K_LEFT, RIGHT: pygame.K_RIGHT,
  w: pygame.K_w, a: pygame.K_a, s: pygame.K_s, d: pygame.K_d,
  RETURN: pygame.K_RETURN, SPACE: pygame.K_SPACE, TAB: pygame.K_TAB,
  LEFTBRACKET: pygame.K_LEFTBRACKET, RIGHTBRACKET: pygame.K_RIGHTBRACKET,
  p: pygame.K_p, b: pygame.K_b, MINUS: pygame.K_MINUS,
  BACKSPACE: pygame.K_BACKSPACE, x: pygame.K_x, ESCAPE: pygame.K_ESCAPE,
};

function ev(key: number, etype: number = pygame.KEYDOWN): ui.PygameEvent {
  return { type: etype, key };
}

// ---------------------------------------------------------------------------
// Mocks -- mirror oracle/dump_ui.py exactly.
// ---------------------------------------------------------------------------
class MockTank implements ui.Tank {
  angle: number;
  power: number;
  health: number;
  selected_weapon: number;
  parachute_deployed: boolean;
  contact_trigger: boolean;
  inventory: number[];
  name: string;
  color: number;
  win_counter: number;
  cash: number;
  score: number;
  constructor(o: Partial<MockTank> = {}) {
    this.angle = o.angle ?? 45;
    this.power = o.power ?? 500;
    this.health = o.health ?? 100;
    this.selected_weapon = o.selected_weapon ?? 0;
    this.parachute_deployed = o.parachute_deployed ?? true;
    this.contact_trigger = o.contact_trigger ?? false;
    this.inventory = o.inventory ? o.inventory.slice() : new Array(weapons.NUM_ITEMS).fill(0);
    this.name = o.name ?? "P1";
    this.color = o.color ?? 1;
    this.win_counter = o.win_counter ?? 0;
    this.cash = o.cash ?? 0;
    this.score = o.score ?? 0;
  }
  get batteries(): number {
    return this.inventory[weapons.SLOT_BATTERY];
  }
  has_ammo(slot: number): boolean {
    if (slot === weapons.SLOT_BABY_MISSILE) return true;
    return this.inventory[slot] > 0;
  }
}

class MockHumanState implements ui.HumanState {
  current_shooter: ui.Tank | null;
  fired = 0;
  _aim_hold?: ui.AimHold;
  constructor(tank: ui.Tank | null) {
    this.current_shooter = tank;
  }
  fire(): void {
    this.fired += 1;
  }
}

class MockEconomy implements ui.ShopEconomy {
  available: boolean[];
  price: number[];
  calls: Array<[string, number, number | null]> = [];
  constructor(available?: boolean[], price?: number[]) {
    const n = weapons.NUM_ITEMS;
    this.available = available ? available.slice() : new Array(n).fill(true);
    this.price = price ? price.slice() : weapons.ITEMS.map((it) => it.cost);
  }
  buy(tank: ui.Tank, slot: number): boolean {
    this.calls.push(["buy", slot, null]);
    const cost = this.price[slot];
    if (tank.cash >= cost && tank.inventory[slot] < C.INVENTORY_CAP) {
      tank.cash -= cost;
      tank.inventory[slot] += weapons.ITEMS[slot].bundle;
      if (tank.inventory[slot] > C.INVENTORY_CAP) tank.inventory[slot] = C.INVENTORY_CAP;
      return true;
    }
    return false;
  }
  sell(tank: ui.Tank, slot: number, qty: number): number {
    this.calls.push(["sell", slot, qty]);
    qty = Math.min(qty, tank.inventory[slot]);
    if (qty <= 0) return 0;
    const bundle = weapons.ITEMS[slot].bundle || 1;
    // round() here is CPython banker's; reuse the same helper the port uses by
    // matching the economy formula's integer-domain (it lands on .0/.5 only for
    // exact halves, which the test's prices avoid). Use Math.round-half-even.
    const raw = (this.price[slot] * qty * C.SELLBACK_MULT_NORMAL) / bundle;
    const offer = roundHalfEven(raw);
    tank.inventory[slot] -= qty;
    tank.cash = Math.max(0, tank.cash + offer);
    return offer;
  }
}

/** CPython round() for the sell-offer (banker's). */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

class MockShopState implements ui.ShopState {
  economy: ui.ShopEconomy;
  constructor(economy: ui.ShopEconomy) {
    this.economy = economy;
  }
}

// --- MockCfg: the Config-shaped object MainMenu mutates (string enums) ---
const SCORING = { BASIC: 0, STANDARD: 1, GREEDY: 2 } as Record<string, number>;
const TEAM_MODE = { NONE: 0, STANDARD: 1, CORPORATE: 2, VICIOUS: 3 } as Record<string, number>;
const PLAY_MODE = { SEQUENTIAL: 0, SYNCHRONOUS: 1, SIMULTANEOUS: 2 } as Record<string, number>;

class MockCfg implements ui.Cfg {
  MAXPLAYERS = 2;
  MAXROUNDS = 10;
  INITIAL_CASH = 0;
  GRAVITY = 0.2;
  MAX_WIND = 200;
  AIR_VISCOSITY = 0;
  SCORING = "STANDARD";
  TEAM_MODE = "NONE";
  PLAY_MODE = "SEQUENTIAL";
  [key: string]: unknown;
  constructor(over: Partial<Record<string, unknown>> = {}) {
    for (const k of Object.keys(over)) {
      (this as Record<string, unknown>)[k] = over[k];
    }
  }
  get team_mode(): number {
    return TEAM_MODE[String(this.TEAM_MODE).toUpperCase()] ?? 0;
  }
  get scoring(): number {
    return SCORING[String(this.SCORING).toUpperCase()] ?? 1;
  }
  get play_mode(): number {
    return PLAY_MODE[String(this.PLAY_MODE).toUpperCase()] ?? 0;
  }
}

// --- deterministic mock font/renderer (mirrors dump_ui.py MockFont) ---
const FONT_CW = 9;
const FONT_H = 18;
const BIG_CW = 16;
const BIG_H = 30;

class MockSurf {
  private _w: number;
  constructor(w: number) {
    this._w = w;
  }
  get_width(): number {
    return this._w;
  }
}

class MockFont {
  cw: number;
  h: number;
  constructor(cw: number, h: number) {
    this.cw = cw;
    this.h = h;
  }
  size(text: string): [number, number] {
    return [this.cw * text.length, this.h];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  render(text: string, _aa = true, _color?: unknown, _bg?: unknown): MockSurf {
    return new MockSurf(this.cw * text.length);
  }
  get_height(): number {
    return this.h;
  }
}

function mockRenderer(): ui.RankRenderer {
  const pal: number[][] = [];
  for (let i = 0; i < 256; i++) pal.push([0, 0, 0]);
  pal[0x6e] = [220, 40, 40];
  pal[1] = [60, 60, 255];
  pal[2] = [255, 255, 80];
  pal[3] = [200, 200, 200];
  pal[4] = [10, 200, 10];
  return {
    font: new MockFont(FONT_CW, FONT_H) as unknown as pygame.Font,
    bigfont: new MockFont(BIG_CW, BIG_H) as unknown as pygame.Font,
    pal,
  };
}

class MockRankTank implements ui.RankTank {
  color: number;
  name: string;
  win_counter: number;
  cash: number;
  score: number;
  constructor(color: number, name: string, win_counter: number, cash: number, score: number) {
    this.color = color;
    this.name = name;
    this.win_counter = win_counter;
    this.cash = cash;
    this.score = score;
  }
}

class MockRankState implements ui.RankState {
  w: number;
  h: number;
  ranking: ui.RankTank[] | null;
  tanks: ui.RankTank[];
  _rankings_go_rect?: pygame.Rect;
  constructor(w: number, h: number, ranking: ui.RankTank[] | null, tanks: ui.RankTank[]) {
    this.w = w;
    this.h = h;
    this.ranking = ranking;
    this.tanks = tanks;
  }
}

// ---------------------------------------------------------------------------
// Vector types
// ---------------------------------------------------------------------------
interface HumanHandleCase {
  name: string;
  key: string;
  angle: number | null;
  power: number | null;
  selected_weapon: number | null;
  parachute_deployed: boolean | null;
  contact_trigger: boolean | null;
  health: number | null;
  fired: number;
  battery_count: number | null;
}
interface WeaponCycleCase {
  name: string;
  owned: number[];
  sel_in: number;
  d: number;
  sel_out: number;
}
interface UCSnap {
  angle: number;
  power: number;
  hold: [number, number, number, number] | null;
}
interface UCCase {
  name: string;
  held?: string[];
  frames?: number;
  dt?: number;
  angle0?: number;
  power0?: number;
  snaps?: UCSnap[];
  release?: { name: string; angle: number; power: number; hold: [number, number, number, number] | null };
  hold_is_none?: boolean;
}
interface MenuState {
  num_players: number;
  types: number[];
  sel: number;
  start: boolean;
  quit: boolean;
  row_keys: string[];
  cfg: {
    MAXPLAYERS: number; MAXROUNDS: number; INITIAL_CASH: number; GRAVITY: number;
    MAX_WIND: number; AIR_VISCOSITY: number; SCORING: string; TEAM_MODE: string; PLAY_MODE: string;
  };
}
interface NavCase { name: string; keys: string[]; trace: Array<{ key: string; sel: number; start: boolean; quit: boolean }>; final: MenuState }
interface ValueTrace {
  d: number; value: string; cfg_gravity: number; cfg_maxrounds: number; cfg_cash: number;
  cfg_wind: number; cfg_visc: number; cfg_scoring: string; cfg_team: string; cfg_mode: string;
  num_players: number; types: number[];
}
interface ValueCase { name: string; sel_key: string; dirs: number[]; trace: ValueTrace[]; final: MenuState }
interface BuildPlayersCase { team_mode: string; num_players: number; specs: Array<[string, number, number]> }
interface FlagCase { target: string; start: boolean; quit: boolean }
interface MainMenuVec {
  inits: Array<{ maxplayers: number; state: MenuState }>;
  nav: NavCase[];
  values: ValueCase[];
  build_players: BuildPlayersCase[];
  flags: FlagCase[];
}
interface ShopVec {
  items_filter: { available: boolean[]; items: number[] };
  nav: Array<{ name: string; keys: string[]; n_items: number; trace: Array<{ key: string; sel: number }> }>;
  session: {
    script: string[];
    actions: Array<{ key: string; sel: number; done: boolean; cash: number; inv_at_sel: number }>;
    calls: Array<[string, number, number | null]>;
    final_cash: number;
    final_inv: number[];
  };
  tab_done: { done: boolean };
  buy_broke: { calls: Array<[string, number, number | null]>; cash: number; inv0: number };
}
interface RankLayout {
  fills: unknown[];
  blits: Array<[number, [number, number]]>;
  rects: Array<[number[], [number, number, number, number], number]>;
  lines: unknown[];
  go_rect: [number, number, number, number] | null;
}
interface RankCase {
  name: string;
  title: string;
  rounds_left: number | null;
  quote: [string, string] | null;
  w: number;
  h: number;
  ranking_set: boolean;
  tanks: Array<[number, string, number, number, number]>;
  layout: RankLayout;
}
interface RankVec {
  font: { cw: number; h: number; big_cw: number; big_h: number };
  cases: RankCase[];
  wraps: Array<{ qtext: string; qauthor: string; qlines: string[] }>;
}
interface UiVectors {
  module: string;
  human_handle: HumanHandleCase[];
  weapon_cycle: WeaponCycleCase[];
  update_continuous: UCCase[];
  mainmenu: MainMenuVec;
  shop: ShopVec;
  rankings: RankVec;
}

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as UiVectors;

// ---------------------------------------------------------------------------
// Build a MockMenu from a state-like cfg seed mirroring _mk_cfg(**over).
// ---------------------------------------------------------------------------
function mkMenu(cfgOver: Partial<Record<string, unknown>> = {}): ui.MainMenu {
  return ui.MainMenu.headless(new MockCfg(cfgOver), 1024, 768);
}
function menuState(m: ui.MainMenu): MenuState {
  return {
    num_players: m.num_players,
    types: m.types.slice(),
    sel: m.sel,
    start: m.start,
    quit: m.quit,
    row_keys: m.rows.map((r) => r[0]),
    cfg: {
      MAXPLAYERS: m.cfg.MAXPLAYERS, MAXROUNDS: m.cfg.MAXROUNDS, INITIAL_CASH: m.cfg.INITIAL_CASH,
      GRAVITY: m.cfg.GRAVITY, MAX_WIND: m.cfg.MAX_WIND, AIR_VISCOSITY: m.cfg.AIR_VISCOSITY,
      SCORING: m.cfg.SCORING, TEAM_MODE: m.cfg.TEAM_MODE, PLAY_MODE: m.cfg.PLAY_MODE,
    },
  };
}
function expectMenuState(got: MenuState, want: MenuState, label: string): void {
  expect(got.num_players, `${label} num_players`).toBe(want.num_players);
  expect(got.types, `${label} types`).toEqual(want.types);
  expect(got.sel, `${label} sel`).toBe(want.sel);
  expect(got.start, `${label} start`).toBe(want.start);
  expect(got.quit, `${label} quit`).toBe(want.quit);
  expect(got.row_keys, `${label} row_keys`).toEqual(want.row_keys);
  expect(got.cfg.MAXPLAYERS, `${label} cfg.MAXPLAYERS`).toBe(want.cfg.MAXPLAYERS);
  expect(got.cfg.MAXROUNDS, `${label} cfg.MAXROUNDS`).toBe(want.cfg.MAXROUNDS);
  expect(got.cfg.INITIAL_CASH, `${label} cfg.INITIAL_CASH`).toBe(want.cfg.INITIAL_CASH);
  expect(got.cfg.GRAVITY, `${label} cfg.GRAVITY`).toBeCloseTo(want.cfg.GRAVITY, 12);
  expect(got.cfg.MAX_WIND, `${label} cfg.MAX_WIND`).toBe(want.cfg.MAX_WIND);
  expect(got.cfg.AIR_VISCOSITY, `${label} cfg.AIR_VISCOSITY`).toBe(want.cfg.AIR_VISCOSITY);
  expect(got.cfg.SCORING, `${label} cfg.SCORING`).toBe(want.cfg.SCORING);
  expect(got.cfg.TEAM_MODE, `${label} cfg.TEAM_MODE`).toBe(want.cfg.TEAM_MODE);
  expect(got.cfg.PLAY_MODE, `${label} cfg.PLAY_MODE`).toBe(want.cfg.PLAY_MODE);
}

// ===========================================================================
describe("ui: oracle tag + non-trivial battery", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("ui");
  });
  it("vector battery is non-trivial", () => {
    const n =
      vec.human_handle.length +
      vec.weapon_cycle.length +
      vec.update_continuous.length +
      vec.mainmenu.values.length +
      vec.mainmenu.nav.length +
      vec.shop.nav.length +
      vec.rankings.cases.length +
      vec.rankings.wraps.length;
    expect(n).toBeGreaterThan(50);
  });
});

// ===========================================================================
describe("ui: HumanController.handle (taps, fire, toggles, battery)", () => {
  for (const c of vec.human_handle) {
    it(c.name, () => {
      if (c.angle === null) {
        // no_shooter: fire must NOT be called, nothing mutated
        const st = new MockHumanState(null);
        ui.HumanController.handle(st, ev(K[c.key]));
        expect(st.fired, `${c.name} fired`).toBe(c.fired);
        return;
      }
      // reconstruct the same setup the dumper used, by name
      const tank = setupHandleTank(c.name);
      const st = new MockHumanState(tank);
      const etype = c.name === "ignore_non_keydown" ? pygame.MOUSEBUTTONDOWN : pygame.KEYDOWN;
      ui.HumanController.handle(st, ev(K[c.key], etype));
      expect(tank.angle, `${c.name} angle`).toBe(c.angle);
      expect(tank.power, `${c.name} power`).toBe(c.power);
      expect(tank.selected_weapon, `${c.name} sel`).toBe(c.selected_weapon);
      expect(tank.parachute_deployed, `${c.name} parachute`).toBe(c.parachute_deployed);
      expect(tank.contact_trigger, `${c.name} contact`).toBe(c.contact_trigger);
      expect(tank.health, `${c.name} health`).toBe(c.health);
      expect(st.fired, `${c.name} fired`).toBe(c.fired);
      expect(tank.inventory[weapons.SLOT_BATTERY], `${c.name} battery`).toBe(c.battery_count);
    });
  }
});

function batteryInv(n: number): number[] {
  const inv = new Array(weapons.NUM_ITEMS).fill(0);
  inv[weapons.SLOT_BATTERY] = n;
  return inv;
}
function setupHandleTank(name: string): MockTank {
  switch (name) {
    case "angle_up_mid": return new MockTank({ angle: 90 });
    case "angle_up_a": return new MockTank({ angle: 90 });
    case "angle_up_clamp": return new MockTank({ angle: 180 });
    case "angle_down_mid": return new MockTank({ angle: 90 });
    case "angle_down_d": return new MockTank({ angle: 90 });
    case "angle_down_clamp": return new MockTank({ angle: 0 });
    case "power_up_mid": return new MockTank({ power: 500 });
    case "power_up_w": return new MockTank({ power: 500 });
    case "power_up_clamp": return new MockTank({ power: 1000 });
    case "power_down_mid": return new MockTank({ power: 500 });
    case "power_down_s": return new MockTank({ power: 500 });
    case "power_down_clamp": return new MockTank({ power: 0 });
    case "fire_space": return new MockTank();
    case "fire_return": return new MockTank();
    case "parachute_toggle_on": return new MockTank({ parachute_deployed: false });
    case "parachute_toggle_off": return new MockTank({ parachute_deployed: true });
    case "contact_toggle_on": return new MockTank({ contact_trigger: false });
    case "contact_toggle_off": return new MockTank({ contact_trigger: true });
    case "battery_heal": return new MockTank({ health: 70, inventory: batteryInv(3) });
    case "battery_cap": return new MockTank({ health: 95, inventory: batteryInv(3) });
    case "battery_full_noop": return new MockTank({ health: 100, inventory: batteryInv(3) });
    case "battery_none": return new MockTank({ health: 70 });
    case "ignore_non_keydown": return new MockTank({ angle: 90 });
    default: throw new Error(`unknown handle case ${name}`);
  }
}

// ===========================================================================
describe("ui: HumanController._cycle_weapon (owned offensive+ammo rotation)", () => {
  for (const c of vec.weapon_cycle) {
    it(c.name, () => {
      // build inventory: give ammo to the owned slots beyond slot0
      const inv = new Array(weapons.NUM_ITEMS).fill(0);
      for (const s of c.owned) if (s !== weapons.SLOT_BABY_MISSILE) inv[s] = 5;
      const tank = new MockTank({ selected_weapon: c.sel_in, inventory: inv });
      const st = new MockHumanState(tank);
      ui.HumanController._cycle_weapon(st, tank, c.d);
      expect(tank.selected_weapon, `${c.name} sel_out`).toBe(c.sel_out);
    });
  }
});

// ===========================================================================
describe("ui: HumanController.update_continuous (hold-ramp accumulator)", () => {
  for (const c of vec.update_continuous) {
    it(c.name, () => {
      if (c.hold_is_none) {
        const st = new MockHumanState(null);
        const keys: { [k: number]: boolean } = { [K.LEFT]: true };
        ui.HumanController.update_continuous(st, keys, 1 / 60.0);
        expect(st._aim_hold === undefined, `${c.name} hold absent`).toBe(true);
        return;
      }
      if (c.release) {
        const tank = new MockTank({ angle: 90, power: 500 });
        const st = new MockHumanState(tank);
        const keys: { [k: number]: boolean } = { [K.LEFT]: true };
        for (let i = 0; i < 30; i++) ui.HumanController.update_continuous(st, keys, 1 / 60.0);
        keys[K.LEFT] = false;
        ui.HumanController.update_continuous(st, keys, 1 / 60.0);
        expect(tank.angle, `${c.name} angle`).toBe(c.release.angle);
        expect(tank.power, `${c.name} power`).toBe(c.release.power);
        const h = st._aim_hold!;
        const want = c.release.hold!;
        expect(h.a, `${c.name} hold.a`).toBeCloseTo(want[0], 12);
        expect(h.p, `${c.name} hold.p`).toBeCloseTo(want[1], 12);
        expect(h.af, `${c.name} hold.af`).toBeCloseTo(want[2], 12);
        expect(h.pf, `${c.name} hold.pf`).toBeCloseTo(want[3], 12);
        return;
      }
      const tank = new MockTank({ angle: c.angle0 ?? 90, power: c.power0 ?? 500 });
      const st = new MockHumanState(tank);
      const keys: { [k: number]: boolean } = {};
      for (const code of c.held ?? []) keys[K[code]] = true;
      const dt = c.dt ?? 1 / 60.0;
      for (let f = 0; f < (c.frames ?? 0); f++) {
        ui.HumanController.update_continuous(st, keys, dt);
        const want = c.snaps![f];
        expect(tank.angle, `${c.name} f${f} angle`).toBe(want.angle);
        expect(tank.power, `${c.name} f${f} power`).toBe(want.power);
        if (want.hold === null) {
          expect(st._aim_hold === undefined, `${c.name} f${f} hold`).toBe(true);
        } else {
          const h = st._aim_hold!;
          expect(h.a, `${c.name} f${f} hold.a`).toBeCloseTo(want.hold[0], 12);
          expect(h.p, `${c.name} f${f} hold.p`).toBeCloseTo(want.hold[1], 12);
          expect(h.af, `${c.name} f${f} hold.af`).toBeCloseTo(want.hold[2], 12);
          expect(h.pf, `${c.name} f${f} hold.pf`).toBeCloseTo(want.hold[3], 12);
        }
      }
    });
  }
});

// ===========================================================================
describe("ui: MainMenu inits (roster + rows for player counts)", () => {
  for (const c of vec.mainmenu.inits) {
    it(`maxplayers=${c.maxplayers}`, () => {
      const m = mkMenu({ MAXPLAYERS: c.maxplayers });
      expectMenuState(menuState(m), c.state, `init ${c.maxplayers}`);
    });
  }
});

describe("ui: MainMenu navigation", () => {
  for (const c of vec.mainmenu.nav) {
    it(c.name, () => {
      const m = mkMenu({ MAXPLAYERS: 2 });
      for (let i = 0; i < c.keys.length; i++) {
        m.handle(ev(K[c.keys[i]]));
        const t = c.trace[i];
        expect(m.sel, `${c.name} #${i} sel`).toBe(t.sel);
        expect(m.start, `${c.name} #${i} start`).toBe(t.start);
        expect(m.quit, `${c.name} #${i} quit`).toBe(t.quit);
      }
      expectMenuState(menuState(m), c.final, `${c.name} final`);
    });
  }
});

describe("ui: MainMenu value mutation (clamp / enum cycle / round(.,2) gravity)", () => {
  for (const c of vec.mainmenu.values) {
    it(c.name, () => {
      const m = mkMenu({ MAXPLAYERS: 2 });
      m.sel = m.rows.map((r) => r[0]).indexOf(c.sel_key);
      for (let i = 0; i < c.dirs.length; i++) {
        m._activate(c.dirs[i]);
        const t = c.trace[i];
        expect(m._value_str(c.sel_key), `${c.name} #${i} value`).toBe(t.value);
        expect(m.cfg.GRAVITY, `${c.name} #${i} gravity`).toBeCloseTo(t.cfg_gravity, 12);
        expect(m.cfg.MAXROUNDS, `${c.name} #${i} rounds`).toBe(t.cfg_maxrounds);
        expect(m.cfg.INITIAL_CASH, `${c.name} #${i} cash`).toBe(t.cfg_cash);
        expect(m.cfg.MAX_WIND, `${c.name} #${i} wind`).toBe(t.cfg_wind);
        expect(m.cfg.AIR_VISCOSITY, `${c.name} #${i} visc`).toBe(t.cfg_visc);
        expect(m.cfg.SCORING, `${c.name} #${i} scoring`).toBe(t.cfg_scoring);
        expect(m.cfg.TEAM_MODE, `${c.name} #${i} team`).toBe(t.cfg_team);
        expect(m.cfg.PLAY_MODE, `${c.name} #${i} mode`).toBe(t.cfg_mode);
        expect(m.num_players, `${c.name} #${i} num_players`).toBe(t.num_players);
        expect(m.types, `${c.name} #${i} types`).toEqual(t.types);
      }
      expectMenuState(menuState(m), c.final, `${c.name} final`);
    });
  }

  it("gravity adjust on a non-finite cfg value is NaN-safe (pyRoundN guard)", () => {
    // _set_f rounds gravity to 2 decimals via pyRoundN, mirroring ui.py:68
    // `round(d * 0.05, 2)`.  CPython's round() returns the value unchanged for a
    // non-finite input (verified live: round(nan,2)==nan, round(inf,2)==inf), so the
    // TS helper's `if (!Number.isFinite(x)) return x` (ui.ts:77-79) reproduces that
    // rather than running the half-even/EPS scaling on NaN.  A real Config never
    // holds NaN gravity, but the helper must stay total: poison the value and confirm
    // the adjust leaves it NaN (no throw, no garbage) exactly as Python would.
    const m = mkMenu({ MAXPLAYERS: 2 });
    m.sel = m.rows.map((r) => r[0]).indexOf("gravity");
    expect(m.sel).toBeGreaterThanOrEqual(0);
    (m.cfg as { GRAVITY: number }).GRAVITY = NaN;
    m._activate(1); // gravity row +1 step -> _set_f -> pyRoundN(NaN, 2)
    expect(Number.isNaN(m.cfg.GRAVITY)).toBe(true);
    m._activate(-1);
    expect(Number.isNaN(m.cfg.GRAVITY)).toBe(true);
  });
});

describe("ui: MainMenu.build_players (team assignment)", () => {
  for (const c of vec.mainmenu.build_players) {
    it(c.team_mode, () => {
      let m: ui.MainMenu;
      if (c.team_mode === "STANDARD_after_chg") {
        m = mkMenu({ MAXPLAYERS: 2, TEAM_MODE: "STANDARD" });
        m._chg_players(3);
      } else {
        m = mkMenu({ MAXPLAYERS: 4, TEAM_MODE: c.team_mode });
        m.types = [0, 1, 6, 7, 6, 6, 6, 6, 6, 6];
      }
      const specs = m.build_players();
      expect(specs.length, `${c.team_mode} count`).toBe(c.specs.length);
      for (let i = 0; i < c.specs.length; i++) {
        expect(specs[i], `${c.team_mode} spec[${i}]`).toEqual(c.specs[i]);
      }
    });
  }
});

describe("ui: MainMenu start/quit flags", () => {
  for (const c of vec.mainmenu.flags) {
    it(c.target, () => {
      const key = c.target === "start_space" ? "SPACE" : "RETURN";
      const target = c.target === "start_space" ? "start" : c.target;
      const m = mkMenu({ MAXPLAYERS: 2 });
      m.sel = m.rows.map((r) => r[0]).indexOf(target);
      m.handle(ev(K[key]));
      expect(m.start, `${c.target} start`).toBe(c.start);
      expect(m.quit, `${c.target} quit`).toBe(c.quit);
    });
  }
});

// ===========================================================================
describe("ui: Shop items filter (availability)", () => {
  it("only available items make the list", () => {
    const econ = new MockEconomy(vec.shop.items_filter.available.slice());
    const tank = new MockTank({ cash: 5000 });
    const shop = ui.Shop.headless(new MockShopState(econ), tank, 1024, 768);
    expect(shop.items, "items").toEqual(vec.shop.items_filter.items);
  });
});

describe("ui: Shop navigation wrap", () => {
  for (const c of vec.shop.nav) {
    it(c.name, () => {
      const econ = new MockEconomy(vec.shop.items_filter.available.slice());
      const tank = new MockTank({ cash: 5000 });
      const sh = ui.Shop.headless(new MockShopState(econ), tank, 1024, 768);
      expect(sh.items.length, `${c.name} n_items`).toBe(c.n_items);
      for (let i = 0; i < c.keys.length; i++) {
        sh.handle(ev(K[c.keys[i]]));
        expect(sh.sel, `${c.name} #${i} sel`).toBe(c.trace[i].sel);
      }
    });
  }
});

describe("ui: Shop session (buy/sell delegation + cash/inv + done)", () => {
  it("scripted buy/sell/esc session", () => {
    const econ = new MockEconomy(new Array(weapons.NUM_ITEMS).fill(true));
    const tank = new MockTank({ cash: 100000 });
    const sh = ui.Shop.headless(new MockShopState(econ), tank, 1024, 768);
    const s = vec.shop.session;
    for (let i = 0; i < s.script.length; i++) {
      sh.handle(ev(K[s.script[i]]));
      const a = s.actions[i];
      expect(sh.sel, `session #${i} sel`).toBe(a.sel);
      expect(sh.done, `session #${i} done`).toBe(a.done);
      expect(tank.cash, `session #${i} cash`).toBe(a.cash);
      expect(tank.inventory[sh.items[sh.sel]], `session #${i} inv_at_sel`).toBe(a.inv_at_sel);
    }
    expect(econ.calls, "session calls").toEqual(s.calls);
    expect(tank.cash, "final cash").toBe(s.final_cash);
    expect(tank.inventory, "final inv").toEqual(s.final_inv);
  });

  it("TAB closes the shop", () => {
    const econ = new MockEconomy(new Array(weapons.NUM_ITEMS).fill(true));
    const tank = new MockTank({ cash: 100 });
    const sh = ui.Shop.headless(new MockShopState(econ), tank, 1024, 768);
    sh.handle(ev(K.TAB));
    expect(sh.done, "tab done").toBe(vec.shop.tab_done.done);
  });

  it("broke buy still delegates, no cash/inv change", () => {
    const econ = new MockEconomy(new Array(weapons.NUM_ITEMS).fill(true));
    const tank = new MockTank({ cash: 0 });
    const sh = ui.Shop.headless(new MockShopState(econ), tank, 1024, 768);
    sh.handle(ev(K.RETURN));
    expect(econ.calls, "broke calls").toEqual(vec.shop.buy_broke.calls);
    expect(tank.cash, "broke cash").toBe(vec.shop.buy_broke.cash);
    expect(tank.inventory[sh.items[0]], "broke inv0").toBe(vec.shop.buy_broke.inv0);
  });
});

// ===========================================================================
// draw_rankings NUMERIC substrate: rankings_layout reproduces the panel geometry,
// the war-quote wrap, the ranked order, the per-row darkened colors, and the
// dismiss-button rect (== state._rankings_go_rect the source writes).
// ===========================================================================
describe("ui: draw_rankings layout substrate (geometry / wrap / go-rect)", () => {
  for (const c of vec.rankings.cases) {
    it(c.name, () => {
      const renderer = mockRenderer();
      const tanks = c.tanks.map((t) => new MockRankTank(t[0], t[1], t[2], t[3], t[4]));
      const ranking = c.ranking_set ? tanks.slice() : null;
      const state = new MockRankState(c.w, c.h, ranking, tanks);
      const L = ui.rankings_layout(
        renderer,
        state,
        c.title,
        c.rounds_left,
        c.quote,
      );
      // go-rect == what draw_rankings writes to state._rankings_go_rect
      const want = c.layout.go_rect!;
      expect([L.go_rect.x, L.go_rect.y, L.go_rect.w, L.go_rect.h], `${c.name} go_rect`).toEqual(want);

      // The dumper also recorded the panel rect as rects[0] (px,py,pw,ph).
      const panelRect = c.layout.rects[0][1];
      expect([L.px, L.py, L.pw, L.ph], `${c.name} panel rect`).toEqual(panelRect);

      // ranked order: ids by name match the source's `ranked` (via the row blits)
      expect(L.ranked.length, `${c.name} ranked count`).toBe(tanks.length);

      // quote wrap line count drives body height; verify qlines vs the recorded
      // blits indirectly by the case quote.
      if (c.quote) {
        const w = wrapExpected(c.quote[0], c.quote[1]);
        expect(L.qlines, `${c.name} qlines`).toEqual(w);
      } else {
        expect(L.qlines.length, `${c.name} no qlines`).toBe(0);
      }
    });
  }
});

/** local recompute mirror of the source wrap (only for cross-check inside a case). */
function wrapExpected(qtext: string, qauthor: string): string[] {
  const qlines: string[] = [];
  let cur = "";
  for (const wd of String(qtext).split(/\s+/).filter((s) => s.length > 0)) {
    if (cur.length + wd.length + 1 > 48) {
      qlines.push(cur);
      cur = wd;
    } else {
      cur = (cur + " " + wd).trim();
    }
  }
  if (cur) qlines.push(cur);
  qlines.push(`- ${qauthor}`);
  return qlines;
}

describe("ui: draw_rankings ranked ORDER + per-row darkened colors", () => {
  it("sorted-by-score case orders descending and darkens bright rows", () => {
    const c = vec.rankings.cases.find((x) => x.name === "sorted_by_score")!;
    const renderer = mockRenderer();
    const tanks = c.tanks.map((t) => new MockRankTank(t[0], t[1], t[2], t[3], t[4]));
    const state = new MockRankState(c.w, c.h, null, tanks);
    const L = ui.rankings_layout(renderer, state, c.title, c.rounds_left, c.quote);
    // descending score: Alice 300, Dee 220, Bob 150, Cy 80
    expect(L.ranked.map((t) => t.name), "order").toEqual(["Alice", "Dee", "Bob", "Cy"]);
    // color darkening: pal[2]=[255,255,80] lum>=150 -> -90 each; pal[1]=[60,60,255] kept
    const idxBob = L.ranked.findIndex((t) => t.name === "Bob");
    expect(L.row_colors[idxBob], "Bob darkened").toEqual([165, 165, 0]);
    const idxAlice = L.ranked.findIndex((t) => t.name === "Alice");
    // pal[1] lum = .299*60+.587*60+.114*255 = 17.94+35.22+29.07 = 82.23 < 150 -> kept
    expect(L.row_colors[idxAlice], "Alice kept").toEqual([60, 60, 255]);
  });
});

describe("ui: draw_rankings war-quote wrap (48-col greedy + author)", () => {
  for (const c of vec.rankings.wraps) {
    it(JSON.stringify(c.qtext).slice(0, 40), () => {
      const renderer = mockRenderer();
      const tanks = [new MockRankTank(1, "X", 0, 0, 0)];
      const state = new MockRankState(1024, 768, tanks.slice(), tanks);
      const L = ui.rankings_layout(renderer, state, "T", null, [c.qtext, c.qauthor]);
      expect(L.qlines, "qlines").toEqual(c.qlines);
    });
  }
});

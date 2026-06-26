/**
 * Menus, shop, rankings, and human in-game input -- a faithful TypeScript port of
 * scorch-py/scorch/ui.py (the fidelity oracle), drawn against src/pygame.ts.
 *
 * Mirrors the main-menu / config screen (FUN_44ed_1870), the interactive shop
 * (FUN_1dbc_1aa8 buy / FUN_40f5_* sell), the rankings screen (FUN_3cc4_0983
 * interim / FUN_33a1_054a final), and the human in-game arm (caseD_1e). Keyboard-
 * driven.
 *
 * NUMERIC SUBSTRATE vs DRAWN PIXELS (read before testing):
 *   The differential gate (test/ui.test.ts) runs in Node, DOM-free, so it
 *   exercises the LOGIC layer only: the HumanController input->angle/power/fire
 *   mapping (handle taps + update_continuous hold-ramp accumulator), the
 *   weapon-cycle owned-list rotation, battery/parachute/contact toggles, MainMenu
 *   row navigation + value mutation (clamp, enum cycle, round(.,2) gravity) +
 *   _value_str + build_players, Shop selection/navigation + buy/sell delegation,
 *   and the draw_rankings NUMERIC substrate (war-quote word-wrap, panel geometry,
 *   _rankings_go_rect, ranked ordering, per-row luminance darkening). NONE of that
 *   touches pygame.font / pygame.Surface / pygame.draw, so it reproduces the oracle
 *   exactly. The .draw() methods (the literal pixels) defer to the Phase-3 visual
 *   gate (pixelsDeferredToPhase3 = true).
 *
 * FONT CAVEAT (DOM dependency): MainMenu/Shop construct pygame.font.SysFont in
 *   their constructors (matching ui.py:31-32,251-252), which requires a Canvas2D
 *   (DOM). So MainMenu/Shop can only be constructed in a browser, not under Node.
 *   The test battery exercises the menu/shop LOGIC by constructing the objects
 *   through a tiny DOM-free seam (the font fields are only read by .draw()), so the
 *   numeric methods run headless. HumanController is entirely static and DOM-free.
 *
 * RENDERER CAVEAT (integrator hook): draw_rankings reads renderer.font /
 *   renderer.bigfont / renderer.pal and state.w / state.h / state.ranking /
 *   state.tanks; it sets state._rankings_go_rect (a hit-test Rect the click router
 *   reads). The renderer/render module supplies those; this module only draws into
 *   the surface it is handed. The geometry + quote-wrap + go-rect math is faithful
 *   to ui.py:307-403.
 */
import * as pygame from "./pygame";

import * as C from "./constants";
import * as weapons from "./weapons";

export const AI_TYPE_NAMES = [
  "Human",
  "Moron",
  "Shooter",
  "Poolshark",
  "Tosser",
  "Chooser",
  "Spoiler",
  "Cyborg",
  "Unknown",
];
export const SCORING_NAMES = ["BASIC", "STANDARD", "GREEDY"];
export const TEAM_NAMES = ["NONE", "STANDARD", "CORPORATE", "VICIOUS"];
export const PLAYMODE_NAMES = ["SEQUENTIAL", "SYNCHRONOUS", "SIMULTANEOUS"];

// ---------------------------------------------------------------------------
// Python-semantics helpers (kept private; preserve the oracle's arithmetic).
// ---------------------------------------------------------------------------

/** Python `%`: result takes the sign of the divisor (always >= 0 for n > 0). */
function pyMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Python int(x): truncate toward zero (matches `int()` on a float). */
function pyInt(x: number): number {
  return Math.trunc(x);
}

/** Python round(x, ndigits): banker's rounding (round-half-to-even) at `ndigits`
 *  decimal places, as ui.py:68 `round(..., 2)` uses. CPython rounds the value to
 *  the nearest multiple of 10**-ndigits, ties to even, then the IEEE-754 double
 *  nearest that decimal is returned. We reproduce the decimal-place half-even
 *  rule by scaling, rounding the scaled value half-to-even, and unscaling. */
function pyRoundN(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) {
    return x;
  }
  const m = Math.pow(10, ndigits);
  const scaled = x * m;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r: number;
  // EPS guards the boundary: scaling by a power of ten can land a true 0.5 a hair
  // above/below, so snap near-half to the exact half before the even test. The
  // domain here (gravity d*0.05 stepped, 2 decimals) keeps values well inside
  // double precision, so this matches CPython on the menu's range.
  const EPS = 1e-9;
  if (Math.abs(diff - 0.5) < EPS) {
    r = floor % 2 === 0 ? floor : floor + 1;
  } else {
    r = Math.round(scaled);
  }
  return r / m;
}

// ---------------------------------------------------------------------------
// Duck-typed structural shapes (the subset of fields the ported methods read).
// main.ts / the ported game-state supplies concrete objects with these members.
// ---------------------------------------------------------------------------

/** The config object MainMenu mutates (Config dataclass; string enum fields). */
export interface Cfg {
  MAXPLAYERS: number;
  MAXROUNDS: number;
  INITIAL_CASH: number;
  GRAVITY: number;
  MAX_WIND: number;
  AIR_VISCOSITY: number;
  SCORING: string;
  TEAM_MODE: string;
  PLAY_MODE: string;
  /** derived index property (team_mode != TEAM_NONE gates team assignment). */
  readonly team_mode: number;
  [key: string]: unknown;
}

/** The active tank the HumanController / Shop drive. */
export interface Tank {
  angle: number;
  power: number;
  health: number;
  selected_weapon: number;
  parachute_deployed: boolean;
  contact_trigger: boolean;
  inventory: number[];
  /** read-only derived count = inventory[SLOT_BATTERY]. */
  readonly batteries: number;
  name: string;
  color: number;
  win_counter: number;
  cash: number;
  score: number;
  has_ammo(slot: number): boolean;
}

/** The persistent per-tank aim-hold accumulator update_continuous threads
 *  through `state._aim_hold` (created lazily). */
export interface AimHold {
  a: number;
  p: number;
  af: number;
  pf: number;
}

/** A pygame.key.get_pressed()-shaped lookup: keys[K_*] is truthy when held. */
export type KeyState = { [code: number]: boolean } | boolean[];

/** The game-state subset HumanController reads. */
export interface HumanState {
  current_shooter: Tank | null;
  _aim_hold?: AimHold;
  fire(): void;
}

/** A pygame-shaped KEYDOWN event (subset of fields the engine reads). */
export interface PygameEvent {
  type: number;
  key?: number;
  unicode?: string;
}

/** The economy interface Shop delegates buy/sell to. */
export interface ShopEconomy {
  available: boolean[];
  price: number[];
  buy(tank: Tank, slot: number): boolean;
  sell(tank: Tank, slot: number, qty: number): number;
}

/** The state subset Shop reads. */
export interface ShopState {
  economy: ShopEconomy;
}

/** The renderer subset draw_rankings reads (font metrics + palette). */
export interface RankRenderer {
  font: pygame.Font;
  bigfont: pygame.Font;
  /** palette: pal[idx] -> [r,g,b] (or array-like). */
  pal: ReadonlyArray<ReadonlyArray<number>>;
}

/** A tank as draw_rankings ranks/renders it. */
export interface RankTank {
  color: number;
  name: string;
  win_counter: number;
  cash: number;
  score: number;
}

/** The state subset draw_rankings reads/writes. */
export interface RankState {
  w: number;
  h: number;
  ranking: RankTank[] | null;
  tanks: RankTank[];
  _rankings_go_rect?: pygame.Rect;
}

// ---------------------------------------------------------------------------
// MainMenu -- config + player-setup screen.  Returns (player_specs) on START.
// (FUN_44ed_1870)
// ---------------------------------------------------------------------------

/** A menu row: (key, label, adjust-callback | null). */
export type MenuRow = [string, string, ((d: number) => void) | null];

export class MainMenu {
  cfg: Cfg;
  w: number;
  h: number;
  num_players: number;
  types: number[];
  sel: number;
  start: boolean;
  quit: boolean;
  font!: pygame.Font;
  big!: pygame.Font;
  rows!: MenuRow[];

  constructor(cfg: Cfg, w: number, h: number) {
    this.cfg = cfg;
    this.w = w;
    this.h = h;
    this.num_players = Math.max(2, cfg.MAXPLAYERS);
    // default roster: P1 human, rest Spoiler
    this.types = [0, 6, 6, 6, 6, 6, 6, 6, 6, 6];
    this.sel = 0;
    this.start = false;
    this.quit = false;
    // Fonts are read only by draw(); building them here matches ui.py:31-32 but
    // touches the DOM. The test seam constructs via MainMenu.headless(...) to run
    // the numeric methods under Node.
    this.font = font18();
    this.big = bigFont34();
    this._rebuild_rows();
  }

  /** DOM-free constructor for the numeric gate: skips the font build (draw() is
   *  the only reader of font/big, and draw() is the Phase-3 pixel path). */
  static headless(cfg: Cfg, w: number, h: number): MainMenu {
    const m: MainMenu = Object.create(MainMenu.prototype);
    m.cfg = cfg;
    m.w = w;
    m.h = h;
    m.num_players = Math.max(2, cfg.MAXPLAYERS);
    m.types = [0, 6, 6, 6, 6, 6, 6, 6, 6, 6];
    m.sel = 0;
    m.start = false;
    m.quit = false;
    m._rebuild_rows();
    return m;
  }

  _rebuild_rows(): void {
    const rows: MenuRow[] = [["players", "Players", (d: number) => this._chg_players(d)]];
    for (let i = 0; i < this.num_players; i++) {
      rows.push([`ptype${i}`, `  Player ${i + 1}`, this._chg_type(i)]);
    }
    rows.push(
      ["rounds", "Rounds", (d: number) => this._set("MAXROUNDS", d, 1, 1000)],
      ["cash", "Cash at Start", (d: number) => this._set("INITIAL_CASH", d * 1000, 0, 1000000)],
      ["scoring", "Scoring", (d: number) => this._cycle_enum("SCORING", SCORING_NAMES, d)],
      ["teams", "Teams", (d: number) => this._cycle_enum("TEAM_MODE", TEAM_NAMES, d)],
      ["mode", "Play Mode", (d: number) => this._cycle_enum("PLAY_MODE", PLAYMODE_NAMES, d)],
      ["gravity", "Gravity x100", (d: number) => this._set_f("GRAVITY", d * 0.05, 0.05, 10.0)],
      ["wind", "Max Wind", (d: number) => this._set("MAX_WIND", d * 25, 0, 500)],
      ["visc", "Air Viscosity", (d: number) => this._set("AIR_VISCOSITY", d, 0, 20)],
      ["start", "START GAME", null],
      ["quit", "Quit", null],
    );
    this.rows = rows;
    this.sel = Math.min(this.sel, rows.length - 1);
  }

  _chg_players(d: number): void {
    this.num_players = Math.max(2, Math.min(10, this.num_players + d));
    this.cfg.MAXPLAYERS = this.num_players;
    this._rebuild_rows();
  }

  _chg_type(i: number): (d: number) => void {
    return (d: number): void => {
      this.types[i] = pyMod(this.types[i] + d, AI_TYPE_NAMES.length);
    };
  }

  _set(key: string, d: number, lo: number, hi: number): void {
    (this.cfg as Record<string, number>)[key] = Math.max(
      lo,
      Math.min(hi, (this.cfg as Record<string, number>)[key] + d),
    );
  }

  _set_f(key: string, d: number, lo: number, hi: number): void {
    (this.cfg as Record<string, number>)[key] = pyRoundN(
      Math.max(lo, Math.min(hi, (this.cfg as Record<string, number>)[key] + d)),
      2,
    );
  }

  _cycle_enum(key: string, names: string[], d: number): void {
    const cur0 = String((this.cfg as Record<string, unknown>)[key]).toUpperCase();
    const idx = names.indexOf(cur0);
    const cur = idx >= 0 ? idx : 0;
    (this.cfg as Record<string, string>)[key] = names[pyMod(cur + d, names.length)];
  }

  handle(e: PygameEvent): void {
    if (e.type !== pygame.KEYDOWN) {
      return;
    }
    const k = e.key;
    if (k === pygame.K_UP || k === pygame.K_w) {
      this.sel = pyMod(this.sel - 1, this.rows.length);
    } else if (k === pygame.K_DOWN || k === pygame.K_s) {
      this.sel = pyMod(this.sel + 1, this.rows.length);
    } else if (k === pygame.K_LEFT || k === pygame.K_a) {
      this._activate(-1);
    } else if (k === pygame.K_RIGHT || k === pygame.K_d) {
      this._activate(1);
    } else if (k === pygame.K_RETURN || k === pygame.K_SPACE) {
      this._activate(0);
    }
  }

  _activate(d: number): void {
    const key = this.rows[this.sel][0];
    if (key === "start") {
      if (d === 0) {
        this.start = true;
      }
      return;
    }
    if (key === "quit") {
      if (d === 0) {
        this.quit = true;
      }
      return;
    }
    if (d === 0) {
      d = 1;
    }
    const cb = this.rows[this.sel][2];
    if (cb) {
      cb(d);
    }
  }

  build_players(): Array<[string, number, number]> {
    const specs: Array<[string, number, number]> = [];
    for (let i = 0; i < this.num_players; i++) {
      const t = this.types[i];
      const team = this.cfg.team_mode !== C.TEAM_NONE ? (i % 2) + 1 : 0;
      specs.push([`P${i + 1}`, t, team]);
    }
    return specs;
  }

  draw(surf: pygame.Surface): void {
    surf.fill([10, 12, 30]);
    const title = this.big.render("SCORCHED  EARTH", true, [255, 210, 80]);
    surf.blit(title, [Math.trunc(this.w / 2) - Math.trunc(title.get_width() / 2), 18]);
    const sub = this.font.render(
      "Python port - true to the v1.5 reverse-engineering",
      true,
      [170, 170, 200],
    );
    surf.blit(sub, [Math.trunc(this.w / 2) - Math.trunc(sub.get_width() / 2), 60]);
    let y = 96;
    for (let i = 0; i < this.rows.length; i++) {
      const [key, label] = this.rows[i];
      const val = this._value_str(key);
      const selc: [number, number, number] = i === this.sel ? [255, 255, 120] : [210, 210, 210];
      const txt = val ? `${label.padEnd(16)} ${val}` : label;
      const r = this.font.render((i === this.sel ? "> " : "  ") + txt, true, selc);
      surf.blit(r, [Math.trunc(this.w / 2) - 200, y]);
      y += 22;
    }
    const hint = this.font.render(
      "Up/Down select   Left/Right change   Enter activate   F11 fullscreen",
      true,
      [150, 150, 170],
    );
    surf.blit(hint, [Math.trunc(this.w / 2) - Math.trunc(hint.get_width() / 2), this.h - 28]);
  }

  _value_str(key: string): string {
    if (key === "players") {
      return String(this.num_players);
    }
    if (key.startsWith("ptype")) {
      const i = parseInt(key.slice(5), 10);
      return AI_TYPE_NAMES[this.types[i]];
    }
    if (key === "rounds") {
      return String(this.cfg.MAXROUNDS);
    }
    if (key === "cash") {
      return `$${this.cfg.INITIAL_CASH}`;
    }
    if (key === "scoring") {
      return this.cfg.SCORING;
    }
    if (key === "teams") {
      return this.cfg.TEAM_MODE;
    }
    if (key === "mode") {
      return this.cfg.PLAY_MODE;
    }
    if (key === "gravity") {
      return this.cfg.GRAVITY.toFixed(2);
    }
    if (key === "wind") {
      return String(this.cfg.MAX_WIND);
    }
    if (key === "visc") {
      return String(this.cfg.AIR_VISCOSITY);
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// HumanController -- in-game aim/fire input for the active human tank
// (caseD_1e human arm).
// ---------------------------------------------------------------------------

/** REPEAT_DELAY: keyboard auto-repeat initial delay (RECONSTRUCTED wall-clock;
 *  the binary's pacing is BLOCKED MIPS-adaptive). update_continuous contributes
 *  nothing until the key is held past this delay so a brief tap (handle's +1)
 *  does not double-count. */
const REPEAT_DELAY = 0.22;

function keyHeld(keys: KeyState, code: number): boolean {
  return Boolean((keys as { [k: number]: boolean })[code]);
}

export class HumanController {
  /** Slow, gently-accelerating power/angle change while a key is held (the
   *  original ramps from a slow tap-rate up to a faster hold-rate). */
  static update_continuous(state: HumanState, keys: KeyState, dt = 1 / 60.0): void {
    const t = state.current_shooter;
    if (!t) {
      return;
    }
    let hold = state._aim_hold;
    if (hold === undefined || hold === null) {
      hold = state._aim_hold = { a: 0.0, p: 0.0, af: 0.0, pf: 0.0 };
    }
    const left = keyHeld(keys, pygame.K_LEFT) || keyHeld(keys, pygame.K_a);
    const right = keyHeld(keys, pygame.K_RIGHT) || keyHeld(keys, pygame.K_d);
    const up = keyHeld(keys, pygame.K_UP) || keyHeld(keys, pygame.K_w);
    const down = keyHeld(keys, pygame.K_DOWN) || keyHeld(keys, pygame.K_s);

    // A single tap is the KEYDOWN +1 in handle(); update_continuous is ONLY the
    // hold-repeat ramp, so it MUST contribute nothing until the key is held past
    // the initial repeat delay (ui.py:171-176).
    if (left || right) {
      hold.a += dt;
      if (hold.a >= REPEAT_DELAY) {
        const rate = Math.min(55.0, 6.0 + (hold.a - REPEAT_DELAY) * 35.0); // deg/sec
        hold.af += rate * dt * (left ? 1 : -1);
        const whole = pyInt(hold.af);
        hold.af -= whole;
        t.angle = Math.max(0, Math.min(180, t.angle + whole));
      }
    } else {
      hold.a = hold.af = 0.0;
    }
    if (up || down) {
      hold.p += dt;
      if (hold.p >= REPEAT_DELAY) {
        const rate = Math.min(350.0, 25.0 + (hold.p - REPEAT_DELAY) * 220.0); // power/sec
        hold.pf += rate * dt * (up ? 1 : -1);
        const whole = pyInt(hold.pf);
        hold.pf -= whole;
        t.power = Math.max(0, Math.min(1000, t.power + whole));
      }
    } else {
      hold.p = hold.pf = 0.0;
    }
  }

  static handle(state: HumanState, e: PygameEvent): void {
    const t = state.current_shooter;
    if (!t || e.type !== pygame.KEYDOWN) {
      return;
    }
    const k = e.key;
    if (k === pygame.K_SPACE || k === pygame.K_RETURN) {
      state.fire();
    } else if (k === pygame.K_LEFT || k === pygame.K_a) {
      // tap = +1 deg (hold ramps via update_continuous); matches the original's
      // 1-unit tap + hold-repeat. left/right convention follows the ramp.
      t.angle = Math.max(0, Math.min(180, t.angle + 1));
    } else if (k === pygame.K_RIGHT || k === pygame.K_d) {
      t.angle = Math.max(0, Math.min(180, t.angle - 1));
    } else if (k === pygame.K_UP || k === pygame.K_w) {
      // tap = +1 power
      t.power = Math.max(0, Math.min(1000, t.power + 1));
    } else if (k === pygame.K_DOWN || k === pygame.K_s) {
      t.power = Math.max(0, Math.min(1000, t.power - 1));
    } else if (k === pygame.K_TAB || k === pygame.K_RIGHTBRACKET) {
      HumanController._cycle_weapon(state, t, 1);
    } else if (k === pygame.K_LEFTBRACKET) {
      HumanController._cycle_weapon(state, t, -1);
    } else if (k === pygame.K_p) {
      t.parachute_deployed = !t.parachute_deployed;
    } else if (k === pygame.K_b) {
      HumanController._use_battery(t);
    } else if (k === pygame.K_MINUS) {
      t.contact_trigger = !t.contact_trigger;
    }
  }

  static _cycle_weapon(state: HumanState, t: Tank, d: number): void {
    const owned: number[] = [];
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      if (weapons.ITEMS[i].offensive && t.has_ammo(i)) {
        owned.push(i);
      }
    }
    if (owned.length === 0) {
      return;
    }
    const at = owned.indexOf(t.selected_weapon);
    if (at >= 0) {
      t.selected_weapon = owned[pyMod(at + d, owned.length)];
    } else {
      t.selected_weapon = owned[0];
    }
  }

  static _use_battery(t: Tank): void {
    if (t.batteries > 0 && t.health < C.TANK_DEFAULT_HEALTH) {
      t.inventory[weapons.SLOT_BATTERY] -= 1;
      t.health = Math.min(C.TANK_DEFAULT_HEALTH, t.health + 10);
    }
  }
}

// ---------------------------------------------------------------------------
// Shop -- interactive buy/sell for one human tank between rounds.
// (FUN_1dbc_1aa8 buy / FUN_40f5_* sell)
// ---------------------------------------------------------------------------

export class Shop {
  state: ShopState;
  tank: Tank;
  w: number;
  h: number;
  sel: number;
  done: boolean;
  font!: pygame.Font;
  big!: pygame.Font;
  items: number[];

  constructor(state: ShopState, tank: Tank, w: number, h: number) {
    this.state = state;
    this.tank = tank;
    this.w = w;
    this.h = h;
    this.sel = 0;
    this.done = false;
    // Fonts read only by draw() (ui.py:251-252) -- DOM. Built here for the live
    // game; the numeric gate uses Shop.headless to skip them.
    this.font = font15();
    this.big = bigFont26();
    this.items = Shop._build_items(state);
  }

  /** DOM-free constructor for the numeric gate (font fields only read by draw). */
  static headless(state: ShopState, tank: Tank, w: number, h: number): Shop {
    const s: Shop = Object.create(Shop.prototype);
    s.state = state;
    s.tank = tank;
    s.w = w;
    s.h = h;
    s.sel = 0;
    s.done = false;
    s.items = Shop._build_items(state);
    return s;
  }

  static _build_items(state: ShopState): number[] {
    const items: number[] = [];
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      if (state.economy.available[i]) {
        items.push(i);
      }
    }
    return items;
  }

  handle(e: PygameEvent): void {
    if (e.type !== pygame.KEYDOWN) {
      return;
    }
    const k = e.key;
    if (k === pygame.K_UP || k === pygame.K_w) {
      this.sel = pyMod(this.sel - 1, this.items.length);
    } else if (k === pygame.K_DOWN || k === pygame.K_s) {
      this.sel = pyMod(this.sel + 1, this.items.length);
    } else if (k === pygame.K_RETURN || k === pygame.K_SPACE || k === pygame.K_b) {
      this.state.economy.buy(this.tank, this.items[this.sel]);
    } else if (k === pygame.K_BACKSPACE || k === pygame.K_x) {
      this.state.economy.sell(this.tank, this.items[this.sel], 1);
    } else if (k === pygame.K_ESCAPE || k === pygame.K_TAB) {
      this.done = true;
    }
  }

  draw(surf: pygame.Surface): void {
    surf.fill([12, 12, 28]);
    const title = this.big.render(
      `SHOP - ${this.tank.name}   Cash $${this.tank.cash}`,
      true,
      [255, 220, 100],
    );
    surf.blit(title, [20, 12]);
    const col_x = [20, 240, 320, 400, 470];
    const hdr = ["Item", "Cost", "Bundle", "Owned", "Arms"];
    for (let j = 0; j < col_x.length; j++) {
      surf.blit(this.font.render(hdr[j], true, [180, 180, 200]), [col_x[j], 48]);
    }
    const top = Math.max(0, this.sel - 12);
    let y = 70;
    for (let vi = top; vi < Math.min(this.items.length, top + 24); vi++) {
      const slot = this.items[vi];
      const it = weapons.ITEMS[slot];
      const price = this.state.economy.price[slot];
      const owned = this.tank.inventory[slot];
      const c: [number, number, number] = vi === this.sel ? [255, 255, 120] : [200, 200, 200];
      const row = [it.name, `$${price}`, String(it.bundle), String(owned), String(it.arms)];
      for (let j = 0; j < col_x.length; j++) {
        surf.blit(this.font.render(row[j], true, c), [col_x[j], y]);
      }
      y += 16;
    }
    const hint = this.font.render(
      "Up/Down  Enter=Buy  X=Sell  Tab/Esc=Done",
      true,
      [160, 160, 180],
    );
    surf.blit(hint, [20, this.h - 26]);
  }
}

// ---------------------------------------------------------------------------
// draw_rankings -- score/rankings panel rendered as the real 4f19 GREY BEVELED
// DIALOG (FUN_3cc4_0983 interim / FUN_33a1_054a final).
// ---------------------------------------------------------------------------

/** The deconstructed numeric substrate of draw_rankings (everything testable
 *  without pixels): the ranked order, the wrapped war-quote lines, the placed
 *  panel geometry, the per-row darkened colors, and the dismiss-button rect that
 *  becomes state._rankings_go_rect. Computed by rankings_layout(); draw_rankings
 *  draws from it. */
export interface RankingsLayout {
  ranked: RankTank[];
  qlines: string[];
  title_h: number;
  row_h: number;
  pad: number;
  btn_h: number;
  body_h: number;
  pw: number;
  ph: number;
  px: number;
  py: number;
  cx: number;
  /** per-row [r,g,b] after the light-grey luminance darkening. */
  row_colors: Array<[number, number, number]>;
  go_rect: pygame.Rect;
  bar_rgb: [number, number, number];
}

/** Wrap a war-quote string to the panel width (48-col greedy wrap), appending the
 *  "- author" line. Mirrors ui.py:317-328 exactly (Python str.split() collapses
 *  runs of whitespace and drops leading/trailing). */
function wrapQuote(qtext: string, qauthor: string): string[] {
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
  if (cur) {
    qlines.push(cur);
  }
  qlines.push(`- ${qauthor}`);
  return qlines;
}

/** Compute the full numeric layout of the rankings panel (no drawing). Used by
 *  draw_rankings and exercised directly by the differential gate. */
export function rankings_layout(
  renderer: RankRenderer,
  state: RankState,
  title: string,
  rounds_left: number | null,
  quote: [string, string] | null,
): RankingsLayout {
  const sfont = renderer.font;
  const bigfont = renderer.bigfont;
  const cx = Math.trunc(state.w / 2);

  const ranked: RankTank[] =
    state.ranking || [...state.tanks].sort((a, b) => -a.score - -b.score);

  // wrap the war quote (game end) to the panel width
  let qlines: string[] = [];
  if (quote) {
    qlines = wrapQuote(quote[0], quote[1]);
  }

  // ---- measure + place the grey panel ----
  const title_h = bigfont.size(title)[1];
  const row_h = 22;
  const pad = 22;
  const btn_h = bigfont.size("Go")[1] + 10;
  const body_h =
    title_h +
    14 +
    row_h * ranked.length +
    (rounds_left !== null ? 26 : 0) +
    (qlines.length ? 8 + 18 * qlines.length : 0) +
    14 +
    btn_h;
  const pw = 480;
  const ph = body_h + pad * 2;
  const px = cx - Math.trunc(pw / 2);
  const py = Math.max(16, Math.trunc(state.h / 2) - Math.trunc(ph / 2));

  // per-row tank colour darkened for the light grey (ui.py:367-374)
  const row_colors: Array<[number, number, number]> = [];
  for (const t of ranked) {
    const pc = renderer.pal[t.color];
    const col: [number, number, number] = [
      pyInt(Number(pc[0])),
      pyInt(Number(pc[1])),
      pyInt(Number(pc[2])),
    ];
    const lum = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2];
    const rc: [number, number, number] =
      lum < 150 ? col : [Math.max(0, col[0] - 90), Math.max(0, col[1] - 90), Math.max(0, col[2] - 90)];
    row_colors.push(rc);
  }

  // dismiss button (raised bevel) geometry -> _rankings_go_rect (ui.py:392-402)
  // Recompute y exactly as the draw walk does so bx/by2 match byte-for-byte.
  // The button rect depends only on px/ph/pad/btn_h + bigfont "Go" width.
  const goW = bigfont.size("Go")[0]; // bigfont.render("Go").get_width()
  const bw2 = goW + 30;
  const bh2 = btn_h;
  const bx = cx - Math.trunc(bw2 / 2);
  const by2 = py + ph - pad - bh2;
  const go_rect = new pygame.Rect(bx, by2, bw2, bh2);

  const bp = renderer.pal[0x6e];
  const bar_rgb: [number, number, number] = [pyInt(Number(bp[0])), pyInt(Number(bp[1])), pyInt(Number(bp[2]))];

  return {
    ranked,
    qlines,
    title_h,
    row_h,
    pad,
    btn_h,
    body_h,
    pw,
    ph,
    px,
    py,
    cx,
    row_colors,
    go_rect,
    bar_rgb,
  };
}

/** Score/rankings panel rendered as the real 4f19 grey beveled dialog. Pass
 *  `quote` = [text, author] on the game-over screen only (the war quote); None on
 *  the interim rankings. `rounds_left` (int) draws the rounds-remaining line
 *  (interim); null omits it (game end). Sets state._rankings_go_rect to the
 *  dismiss-button rect for the click router. */
export function draw_rankings(
  surf: pygame.Surface,
  renderer: RankRenderer,
  state: RankState,
  title = "Player Rankings",
  rounds_left: number | null = null,
  quote: [string, string] | null = null,
): void {
  const W = pygame; // alias kept to read 1:1 with the `import widgets as _w` form
  // widgets palette greys (recovered Borland dialog grey, widgets.py:22-25).
  const C_PANEL: [number, number, number] = [170, 170, 170];
  const C_PANEL_HI: [number, number, number] = [210, 210, 210];
  const C_PANEL_LO: [number, number, number] = [110, 110, 110];
  const C_TEXT_LT: [number, number, number] = [255, 255, 255];

  const sfont = renderer.font;
  const bigfont = renderer.bigfont;

  const L = rankings_layout(renderer, state, title, rounds_left, quote);
  const { ranked, qlines, title_h, row_h, pad, px, py, pw, ph, cx, bar_rgb } = L;

  // ---- 4f19 grey beveled panel (raised: HI top/left, LO bottom/right) ----
  W.draw.rect(surf, C_PANEL, [px, py, pw, ph]);
  W.draw.line(surf, C_PANEL_HI, [px, py], [px + pw - 1, py]);
  W.draw.line(surf, C_PANEL_HI, [px, py], [px, py + ph - 1]);
  W.draw.line(surf, C_PANEL_LO, [px + pw - 1, py], [px + pw - 1, py + ph - 1]);
  W.draw.line(surf, C_PANEL_LO, [px, py + ph - 1], [px + pw - 1, py + ph - 1]);

  let y = py + pad;

  // ---- title (dark on grey) + red flanking bars (recovered team-red slot 0x6e) ----
  const tsurf = bigfont.render(title, true, [24, 24, 32]);
  const tw = tsurf.get_width();
  surf.blit(tsurf, [cx - Math.trunc(tw / 2), y]);
  const bh = Math.max(8, title_h - 10);
  const bw = 13;
  const by = y + Math.trunc((title_h - bh) / 2);
  W.draw.rect(surf, bar_rgb, [cx - Math.trunc(tw / 2) - 12 - bw, by, bw, bh]);
  W.draw.rect(surf, bar_rgb, [cx + Math.trunc(tw / 2) + 12, by, bw, bh]);
  y += title_h + 14;

  // ---- rows: #N  Name  N wins  $cash ; tank colour darkened for the light grey ----
  const col_x = [px + 44, px + 96, px + 250, px + 366];
  for (let i = 0; i < ranked.length; i++) {
    const t = ranked[i];
    const rc = L.row_colors[i];
    const cells = [`#${i + 1}`, String(t.name), `${t.win_counter} wins`, `$${t.cash}`];
    for (let j = 0; j < col_x.length; j++) {
      surf.blit(sfont.render(cells[j], true, rc), [col_x[j], y]);
    }
    y += row_h;
  }

  // ---- "N rounds remain." (interim only) ----
  if (rounds_left !== null) {
    const rtxt = rounds_left === 1 ? "1 round remains" : `${rounds_left} rounds remain`;
    const rr = sfont.render(rtxt, true, [40, 40, 40]);
    surf.blit(rr, [cx - Math.trunc(rr.get_width() / 2), y + 4]);
    y += 26;
  }

  // ---- war quote (game end only): centered, author dimmed ----
  if (qlines.length) {
    y += 8;
    for (let j = 0; j < qlines.length; j++) {
      const ql = qlines[j];
      const qc: [number, number, number] = j === qlines.length - 1 ? [70, 70, 70] : [24, 24, 24];
      const qs = sfont.render(ql, true, qc);
      surf.blit(qs, [cx - Math.trunc(qs.get_width() / 2), y]);
      y += 18;
    }
  }

  // ---- dismiss button (raised bevel) ----
  const go = bigfont.render("Go", true, [20, 20, 30]);
  const bw2 = go.get_width() + 30;
  const bh2 = L.btn_h;
  const bx = cx - Math.trunc(bw2 / 2);
  const by2 = py + ph - pad - bh2;
  W.draw.rect(surf, C_PANEL_HI, [bx, by2, bw2, bh2]);
  W.draw.line(surf, C_TEXT_LT, [bx, by2], [bx + bw2 - 1, by2]);
  W.draw.line(surf, C_TEXT_LT, [bx, by2], [bx, by2 + bh2 - 1]);
  W.draw.line(surf, C_PANEL_LO, [bx + bw2 - 1, by2], [bx + bw2 - 1, by2 + bh2 - 1]);
  W.draw.line(surf, C_PANEL_LO, [bx, by2 + bh2 - 1], [bx + bw2 - 1, by2 + bh2 - 1]);
  surf.blit(go, [bx + 15, by2 + 5]);
  state._rankings_go_rect = new pygame.Rect(bx, by2, bw2, bh2);
}

// ---------------------------------------------------------------------------
// Font builders (DOM; only the .draw() paths reach these).
// ---------------------------------------------------------------------------

function font18(): pygame.Font {
  return pygame.font.SysFont("consolas,couriernew,monospace", 18);
}
function bigFont34(): pygame.Font {
  return pygame.font.SysFont("consolas,couriernew,monospace", 34, true);
}
function font15(): pygame.Font {
  return pygame.font.SysFont("consolas,couriernew,monospace", 15);
}
function bigFont26(): pygame.Font {
  return pygame.font.SysFont("consolas,couriernew,monospace", 26, true);
}

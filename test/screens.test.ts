/**
 * Differential gate: TS screens == Python scorch.screens (the fidelity oracle).
 *
 * Golden vectors come from oracle/dump_screens.py -> oracle/vectors/screens.json.
 * This test runs in Node (vitest environment: "node"), which has NO DOM, so it
 * exercises the NUMERIC / LOGIC substrate of the out-of-game UI only:
 *
 *   - module data tables   : ENUM_LABELS, SUBMENUS shape, AI_TYPE_LABELS,
 *                            TANK_ICONS, the NUM_ counts + TANK_ICON_CPU_ONLY,
 *                            REGISTRATION_LINES, SHOP_ICON_RGB6/BASE/COUNT/CYCLE
 *   - tank_icon_mobile     : per-index mobility flag
 *   - _build_shop_lut      : the 21-entry icon band RGB (6->8-bit expansion) +
 *                            the low-slot <-> DAC-0xAA mirror
 *   - _save_path/_list_saves : filename normalisation (basename/ext/traversal),
 *                            os.path.splitext + sort over a synthetic listing
 *   - TankInit             : _build_shades ramp, _set_icon/_set_player_type/
 *                            _set_sim_key (dup-reject)/_team_for value logic, the
 *                            ~Done result tuple composition, update() palette phase
 *   - Shop FLOW            : _refresh_items (category+arms+affordability filter),
 *                            _affordable, _buy_selected (cash/inventory mutation +
 *                            list compaction + cursor follow), _move_selection/
 *                            _scroll_by/_max_scroll, _category_click, update()
 *                            palette-cycle counter
 *   - SellScreen._offer    : 0.80/0.65 sellback pricing (pyRound) + accept commit
 *   - Inventory            : _GUIDANCE_SLOTS, _owned_offensive set, guidance owned
 *                            filter, _weapon_array_index, _count_str
 *   - option cycling       : the _enum_selector Selector get/set round-trip
 *
 * HEADLESS SEAM: every Screen CONSTRUCTOR builds font-measured Label/Button
 * widgets (a Canvas2D/DOM the test env lacks), so the screens cannot be `new`-ed
 * here.  The REAL method bodies are reached by attaching the instance fields the
 * method reads to an Object.create(<Screen>.prototype) -- the exact seam ingame's
 * _BatteryDischargeScreen and ui.ts established.  This tests the actual ported
 * method body, not a reimplementation.
 *
 * EPSILON POLICY: every asserted value is an INTEGER, an index, a boolean, a
 * string, an RGB byte, or an exactly-representable float, asserted EXACT
 * (.toBe/.toEqual) -- EXCEPT the TankInit palette-cycle phase, which is
 * `phase + rate*dt` accumulated in a transcendental-free but float-accumulating
 * loop; it is asserted within toBeCloseTo(.,12) per the brief's float rule.  The
 * shop palette-cycle COUNTER is an integer (int(accum)) and is asserted EXACT.
 *
 * DRAWN PIXELS: the .draw() methods (pygame.draw / blit / font) and the
 * sprite-cell painters are NOT tested here -- they are the Phase-3 visual gate's
 * job (pixelsDeferredToPhase3 = true).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as screens from "../src/screens";
import * as weapons from "../src/weapons";
import * as palette from "../src/palette";
import { Economy } from "../src/economy";
import type { EconomyConfig, EconomyTank } from "../src/economy";
import { Config } from "../src/config";
import * as C from "../src/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "screens.json");

// ---------------------------------------------------------------------------
// Vector shapes
// ---------------------------------------------------------------------------
type RGB = [number, number, number];
type SubmenuRowRec = { kind: string; a: string | null; b: string | null; nums: number[] };
type DataVec = {
  enum_labels: { [k: string]: [string[], string[]] };
  submenu_keys: string[];
  submenus: { [k: string]: { title: string; rows: SubmenuRowRec[] } };
  ai_type_labels: string[];
  tank_icons: [boolean, boolean][];
  num_tank_icons: number;
  tank_icon_cpu_only: number;
  num_appearance_icons: number;
  tank_icon_mobile: boolean[];
  registration_lines: string[];
  shop_icon_base: number;
  shop_icon_count: number;
  shop_cycle_count: number;
  shop_icon_rgb6: RGB[];
};
type ShopLutVec = { low: RGB[]; band: RGB[] };
type SavesVec = {
  save_path: { name: string; base: string | null }[];
  list_saves: { listing: string[]; out: string[] }[];
};
type TankInitVec = {
  shades: { color: RGB; n: number; out: RGB[] }[];
  set_icon: { in: number; icon_index: number }[];
  set_type: { in: number; is_computer: boolean }[];
  sim_key: { i: number; v: string; keys: string[] }[];
  team_for: { team_mode: string; player_index: number; team: number }[];
  result: {
    is_computer: boolean; ai_index: number; name: string; icon_index: number;
    team_mode: string; player_index: number; ai_class: number; name_out: string; team: number;
  }[];
  cycle_rate: number;
  cycle: number[];
  cycle_dt: number;
};
type ShopVec = {
  refresh: { arms: number; cash: number; category: number; items: number[]; rows_visible: number }[];
  affordable: { slot: number; cash: number; owned: number; out: boolean }[];
  buy_flow: {
    step: number; slot_before: number; cash: number; cash_delta: number;
    items: number[]; sel_row: number; scroll: number; baby_missile_owned: number;
  }[];
  nav: { move: number; sel_row: number; scroll: number; max_scroll: number }[];
  scroll_by: { d: number; scroll: number }[];
  cat_click: { click: number; category: number; sel_row: number; scroll: number; n_items: number }[];
  cycle: { counter: number }[];
  cycle_dt: number;
  palette_cycle_hz: number;
};
type SellVec = {
  offers: { slot: number; price: number; qty: number; free_market: boolean; offer: number; bundle: number }[];
  accept: {
    slot: number; price: number; qty: number; owned: number; free_market: boolean;
    committed: number; cash_after: number; owned_after: number;
  }[];
};
type InvVec = {
  guidance_slots: number[];
  cases: {
    inv_ov: { [k: string]: number }; selected_weapon: number; weapon_slots: number[];
    array_slots: number[]; guidance_slots: number[]; array_index: number; count_str: { [k: string]: string };
  }[];
};
type OptionCycleVec = {
  key: string; tokens: string[]; display: string[];
  steps: { idx: number; token: string; label: string }[];
}[];
type ScreensVectors = {
  module: string;
  data: DataVec;
  shop_lut: ShopLutVec;
  saves: SavesVec;
  tank_init: TankInitVec;
  shop: ShopVec;
  sell: SellVec;
  inventory: InvVec;
  option_cycle: OptionCycleVec;
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as ScreensVectors;

// ---------------------------------------------------------------------------
// Mocks -- structurally identical to oracle/dump_screens.py.
// ---------------------------------------------------------------------------
class TankMock {
  player_index: number;
  name: string;
  cash: number;
  inventory: number[];
  selected_weapon: number;
  selected_guidance: number | null;
  constructor(o: {
    player_index?: number; name?: string; cash?: number; inv?: number[];
    selected_weapon?: number; selected_guidance?: number | null;
  } = {}) {
    this.player_index = o.player_index ?? 0;
    this.name = o.name ?? "P1";
    this.cash = o.cash ?? 0;
    this.inventory = o.inv ? o.inv.slice() : new Array<number>(weapons.NUM_ITEMS).fill(0);
    this.selected_weapon = o.selected_weapon ?? 0;
    this.selected_guidance = o.selected_guidance ?? null;
  }
  has_ammo(slot: number): boolean {
    if (slot === weapons.SLOT_BABY_MISSILE) {
      return true;
    }
    return this.inventory[slot] > 0;
  }
}

class CfgMock implements EconomyConfig {
  ARMS: number;
  INTEREST_RATE = 0.05;
  private _free_market: boolean;
  private _useless: boolean;
  constructor(arms = 4, free_market = false) {
    this.ARMS = arms;
    this._free_market = free_market;
    this._useless = true;
  }
  is_on(key: string): boolean {
    if (key === "FREE_MARKET") {
      return this._free_market;
    }
    if (key === "USELESS_ITEMS") {
      return this._useless;
    }
    return false;
  }
}

function makeEcon(arms = 4, priceOv: { [slot: number]: number } = {}, freeMarket = false): Economy {
  const e = new Economy(new CfgMock(arms, freeMarket));
  e.refresh_availability();
  for (const k of Object.keys(priceOv)) {
    e.price[Number(k)] = priceOv[Number(k)];
  }
  return e;
}

// ---------------------------------------------------------------------------
// Headless seam: reach a Screen's real method bodies WITHOUT running the
// font-measured constructor.  Object.create links the prototype; we set the
// fields the methods read.
// ---------------------------------------------------------------------------
function shopSeam(opts: {
  econ: Economy; tank: TankMock; category?: number; rows_visible?: number;
  sel_row?: number; scroll?: number; round_index?: number;
}): screens.ShopScreen {
  const self = Object.create(screens.ShopScreen.prototype) as screens.ShopScreen;
  self.econ = opts.econ;
  self.tank = opts.tank as unknown as EconomyTank & {
    cash: number; inventory: number[]; player_index?: number; name: string;
    has_ammo(s: number): boolean; selected_weapon?: number; selected_guidance?: number | null;
  };
  self.state = { economy: opts.econ, cfg: { MAXROUNDS: 10, is_on: () => false }, round_index: opts.round_index ?? 0 };
  self.category = opts.category ?? 0;
  self.rows_visible = opts.rows_visible ?? 18;
  self.sel_row = opts.sel_row ?? 0;
  self.scroll = opts.scroll ?? 0;
  self.items = [];
  return self;
}

describe("screens: oracle invariants", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("screens");
  });
});

// ===========================================================================
// 1. module data tables
// ===========================================================================
describe("screens: module data tables (verbatim, index-for-index)", () => {
  it("ENUM_LABELS == the oracle (tokens + display per key)", () => {
    const keys = Object.keys(vec.data.enum_labels);
    expect(Object.keys(screens.ENUM_LABELS).sort()).toEqual(keys.sort());
    for (const k of keys) {
      const [toks, disp] = screens.ENUM_LABELS[k];
      expect(toks, `${k} tokens`).toEqual(vec.data.enum_labels[k][0]);
      expect(disp, `${k} display`).toEqual(vec.data.enum_labels[k][1]);
      // display and token arrays are the same length (Selector index == enum idx)
      expect(toks.length, `${k} len`).toBe(disp.length);
    }
  });

  it("SUBMENUS keys + per-row (kind, cfg-key, label, numeric range) match", () => {
    expect(Object.keys(screens.SUBMENUS)).toEqual(vec.data.submenu_keys);
    for (const spec of vec.data.submenu_keys) {
      const [title, fields] = screens.SUBMENUS[spec];
      const want = vec.data.submenus[spec];
      expect(title, `${spec} title`).toBe(want.title);
      expect(fields.length, `${spec} row count`).toBe(want.rows.length);
      for (let r = 0; r < fields.length; r++) {
        const row = fields[r];
        const wr = want.rows[r];
        expect(row[0], `${spec}[${r}] kind`).toBe(wr.kind);
        const a = typeof row[1] === "string" ? row[1] : null;
        const b = typeof row[2] === "string" ? row[2] : null;
        expect(a, `${spec}[${r}] a`).toBe(wr.a);
        expect(b, `${spec}[${r}] b`).toBe(wr.b);
        const nums = row.slice(3).filter((v) => typeof v === "number") as number[];
        expect(nums, `${spec}[${r}] nums`).toEqual(wr.nums);
      }
    }
  });

  it("AI_TYPE_LABELS == the oracle", () => {
    expect(screens.AI_TYPE_LABELS).toEqual(vec.data.ai_type_labels);
  });

  it("TANK_ICONS + NUM_* + TANK_ICON_CPU_ONLY + NUM_APPEARANCE_ICONS", () => {
    expect(screens.TANK_ICONS).toEqual(vec.data.tank_icons);
    expect(screens.NUM_TANK_ICONS).toBe(vec.data.num_tank_icons);
    expect(screens.TANK_ICON_CPU_ONLY).toBe(vec.data.tank_icon_cpu_only);
    expect(screens.NUM_APPEARANCE_ICONS).toBe(vec.data.num_appearance_icons);
  });

  it("tank_icon_mobile(-1..8) == the oracle (out-of-range -> true)", () => {
    for (let i = -1; i <= 8; i++) {
      expect(screens.tank_icon_mobile(i), `mobile(${i})`).toBe(vec.data.tank_icon_mobile[i + 1]);
    }
  });

  it("REGISTRATION_LINES == the oracle (verbatim, 14 lines)", () => {
    expect(screens.REGISTRATION_LINES).toEqual(vec.data.registration_lines);
  });

  it("SHOP_ICON_BASE/COUNT/CYCLE_COUNT + SHOP_ICON_RGB6 (6-bit)", () => {
    expect(screens.SHOP_ICON_BASE).toBe(vec.data.shop_icon_base);
    expect(screens.SHOP_ICON_COUNT).toBe(vec.data.shop_icon_count);
    expect(screens.SHOP_CYCLE_COUNT).toBe(vec.data.shop_cycle_count);
    expect(screens.SHOP_ICON_RGB6).toEqual(vec.data.shop_icon_rgb6);
  });
});

// ===========================================================================
// 2. _build_shop_lut -- the installed icon band (6->8-bit) + low/0xAA mirror
// ===========================================================================
describe("screens: _build_shop_lut (21-entry icon band, 6->8-bit expansion)", () => {
  it("low staging slots 0..0x14 AND DAC band 0xAA.. match the oracle", () => {
    const lut = screens._build_shop_lut();
    for (let i = 0; i < screens.SHOP_ICON_COUNT; i++) {
      expect(lut.get(i), `low[${i}]`).toEqual(vec.shop_lut.low[i]);
      expect(lut.get(screens.SHOP_ICON_BASE + i), `band[${i}]`).toEqual(vec.shop_lut.band[i]);
    }
  });
  it("is a real palette.LiveLUT (table length 256)", () => {
    const lut = screens._build_shop_lut();
    expect(lut).toBeInstanceOf(palette.LiveLUT);
    expect(lut.table.length).toBe(256);
  });
});

// ===========================================================================
// 3. _save_path / _list_saves -- filename handling
// ===========================================================================
describe("screens: _save_path (basename + .sav ext + no traversal)", () => {
  for (let i = 0; i < vec.saves.save_path.length; i++) {
    const c = vec.saves.save_path[i];
    it(`#${i} ${JSON.stringify(c.name)} -> ${JSON.stringify(c.base)}`, () => {
      expect(screens._save_path(c.name)).toBe(c.base);
    });
  }
});

describe("screens: _list_saves (.sav filter + splitext + sort)", () => {
  for (let i = 0; i < vec.saves.list_saves.length; i++) {
    const c = vec.saves.list_saves[i];
    it(`#${i} ${JSON.stringify(c.listing)}`, () => {
      // TS _list_saves takes a raw listing array (the host-supplied directory
      // contents); the Python side recorded os.listdir of the same names.
      expect(screens._list_saves(c.listing)).toEqual(c.out);
    });
  }
});

// ===========================================================================
// 4. TankInitScreen logic
// ===========================================================================
describe("screens: TankInitScreen._build_shades (player-color ramp, static)", () => {
  for (let i = 0; i < vec.tank_init.shades.length; i++) {
    const c = vec.tank_init.shades[i];
    it(`#${i} color=${c.color} n=${c.n}`, () => {
      expect(screens.TankInitScreen._build_shades(c.color, c.n)).toEqual(c.out);
    });
  }
});

describe("screens: TankInit value logic via headless seam", () => {
  function tankInitSeam(player_index = 0): screens.TankInitScreen {
    const self = Object.create(screens.TankInitScreen.prototype) as screens.TankInitScreen;
    self.player_index = player_index;
    self.icon_index = 3;
    self.is_computer = false;
    self.ai_index = 3;
    self.name = `Player ${player_index + 1}`;
    self.sim_keys = ["", "", "", "", "", ""];
    return self;
  }

  it("_set_icon clamps to [0, NUM_APPEARANCE_ICONS-1] (trunc)", () => {
    for (const c of vec.tank_init.set_icon) {
      const self = tankInitSeam(0);
      self._set_icon(c.in);
      expect(self.icon_index, `_set_icon(${c.in})`).toBe(c.icon_index);
    }
  });

  it("_set_player_type maps 1 -> Computer else Person (trunc)", () => {
    for (const c of vec.tank_init.set_type) {
      const self = tankInitSeam(0);
      self._set_player_type(c.in);
      expect(self.is_computer, `_set_player_type(${c.in})`).toBe(c.is_computer);
    }
  });

  it("_set_sim_key rejects duplicates (manual L264-266 beep) and upper-cases", () => {
    const self = tankInitSeam(0);
    for (const c of vec.tank_init.sim_key) {
      self._set_sim_key(c.i, c.v);
      expect(self.sim_keys.slice(), `after set(${c.i},${c.v})`).toEqual(c.keys);
    }
  });

  it("_team_for: 0 when TEAM_NONE else player_index", () => {
    for (const c of vec.tank_init.team_for) {
      const self = tankInitSeam(c.player_index);
      const tmIdx = Config.load(`TEAM_MODE=${c.team_mode}`).team_mode;
      self.cfg = { team_mode: tmIdx } as unknown as typeof self.cfg;
      expect(self._team_for(), `_team_for ${c.team_mode}/${c.player_index}`).toBe(c.team);
    }
  });

  it("~Done result tuple composition (ai_class / name fallback / team)", () => {
    for (const c of vec.tank_init.result) {
      const self = tankInitSeam(c.player_index);
      self.is_computer = c.is_computer;
      self.ai_index = c.ai_index;
      self.name = c.name;
      self.icon_index = c.icon_index;
      const tmIdx = Config.load(`TEAM_MODE=${c.team_mode}`).team_mode;
      self.cfg = { team_mode: tmIdx } as unknown as typeof self.cfg;
      // replicate handle()'s 'tank_done' composition (the panel routing is DOM):
      const ai_class = self.is_computer ? self.ai_index + 1 : C.AI_HUMAN;
      const name_out = self.name.trim() || `Player ${self.player_index + 1}`;
      const team = self._team_for();
      expect(ai_class, `${c.name} ai_class`).toBe(c.ai_class);
      expect(name_out, `${c.name} name_out`).toBe(c.name_out);
      expect(team, `${c.name} team`).toBe(c.team);
    }
  });

  it("update() palette-cycle phase walk (mod RAMP; float epsilon)", () => {
    const self = Object.create(screens.TankInitScreen.prototype) as screens.TankInitScreen;
    self._cycle_phase = 0.0;
    self._cycle_rate = vec.tank_init.cycle_rate;
    self._RAMP = 40;
    const dt = vec.tank_init.cycle_dt;
    for (let i = 0; i < vec.tank_init.cycle.length; i++) {
      self.update(dt);
      expect(self._cycle_phase, `phase #${i}`).toBeCloseTo(vec.tank_init.cycle[i], 12);
    }
  });
});

// ===========================================================================
// 5. ShopScreen FLOW (the screen-level use of economy)
// ===========================================================================
describe("screens: ShopScreen._refresh_items (category + arms + affordability)", () => {
  for (let i = 0; i < vec.shop.refresh.length; i++) {
    const c = vec.shop.refresh[i];
    it(`#${i} arms=${c.arms} cash=${c.cash} cat=${c.category}`, () => {
      const econ = makeEcon(c.arms);
      const tank = new TankMock({ cash: c.cash });
      const self = shopSeam({ econ, tank, category: c.category });
      self._refresh_items();
      expect(self.items, `${i} items`).toEqual(c.items);
    });
  }
});

describe("screens: ShopScreen._affordable (price/cash/cap gate == economy.buy)", () => {
  for (let i = 0; i < vec.shop.affordable.length; i++) {
    const c = vec.shop.affordable[i];
    it(`#${i} slot=${c.slot} cash=${c.cash} owned=${c.owned}`, () => {
      const econ = makeEcon(4);
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      inv[c.slot] = c.owned;
      const tank = new TankMock({ cash: c.cash, inv });
      const self = shopSeam({ econ, tank });
      expect(self._affordable(c.slot)).toBe(c.out);
    });
  }
});

describe("screens: ShopScreen._buy_selected (debit + inventory + list compaction)", () => {
  it("buy sequence reproduces cash/inventory/items/cursor walk", () => {
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 3000 });
    const self = shopSeam({ econ, tank, category: 0 });
    self._refresh_items();
    for (let step = 0; step < vec.shop.buy_flow.length; step++) {
      const c = vec.shop.buy_flow[step];
      const slotBefore = self._selected_slot();
      expect(slotBefore, `step ${step} slot_before`).toBe(c.slot_before);
      self.sel_row = 0;
      self._buy_selected();
      expect(tank.cash, `step ${step} cash`).toBe(c.cash);
      expect(self.items, `step ${step} items`).toEqual(c.items);
      expect(self.sel_row, `step ${step} sel_row`).toBe(c.sel_row);
      expect(self.scroll, `step ${step} scroll`).toBe(c.scroll);
      expect(tank.inventory[weapons.SLOT_BABY_MISSILE], `step ${step} baby owned`).toBe(c.baby_missile_owned);
    }
  });
});

describe("screens: ShopScreen._move_selection / _scroll_by / _max_scroll", () => {
  it("_move_selection walk (clamp + scroll-to-keep-visible)", () => {
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank, category: 0, rows_visible: 5 });
    self._refresh_items();
    self.rows_visible = 5;
    self.scroll = 0;
    self.sel_row = 0;
    for (let i = 0; i < vec.shop.nav.length; i++) {
      const c = vec.shop.nav[i];
      self._move_selection(c.move);
      expect(self.sel_row, `nav #${i} sel_row`).toBe(c.sel_row);
      expect(self.scroll, `nav #${i} scroll`).toBe(c.scroll);
      expect(self._max_scroll(), `nav #${i} max_scroll`).toBe(c.max_scroll);
    }
  });

  it("_scroll_by walk (clamp to [0, max_scroll])", () => {
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank, category: 0, rows_visible: 5 });
    self._refresh_items();
    self.rows_visible = 5;
    self.scroll = 0;
    for (let i = 0; i < vec.shop.scroll_by.length; i++) {
      const c = vec.shop.scroll_by[i];
      self._scroll_by(c.d);
      expect(self.scroll, `scroll_by #${i}`).toBe(c.scroll);
    }
  });
});

describe("screens: ShopScreen._category_click (toggle + cursor reset + relist)", () => {
  it("click walk reproduces category/sel_row/scroll/n_items", () => {
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank, category: 0, sel_row: 3, scroll: 2 });
    self._refresh_items();
    self.sel_row = 3;
    self.scroll = 2;
    for (let i = 0; i < vec.shop.cat_click.length; i++) {
      const c = vec.shop.cat_click[i];
      self._category_click(c.click);
      expect(self.category, `click #${i} category`).toBe(c.category);
      expect(self.sel_row, `click #${i} sel_row`).toBe(c.sel_row);
      expect(self.scroll, `click #${i} scroll`).toBe(c.scroll);
      expect(self.items.length, `click #${i} n_items`).toBe(c.n_items);
    }
  });
});

describe("screens: ShopScreen.update (palette-cycle counter, 70Hz accumulator)", () => {
  it("counter walk matches the oracle (int(accum) wrap at 100)", () => {
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1000 });
    const self = shopSeam({ econ, tank });
    self.shop_lut = screens._build_shop_lut();
    self._cycle_counter = 0;
    self._cycle_accum = 0.0;
    const dt = vec.shop.cycle_dt;
    for (let i = 0; i < vec.shop.cycle.length; i++) {
      self.update(dt);
      expect(self._cycle_counter, `cycle #${i} counter`).toBe(vec.shop.cycle[i].counter);
    }
  });
});

// ===========================================================================
// 6. SellScreen._offer + accept commit
// ===========================================================================
describe("screens: SellScreen._offer (0.80/0.65 sellback, pyRound)", () => {
  function sellSeam(econ: Economy, tank: EconomyTank, slot: number): screens.SellScreen {
    const self = Object.create(screens.SellScreen.prototype) as screens.SellScreen;
    self.econ = econ;
    self.tank = tank;
    self.slot = slot;
    return self;
  }
  for (let i = 0; i < vec.sell.offers.length; i++) {
    const c = vec.sell.offers[i];
    it(`#${i} slot=${c.slot} price=${c.price} qty=${c.qty} fm=${c.free_market}`, () => {
      const econ = makeEcon(4, { [c.slot]: c.price }, c.free_market);
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      inv[c.slot] = 99;
      const tank = new TankMock({ inv });
      const self = sellSeam(econ, tank, c.slot);
      expect(weapons.ITEMS[c.slot].bundle, `${i} bundle`).toBe(c.bundle);
      expect(self._offer(c.qty), `${i} offer`).toBe(c.offer);
    });
  }
});

describe("screens: SellScreen accept -> economy.sell commit", () => {
  for (let i = 0; i < vec.sell.accept.length; i++) {
    const c = vec.sell.accept[i];
    it(`#${i} slot=${c.slot} qty=${c.qty} owned=${c.owned} fm=${c.free_market}`, () => {
      const econ = makeEcon(4, { [c.slot]: c.price }, c.free_market);
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      inv[c.slot] = c.owned;
      const tank = new TankMock({ cash: 100, inv });
      // accept commits via econ.sell (the handle() 'accept' branch)
      const committed = econ.sell(tank, c.slot, c.qty);
      expect(committed, `${i} committed`).toBe(c.committed);
      expect(tank.cash, `${i} cash_after`).toBe(c.cash_after);
      expect(tank.inventory[c.slot], `${i} owned_after`).toBe(c.owned_after);
    });
  }
});

// ===========================================================================
// 7. InventoryScreen logic
// ===========================================================================
describe("screens: InventoryScreen slot sets + counts + array index", () => {
  it("_GUIDANCE_SLOTS == the oracle (category == guidance)", () => {
    expect(screens.InventoryScreen._GUIDANCE_SLOTS).toEqual(vec.inventory.guidance_slots);
  });

  function invSeam(tank: TankMock): screens.InventoryScreen {
    // The constructor's weapon_slots/guidance_slots/_array_slots are computed from
    // the tank in _build_chrome (which also adds font-measured buttons), so reach
    // those pure computations off the prototype by replaying them directly.
    const self = Object.create(screens.InventoryScreen.prototype) as screens.InventoryScreen;
    self.tank = tank as unknown as screens.InventoryScreen["tank"];
    // weapon_slots = ingame._owned_offensive(tank) -- reproduced in screens.ts.
    const ws: number[] = [];
    for (let s = 0; s < weapons.NUM_ITEMS; s++) {
      if (weapons.ITEMS[s].offensive && tank.has_ammo(s)) {
        ws.push(s);
      }
    }
    self.weapon_slots = ws;
    self.guidance_slots = screens.InventoryScreen._GUIDANCE_SLOTS.filter((s) => tank.inventory[s] > 0);
    self._array_slots = ws.slice(0, 8);
    return self;
  }

  for (let i = 0; i < vec.inventory.cases.length; i++) {
    const c = vec.inventory.cases[i];
    it(`#${i} sel=${c.selected_weapon}`, () => {
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      for (const k of Object.keys(c.inv_ov)) {
        inv[Number(k)] = c.inv_ov[k];
      }
      const tank = new TankMock({ inv, selected_weapon: c.selected_weapon });
      const self = invSeam(tank);
      expect(self.weapon_slots, `${i} weapon_slots`).toEqual(c.weapon_slots);
      expect(self._array_slots, `${i} array_slots`).toEqual(c.array_slots);
      expect(self.guidance_slots, `${i} guidance_slots`).toEqual(c.guidance_slots);
      expect(self._weapon_array_index(), `${i} array_index`).toBe(c.array_index);
      for (const s of self.weapon_slots) {
        expect(self._count_str(s), `${i} count_str[${s}]`).toBe(c.count_str[String(s)]);
      }
    });
  }
});

// ===========================================================================
// 8. option cycling -- the _enum_selector Selector get/set round-trip
// ===========================================================================
describe("screens: option value cycling (_enum_selector get_idx/set_idx)", () => {
  // Reproduce the _enum_selector binding directly off a real Config: the Selector
  // get_idx/set_idx logic is exactly what _enum_selector closes over (screens.ts).
  function makeEnumBinding(cfg: Config, key: string): { getIdx: () => number; cycle: (d: number) => void } {
    const [tokens] = screens.ENUM_LABELS[key];
    const getIdx = (): number => {
      const cur = String((cfg as unknown as { [k: string]: unknown })[key]).toUpperCase();
      const toksU = tokens.map((t) => t.toUpperCase());
      const j = toksU.indexOf(cur);
      return j >= 0 ? j : 0;
    };
    const setIdx = (i: number): void => {
      (cfg as unknown as { [k: string]: unknown })[key] = tokens[((i % tokens.length) + tokens.length) % tokens.length];
    };
    const cycle = (d: number): void => {
      setIdx(((getIdx() + d) % tokens.length + tokens.length) % tokens.length);
    };
    return { getIdx, cycle };
  }

  for (const ks of vec.option_cycle) {
    it(`${ks.key} cycle walk (idx + cfg token + display label)`, () => {
      const cfg = new Config();
      const [tokens, display] = screens.ENUM_LABELS[ks.key];
      expect(tokens, `${ks.key} tokens`).toEqual(ks.tokens);
      expect(display, `${ks.key} display`).toEqual(ks.display);
      const b = makeEnumBinding(cfg, ks.key);
      // step seq: start (record), then +1 x (len+1), then -1, -1 -- mirror dumper
      const seq = [0, ...Array<number>(tokens.length + 1).fill(1), -1, -1];
      let step = 0;
      // initial
      {
        const idx = b.getIdx();
        const w = ks.steps[step];
        expect(idx, `${ks.key} step0 idx`).toBe(w.idx);
        expect(String((cfg as unknown as { [k: string]: unknown })[ks.key]), `${ks.key} step0 token`).toBe(w.token);
        expect(display[((idx % display.length) + display.length) % display.length], `${ks.key} step0 label`).toBe(w.label);
        step++;
      }
      for (let s = 1; s < seq.length; s++) {
        b.cycle(seq[s]);
        const idx = b.getIdx();
        const w = ks.steps[step];
        expect(idx, `${ks.key} step${step} idx`).toBe(w.idx);
        expect(String((cfg as unknown as { [k: string]: unknown })[ks.key]), `${ks.key} step${step} token`).toBe(w.token);
        expect(display[((idx % display.length) + display.length) % display.length], `${ks.key} step${step} label`).toBe(w.label);
        step++;
      }
    });
  }
});

/**
 * Differential gate (PART 2): the scorch.screens STATE MACHINES -- the real-game
 * event-handler / commit-routing paths the per-method screens.test.ts left
 * uncovered (it drove only the pure value-logic).  Golden vectors come from
 * oracle/dump_screens_flow.py -> oracle/vectors/screens_flow.json, which drives
 * the REAL Python Screen objects headless (SDL dummy) and snapshots the outcome.
 *
 * Runs in Node (no DOM), so the font-measured Screen CONSTRUCTORS (which build
 * Label/Button widgets) cannot run.  The real method BODIES are reached through
 * the Object.create(prototype) headless seam -- the same seam screens.test.ts /
 * ingame use -- by attaching the instance fields each handler reads.  Where a
 * handler delegates to Panel.handle (the already-differential-tested widget
 * router, test/widgets.test.ts), the Panel is stubbed to feed a scripted action,
 * so ONLY the screen's own dispatch runs -- the SAME isolation the Python dumper
 * applies (FakePanel), making the comparison apples-to-apples.  The Spinner/
 * Selector/Toggle/Panel constructors are DOM-free, so the OptionsScreen weapon
 * list runs against a REAL Panel + REAL Toggle widgets.
 *
 * EPSILON: every asserted value is an integer / index / boolean / string / RGB
 * byte, asserted EXACT (.toBe/.toEqual).  No transcendental on these paths.
 *
 * Drawn pixels (.draw / blit / font) stay in the Phase-3 visual gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import * as screens from "../src/screens";
import * as weapons from "../src/weapons";
import * as W from "../src/widgets";
import * as pygame from "../src/pygame";
import * as savegame from "../src/savegame";
import { Economy } from "../src/economy";
import type { EconomyConfig, EconomyTank } from "../src/economy";
import { Config } from "../src/config";
import type { ScreenEvent } from "../src/screen";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "screens_flow.json");

// ---------------------------------------------------------------------------
// Vector shapes
// ---------------------------------------------------------------------------
type EvSpec =
  | { t: "key"; k: "DOWN" | "UP" | "PGDN" | "PGUP" }
  | { t: "wheel"; d: number }
  | { t: "click"; row: number };
type ShopHandleVec = {
  geom: { grid_top: number; list_x: number; list_right: number };
  n_items: number;
  items: number[];
  rows_visible: number;
  script: EvSpec[];
  trace: { sel_row: number; scroll: number; ret: string | null }[];
};
type ShopDispatchVec = {
  case: string;
  ret?: string | null;
  slot?: number;
  cash_before?: number;
  cash_after?: number;
  owned_after?: number;
  items_before?: number[];
  items_after?: number[];
  sel_row?: number;
  arms?: number;
  start_cash?: number;
  category?: number;
  sell_slot?: number | null;
  owned?: number;
  scroll?: number;
  rows_visible?: number;
  n_items?: number;
}[];
type ShopGuardsVec = {
  empty_selected_slot: number | null;
  empty_move_sel_row: number;
  empty_buy_cash: number;
  empty_n_items: number;
  unafford_cash_before: number;
  unafford_cash_after: number;
  unafford_owned_after: number;
  update_tiny_counter: number;
  update_tiny_dt: number;
};
type SellAcceptVec = {
  slot?: number;
  price?: number;
  qty?: number;
  owned?: number;
  free_market?: boolean;
  ret: string | null;
  committed: number;
  cash_after: number;
  owned_after: number;
  case?: string;
}[];
type OptionsWeaponsVec = {
  wl_h: number;
  n_items: number;
  script: { d: number }[];
  trace: { d: number; scroll: number; visible_slots: number[]; labels: string[] }[];
  slot_names: string[];
};
type CalibVec = {
  key_ret: string | null;
  update_ret: string | null;
  nonkey_ret: string | null;
  reg_update_ret: string | null;
};
type SavesExtraVec = { listing: string[]; out: string[] }[];
type SaveStringsVec = {
  filelist_primary_label: string;
  filelist_primary_action: string;
  save_primary_label: string;
  save_primary_action: string;
  save_err_create: string;
  save_confirm_tmpl: string;
  restore_primary_label: string;
  restore_primary_action: string;
  restore_err_missing: string;
  save_ext: string;
};
type FlowVectors = {
  module: string;
  shop_handle: ShopHandleVec;
  shop_dispatch: ShopDispatchVec;
  shop_guards: ShopGuardsVec;
  sell_accept: SellAcceptVec;
  options_weapons: OptionsWeaponsVec;
  calibrate_registration: CalibVec;
  saves_extra: SavesExtraVec;
  save_strings: SaveStringsVec;
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as FlowVectors;

// ---------------------------------------------------------------------------
// Mocks -- structurally identical to oracle/dump_screens_flow.py.
// ---------------------------------------------------------------------------
class TankMock {
  player_index: number;
  name: string;
  cash: number;
  inventory: number[];
  selected_weapon: number;
  selected_guidance: number | null;
  constructor(o: { player_index?: number; name?: string; cash?: number; inv?: number[] } = {}) {
    this.player_index = o.player_index ?? 0;
    this.name = o.name ?? "P1";
    this.cash = o.cash ?? 0;
    this.inventory = o.inv ? o.inv.slice() : new Array<number>(weapons.NUM_ITEMS).fill(0);
    this.selected_weapon = 0;
    this.selected_guidance = null;
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
  private _useless = true;
  constructor(arms = 4, free_market = false) {
    this.ARMS = arms;
    this._free_market = free_market;
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

/** A Panel stub: feeds the screen's dispatch one scripted action (the unit-
 *  isolation seam, symmetric with the dumper's FakePanel). */
function fakePanel(act: string | [string, number] | null): { handle: () => string | [string, number] | null } {
  return { handle: () => act };
}

type ShopTank = EconomyTank & {
  cash: number;
  inventory: number[];
  player_index?: number;
  name: string;
  has_ammo(s: number): boolean;
};

function shopSeam(opts: {
  econ: Economy;
  tank: TankMock;
  category?: number;
  rows_visible?: number;
  sel_row?: number;
  scroll?: number;
}): screens.ShopScreen {
  const self = Object.create(screens.ShopScreen.prototype) as screens.ShopScreen;
  self.econ = opts.econ;
  self.tank = opts.tank as unknown as ShopTank;
  self.state = { economy: opts.econ, cfg: { MAXROUNDS: 10, is_on: () => false }, round_index: 0 };
  self.category = opts.category ?? 0;
  self.rows_visible = opts.rows_visible ?? 18;
  self.sel_row = opts.sel_row ?? 0;
  self.scroll = opts.scroll ?? 0;
  self.items = [];
  return self;
}

/** Build a pygame-shaped event from a dumped EvSpec, mirroring dump _ev_for. */
function evFor(spec: EvSpec, geom: { grid_top: number; list_x: number }): ScreenEvent {
  if (spec.t === "key") {
    const k = { DOWN: pygame.K_DOWN, UP: pygame.K_UP, PGDN: pygame.K_PAGEDOWN, PGUP: pygame.K_PAGEUP }[spec.k];
    return { type: pygame.KEYDOWN, key: k };
  }
  if (spec.t === "wheel") {
    return { type: pygame.MOUSEBUTTONDOWN, button: spec.d < 0 ? 4 : 5, pos: [0, 0] };
  }
  // click screen-row r -> hits items[scroll + r]
  return {
    type: pygame.MOUSEBUTTONDOWN,
    button: 1,
    pos: [geom.list_x + 5, geom.grid_top + spec.row * 18 + 2],
  };
}

afterEach(() => {
  // never leak provider state into the rest of the suite
  screens.setSaveStoreProvider(null);
  screens.setSpritesProvider(null);
});

// ===========================================================================
// 1. ShopScreen.handle -- mouse + keyboard EARLY-RETURN routing (no panel)
// ===========================================================================
describe("screens_flow: ShopScreen.handle keyboard/mouse routing == Python", () => {
  it("scripted event walk reproduces sel_row/scroll/ret tick-for-tick", () => {
    const h = vec.shop_handle;
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank });
    // pin the geometry to the Python construct so the row hit-test matches
    self._grid_top = h.geom.grid_top;
    self._list_x = h.geom.list_x;
    self._list_right = h.geom.list_right;
    self.rows_visible = h.rows_visible;
    self.items = h.items.slice();
    self.sel_row = 0;
    self.scroll = 0;
    // a stub panel only reached if a click misses every row (the script's clicks hit)
    self.panel = fakePanel(null) as unknown as typeof self.panel;
    // sanity: the dumped item list is the one this econ produces (else economy drift)
    const live = shopSeam({ econ, tank });
    live._refresh_items();
    expect(live.items, "shop item list == dump (economy parity)").toEqual(h.items);

    for (let i = 0; i < h.script.length; i++) {
      const ret = self.handle(evFor(h.script[i], h.geom));
      const w = h.trace[i];
      expect(self.sel_row, `step ${i} (${JSON.stringify(h.script[i])}) sel_row`).toBe(w.sel_row);
      expect(self.scroll, `step ${i} scroll`).toBe(w.scroll);
      expect(ret, `step ${i} ret`).toBe(w.ret);
    }
  });
});

// ===========================================================================
// 2. ShopScreen.handle -- panel-action dispatch (buy/inventory/sell_req/scroll)
// ===========================================================================
describe("screens_flow: ShopScreen.handle action dispatch == Python", () => {
  const dispatch = vec.shop_dispatch;
  const byCase = (c: string) => dispatch.find((d) => d.case === c)!;

  it("'buy' debits cash, mutates inventory, recompacts list (cash/items parity)", () => {
    const c = byCase("buy");
    const econ = makeEcon(c.arms ?? 4);
    const tank = new TankMock({ cash: c.start_cash ?? 900 });
    const self = shopSeam({ econ, tank, category: c.category ?? 0, rows_visible: 35 });
    self._refresh_items();
    expect(self.items, "items_before == dump").toEqual(c.items_before);
    self.sel_row = 0;
    self.scroll = 0;
    self.panel = fakePanel("buy") as unknown as typeof self.panel;
    const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
    expect(ret, "buy ret").toBe(c.ret ?? null);
    expect(tank.cash, "cash_after").toBe(c.cash_after);
    expect(self.items, "items_after").toEqual(c.items_after);
    expect(tank.inventory[c.slot as number], "owned_after").toBe(c.owned_after);
    expect(self.sel_row, "sel_row").toBe(c.sel_row);
  });

  it("'inventory' returns 'shop_inventory'", () => {
    const c = byCase("inventory");
    const self = shopSeam({ econ: makeEcon(4), tank: new TankMock({ cash: 1000 }) });
    self.panel = fakePanel("inventory") as unknown as typeof self.panel;
    expect(self.handle({ type: pygame.KEYDOWN, key: 0 })).toBe(c.ret);
  });

  it("'sell_req' on an owned slot sets sell_slot and returns 'push:sell'", () => {
    const c = byCase("sell_req_owned");
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank, category: 0 });
    self._refresh_items();
    self.sel_row = c.sel_row as number;
    const sel = self._selected_slot() as number;
    tank.inventory[sel] = c.owned as number;
    self.sell_slot = null;
    self.panel = fakePanel("sell_req") as unknown as typeof self.panel;
    const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
    expect(ret, "ret").toBe(c.ret);
    expect(self.sell_slot, "sell_slot == selected").toBe(sel);
    expect(self.sell_slot, "sell_slot == dump").toBe(c.sell_slot);
  });

  it("'sell_req' on an UNOWNED slot returns null, sell_slot stays null", () => {
    const c = byCase("sell_req_unowned");
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank, category: 0 });
    self._refresh_items();
    self.sel_row = c.sel_row as number;
    self.sell_slot = null;
    self.panel = fakePanel("sell_req") as unknown as typeof self.panel;
    expect(self.handle({ type: pygame.KEYDOWN, key: 0 }), "ret").toBe(c.ret);
    expect(self.sell_slot, "sell_slot").toBe(c.sell_slot ?? null);
  });

  it("['__scroll__', d] pages the grid by d*rows_visible", () => {
    const c = byCase("scroll_page_down");
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 1_000_000 });
    const self = shopSeam({ econ, tank, category: 0, rows_visible: c.rows_visible ?? 5 });
    self._refresh_items();
    self.rows_visible = c.rows_visible as number;
    self.scroll = 0;
    expect(self.items.length, "n_items == dump").toBe(c.n_items);
    self.panel = fakePanel(["__scroll__", 1]) as unknown as typeof self.panel;
    const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
    expect(ret, "scroll ret").toBeNull();
    expect(self.scroll, "scroll paged").toBe(c.scroll);
  });

  it("an unknown panel action is returned verbatim (passthrough)", () => {
    const c = byCase("passthrough");
    const self = shopSeam({ econ: makeEcon(4), tank: new TankMock({ cash: 1000 }) });
    self.panel = fakePanel("pop") as unknown as typeof self.panel;
    expect(self.handle({ type: pygame.KEYDOWN, key: 0 })).toBe(c.ret);
  });
});

// ===========================================================================
// 3. ShopScreen guard branches + update() early return
// ===========================================================================
describe("screens_flow: ShopScreen guard branches == Python", () => {
  const g = vec.shop_guards;

  it("empty list: _selected_slot null, _move_selection no-op, _buy_selected no-op", () => {
    const econ = makeEcon(4);
    const tank = new TankMock({ cash: 0 }); // broke -> nothing affordable
    const self = shopSeam({ econ, tank, category: 0 });
    self._refresh_items();
    expect(self.items.length, "n_items").toBe(g.empty_n_items);
    expect(self._selected_slot(), "selected_slot").toBe(g.empty_selected_slot);
    self.sel_row = 0;
    self._move_selection(1);
    expect(self.sel_row, "move no-op").toBe(g.empty_move_sel_row);
    self._buy_selected();
    expect(tank.cash, "buy no-op cash").toBe(g.empty_buy_cash);
  });

  it("unaffordable selection: buy gate fails -> NO cash/inventory change", () => {
    const econ = makeEcon(4, { [weapons.SLOT_BABY_MISSILE]: 5 });
    const tank = new TankMock({ cash: g.unafford_cash_before }); // cash 3 < price 5
    const self = shopSeam({ econ, tank, category: 0 });
    self.items = [weapons.SLOT_BABY_MISSILE]; // force the selection onto it
    self.sel_row = 0;
    self._buy_selected();
    expect(tank.cash, "cash unchanged").toBe(g.unafford_cash_after);
    expect(tank.inventory[weapons.SLOT_BABY_MISSILE], "owned unchanged").toBe(g.unafford_owned_after);
  });

  it("update(dt) below one tick is a no-op (counter unchanged)", () => {
    const self = shopSeam({ econ: makeEcon(4), tank: new TankMock({ cash: 1000 }) });
    self.shop_lut = screens._build_shop_lut();
    self._cycle_counter = 0;
    self._cycle_accum = 0.0;
    const ret = self.update(g.update_tiny_dt);
    expect(ret, "update ret").toBeNull();
    expect(self._cycle_counter, "counter unchanged").toBe(g.update_tiny_counter);
  });
});

// ===========================================================================
// 4. SellScreen.handle -- accept commit routing
// ===========================================================================
describe("screens_flow: SellScreen.handle accept/reject == Python", () => {
  function sellSeam(econ: Economy, tank: TankMock, slot: number, qty: number): screens.SellScreen {
    const self = Object.create(screens.SellScreen.prototype) as screens.SellScreen;
    self.econ = econ;
    self.tank = tank as unknown as EconomyTank;
    self.slot = slot;
    self.qty = qty;
    self.committed = 0;
    return self;
  }

  for (let i = 0; i < vec.sell_accept.length; i++) {
    const c = vec.sell_accept[i];
    const label = c.case === "reject" ? "reject (passthrough, no commit)" : `accept slot=${c.slot} qty=${c.qty}`;
    it(`#${i} ${label}`, () => {
      if (c.case === "reject") {
        const econ = makeEcon(4, { 0: 400 }, false);
        const tank = new TankMock({ cash: 100, inv: (() => { const a = new Array<number>(weapons.NUM_ITEMS).fill(0); a[0] = 5; return a; })() });
        const self = sellSeam(econ, tank, 0, 3);
        self.panel = fakePanel("pop") as unknown as typeof self.panel;
        const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
        expect(ret, "reject ret").toBe(c.ret);
        expect(self.committed, "no commit").toBe(c.committed);
        expect(tank.cash, "cash unchanged").toBe(c.cash_after);
        expect(tank.inventory[0], "owned unchanged").toBe(c.owned_after);
        return;
      }
      const slot = c.slot as number;
      const inv = new Array<number>(weapons.NUM_ITEMS).fill(0);
      inv[slot] = c.owned as number;
      const econ = makeEcon(4, { [slot]: c.price as number }, c.free_market as boolean);
      const tank = new TankMock({ cash: 100, inv });
      const self = sellSeam(econ, tank, slot, c.qty as number);
      self.panel = fakePanel("accept") as unknown as typeof self.panel;
      const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
      expect(ret, "accept ret").toBe(c.ret);
      expect(self.committed, "committed").toBe(c.committed);
      expect(tank.cash, "cash_after").toBe(c.cash_after);
      expect(tank.inventory[slot], "owned_after").toBe(c.owned_after);
    });
  }
});

// ===========================================================================
// 5. OptionsScreen('weapons') weapon-list scroll (REAL Panel + REAL Toggles)
// ===========================================================================
describe("screens_flow: OptionsScreen weapon-list scroll == Python", () => {
  function weaponsSeam(): screens.OptionsScreen {
    const self = Object.create(screens.OptionsScreen.prototype) as screens.OptionsScreen;
    self.spec = "weapons";
    self.scroll = 0;
    self.panel = new W.Panel(0, 0, 400, 400, "");
    self._wl_toggles = [];
    self._build_weapon_list(10, 20); // sets weapon_items + _wl_h + builds toggles
    return self;
  }

  it("each wheel event moves scroll one row (clamped) and remaps the 8-row window", () => {
    const ow = vec.options_weapons;
    const self = weaponsSeam();
    expect(self._wl_h, "wl_h").toBe(ow.wl_h);
    expect(self.weapon_items.length, "n_items").toBe(ow.n_items);
    for (let i = 0; i < ow.script.length; i++) {
      const d = ow.script[i].d;
      self.handle({ type: pygame.MOUSEBUTTONDOWN, button: d < 0 ? 4 : 5, pos: [0, 0] });
      const w = ow.trace[i];
      expect(self.scroll, `wheel #${i} scroll`).toBe(w.scroll);
      // the visible toggle labels MUST equal the weapon names in the scroll window
      const labels = self._wl_toggles.map((t) => (t as W.Toggle).label);
      expect(labels, `wheel #${i} toggle labels == window weapon names`).toEqual(w.labels);
      // and the labels are exactly ITEMS[slot].name for the visible slots
      const want = w.visible_slots.map((s) => ow.slot_names[s]);
      expect(labels, `wheel #${i} labels == ITEMS[slot].name`).toEqual(want);
    }
  });

  it("each weapon toggle is bound to its item's enabled flag (get reads, set writes)", () => {
    const self = weaponsSeam(); // scroll 0 -> visible slots 0..wl_h-1
    const slots = self.weapon_items.slice(0, self._wl_h);
    const saved = slots.map((s) => weapons.ITEMS[s].enabled);
    try {
      // get() reflects the live enabled flag for the bound slot
      for (let r = 0; r < slots.length; r++) {
        expect((self._wl_toggles[r] as W.Toggle).get(), `toggle ${r} get`).toBe(weapons.ITEMS[slots[r]].enabled);
      }
      // set() writes through to THAT slot's flag only
      (self._wl_toggles[0] as W.Toggle).set(false);
      expect(weapons.ITEMS[slots[0]].enabled, "set wrote slot 0").toBe(false);
      expect(weapons.ITEMS[slots[1]].enabled, "set did not touch slot 1").toBe(saved[1]);
      expect((self._wl_toggles[0] as W.Toggle).get(), "get sees the write").toBe(false);
    } finally {
      for (let r = 0; r < slots.length; r++) {
        weapons.ITEMS[slots[r]].enabled = saved[r]; // restore the shared global
      }
    }
  });
});

// ===========================================================================
// 6. CalibrateScreen + RegistrationScreen handle/update
// ===========================================================================
describe("screens_flow: Calibrate/Registration handle+update == Python", () => {
  const c = vec.calibrate_registration;

  it("CalibrateScreen.handle: any KEYDOWN -> 'pop'", () => {
    const self = Object.create(screens.CalibrateScreen.prototype) as screens.CalibrateScreen;
    expect(self.handle({ type: pygame.KEYDOWN, key: pygame.K_a, unicode: "a" }), "key->pop").toBe(c.key_ret);
  });

  it("CalibrateScreen.handle: a non-key event forwards the panel result", () => {
    const self = Object.create(screens.CalibrateScreen.prototype) as screens.CalibrateScreen;
    self.panel = fakePanel("pop") as unknown as typeof self.panel;
    expect(self.handle({ type: pygame.MOUSEBUTTONDOWN, button: 1, pos: [9999, 9999] }), "nonkey forward").toBe(c.nonkey_ret);
  });

  it("CalibrateScreen.update -> null", () => {
    const self = Object.create(screens.CalibrateScreen.prototype) as screens.CalibrateScreen;
    expect(self.update(0.016)).toBe(c.update_ret);
  });

  it("RegistrationScreen.update -> null", () => {
    const self = Object.create(screens.RegistrationScreen.prototype) as screens.RegistrationScreen;
    expect(self.update(0.016)).toBe(c.reg_update_ret);
  });
});

// ===========================================================================
// 7. _list_saves over .sav names (splitext dotfile branch) == Python os.splitext
// ===========================================================================
describe("screens_flow: _list_saves splitext/dotfile cases == Python os.path.splitext", () => {
  for (let i = 0; i < vec.saves_extra.length; i++) {
    const c = vec.saves_extra[i];
    it(`#${i} ${JSON.stringify(c.listing)} -> ${JSON.stringify(c.out)}`, () => {
      expect(screens._list_saves(c.listing)).toEqual(c.out);
    });
  }

  it("_list_saves() with no arg reads the save-store provider (basename + sort)", () => {
    // Browser path (no Python analog): provider.list() -> + .sav -> splitext+sort.
    screens.setSaveStoreProvider({
      list: () => ["zebra", "alpha", "mid"],
      exists: () => false,
      write: () => undefined,
      read: () => null,
    });
    expect(screens._list_saves()).toEqual(["alpha", "mid", "zebra"]);
  });

  it("_list_saves() with no provider returns [] (no saves yet)", () => {
    screens.setSaveStoreProvider(null);
    expect(screens._list_saves()).toEqual([]);
  });
});

// ===========================================================================
// 8. SaveScreen / RestoreScreen commit + overwrite + missing-file behaviour
// ===========================================================================
class FakeStore implements screens.SaveStoreProvider {
  files = new Map<string, Uint8Array>();
  writes: { basename: string; bytes: Uint8Array }[] = [];
  throwOnWrite = false;
  list(): string[] {
    return [...this.files.keys()];
  }
  exists(b: string): boolean {
    return this.files.has(b);
  }
  write(b: string, bytes: Uint8Array): void {
    this.writes.push({ basename: b, bytes });
    if (this.throwOnWrite) {
      throw new Error("disk full");
    }
    this.files.set(b, bytes);
  }
  read(b: string): Uint8Array | null {
    return this.files.get(b) ?? null;
  }
}

/** A minimal but REAL save-able GameState: real Config + Economy satisfy the
 *  serializer; an empty tank roster keeps apply()'s length guard happy. */
function mkSaveState(): savegame.SaveGameState {
  const cfg = new Config();
  const econ = new Economy(cfg as unknown as EconomyConfig);
  econ.refresh_availability();
  return {
    round_index: 0,
    phase: "place",
    timer: 0,
    message: "",
    fire_index: 0,
    firing_order: [],
    current_shooter: null,
    last_landing: null,
    winner: null,
    ranking: [],
    w: 64,
    h: 64,
    cfg,
    tanks: [],
    economy: econ,
    terrain: { grid: { w: 64, h: 64, data: new Uint8Array(64 * 64) } },
    projectiles: [],
    explosions: [],
    beams: [],
    awaiting_human: false,
  } as unknown as savegame.SaveGameState;
}

describe("screens_flow: Save/Restore class strings == Python (verbatim)", () => {
  const s = vec.save_strings;
  it("primary labels/actions + verbatim filesystem templates match the oracle", () => {
    expect(screens.SaveScreen.PRIMARY_LABEL, "save label").toBe(s.save_primary_label);
    expect(screens.SaveScreen.PRIMARY_ACTION, "save action").toBe(s.save_primary_action);
    expect(screens.SaveScreen.ERR_CREATE, "err_create").toBe(s.save_err_create);
    expect(screens.SaveScreen.CONFIRM_TMPL, "confirm_tmpl").toBe(s.save_confirm_tmpl);
    expect(screens.RestoreScreen.PRIMARY_LABEL, "restore label").toBe(s.restore_primary_label);
    expect(screens.RestoreScreen.PRIMARY_ACTION, "restore action").toBe(s.restore_primary_action);
    expect(screens.RestoreScreen.ERR_MISSING, "err_missing").toBe(s.restore_err_missing);
    expect(screens.SAVE_EXT, "save_ext").toBe(s.save_ext);
  });
});

describe("screens_flow: SaveScreen commit/_do_save behaviour", () => {
  function saveSeam(state: savegame.SaveGameState | null, name: string): screens.SaveScreen {
    const self = Object.create(screens.SaveScreen.prototype) as screens.SaveScreen;
    self.state = state;
    self.status = "";
    self.name = name;
    self._confirm = null;
    self._pending_path = null;
    return self;
  }

  it("_do_save success: writes basename + SCORPY-magic bytes via the store, returns 'pop'", () => {
    const store = new FakeStore();
    screens.setSaveStoreProvider(store);
    const self = saveSeam(mkSaveState(), "game1");
    const ret = self._do_save("game1.sav");
    expect(ret, "success ret").toBe("pop");
    expect(store.writes.length, "one write").toBe(1);
    expect(store.writes[0].basename, "basename (no ext)").toBe("game1");
    // the bytes are a real savegame blob: 6-byte "SCORPY" magic header
    const head = String.fromCharCode(...store.writes[0].bytes.slice(0, 6));
    expect(head, "SCORPY magic").toBe(savegame.MAGIC);
  });

  it("_do_save with no save store reports the create error, returns null (no false success)", () => {
    screens.setSaveStoreProvider(null);
    const self = saveSeam(mkSaveState(), "game1");
    const ret = self._do_save("game1.sav");
    expect(ret, "no-store ret").toBeNull();
    expect(self.status).toContain('Error trying to create file "game1.sav"!');
    expect(self.status).toContain("no save store");
  });

  it("_do_save I/O failure sets the create-error status and returns null (DTM 6.8: no false 'pop')", () => {
    const store = new FakeStore();
    store.throwOnWrite = true;
    screens.setSaveStoreProvider(store);
    const self = saveSeam(mkSaveState(), "game1");
    const ret = self._do_save("oops.sav");
    expect(ret, "failure must NOT report success").toBeNull();
    expect(self.status).toBe('Error trying to create file "oops.sav"!  (disk full)');
    expect(store.files.has("oops"), "nothing persisted on failure").toBe(false);
  });

  it("_commit with no game in progress -> status, no write", () => {
    const store = new FakeStore();
    screens.setSaveStoreProvider(store);
    const self = saveSeam(null, "game1");
    expect((self as unknown as { _commit(): string | null })._commit()).toBeNull();
    expect(self.status).toBe("No game in progress.");
    expect(store.writes.length).toBe(0);
  });

  it("_commit with an empty filename -> 'Enter a file name.'", () => {
    screens.setSaveStoreProvider(new FakeStore());
    const self = saveSeam(mkSaveState(), "   ");
    expect((self as unknown as { _commit(): string | null })._commit()).toBeNull();
    expect(self.status).toBe("Enter a file name.");
  });

  it("_commit on a NON-existing name writes immediately and returns 'pop'", () => {
    const store = new FakeStore(); // empty -> name does not exist
    screens.setSaveStoreProvider(store);
    const self = saveSeam(mkSaveState(), "fresh");
    const ret = (self as unknown as { _commit(): string | null })._commit();
    expect(ret, "commit non-existing -> pop").toBe("pop");
    expect(store.files.has("fresh"), "wrote fresh.sav").toBe(true);
  });

  it("handle() confirm-overwrite YES performs the save then pops", () => {
    const store = new FakeStore();
    store.files.set("dup", new Uint8Array([0])); // pre-existing
    screens.setSaveStoreProvider(store);
    const self = saveSeam(mkSaveState(), "dup");
    self._pending_path = "dup.sav";
    self._confirm = fakePanel("confirm_overwrite") as unknown as typeof self._confirm;
    const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
    expect(ret, "YES -> pop").toBe("pop");
    expect(self._confirm, "confirm cleared").toBeNull();
    expect(self._pending_path, "pending cleared").toBeNull();
    expect(store.writes.some((w) => w.basename === "dup"), "overwrote dup").toBe(true);
  });

  it("handle() confirm-overwrite NO clears the confirm without saving (no pop)", () => {
    const store = new FakeStore();
    store.files.set("dup", new Uint8Array([0]));
    screens.setSaveStoreProvider(store);
    const self = saveSeam(mkSaveState(), "dup");
    self._pending_path = "dup.sav";
    self._confirm = fakePanel("cancel_overwrite") as unknown as typeof self._confirm;
    const ret = self.handle({ type: pygame.KEYDOWN, key: 0 });
    expect(ret, "NO -> stays open").toBeNull();
    expect(self._confirm, "confirm cleared").toBeNull();
    expect(self._pending_path).toBeNull();
    expect(store.writes.length, "no write on NO").toBe(0);
  });

  it("handle() while the confirm is open swallows non-decision events (stays modal)", () => {
    const self = saveSeam(mkSaveState(), "dup");
    self._pending_path = "dup.sav";
    self._confirm = fakePanel(null) as unknown as typeof self._confirm;
    const ret = self.handle({ type: pygame.MOUSEBUTTONDOWN, button: 1, pos: [0, 0] });
    expect(ret, "no decision -> null").toBeNull();
    expect(self._confirm, "confirm still open").not.toBeNull();
  });
});

describe("screens_flow: RestoreScreen commit behaviour", () => {
  function restoreSeam(state: savegame.SaveGameState | null, name: string): screens.RestoreScreen {
    const self = Object.create(screens.RestoreScreen.prototype) as screens.RestoreScreen;
    self.state = state;
    self.status = "";
    self.name = name;
    self.restored = null;
    return self;
  }

  it("_commit with an empty filename -> 'Pick a saved game.'", () => {
    screens.setSaveStoreProvider(new FakeStore());
    const self = restoreSeam(mkSaveState(), "  ");
    expect((self as unknown as { _commit(): string | null })._commit()).toBeNull();
    expect(self.status).toBe("Pick a saved game.");
  });

  it("_commit with no save store -> cannot-read status", () => {
    screens.setSaveStoreProvider(null);
    const self = restoreSeam(mkSaveState(), "game1");
    expect((self as unknown as { _commit(): string | null })._commit()).toBeNull();
    expect(self.status).toBe("Cannot read: no save store");
  });

  it("_commit on a missing file -> verbatim missing-file message", () => {
    screens.setSaveStoreProvider(new FakeStore()); // read() -> null
    const self = restoreSeam(mkSaveState(), "missing");
    expect((self as unknown as { _commit(): string | null })._commit()).toBeNull();
    expect(self.status).toBe('File "missing.sav" doesn\'t exist!');
    expect(self.restored, "nothing restored").toBeNull();
  });

  it("_commit on a corrupt blob (bad magic) surfaces the SaveError, dialog stays open", () => {
    const store = new FakeStore();
    store.files.set("bad", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); // wrong magic
    screens.setSaveStoreProvider(store);
    const self = restoreSeam(mkSaveState(), "bad");
    expect((self as unknown as { _commit(): string | null })._commit()).toBeNull();
    expect(self.status, "SaveError message").toBe('"bad" is not a saved game.');
    expect(self.restored).toBeNull();
  });

  it("_commit on a valid blob loads + applies it, sets .restored, returns 'pop'", () => {
    const store = new FakeStore();
    store.files.set("ok", savegame.save(mkSaveState())); // a real blob
    screens.setSaveStoreProvider(store);
    const target = mkSaveState(); // matching (empty) roster
    const self = restoreSeam(target, "ok");
    const ret = (self as unknown as { _commit(): string | null })._commit();
    expect(ret, "restore ok -> pop").toBe("pop");
    expect(self.restored, "restored is the applied state").toBe(target);
    expect(self.status, "no error status").toBe("");
  });
});

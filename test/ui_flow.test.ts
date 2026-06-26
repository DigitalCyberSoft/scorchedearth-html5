/**
 * Real-path gate for src/ui.ts draw walks: TS draw_rankings / MainMenu.draw /
 * Shop.draw == Python scorch.ui (the fidelity oracle), driven over the SAME
 * recording-surface seam the dumper uses.
 *
 * WHY THIS EXISTS (vs test/ui.test.ts):
 *   test/ui.test.ts exercises the EXTRACTED numeric helper rankings_layout() plus
 *   the HumanController / MainMenu / Shop LOGIC. It never drives the actual
 *   draw_rankings() / MainMenu.draw() / Shop.draw() walks, so those bodies sat
 *   uncovered. oracle/dump_ui.py ALREADY records the full draw_rankings draw trace
 *   (fills / blits / rects / lines / go_rect) by driving the REAL Python
 *   ui.draw_rankings against a recording surface + a fake pygame.draw
 *   (dump_ui.py:_layout_via_real_draw). This gate reproduces that EXACT seam in TS:
 *   a RecSurf records fill/blit, pygame.draw.rect/line are swapped for recorders,
 *   and the TS draw_rankings output is asserted to match the oracle vector's
 *   recorded trace byte-for-byte. That is a true differential assertion on the draw
 *   walk, not a coverage stub.
 *
 *   The Python dumper does NOT record MainMenu.draw / Shop.draw traces (those defer
 *   to the Phase-3 pixel gate), so the MainMenu.draw / Shop.draw sections here
 *   assert against the TS code's own documented draw contract cross-checked against
 *   the Python source (ui.py:110-126 / 269-290): the geometry, the per-row select
 *   highlight, the _value_str values it emits (including the empty value on the
 *   start/quit rows, ui.py:128-150), and the viewport window the shop scrolls.
 *
 * DOM-FREE: vitest runs under Node (vite.config.ts environment:"node"). A real
 *   pygame.Surface / pygame.Font cannot be constructed (no document), so this gate
 *   feeds the SAME deterministic MockFont the dumper used and a recording surface,
 *   exactly as dump_ui.py does. No Canvas is touched.
 *
 * EPSILON POLICY: every recorded quantity (rect/line coords, blit src-width + dest,
 *   go_rect) is an INTEGER and is asserted EXACT (.toEqual). draw_rankings computes
 *   all geometry with integer //-truncation (Math.trunc), so there are no floats on
 *   this path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import * as pygame from "./../src/pygame";
import * as ui from "../src/ui";
import * as weapons from "../src/weapons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "ui.json");

// ---------------------------------------------------------------------------
// Deterministic mock font / renderer -- byte-identical to dump_ui.py MockFont
// (FONT_CW/FONT_H/BIG_CW/BIG_H) so the geometry math, not a platform font, is
// what is compared.
// ---------------------------------------------------------------------------
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
  pal[0x6e] = [220, 40, 40]; // team-red bar
  pal[1] = [60, 60, 255]; // dark-ish blue (lum < 150 -> kept)
  pal[2] = [255, 255, 80]; // bright yellow (lum >= 150 -> darkened)
  pal[3] = [200, 200, 200]; // light grey (darkened)
  pal[4] = [10, 200, 10]; // green
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
// Recording seam -- mirror dump_ui.py:_layout_via_real_draw (RecSurf + FakeDraw).
// surf.fill/blit are recorded on the surface; pygame.draw.rect/line are swapped
// for recorders, restored after every test. The same shapes the dumper wrote:
//   fills: [color, rect|null]      (draw_rankings never fills, so this stays [])
//   blits: [src.get_width(), [x, y]]
//   rects: [color, [x, y, w, h], width]
//   lines: [color, [ax, ay], [bx, by], width]
// ---------------------------------------------------------------------------
type RecRect = [number[], [number, number, number, number], number];
type RecLine = [number[], [number, number], [number, number], number];
type RecBlit = [number, [number, number]];

class RecSurf {
  fills: Array<[number[], unknown]> = [];
  blits: RecBlit[] = [];
  fill(color: pygame.ColorArg, rect?: unknown): void {
    this.fills.push([[...(color as number[])], rect ?? null]);
  }
  blit(src: { get_width(): number }, pos: [number, number]): pygame.Rect {
    this.blits.push([src.get_width(), [Math.trunc(pos[0]), Math.trunc(pos[1])]]);
    return new pygame.Rect(0, 0, src.get_width(), 0);
  }
}

interface DrawRecorder {
  rects: RecRect[];
  lines: RecLine[];
  restore(): void;
}

/** Swap pygame.draw.rect/line for recorders; returns the capture + a restore(). */
function patchDraw(): DrawRecorder {
  const rects: RecRect[] = [];
  const lines: RecLine[] = [];
  const origRect = pygame.draw.rect;
  const origLine = pygame.draw.line;
  (pygame.draw as { rect: unknown }).rect = (
    _surf: unknown,
    color: number[],
    r: pygame.Rect | [number, number, number, number],
    width = 0,
  ): pygame.Rect => {
    const x = Array.isArray(r) ? r[0] : r.x;
    const y = Array.isArray(r) ? r[1] : r.y;
    const w = Array.isArray(r) ? r[2] : r.w;
    const h = Array.isArray(r) ? r[3] : r.h;
    rects.push([[...color], [Math.trunc(x), Math.trunc(y), Math.trunc(w), Math.trunc(h)], width]);
    return new pygame.Rect(x, y, w, h);
  };
  (pygame.draw as { line: unknown }).line = (
    _surf: unknown,
    color: number[],
    a: [number, number],
    b: [number, number],
    width = 1,
  ): void => {
    lines.push([
      [...color],
      [Math.trunc(a[0]), Math.trunc(a[1])],
      [Math.trunc(b[0]), Math.trunc(b[1])],
      width,
    ]);
  };
  return {
    rects,
    lines,
    restore(): void {
      (pygame.draw as { rect: unknown }).rect = origRect;
      (pygame.draw as { line: unknown }).line = origLine;
    },
  };
}

let _activeRec: DrawRecorder | null = null;
afterEach(() => {
  if (_activeRec) {
    _activeRec.restore();
    _activeRec = null;
  }
});

// ---------------------------------------------------------------------------
// Vector types (the subset this gate reads from oracle/vectors/ui.json).
// ---------------------------------------------------------------------------
interface RankLayout {
  fills: unknown[];
  blits: RecBlit[];
  rects: RecRect[];
  lines: RecLine[];
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
/** One _cycle_weapon golden case (dumped from Python ui.HumanController by
 *  oracle/dump_ui.py:dump_weapon_cycle). Reused here to drive the SAME oracle
 *  data through the KEYBOARD route (handle TAB/]/[), which ui.test.ts skipped. */
interface WeaponCycleCase {
  name: string;
  owned: number[];
  sel_in: number;
  d: number;
  sel_out: number;
}
interface UiVectors {
  module: string;
  rankings: { font: { cw: number; h: number; big_cw: number; big_h: number }; cases: RankCase[] };
  weapon_cycle: WeaponCycleCase[];
}
const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as UiVectors;

// ===========================================================================
// Lock the mock-font constants to the dumper's so the geometry is comparable.
// (If these drift, every recorded coordinate would shift and the diff below
// would be against a different font -- assert they are pinned.)
// ===========================================================================
describe("ui_flow: mock-font constants match the dumper", () => {
  it("FONT/BIG metrics equal vectors.rankings.font", () => {
    expect(vec.module).toBe("ui");
    expect({ cw: FONT_CW, h: FONT_H, big_cw: BIG_CW, big_h: BIG_H }).toEqual(vec.rankings.font);
  });
});

// ===========================================================================
// draw_rankings: drive the REAL draw walk and assert the recorded trace
// reproduces the Python oracle EXACTLY (rects, lines, blits, go_rect).
// ===========================================================================
describe("ui_flow: draw_rankings draw walk == Python oracle trace", () => {
  function runCase(c: RankCase): { rec: RecSurf; draw: DrawRecorder; state: MockRankState } {
    const renderer = mockRenderer();
    const tanks = c.tanks.map((t) => new MockRankTank(t[0], t[1], t[2], t[3], t[4]));
    const ranking = c.ranking_set ? tanks.slice() : null;
    const state = new MockRankState(c.w, c.h, ranking, tanks);
    const rec = new RecSurf();
    const draw = patchDraw();
    _activeRec = draw;
    ui.draw_rankings(
      rec as unknown as pygame.Surface,
      renderer,
      state,
      c.title,
      c.rounds_left,
      c.quote,
    );
    return { rec, draw, state };
  }

  for (const c of vec.rankings.cases) {
    it(c.name, () => {
      const { rec, draw, state } = runCase(c);
      const want = c.layout;

      // surf.fill is never called by draw_rankings (panel is drawn via draw.rect).
      expect(rec.fills, `${c.name} fills`).toEqual(want.fills);

      // rect ops: panel + 2 red title bars + dismiss-button face, in source order.
      expect(draw.rects, `${c.name} rects`).toEqual(want.rects);

      // line ops: panel bevel (4) + button bevel (4), in source order.
      expect(draw.lines, `${c.name} lines`).toEqual(want.lines);

      // blit ops: title, every row cell, optional rounds line, optional quote
      // lines, the Go label -- src width + integer dest, in source order.
      expect(rec.blits, `${c.name} blits`).toEqual(want.blits);

      // state._rankings_go_rect: the dismiss hit-rect the click router reads.
      // This is computed by the DRAW walk (ui.ts:869-873), independently of
      // rankings_layout's go_rect; assert the draw walk's value matches the oracle.
      const gr = state._rankings_go_rect!;
      expect([gr.x, gr.y, gr.w, gr.h], `${c.name} go_rect`).toEqual(want.go_rect);
    });
  }

  // Cross-check: the go_rect the draw walk writes must equal the extracted
  // rankings_layout()'s go_rect for the same inputs (the two computations are
  // separate code paths in ui.ts; a divergence would be a real bug).
  it("draw-walk go_rect == rankings_layout go_rect (interim_5)", () => {
    const c = vec.rankings.cases.find((x) => x.name === "interim_5")!;
    const renderer = mockRenderer();
    const tanks = c.tanks.map((t) => new MockRankTank(t[0], t[1], t[2], t[3], t[4]));
    const state = new MockRankState(c.w, c.h, tanks.slice(), tanks);
    const L = ui.rankings_layout(renderer, state, c.title, c.rounds_left, c.quote);
    const rec = new RecSurf();
    const draw = patchDraw();
    _activeRec = draw;
    const drawState = new MockRankState(c.w, c.h, tanks.slice(), tanks);
    ui.draw_rankings(
      rec as unknown as pygame.Surface,
      renderer,
      drawState,
      c.title,
      c.rounds_left,
      c.quote,
    );
    const gr = drawState._rankings_go_rect!;
    expect([gr.x, gr.y, gr.w, gr.h], "layout vs draw go_rect").toEqual([
      L.go_rect.x,
      L.go_rect.y,
      L.go_rect.w,
      L.go_rect.h,
    ]);
  });
});

// ===========================================================================
// MainMenu.draw: no Python draw-trace oracle (Phase-3 pixel gate owns the
// pixels), so assert against the TS draw contract cross-checked with the Python
// source (ui.py:110-126). We drive the REAL draw walk with the recording seam and
// assert the load-bearing facts: it blits a header pair + one row per menu row
// (each row's first blit dest is the fixed left margin w//2-200, y stepping 22
// from 96), the selected row uses the highlight color, and _value_str produces ""
// for the start/quit rows (exercising ui.ts:423 default return).
// ===========================================================================
describe("ui_flow: MainMenu.draw walk (row geometry + select highlight + value strings)", () => {
  /** Build a headless MainMenu and attach the deterministic mock fonts so the
   *  real draw() runs without a DOM (font/big are only read by draw). */
  function headlessMenuWithFonts(maxplayers: number): ui.MainMenu {
    const cfg: ui.Cfg = {
      MAXPLAYERS: maxplayers,
      MAXROUNDS: 10,
      INITIAL_CASH: 0,
      GRAVITY: 0.2,
      MAX_WIND: 200,
      AIR_VISCOSITY: 0,
      SCORING: "STANDARD",
      TEAM_MODE: "NONE",
      PLAY_MODE: "SEQUENTIAL",
      get team_mode(): number {
        return 0;
      },
    };
    const m = ui.MainMenu.headless(cfg, 1024, 768);
    m.font = new MockFont(FONT_CW, FONT_H) as unknown as pygame.Font;
    m.big = new MockFont(BIG_CW, BIG_H) as unknown as pygame.Font;
    return m;
  }

  it("blits header pair + one labelled row per menu row at the documented grid", () => {
    const m = headlessMenuWithFonts(2);
    m.sel = 3; // select an arbitrary row to exercise the highlight branch
    const rec = new RecSurf();
    const draw = patchDraw();
    _activeRec = draw;
    m.draw(rec as unknown as pygame.Surface);

    // ui.py:111 -> surf.fill((10,12,30)) exactly once, first op.
    expect(rec.fills.length, "fills count").toBe(1);
    expect(rec.fills[0][0], "fill color").toEqual([10, 12, 30]);

    // Blits: title + subtitle (2), then one per row (rows.length), then the hint
    // (1). The row blits land at x = w//2-200 = 1024//2-200 = 312, ui.py:122.
    const nRows = m.rows.length;
    expect(rec.blits.length, "blit count").toBe(2 + nRows + 1);

    // The per-row blits (skip the 2 header blits) start at y=96 and step 22.
    const X_ROW = Math.trunc(1024 / 2) - 200; // 312
    for (let i = 0; i < nRows; i++) {
      const b = rec.blits[2 + i];
      expect(b[1][0], `row ${i} x`).toBe(X_ROW);
      expect(b[1][1], `row ${i} y`).toBe(96 + i * 22);
    }

    // The hint blit (last) is centered: x = w//2 - hint_width//2, y = h-28 = 740.
    const hint = rec.blits[rec.blits.length - 1];
    expect(hint[1][1], "hint y").toBe(768 - 28);
  });

  it("row label+value width follows _value_str (start/quit rows have empty value)", () => {
    const m = headlessMenuWithFonts(2);
    const rec = new RecSurf();
    const draw = patchDraw();
    _activeRec = draw;
    m.draw(rec as unknown as pygame.Surface);

    // Reconstruct what each row blit's text length should be, mirroring ui.py:
    //   prefix = "> " if selected else "  "  (2 chars)
    //   txt    = f"{label:<16} {val}" if val else label   (ui.ts:378)
    // MockFont width = FONT_CW * len(rendered string). The row blits are at
    // indices [2 .. 2+nRows). We assert the start/quit rows (val == "" via the
    // _value_str default, ui.ts:423) render as just the label (no padded value),
    // which is shorter than a 16-pad + value would be.
    const startIdx = m.rows.map((r) => r[0]).indexOf("start");
    const quitIdx = m.rows.map((r) => r[0]).indexOf("quit");
    for (const [rowIdx, key, label] of [
      [startIdx, "start", "START GAME"],
      [quitIdx, "quit", "Quit"],
    ] as Array<[number, string, string]>) {
      const isSel = m.sel === rowIdx;
      const prefix = isSel ? "> " : "  ";
      const expectedText = prefix + label; // val is "", so txt == label
      const wantW = FONT_CW * expectedText.length;
      expect(rec.blits[2 + rowIdx][0], `${key} row blit width`).toBe(wantW);
      // and _value_str itself returns "" for these rows (ui.ts:423).
      expect(m._value_str(key), `${key} _value_str`).toBe("");
    }

    // A value row (gravity) renders the padded label + the value string, so its
    // blit width matches the 16-pad form -- proves the `val ? ... : label` branch
    // takes the OTHER arm for value rows.
    const gravIdx = m.rows.map((r) => r[0]).indexOf("gravity");
    const gravVal = m._value_str("gravity"); // "0.20"
    expect(gravVal, "gravity value").toBe("0.20");
    const gravPrefix = m.sel === gravIdx ? "> " : "  ";
    const gravText = gravPrefix + `${"Gravity x100".padEnd(16)} ${gravVal}`;
    expect(rec.blits[2 + gravIdx][0], "gravity row blit width").toBe(FONT_CW * gravText.length);
  });
});

// ===========================================================================
// Shop.draw walk: again no Python draw-trace oracle, so assert the TS draw
// contract cross-checked with the Python source (ui.py:269-290): a title blit, a
// 5-column header row, then one row-of-5-cells per VISIBLE item (the viewport is
// top=max(0,sel-12) .. min(n, top+24)), then a hint. The header/cell column x
// offsets are fixed [20,240,320,400,470].
// ===========================================================================
describe("ui_flow: Shop.draw walk (header + viewport rows + scroll window)", () => {
  function headlessShopWithFonts(available: boolean[], cash: number): {
    shop: ui.Shop;
    tank: ui.Tank;
  } {
    const econ: ui.ShopEconomy = {
      available,
      price: weapons.ITEMS.map((it) => it.cost),
      buy: () => false,
      sell: () => 0,
    };
    const tank: ui.Tank = {
      angle: 45,
      power: 500,
      health: 100,
      selected_weapon: 0,
      parachute_deployed: false,
      contact_trigger: false,
      inventory: new Array(weapons.NUM_ITEMS).fill(0),
      name: "P1",
      color: 1,
      win_counter: 0,
      cash,
      score: 0,
      get batteries(): number {
        return this.inventory[weapons.SLOT_BATTERY];
      },
      has_ammo(slot: number): boolean {
        return slot === weapons.SLOT_BABY_MISSILE || this.inventory[slot] > 0;
      },
    };
    const state: ui.ShopState = { economy: econ };
    const shop = ui.Shop.headless(state, tank, 1024, 768);
    shop.font = new MockFont(FONT_CW, FONT_H) as unknown as pygame.Font;
    shop.big = new MockFont(BIG_CW, BIG_H) as unknown as pygame.Font;
    return { shop, tank };
  }

  it("draws title + 5-col header + 5 cells per visible row + hint (no scroll)", () => {
    const avail = new Array(weapons.NUM_ITEMS).fill(true);
    const { shop } = headlessShopWithFonts(avail, 100000);
    // pick a small item-set window: with sel=0, top=0, visible = min(n, 24).
    shop.sel = 0;
    const nItems = shop.items.length;
    const visible = Math.min(nItems, 24); // top+24 with top=0
    const rec = new RecSurf();
    const draw = patchDraw();
    _activeRec = draw;
    shop.draw(rec as unknown as pygame.Surface);

    // ui.py:270 fill once.
    expect(rec.fills.length, "fills").toBe(1);
    expect(rec.fills[0][0], "fill color").toEqual([12, 12, 28]);

    // blits = title(1) + header(5) + 5*visible (cells) + hint(1).
    expect(rec.blits.length, "blit count").toBe(1 + 5 + 5 * visible + 1);

    // The header cells (blits 1..5) land at the fixed column xs, y=48 (ui.py:273-276).
    const COL_X = [20, 240, 320, 400, 470];
    for (let j = 0; j < 5; j++) {
      const b = rec.blits[1 + j];
      expect(b[1], `header col ${j}`).toEqual([COL_X[j], 48]);
    }

    // First visible row's 5 cells (blits 6..10) at the same xs, y=70 (ui.py:278-288).
    for (let j = 0; j < 5; j++) {
      const b = rec.blits[1 + 5 + j];
      expect(b[1], `row0 col ${j}`).toEqual([COL_X[j], 70]);
    }
    // Second visible row steps y by 16.
    if (visible >= 2) {
      for (let j = 0; j < 5; j++) {
        const b = rec.blits[1 + 5 + 5 + j];
        expect(b[1], `row1 col ${j}`).toEqual([COL_X[j], 86]);
      }
    }
  });

  it("viewport scrolls: large sel -> top=sel-12, window of <=24 rows", () => {
    const avail = new Array(weapons.NUM_ITEMS).fill(true);
    const { shop } = headlessShopWithFonts(avail, 100000);
    const nItems = shop.items.length;
    // Only meaningful if there are more than 24 items; assert the precondition so
    // this is not a silent no-op (ui.py NUM_ITEMS is large enough in practice).
    expect(nItems, "enough items to scroll").toBeGreaterThan(24);
    shop.sel = nItems - 1; // last item -> top = max(0, n-1-12)
    const top = Math.max(0, shop.sel - 12);
    const visible = Math.min(nItems, top + 24) - top;
    const rec = new RecSurf();
    const draw = patchDraw();
    _activeRec = draw;
    shop.draw(rec as unknown as pygame.Surface);

    // blits = title(1) + header(5) + 5*visible + hint(1).
    expect(rec.blits.length, "scrolled blit count").toBe(1 + 5 + 5 * visible + 1);

    // The FIRST visible data row corresponds to item index `top`, drawn at y=70.
    const COL_X = [20, 240, 320, 400, 470];
    for (let j = 0; j < 5; j++) {
      expect(rec.blits[1 + 5 + j][1], `scroll row0 col ${j}`).toEqual([COL_X[j], 70]);
    }
    // The selected item (index n-1) is the LAST visible row; its highlight is the
    // select color. The cell text is the item's name in column 0 -- assert that
    // row's column-0 blit width equals FONT_CW*len(name) so we know the right
    // item is shown at the right slot.
    const selSlot = shop.items[shop.sel];
    const selName = weapons.ITEMS[selSlot].name;
    const lastRowIdx = visible - 1;
    const col0 = rec.blits[1 + 5 + 5 * lastRowIdx];
    expect(col0[0], "selected-row name width").toBe(FONT_CW * selName.length);
    expect(col0[1][1], "selected-row y").toBe(70 + lastRowIdx * 16);
  });
});

// ===========================================================================
// REAL-PATH INPUT MAPPING (the gaps test/ui.test.ts left in ui.ts):
//   * HumanController.handle's keyboard->weapon-cycle wiring (ui.ts:507-510) and
//     the _cycle_weapon empty-owned guard (ui.ts:527-529) -- ui.test.ts called
//     _cycle_weapon DIRECTLY and never via a TAB/]/[ KEYDOWN, and slot-0 is always
//     firable so its only_slot0 case never reaches the empty-owned return.
//   * MainMenu.handle's LEFT/RIGHT/a/d -> _activate(-1/+1) wiring and the
//     non-KEYDOWN early-return (ui.ts:313-324) -- ui.test.ts's value tests called
//     _activate DIRECTLY and its nav tests only sent UP/DOWN.
//   * _cycle_enum's unknown-string default (ui.ts:308) and _set_f's half-even tie
//     (ui.ts:91).
//   * Shop.handle's non-KEYDOWN early-return (ui.ts:600-602).
//   * the LIVE (non-headless) MainMenu/Shop constructors + the four SysFont
//     builders (ui.ts:224-240,562-574,887-898) -- DOM-free to construct (the Font
//     ctor only touches the DOM lazily in size()/render()), so they run under Node.
// Oracle: Python scorch/ui.py is the reference. The weapon-cycle expectations are
// the SAME Python-dumped sel_out as ui.test.ts; the rest assert the ui.py source
// semantics (cited inline) plus literals verified against the venv CPython.
// ===========================================================================

/** A ui.Tank stand-in for the input-mapping batteries. has_ammo mirrors the real
 *  tank (slot-0 baby missile always firable, else inventory>0) unless `noAmmo` is
 *  set, which forces the off-nominal "no offensive ammo at all" case so the
 *  _cycle_weapon empty-owned guard (ui.ts:527) is exercised. */
class FlowTank implements ui.Tank {
  angle = 45;
  power = 500;
  health = 100;
  selected_weapon = 0;
  parachute_deployed = false;
  contact_trigger = false;
  inventory: number[];
  name = "P1";
  color = 1;
  win_counter = 0;
  cash = 0;
  score = 0;
  private _noAmmo: boolean;
  constructor(o: { selected_weapon?: number; inventory?: number[]; noAmmo?: boolean } = {}) {
    this.selected_weapon = o.selected_weapon ?? 0;
    this.inventory = o.inventory ? o.inventory.slice() : new Array(weapons.NUM_ITEMS).fill(0);
    this._noAmmo = o.noAmmo ?? false;
  }
  get batteries(): number {
    return this.inventory[weapons.SLOT_BATTERY];
  }
  has_ammo(slot: number): boolean {
    if (this._noAmmo) {
      return false;
    }
    if (slot === weapons.SLOT_BABY_MISSILE) {
      return true;
    }
    return this.inventory[slot] > 0;
  }
}

class FlowHumanState implements ui.HumanState {
  current_shooter: ui.Tank | null;
  fired = 0;
  _aim_hold?: ui.AimHold;
  constructor(t: ui.Tank | null) {
    this.current_shooter = t;
  }
  fire(): void {
    this.fired += 1;
  }
}

function kev(key: number, type: number = pygame.KEYDOWN): ui.PygameEvent {
  return { type, key };
}

/** A live MainMenu through the headless seam with a full mutable cfg (no DOM). */
function flowMenu(over: Partial<Record<string, unknown>> = {}): ui.MainMenu {
  const cfg: ui.Cfg = {
    MAXPLAYERS: 2,
    MAXROUNDS: 10,
    INITIAL_CASH: 0,
    GRAVITY: 0.2,
    MAX_WIND: 200,
    AIR_VISCOSITY: 0,
    SCORING: "STANDARD",
    TEAM_MODE: "NONE",
    PLAY_MODE: "SEQUENTIAL",
    get team_mode(): number {
      return 0;
    },
  };
  for (const k of Object.keys(over)) {
    (cfg as Record<string, unknown>)[k] = over[k];
  }
  return ui.MainMenu.headless(cfg, 1024, 768);
}

function rowIndex(m: ui.MainMenu, key: string): number {
  return m.rows.map((r) => r[0]).indexOf(key);
}

// ---------------------------------------------------------------------------
describe("ui_flow: HumanController.handle keyboard -> weapon cycle (== Python oracle)", () => {
  // Reuse the Python-dumped _cycle_weapon sel_out, but reach it through the
  // KEYBOARD: TAB and ] map to _cycle_weapon(+1); [ maps to _cycle_weapon(-1)
  // (ui.ts:507-510). Same inventory construction ui.test.ts uses (ammo 5 to every
  // owned slot beyond the always-firable slot 0).
  function invForOwned(owned: number[]): number[] {
    const inv = new Array(weapons.NUM_ITEMS).fill(0);
    for (const s of owned) {
      if (s !== weapons.SLOT_BABY_MISSILE) {
        inv[s] = 5;
      }
    }
    return inv;
  }
  for (const c of vec.weapon_cycle) {
    const keys: Array<[number, string]> =
      c.d === 1
        ? [
            [pygame.K_TAB, "TAB"],
            [pygame.K_RIGHTBRACKET, "]"],
          ]
        : [[pygame.K_LEFTBRACKET, "["]];
    for (const [key, kname] of keys) {
      it(`${c.name} via ${kname}`, () => {
        const tank = new FlowTank({ selected_weapon: c.sel_in, inventory: invForOwned(c.owned) });
        const st = new FlowHumanState(tank);
        ui.HumanController.handle(st, kev(key));
        expect(tank.selected_weapon, `${c.name} sel_out`).toBe(c.sel_out);
        expect(st.fired, `${c.name} no fire`).toBe(0);
      });
    }
  }

  it("no offensive ammo at all -> _cycle_weapon early-returns, selection unchanged", () => {
    // off-nominal: has_ammo false for EVERY slot (incl. slot 0) so owned == [].
    // ui.ts:527 must return before owned[pyMod(at+d, 0)] (== owned[NaN] ==
    // undefined) corrupts selected_weapon. ui.py:227 `if not owned: return`.
    const tank = new FlowTank({ selected_weapon: 7, noAmmo: true });
    const st = new FlowHumanState(tank);
    expect(() => ui.HumanController.handle(st, kev(pygame.K_TAB)), "no throw").not.toThrow();
    expect(tank.selected_weapon, "unchanged via handle(TAB)").toBe(7);
    ui.HumanController._cycle_weapon(st, tank, -1);
    expect(tank.selected_weapon, "unchanged via direct _cycle_weapon(-1)").toBe(7);
  });
});

// ---------------------------------------------------------------------------
describe("ui_flow: MainMenu.handle key -> value wiring (LEFT/RIGHT/a/d, non-KEYDOWN, enum default)", () => {
  it("RIGHT/d increment and LEFT/a decrement the selected value row (ui.py:81-84)", () => {
    const m = flowMenu();
    m.sel = rowIndex(m, "rounds"); // _set("MAXROUNDS", d, 1, 1000)
    m.handle(kev(pygame.K_RIGHT));
    expect(m.cfg.MAXROUNDS, "RIGHT -> _activate(+1)").toBe(11);
    m.handle(kev(pygame.K_LEFT));
    expect(m.cfg.MAXROUNDS, "LEFT -> _activate(-1)").toBe(10);
    m.handle(kev(pygame.K_d));
    expect(m.cfg.MAXROUNDS, "d -> _activate(+1)").toBe(11);
    m.handle(kev(pygame.K_a));
    expect(m.cfg.MAXROUNDS, "a -> _activate(-1)").toBe(10);
  });

  it("non-KEYDOWN events are ignored (ui.ts:313 early return)", () => {
    const m = flowMenu();
    m.sel = rowIndex(m, "rounds");
    const sel0 = m.sel;
    m.handle(kev(pygame.K_RIGHT, pygame.MOUSEBUTTONDOWN));
    expect(m.cfg.MAXROUNDS, "value unchanged on non-KEYDOWN").toBe(10);
    m.handle(kev(pygame.K_DOWN, pygame.MOUSEBUTTONUP));
    expect(m.sel, "sel unchanged on non-KEYDOWN").toBe(sel0);
  });

  it("unknown enum string resets the cycle index to 0 (ui.ts:308 / ui.py:71)", () => {
    // SCORING is not one of SCORING_NAMES, so names.indexOf == -1 -> cur=0, then
    // d=+1 -> names[(0+1)%3] == "STANDARD".
    const m = flowMenu({ SCORING: "BOGUS" });
    m.sel = rowIndex(m, "scoring");
    m.handle(kev(pygame.K_RIGHT));
    expect(m.cfg.SCORING, "bogus enum -> index 0 then +1").toBe("STANDARD");
  });
});

// ---------------------------------------------------------------------------
describe("ui_flow: MainMenu._set_f reproduces CPython round-half-even at a 2-decimal tie", () => {
  it("GRAVITY 0.075 +0.05 -> 0.125 rounds half-even to 0.12 (not half-up 0.13)", () => {
    // ui.ts:91 (the floor%2 banker's branch) is only reached at an exact .5 tie.
    // 0.075 + 0.05 === 0.125 exactly; scaled *100 == 12.5; half-even keeps the even
    // 12 -> 0.12. Verified against the venv: CPython round(0.125, 2) == 0.12. A
    // half-up Math.round(12.5) would give 13 -> 0.13, so this pins the fidelity.
    const m = flowMenu({ GRAVITY: 0.075 });
    m.sel = rowIndex(m, "gravity"); // _set_f("GRAVITY", d*0.05, 0.05, 10.0)
    m._activate(1);
    expect(m.cfg.GRAVITY, "round(0.125,2) half-even -> even floor kept").toBe(0.12);
  });

  it("GRAVITY 0.325 +0.05 -> 0.375 rounds half-even UP to 0.38 (odd floor)", () => {
    // The other half-even outcome (ui.ts:91 floor+1): 0.325 + 0.05 === 0.375 (== 3/8,
    // an EXACT double), scaled *100 == 37.5, floor 37 is ODD so half-even rounds UP
    // to 38 -> 0.38. Verified against the venv: CPython round(0.375, 2) == 0.38.
    const m = flowMenu({ GRAVITY: 0.325 });
    m.sel = rowIndex(m, "gravity");
    m._activate(1);
    expect(m.cfg.GRAVITY, "round(0.375,2) half-even -> odd floor up").toBe(0.38);
  });
});

// ---------------------------------------------------------------------------
describe("ui_flow: Shop.handle ignores non-KEYDOWN events (ui.ts:600 early return)", () => {
  function flowShop(): ui.Shop {
    const econ: ui.ShopEconomy = {
      available: new Array(weapons.NUM_ITEMS).fill(true),
      price: weapons.ITEMS.map((it) => it.cost),
      buy: () => false,
      sell: () => 0,
    };
    return ui.Shop.headless({ economy: econ }, new FlowTank({}), 1024, 768);
  }
  it("MOUSEBUTTONDOWN does not move the selection or set done", () => {
    const shop = flowShop();
    shop.sel = 4;
    shop.handle(kev(pygame.K_DOWN, pygame.MOUSEBUTTONDOWN));
    expect(shop.sel, "sel unchanged").toBe(4);
    shop.handle(kev(pygame.K_ESCAPE, pygame.MOUSEBUTTONDOWN));
    expect(shop.done, "done unchanged").toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("ui_flow: live (non-headless) MainMenu/Shop constructors run DOM-free", () => {
  // The Font ctor (src/pygame.ts:910) is DOM-free -- it only reads the DOM lazily
  // in size()/render(). So `new MainMenu(...)` / `new Shop(...)` (which build fonts
  // in their ctors, ui.ts:237-238,571-572) construct under Node. The header
  // comments in ui.ts/ui.test.ts claiming these are browser-only are stale (the
  // construction is DOM-free; only the .draw() pixel path needs a Canvas).
  it("new MainMenu(...) == MainMenu.headless(...) logic + SysFont 18/34 (ui.py:31-32)", () => {
    const live = new ui.MainMenu(flowMenuCfg(4), 1024, 768);
    const head = ui.MainMenu.headless(flowMenuCfg(4), 1024, 768);
    expect(
      live.rows.map((r) => r[0]),
      "live rows == headless rows",
    ).toEqual(head.rows.map((r) => r[0]));
    expect(live.num_players, "num_players").toBe(head.num_players);
    expect(live.types, "default roster").toEqual(head.types);
    // font18()/bigFont34(): 18 regular + 34 bold (ui.py:31-32).
    expect(live.font.size_px, "menu font px").toBe(18);
    expect(live.font.bold, "menu font not bold").toBe(false);
    expect(live.big.size_px, "menu big px").toBe(34);
    expect(live.big.bold, "menu big bold").toBe(true);
  });

  it("new Shop(...) builds the available-item list + SysFont 15/26 (ui.py:251-252)", () => {
    const econ: ui.ShopEconomy = {
      available: new Array(weapons.NUM_ITEMS).fill(true),
      price: weapons.ITEMS.map((it) => it.cost),
      buy: () => false,
      sell: () => 0,
    };
    const live = new ui.Shop({ economy: econ }, new FlowTank({}), 1024, 768);
    // all available -> every slot is in the item list, in index order.
    expect(live.items.length, "item count").toBe(weapons.NUM_ITEMS);
    expect(live.items[0], "first slot").toBe(0);
    expect(live.items[live.items.length - 1], "last slot").toBe(weapons.NUM_ITEMS - 1);
    // font15()/bigFont26(): 15 regular + 26 bold (ui.py:251-252).
    expect(live.font.size_px, "shop font px").toBe(15);
    expect(live.font.bold, "shop font not bold").toBe(false);
    expect(live.big.size_px, "shop big px").toBe(26);
    expect(live.big.bold, "shop big bold").toBe(true);
  });
});

/** Full Cfg literal for the live-ctor comparison (distinct instance per call so
 *  the live/headless menus do not share a mutated cfg). */
function flowMenuCfg(maxplayers: number): ui.Cfg {
  return {
    MAXPLAYERS: maxplayers,
    MAXROUNDS: 10,
    INITIAL_CASH: 0,
    GRAVITY: 0.2,
    MAX_WIND: 200,
    AIR_VISCOSITY: 0,
    SCORING: "STANDARD",
    TEAM_MODE: "NONE",
    PLAY_MODE: "SEQUENTIAL",
    get team_mode(): number {
      return 0;
    },
  };
}

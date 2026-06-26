/**
 * Mouse-driven widget / dialog engine -- a faithful TypeScript port of
 * scorch-py/scorch/widgets.py (the fidelity oracle), drawn against src/pygame.ts.
 *
 * Mirrors the recovered 4f19 dialog framework (catalog 17 section 2): a panel is a
 * box of widgets, drawn each frame, hit-tested on click, with `~`-accelerator
 * keys, Enter = default, Esc = cancel. Widget types map to the recovered
 * constructor tags: Button(0), Label(1), Spinner(2), Selector/Toggle(5/8),
 * TextField(2-edit), Slider(6), IconStrip(4). A software arrow cursor is drawn
 * over everything.
 *
 * NUMERIC SUBSTRATE vs DRAWN PIXELS (read before testing):
 *   The differential gate (test/widgets.test.ts) runs in Node, DOM-free, so it
 *   exercises the LOGIC layer only: widget layout rects, hit-testing
 *   (Rect.collidepoint), value clamp/step (Spinner/Slider), selection-state
 *   transitions (Selector/Toggle/RadioGroup), Slider tick<->x mapping and its
 *   Python-`round` (banker's) rounding, and the entire Panel.handle event router
 *   over scripted MOUSEBUTTON/MOTION/KEYDOWN batteries. NONE of that touches
 *   pygame.font / pygame.Surface / pygame.draw, so it reproduces the oracle
 *   exactly. The .draw() methods (the literal pixels) defer to the Phase-3 visual
 *   gate (pixelsDeferredToPhase3 = true).
 *
 * FONT CAVEAT (DOM dependency): Label and Button measure their label with
 *   font(...).size(...) / .get_height() in their CONSTRUCTORS (matching
 *   widgets.py:115,141,142), which requires a Canvas2D (DOM). So Label/Button can
 *   only be constructed in a browser, not under Node. Every OTHER widget
 *   constructor is DOM-free (it just builds Rects), which is what the test
 *   battery constructs.
 *
 * CURSOR CAVEAT (integrator hook): draw_cursor() in the Python port imports
 *   `scorch.sprites` (sprites.get_cursor) and reads pygame.mouse.get_pos(). The
 *   sprites module is not yet ported and pygame.mouse is not in the shim, and this
 *   agent may only touch widgets.ts. So draw_cursor() is wired to two settable
 *   providers (setCursorProvider / setMousePosProvider) that the integrator
 *   supplies from the ported sprites module and the host mouse state; the blit
 *   sequence and hotspot math are byte-faithful to widgets.py:628-641. Until a
 *   provider is set, draw_cursor() is a no-op (it cannot fabricate the sprite).
 */
import * as pygame from "./pygame";
import { pyRound } from "./damage";

// palette-ish UI colors (Borland-dialog gray look)
// Dialog/shop DESKTOP clear color.  The real Scorch dialog desktop is GREY, not
// the dark blue this was (the user reported the shop/dialog backdrop blue from the
// real game).  RGB is byte-recovered: the engine's general-purpose UI grey is DAC
// idx 0x96 = (0x32,0x32,0x32) 6-bit -> (200,200,200) 8-bit, written at boot in
// FUN_33a1_001d.c:118 `FUN_556b_0005(0x96,0x32,0x32,0x32)`.  RECONSTRUCTED: that
// 0x96 is specifically the dialog-DESKTOP index is not provable from the available
// decompiles (the 4f19 framework's full-screen clear is in FUN_400b_08ba, which
// disassembles to bad-instruction garbage); the desktop-clear index is BLOCKED.
// A faithful DOS grey from this binary is used, distinct from the (170,170,170)
// panel so the panel reads against it.
export const C_BG: [number, number, number] = [200, 200, 200];
export const C_PANEL: [number, number, number] = [170, 170, 170];
export const C_PANEL_HI: [number, number, number] = [210, 210, 210];
export const C_PANEL_LO: [number, number, number] = [110, 110, 110];
export const C_TEXT: [number, number, number] = [0, 0, 0];
export const C_TEXT_LT: [number, number, number] = [255, 255, 255];
// Accelerator hot-letter color.  RE (FACT): the real game draws the `~`-marked
// letter in the dotext SECONDARY color DAT_5f38_f2d8, set once at boot to palette
// index 0xa1 (FUN_33a1_001d.c:121 `FUN_5589_0679(0xa1)`).  DAC index 0xa1 is
// written 6-bit (10,63,63) at FUN_33a1_001d.c:120 -> 8-bit (40,252,252), bright
// cyan.  (Was (200,0,0) red, which the binary never uses for accelerators.)
export const C_ACCEL: [number, number, number] = [40, 252, 252];
export const C_SEL: [number, number, number] = [0, 0, 160];
export const C_BTN: [number, number, number] = [0, 0, 150];
export const C_FIELD: [number, number, number] = [255, 255, 255];

const _fonts: { [key: string]: pygame.Font } = {};

export function font(size = 15, bold = false): pygame.Font {
  const key = `${size},${bold}`;
  let f = _fonts[key];
  if (f === undefined) {
    f = pygame.font.SysFont("consolas,couriernew,monospace", size, bold);
    _fonts[key] = f;
  }
  return f;
}

/** Render a label, drawing the char after '~' underlined/cyan (accelerator). */
function _draw_accel_text(
  surf: pygame.Surface,
  text: string,
  x: number,
  y: number,
  color: pygame.ColorArg = C_TEXT,
  fnt: pygame.Font | null = null,
): number {
  const f = fnt || font();
  let cx = x;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "~" && i + 1 < text.length) {
      const nxt = text[i + 1];
      const r = f.render(nxt, true, C_ACCEL);
      surf.blit(r, [cx, y]);
      pygame.draw.line(
        surf,
        C_ACCEL,
        [cx, y + r.get_height() - 2],
        [cx + r.get_width(), y + r.get_height() - 2],
      );
      cx += r.get_width();
      i += 2;
    } else {
      const r = f.render(ch, true, color);
      surf.blit(r, [cx, y]);
      cx += r.get_width();
      i += 1;
    }
  }
  return cx;
}

export function accel_of(label: string): string | null {
  const j = label.indexOf("~");
  if (0 <= j && j < label.length - 1) {
    return label[j + 1].toLowerCase();
  }
  return null;
}

export function plain(label: string): string {
  return label.replace(/~/g, "");
}

/** Action returned by a widget's on_click/on_accel, or routed by the Panel. */
export type Action = string | null;

export class Widget {
  rect: pygame.Rect;
  label: string;
  action: Action;
  accel: string | null;
  enabled: boolean;

  constructor(x: number, y: number, w: number, h: number, label = "", action: Action = null) {
    this.rect = new pygame.Rect(x, y, w, h);
    this.label = label;
    this.action = action;
    this.accel = accel_of(label);
    this.enabled = true;
  }

  hit(pos: pygame.Point): boolean {
    return this.enabled && this.rect.collidepoint(pos);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  on_click(_pos: pygame.Point, _button: number): Action {
    return this.action; // default: fire the action
  }

  on_accel(): Action {
    return this.action;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  draw(_surf: pygame.Surface, _focused = false): void {
    /* base widget draws nothing */
  }
}

export class Label extends Widget {
  /** Tag-1 static text.  Per SCREENS.md s0.1 NOTE: the tag-1 constructor
   * (FUN_4f19_2a9b) is also used for CLICKABLE controls (Shop Inventory/Update/
   * Done, Hardware spinner prompts) when a non-0xffff field-id/callback is
   * passed.  So a Label takes an OPTIONAL action + accelerator: with action it
   * behaves as a flat (borderless) button; without, it is pure static text and
   * is not focusable/clickable. */
  color: pygame.ColorArg;
  size: number;
  bold: boolean;

  constructor(
    x: number,
    y: number,
    label: string,
    color: pygame.ColorArg = C_TEXT,
    size = 15,
    bold = false,
    action: Action = null,
  ) {
    // measure so a clickable label still hit-tests over its glyphs
    const fnt = font(size, bold);
    super(x, y, fnt.size(plain(label))[0] + 4, fnt.get_height(), label, action);
    this.color = color;
    this.size = size;
    this.bold = bold;
  }

  get clickable(): boolean {
    return this.action !== null;
  }

  override hit(pos: pygame.Point): boolean {
    return this.clickable && this.enabled && this.rect.collidepoint(pos);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override on_click(_pos: pygame.Point, _button: number): Action {
    return this.action; // null for a pure label
  }

  override on_accel(): Action {
    return this.action;
  }

  override draw(surf: pygame.Surface, focused = false): void {
    const col = this.clickable && focused ? C_SEL : this.color;
    _draw_accel_text(surf, this.label, this.rect.x, this.rect.y, col, font(this.size, this.bold));
  }
}

export class Button extends Widget {
  default: boolean;

  constructor(x: number, y: number, label: string, action: Action, w: number | null = null, defaultBtn = false) {
    const fnt = font(15, true);
    const ww = w || fnt.size(plain(label))[0] + 18;
    super(x, y, ww, 22, label, action);
    this.default = defaultBtn;
  }

  override draw(surf: pygame.Surface, focused = false): void {
    const r = this.rect;
    const col = focused ? C_PANEL_HI : C_PANEL;
    pygame.draw.rect(surf, col, r);
    pygame.draw.line(surf, C_PANEL_HI, r.topleft, r.topright);
    pygame.draw.line(surf, C_PANEL_HI, r.topleft, r.bottomleft);
    pygame.draw.line(surf, C_PANEL_LO, r.bottomleft, r.bottomright);
    pygame.draw.line(surf, C_PANEL_LO, r.topright, r.bottomright);
    if (this.default) {
      pygame.draw.rect(surf, [0, 0, 0], r, 1);
    }
    const tw = font(15, true).size(plain(this.label))[0];
    _draw_accel_text(surf, this.label, r.centerx - Math.trunc(tw / 2), r.y + 3, C_TEXT, font(15, true));
  }
}

export class Spinner extends Widget {
  /** label: value  with < > click zones (left/right click or arrows). */
  get: () => number;
  set: (v: number) => void;
  lo: number;
  hi: number;
  step: number;
  fmt: (v: number) => string;

  constructor(
    x: number,
    y: number,
    label: string,
    get: () => number,
    set_: (v: number) => void,
    lo: number,
    hi: number,
    step = 1,
    fmt: (v: number) => string = String,
    w = 260,
  ) {
    super(x, y, w, 20, label);
    this.get = get;
    this.set = set_;
    this.lo = lo;
    this.hi = hi;
    this.step = step;
    this.fmt = fmt;
  }

  _clamp(v: number): number {
    return Math.max(this.lo, Math.min(this.hi, v));
  }

  adjust(d: number): void {
    this.set(this._clamp(this.get() + d * this.step));
  }

  override on_click(pos: pygame.Point, button: number): Action {
    // right portion is "<value>"; click left of center decrements
    if (button === 3) {
      this.adjust(-1);
    } else if (pos[0] > this.rect.centerx) {
      this.adjust(1);
    } else {
      this.adjust(-1);
    }
    return null;
  }

  override on_accel(): Action {
    this.adjust(1);
    return null;
  }

  override draw(surf: pygame.Surface, focused = false): void {
    const r = this.rect;
    if (focused) {
      pygame.draw.rect(surf, C_PANEL_HI, r);
    }
    _draw_accel_text(surf, this.label, r.x, r.y, C_TEXT);
    const val = `  < ${this.fmt(this.get())} >`;
    surf.blit(font().render(val, true, C_SEL), [r.x + 150, r.y]);
  }
}

export class Selector extends Widget {
  /** label: OPTION  - left-click next, right-click prev. */
  options: string[];
  get_idx: () => number;
  set_idx: (i: number) => void;

  constructor(
    x: number,
    y: number,
    label: string,
    options: string[],
    get_idx: () => number,
    set_idx: (i: number) => void,
    w = 300,
  ) {
    super(x, y, w, 20, label);
    this.options = options;
    this.get_idx = get_idx;
    this.set_idx = set_idx;
  }

  cycle(d: number): void {
    this.set_idx(pyMod(this.get_idx() + d, this.options.length));
  }

  override on_click(_pos: pygame.Point, button: number): Action {
    this.cycle(button === 3 ? -1 : 1);
    return null;
  }

  override on_accel(): Action {
    this.cycle(1);
    return null;
  }

  override draw(surf: pygame.Surface, focused = false): void {
    const r = this.rect;
    if (focused) {
      pygame.draw.rect(surf, C_PANEL_HI, r);
    }
    _draw_accel_text(surf, this.label, r.x, r.y, C_TEXT);
    const val = this.options[pyMod(this.get_idx(), this.options.length)];
    surf.blit(font().render(`< ${val} >`, true, C_SEL), [r.x + 150, r.y]);
  }
}

export class Toggle extends Widget {
  get: () => boolean;
  set: (v: boolean) => void;

  constructor(x: number, y: number, label: string, get: () => boolean, set_: (v: boolean) => void, w = 300) {
    super(x, y, w, 20, label);
    this.get = get;
    this.set = set_;
  }

  override on_click(_pos: pygame.Point, _button: number): Action {
    this.set(!this.get());
    return null;
  }

  override on_accel(): Action {
    this.set(!this.get());
    return null;
  }

  override draw(surf: pygame.Surface, focused = false): void {
    const r = this.rect;
    const box = new pygame.Rect(r.x, r.y + 2, 14, 14);
    pygame.draw.rect(surf, C_FIELD, box);
    pygame.draw.rect(surf, C_TEXT, box, 1);
    if (this.get()) {
      pygame.draw.line(surf, C_TEXT, [box.x + 2, box.y + 7], [box.x + 6, box.y + 11], 2);
      pygame.draw.line(surf, C_TEXT, [box.x + 6, box.y + 11], [box.x + 12, box.y + 2], 2);
    }
    _draw_accel_text(surf, this.label, r.x + 20, r.y, focused ? C_TEXT_LT : C_TEXT);
  }
}

export class TextField extends Widget {
  get: () => string;
  set: (v: string) => void;
  maxlen: number;
  label_w: number;
  editing: boolean;

  constructor(
    x: number,
    y: number,
    label: string,
    get: () => string,
    set_: (v: string) => void,
    maxlen = 12,
    w = 240,
    label_w = 60,
  ) {
    super(x, y, w, 22, label);
    this.get = get;
    this.set = set_;
    this.maxlen = maxlen;
    this.label_w = label_w; // px reserved for the label before the box
    this.editing = false;
  }

  override on_click(_pos: pygame.Point, _button: number): Action {
    this.editing = true;
    return "focus_text";
  }

  on_text_key(event: PygameEvent): void {
    if (event.key === pygame.K_BACKSPACE) {
      this.set(this.get().slice(0, -1));
    } else if (
      event.key === pygame.K_RETURN ||
      event.key === pygame.K_TAB ||
      event.key === pygame.K_ESCAPE
    ) {
      this.editing = false;
    } else if (
      event.unicode &&
      isPrintable(event.unicode) &&
      this.get().length < this.maxlen
    ) {
      this.set(this.get() + event.unicode);
    }
  }

  override draw(surf: pygame.Surface, _focused = false): void {
    const r = this.rect;
    _draw_accel_text(surf, this.label, r.x, r.y + 2, C_TEXT);
    const box = new pygame.Rect(r.x + this.label_w, r.y, r.w - this.label_w, r.h);
    pygame.draw.rect(surf, C_FIELD, box);
    pygame.draw.rect(surf, C_TEXT, box, 1);
    const txt = this.get() + (this.editing ? "_" : "");
    surf.blit(font().render(txt, true, C_TEXT), [box.x + 4, box.y + 3]);
  }
}

export class IconStrip extends Widget {
  /** Row of selectable cells (tank-icon strip / weapon array). */
  cells: unknown[];
  get_idx: () => number;
  set_idx: (i: number) => void;
  cell: number;
  draw_cell: ((surf: pygame.Surface, box: pygame.Rect, i: number, c: unknown) => void) | null;

  constructor(
    x: number,
    y: number,
    cells: unknown[],
    get_idx: () => number,
    set_idx: (i: number) => void,
    cell = 34,
    draw_cell: ((surf: pygame.Surface, box: pygame.Rect, i: number, c: unknown) => void) | null = null,
  ) {
    super(x, y, cell * cells.length, cell, "");
    this.cells = cells;
    this.get_idx = get_idx;
    this.set_idx = set_idx;
    this.cell = cell;
    this.draw_cell = draw_cell;
  }

  override on_click(pos: pygame.Point, _button: number): Action {
    const i = Math.floor((pos[0] - this.rect.x) / this.cell);
    if (0 <= i && i < this.cells.length) {
      this.set_idx(i);
    }
    return null;
  }

  override draw(surf: pygame.Surface, _focused = false): void {
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const cx = this.rect.x + i * this.cell;
      const box = new pygame.Rect(cx, this.rect.y, this.cell - 2, this.cell - 2);
      pygame.draw.rect(surf, C_PANEL, box);
      pygame.draw.rect(
        surf,
        i === this.get_idx() ? C_SEL : C_PANEL_LO,
        box,
        i === this.get_idx() ? 2 : 1,
      );
      if (this.draw_cell) {
        this.draw_cell(surf, box, i, c);
      }
    }
  }
}

export class Slider extends Widget {
  /** Tag-6 value-array slider (FUN_4f19_3dfa builder / FUN_4f19_3ffd drag).
   *
   * Holds a discrete value list; the thumb snaps to ticks.  Click left/right of
   * the thumb steps one tick (left mouse / drag) or back (right mouse); dragging
   * snaps to the nearest tick.  Binds to the real value via get/set; the widget
   * finds the nearest tick index for the current value on draw. */
  values: number[];
  get: () => number;
  set: (v: number) => void;
  fmt: (v: number) => string;
  track_x: number;
  track_w: number;
  dragging: boolean;

  constructor(
    x: number,
    y: number,
    label: string,
    values: Iterable<number>,
    get: () => number,
    set_: (v: number) => void,
    w = 240,
    fmt: (v: number) => string = String,
  ) {
    super(x, y, w, 30, label);
    this.values = Array.from(values);
    this.get = get;
    this.set = set_;
    this.fmt = fmt;
    this.track_x = x + 8;
    this.track_w = w - 16;
    this.dragging = false;
  }

  _cur_index(): number {
    const v = this.get();
    // nearest tick to the current value (Python min keeps the FIRST on a tie)
    let best = 0;
    let bestD = Math.abs(this.values[0] - v);
    for (let i = 1; i < this.values.length; i++) {
      const d = Math.abs(this.values[i] - v);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  _set_index(i: number): void {
    i = Math.max(0, Math.min(this.values.length - 1, i));
    this.set(this.values[i]);
  }

  _x_to_index(x: number): number {
    if (this.track_w <= 0 || this.values.length <= 1) {
      return 0;
    }
    const frac = (x - this.track_x) / this.track_w;
    return pyRound(frac * (this.values.length - 1));
  }

  _thumb_x(): number {
    if (this.values.length <= 1) {
      return this.track_x;
    }
    return this.track_x + Math.trunc((this.track_w * this._cur_index()) / (this.values.length - 1));
  }

  override on_click(pos: pygame.Point, button: number): Action {
    if (button === 3) {
      this._set_index(this._cur_index() - 1);
      return null;
    }
    const tx = this._thumb_x();
    if (Math.abs(pos[0] - tx) <= 6) {
      this.dragging = true; // grab the thumb
    } else {
      this._set_index(this._x_to_index(pos[0])); // jump to clicked tick
    }
    return null;
  }

  on_drag(pos: pygame.Point): void {
    if (this.dragging) {
      this._set_index(this._x_to_index(pos[0]));
    }
  }

  on_release(): void {
    this.dragging = false;
  }

  override on_accel(): Action {
    this._set_index(this._cur_index() + 1);
    return null;
  }

  override draw(surf: pygame.Surface, focused = false): void {
    const r = this.rect;
    _draw_accel_text(surf, this.label, r.x, r.y, focused ? C_TEXT_LT : C_TEXT);
    const ty = r.y + 20;
    pygame.draw.line(surf, C_PANEL_LO, [this.track_x, ty], [this.track_x + this.track_w, ty], 2);
    // ticks
    const n = this.values.length;
    if (n > 1) {
      for (let i = 0; i < n; i++) {
        const tx = this.track_x + Math.trunc((this.track_w * i) / (n - 1));
        pygame.draw.line(surf, C_PANEL_LO, [tx, ty - 2], [tx, ty + 2], 1);
      }
    }
    const tx = this._thumb_x();
    const thumb = new pygame.Rect(tx - 4, ty - 6, 8, 12);
    pygame.draw.rect(surf, focused ? C_PANEL_HI : C_PANEL, thumb);
    pygame.draw.rect(surf, C_TEXT, thumb, 1);
    const val = this.fmt(this.get());
    surf.blit(font().render(String(val), true, C_SEL), [this.track_x + this.track_w + 8, r.y]);
  }
}

export class RadioGroup extends Widget {
  /** Tag-8 multi-cell selector (FUN_4f19_3a81; hit-test FUN_4f19_4a2a).
   *
   * A column (or grid) of mutually-exclusive cells, each with its own
   * `~`-accelerator from its label.  Exactly one is selected; click a cell or
   * press its accel to select it.  Binds to an index via get_idx/set_idx.
   * Labels keep the `~` marker so the hot letter renders underlined. */
  labels: string[];
  get_idx: () => number;
  set_idx: (i: number) => void;
  cols: number;
  cell_w: number;
  cell_h: number;
  cell_accels: (string | null)[];

  constructor(
    x: number,
    y: number,
    labels: string[],
    get_idx: () => number,
    set_idx: (i: number) => void,
    cols = 1,
    cell_w = 150,
    cell_h = 20,
  ) {
    const rows = Math.floor((labels.length + cols - 1) / cols);
    super(x, y, cell_w * cols, cell_h * rows, "");
    this.labels = Array.from(labels);
    this.get_idx = get_idx;
    this.set_idx = set_idx;
    this.cols = cols;
    this.cell_w = cell_w;
    this.cell_h = cell_h;
    this.cell_accels = this.labels.map((l) => accel_of(l));
  }

  _cell_rect(i: number): pygame.Rect {
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    return new pygame.Rect(
      this.rect.x + col * this.cell_w,
      this.rect.y + row * this.cell_h,
      this.cell_w,
      this.cell_h,
    );
  }

  override hit(pos: pygame.Point): boolean {
    return this.enabled && this.rect.collidepoint(pos);
  }

  override on_click(pos: pygame.Point, _button: number): Action {
    for (let i = 0; i < this.labels.length; i++) {
      if (this._cell_rect(i).collidepoint(pos)) {
        this.set_idx(i);
        break;
      }
    }
    return null;
  }

  /** A tag-8 group matches its per-cell key list (SCREENS.md s0.2). */
  accel_hit(ch: string): boolean {
    for (let i = 0; i < this.cell_accels.length; i++) {
      if (this.cell_accels[i] === ch) {
        this.set_idx(i);
        return true;
      }
    }
    return false;
  }

  override draw(surf: pygame.Surface, _focused = false): void {
    for (let i = 0; i < this.labels.length; i++) {
      const lbl = this.labels[i];
      const cr = this._cell_rect(i);
      const sel = i === this.get_idx();
      // radio bullet
      const cy = cr.y + Math.floor(cr.h / 2);
      pygame.draw.circle(surf, C_FIELD, [cr.x + 7, cy], 6);
      pygame.draw.circle(surf, C_TEXT, [cr.x + 7, cy], 6, 1);
      if (sel) {
        pygame.draw.circle(surf, C_TEXT, [cr.x + 7, cy], 3);
      }
      _draw_accel_text(surf, lbl, cr.x + 18, cr.y + 1, C_TEXT);
    }
  }
}

export class Frame extends Widget {
  /** Tag-0xA titled group-box (FUN_4f19_333b).  Used as a plain bordered group,
   * and (Simultaneous 6-key block, SCREENS.md s3.1) as a single-keypress capture
   * cell: when `capture` is set, clicking it arms capture and the next KEYDOWN is
   * stored via set_key. */
  title: string;
  capture: boolean;
  get_key: (() => unknown) | null;
  set_key: ((v: unknown) => void) | null;
  arming: boolean;

  constructor(
    x: number,
    y: number,
    w: number,
    h: number,
    title = "",
    capture = false,
    get_key: (() => unknown) | null = null,
    set_key: ((v: unknown) => void) | null = null,
  ) {
    super(x, y, w, h, title);
    this.title = title;
    this.capture = capture;
    this.get_key = get_key;
    this.set_key = set_key;
    this.arming = false;
  }

  override hit(pos: pygame.Point): boolean {
    return this.capture && this.enabled && this.rect.collidepoint(pos);
  }

  override on_click(_pos: pygame.Point, _button: number): Action {
    if (this.capture) {
      this.arming = true;
      return "capture_key";
    }
    return null;
  }

  take_key(event: PygameEvent): void {
    if (this.set_key) {
      this.set_key(event.unicode ? event.unicode.toUpperCase() : event.key);
    }
    this.arming = false;
  }

  override draw(surf: pygame.Surface, _focused = false): void {
    const r = this.rect;
    pygame.draw.rect(surf, !this.arming ? C_PANEL_LO : C_SEL, r, 1);
    if (this.title) {
      const t = font(13).render(plain(this.title), true, C_TEXT);
      surf.fill(C_PANEL, [r.x + 6, r.y - 7, t.get_width() + 4, 12]);
      surf.blit(t, [r.x + 8, r.y - 7]);
    }
    if (this.capture) {
      let keytxt = this.get_key ? String(this.get_key()) : "";
      if (this.arming) {
        keytxt = "press a key...";
      }
      const kr = font(13).render(keytxt, true, C_SEL);
      surf.blit(kr, [r.centerx - Math.floor(kr.get_width() / 2), r.centery - 6]);
    }
  }
}

/**
 * A pygame-shaped event as main.ts constructs it (subset of fields the engine
 * reads). Mirrors the duck-typed `e` widgets.py.handle receives.
 */
export interface PygameEvent {
  type: number;
  pos?: pygame.Point;
  button?: number;
  key?: number;
  unicode?: string;
}

export class Panel {
  /** A titled window of widgets with mouse + accelerator + Enter/Esc handling.
   * Returns an action string from handle() when a Button is clicked or Esc/Enter. */
  rect: pygame.Rect;
  title: string;
  widgets: Widget[];
  focus: number;
  text_widget: TextField | null;
  no_cancel: boolean;
  cancel_action: string;
  default_widget: Button | null;
  capture_widget: Frame | null;

  constructor(x: number, y: number, w: number, h: number, title = "", no_cancel = false, cancel_action = "back") {
    this.rect = new pygame.Rect(x, y, w, h);
    this.title = title;
    this.widgets = [];
    this.focus = 0;
    this.text_widget = null;
    // dialog[5] flag (SCREENS.md s0.2): nonzero => Esc and click-outside do
    // NOT dismiss (Tank Control Panel, Tank Init, in-round Inventory).
    this.no_cancel = no_cancel;
    this.cancel_action = cancel_action;
    this.default_widget = null; // Enter (0x0D) activates this (tag-0 default button)
    this.capture_widget = null; // a Frame currently arming a key-capture
  }

  add<T extends Widget>(widget: T): T {
    this.widgets.push(widget);
    if (widget instanceof Button && widget.default) {
      this.default_widget = widget;
    }
    return widget;
  }

  _focusables(): Widget[] {
    const out: Widget[] = [];
    for (const w of this.widgets) {
      if (w instanceof Label && !w.clickable) {
        continue; // pure static text is not focusable
      }
      if (w instanceof Frame && !w.capture) {
        continue; // decorative group-box
      }
      out.push(w);
    }
    return out;
  }

  /** Route the special focus_text / capture_key sentinels; else pass act up. */
  _resolve(act: Action, w: Widget): Action {
    if (act === "focus_text") {
      this.text_widget = w as TextField;
      return null;
    }
    if (act === "capture_key") {
      this.capture_widget = w as Frame;
      return null;
    }
    return act;
  }

  handle(e: PygameEvent): Action {
    // text-field line editor owns the keyboard while editing (FUN_4f19_43c2)
    if (this.text_widget && this.text_widget.editing && e.type === pygame.KEYDOWN) {
      this.text_widget.on_text_key(e);
      if (!this.text_widget.editing) {
        this.text_widget = null;
      }
      return null;
    }
    // Frame key-capture (Simultaneous 6-key block): next KEYDOWN is the key
    if (this.capture_widget && e.type === pygame.KEYDOWN) {
      if (e.key === pygame.K_ESCAPE) {
        this.capture_widget.arming = false;
      } else {
        this.capture_widget.take_key(e);
      }
      this.capture_widget = null;
      return null;
    }

    if (e.type === pygame.MOUSEBUTTONDOWN) {
      for (const w of this.widgets) {
        if (w.hit(e.pos as pygame.Point)) {
          // focus the widget that was clicked
          const fs = this._focusables();
          const idx = fs.indexOf(w);
          if (idx >= 0) {
            this.focus = idx;
          }
          return this._resolve(w.on_click(e.pos as pygame.Point, e.button as number), w);
        }
      }
      // click outside any widget: cancel iff outside the panel and cancel allowed
      if (!this.rect.collidepoint(e.pos as pygame.Point) && !this.no_cancel) {
        return this.cancel_action;
      }
      return null;
    }
    if (e.type === pygame.MOUSEMOTION) {
      for (const w of this.widgets) {
        if (w instanceof Slider && w.dragging) {
          w.on_drag(e.pos as pygame.Point);
        }
      }
      return null;
    }
    if (e.type === pygame.MOUSEBUTTONUP) {
      for (const w of this.widgets) {
        if (w instanceof Slider) {
          w.on_release();
        }
      }
      return null;
    }
    if (e.type === pygame.KEYDOWN) {
      if (e.key === pygame.K_ESCAPE) {
        return this.no_cancel ? null : this.cancel_action;
      }
      if (e.key === pygame.K_DOWN || e.key === pygame.K_TAB) {
        this.focus = pyMod(this.focus + 1, Math.max(1, this._focusables().length));
        return null;
      }
      if (e.key === pygame.K_UP) {
        this.focus = pyMod(this.focus - 1, Math.max(1, this._focusables().length));
        return null;
      }
      // Enter (0x0D) = activate the default button (SCREENS.md s0.2)
      if (e.key === pygame.K_RETURN && this.default_widget !== null) {
        return this._resolve(this.default_widget.on_accel(), this.default_widget);
      }
      if (
        e.key === pygame.K_RETURN ||
        e.key === pygame.K_SPACE ||
        e.key === pygame.K_LEFT ||
        e.key === pygame.K_RIGHT
      ) {
        const fs = this._focusables();
        if (fs.length) {
          const w = fs[pyMod(this.focus, fs.length)];
          // left/right step value widgets (right mouse == prev, left == next)
          if (e.key === pygame.K_LEFT || e.key === pygame.K_RIGHT) {
            const d = e.key === pygame.K_RIGHT ? 1 : -1;
            if (w instanceof Spinner) {
              w.adjust(d);
              return null;
            }
            if (w instanceof Selector) {
              w.cycle(d);
              return null;
            }
            if (w instanceof Slider) {
              w._set_index(w._cur_index() + d);
              return null;
            }
            if (w instanceof RadioGroup) {
              w.set_idx(pyMod(w.get_idx() + d, w.labels.length));
              return null;
            }
          }
          return this._resolve(w.on_accel(), w);
        }
        return null;
      }
      // accelerator match: clickable labels/buttons/toggles + tag-8 cell key lists
      const ch = e.unicode ? e.unicode.toLowerCase() : null;
      if (ch) {
        for (const w of this.widgets) {
          if (w instanceof RadioGroup && w.enabled && w.accel_hit(ch)) {
            return null;
          }
          if (w.accel === ch && w.enabled) {
            return this._resolve(w.on_accel(), w);
          }
        }
      }
    }
    return null;
  }

  draw(surf: pygame.Surface, dim_bg = true): void {
    if (dim_bg) {
      const ov = new pygame.Surface(surf.get_size());
      ov.set_alpha(140);
      ov.fill([0, 0, 0]);
      surf.blit(ov, [0, 0]);
    }
    pygame.draw.rect(surf, C_PANEL, this.rect);
    pygame.draw.rect(surf, C_PANEL_HI, this.rect, 1);
    pygame.draw.line(surf, C_PANEL_LO, this.rect.bottomleft, this.rect.bottomright, 2);
    pygame.draw.line(surf, C_PANEL_LO, this.rect.topright, this.rect.bottomright, 2);
    if (this.title) {
      const bar = new pygame.Rect(this.rect.x, this.rect.y, this.rect.w, 20);
      pygame.draw.rect(surf, C_SEL, bar);
      const t = font(15, true).render(this.title, true, C_TEXT_LT);
      surf.blit(t, [bar.centerx - Math.floor(t.get_width() / 2), bar.y + 2]);
    }
    const fs = this._focusables();
    for (const w of this.widgets) {
      const focused = fs.length > 0 && w === fs[pyMod(this.focus, fs.length)];
      w.draw(surf, focused);
    }
  }
}

// ---------------------------------------------------------------------------
// Software arrow cursor (the 54e7 pointer).
// ---------------------------------------------------------------------------
// draw_cursor() in widgets.py imports scorch.sprites (get_cursor) and reads
// pygame.mouse.get_pos(). Neither the sprites port nor pygame.mouse exists yet,
// and this agent may only touch widgets.ts, so both are wired to integrator-
// supplied providers. The blit/hotspot math below is byte-faithful to
// widgets.py:628-641; the geometry source remains the single authentic cursor
// sprite (sprites.CURSOR_POINTS @ file 0x55d80+0x703a) once the provider is set.

/** (surface, hotspot) -- a built cursor sprite, as sprites.get_cursor returns. */
export type CursorPair = [pygame.Surface, [number, number]];

let _cursorProvider: ((rgb: [number, number, number], scale: number) => CursorPair) | null = null;
let _mousePosProvider: (() => [number, number]) | null = null;
let _CURSOR_CACHE: CursorPair | null = null; // (surface, hotspot); built once -- geometry is constant

/** Integrator hook: supply the ported sprites.get_cursor (builds the arrow sprite). */
export function setCursorProvider(p: (rgb: [number, number, number], scale: number) => CursorPair): void {
  _cursorProvider = p;
  _CURSOR_CACHE = null;
}

/** Integrator hook: supply the live mouse position (pygame.mouse.get_pos equivalent). */
export function setMousePosProvider(p: () => [number, number]): void {
  _mousePosProvider = p;
}

/** Software arrow cursor at the mouse position (the 54e7 pointer).
 *
 * Blits the BYTE-EXACT extracted arrow (sprites.CURSOR_POINTS, the 28 (dx,dy)
 * triplets from FUN_54e7_06c0 @ file 0x55d80+0x703a) rather than an ad-hoc
 * polygon, so the one authentic cursor sprite is the single source for the
 * pointer everywhere it is drawn.  Built once and cached (the shape is fixed).
 * No-op until the integrator supplies the sprite + mouse-pos providers (it
 * cannot fabricate the sprite asset here). */
export function draw_cursor(surf: pygame.Surface): void {
  if (_cursorProvider === null || _mousePosProvider === null) {
    return;
  }
  if (_CURSOR_CACHE === null) {
    _CURSOR_CACHE = _cursorProvider([255, 255, 255], 1);
  }
  const [cur, hot] = _CURSOR_CACHE;
  const [x, y] = _mousePosProvider(); // SCALED surfaces report logical coords already
  surf.blit(cur, [x - hot[0], y - hot[1]]);
}

// ---------------------------------------------------------------------------
// Python-semantics helpers (kept private; preserve the oracle's arithmetic).
// ---------------------------------------------------------------------------

/** Python `%`: result takes the sign of the divisor (always >= 0 for n > 0). */
function pyMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Python str.isprintable() for a single produced character (event.unicode).
 *  pygame delivers printable chars; the engine guards with .isprintable() to
 *  drop control chars. A single-char unicode is printable unless it is a C0/C1
 *  control or DEL. */
function isPrintable(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0xa0)) {
      return false;
    }
  }
  return true;
}

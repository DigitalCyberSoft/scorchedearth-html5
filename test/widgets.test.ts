/**
 * Differential gate: TS widgets == Python scorch.widgets (the fidelity oracle).
 *
 * Golden vectors come from oracle/dump_widgets.py -> oracle/vectors/widgets.json.
 * This test runs in Node (vitest environment: "node"), which has NO DOM, so it
 * exercises the NUMERIC / LOGIC substrate of the widget toolkit only:
 *
 *   - accel_of / plain (string)
 *   - constructor layout rects + sub-rects (Spinner/Selector/Toggle/TextField/
 *     IconStrip/Slider/RadioGroup/Frame)  [Label/Button EXCLUDED: their ctors
 *     measure a font, which needs a Canvas2D/DOM the test env lacks; their pixels
 *     defer to the Phase-3 visual gate]
 *   - hit-testing (Widget.hit / Rect.collidepoint, RadioGroup._cell_rect)
 *   - value clamp/step (Spinner._clamp/adjust/on_click)
 *   - selection-state transitions (Selector.cycle, Toggle, RadioGroup.accel_hit/
 *     on_click)
 *   - Slider tick<->x mapping incl. Python-`round` (banker's) at exact .5,
 *     _cur_index first-wins tie, _set_index clamp, on_click thumb-grab vs jump,
 *     on_drag
 *   - the WHOLE Panel.handle event router over scripted MOUSEBUTTON/MOTION/KEYDOWN
 *     sequences (focus walk, value stepping, Esc/cancel + no_cancel, click-outside
 *     cancel, accel match, text-field capture, frame key-capture)
 *
 * EPSILON POLICY: every asserted value here is an INTEGER, a string, a boolean, an
 * exactly-representable float tick value (the Slider value list members are passed
 * through unchanged), or a Python-`round` result reproduced by the shared pyRound
 * (round-half-to-even) -- all asserted EXACT (.toBe / .toEqual). There is NO
 * transcendental on this path (no sqrt/sin/cos), so no toBeCloseTo is needed.
 *
 * The drawn pixels (pygame.draw / blit) are NOT tested here -- they are the
 * Phase-3 visual gate's job (pixelsDeferredToPhase3 = true). draw_cursor()'s
 * blit/hotspot math is also pixel-path and integrator-provider-gated; not unit
 * tested.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import * as W from "../src/widgets";
import * as pygame from "../src/pygame";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "widgets.json");

// ---------------------------------------------------------------------------
// A mutable binding cell == the dumper's Cell (getter/setter over one value).
// Non-generic on purpose: a generic Cell<T> would narrow `new Cell(0)` to the
// literal type 0, and the literal-typed setter would then reject the widget's
// (v: number) => void binding. Storing the union and exposing typed get/set
// accessors via the cast helpers below keeps the bindings exact at each widget.
// ---------------------------------------------------------------------------
type CellVal = number | string | boolean;
class Cell {
  v: CellVal;
  constructor(v: CellVal) {
    this.v = v;
  }
  get = (): CellVal => this.v;
  set = (x: CellVal): void => {
    this.v = x;
  };
  // Typed views: the widget binders below want concrete signatures.
  getN = (): number => this.v as number;
  setN = (x: number): void => {
    this.v = x;
  };
  getS = (): string => this.v as string;
  setS = (x: string): void => {
    this.v = x;
  };
  getB = (): boolean => this.v as boolean;
  setB = (x: boolean): void => {
    this.v = x;
  };
}

// SDL key/event numeric constants mirrored from pygame in the dumper -> reuse the
// shim's so a vector "key" matches what handle() compares against.
const KD = pygame.KEYDOWN;
const MD = pygame.MOUSEBUTTONDOWN;
const MM = pygame.MOUSEMOTION;
const MU = pygame.MOUSEBUTTONUP;

// ---------------------------------------------------------------------------
// Vector shapes
// ---------------------------------------------------------------------------
type Rect4 = [number, number, number, number];

interface HelperCase {
  s: string;
  accel: string | null;
  plain: string;
}
interface GeomCase {
  name: string;
  rect: Rect4;
  cells?: Rect4[];
  accels?: (string | null)[];
  cell?: number;
  maxlen?: number;
  label_w?: number;
  track_x?: number;
  track_w?: number;
}
interface HitCase {
  name: string;
  rect?: Rect4;
  hits: boolean[];
  cell_of?: (number | null)[];
  grid: [number, number][];
}
interface SpinnerCase {
  cfg: { start: number; lo: number; hi: number; step: number };
  clamps: number[];
  adjust_seq: number[];
  clicks: { px: number; button: number; ret: W.Action; val: number }[];
  accel: { ret: W.Action; val: number }[];
  centerx: number;
}
interface SelectorCase {
  opts: string[];
  cycle: number[];
  clicks: { button: number; ret: W.Action; val: number }[];
  accel: { ret: W.Action; val: number }[];
}
interface ToggleCase {
  start: boolean;
  seq: { ret: W.Action; val: boolean }[];
}
interface SliderCase {
  values: number[];
  x2i: { x: number; i: number }[];
  cur: { v: number; cur: number; thumb: number }[];
  set_index: { i: number; val: number }[];
  clicks: {
    kind: string;
    pos?: number[];
    button?: number;
    ret?: W.Action;
    val: number;
    dragging: boolean;
  }[];
  accel: { ret: W.Action; val: number }[];
}
interface RadioCase {
  labels: string[];
  cols: number;
  accel_hit: { ch: string; hit: boolean; val: number }[];
  clicks: { p: number[]; ret: W.Action; val: number }[];
}
interface PanelStep {
  step: number;
  ret: W.Action;
  focus: number;
  cells: CellVal[];
  flags: { [k: string]: boolean };
  text_widget: number;
  capture_widget: number;
}
interface PanelScenario {
  name: string;
  log: PanelStep[];
}
interface WidgetVectors {
  module: string;
  helpers: HelperCase[];
  geom: GeomCase[];
  hit: HitCase[];
  spinner: SpinnerCase[];
  selector: SelectorCase[];
  toggle: ToggleCase[];
  slider: SliderCase[];
  radio: RadioCase[];
  panel: PanelScenario[];
}

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as WidgetVectors;

const r4 = (r: pygame.Rect): Rect4 => [r.x, r.y, r.w, r.h];

// ---------------------------------------------------------------------------
describe("widgets: module + battery non-triviality", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("widgets");
  });
  it("vector battery is non-trivial", () => {
    const n =
      vec.helpers.length +
      vec.geom.length +
      vec.spinner.length +
      vec.selector.length +
      vec.toggle.length +
      vec.slider.length +
      vec.radio.length +
      vec.panel.length;
    expect(n).toBeGreaterThan(40);
    expect(vec.panel.length).toBeGreaterThanOrEqual(7);
  });
});

describe("widgets: accel_of / plain", () => {
  for (let i = 0; i < vec.helpers.length; i++) {
    const c = vec.helpers[i];
    it(`#${i} ${JSON.stringify(c.s)}`, () => {
      expect(W.accel_of(c.s), `accel_of(${JSON.stringify(c.s)})`).toBe(c.accel);
      expect(W.plain(c.s), `plain(${JSON.stringify(c.s)})`).toBe(c.plain);
    });
  }
});

describe("widgets: constructor layout rects (DOM-free widgets)", () => {
  // Build each by name so we feed the EXACT ctor args the dumper used. The bound
  // cells are throwaway here (only .rect / sub-rects are exercised), but use the
  // typed accessors so the bindings match the widget signatures.
  const cN = () => new Cell(0);
  const cS = () => new Cell("");
  const cB = () => new Cell(false);
  const builders: { [name: string]: () => { rect: pygame.Rect; extra?: Partial<GeomCase> } } = {
    spinner_default: () => {
      const c = cN();
      return { rect: new W.Spinner(10, 20, "P", c.getN, c.setN, 0, 10).rect };
    },
    spinner_w: () => {
      const c = cN();
      return { rect: new W.Spinner(3, 4, "P", c.getN, c.setN, 0, 10, 1, String, 120).rect };
    },
    selector_default: () => {
      const c = cN();
      return { rect: new W.Selector(0, 0, "S", ["a", "b"], c.getN, c.setN).rect };
    },
    selector_w: () => {
      const c = cN();
      return { rect: new W.Selector(7, 9, "S", ["a"], c.getN, c.setN, 200).rect };
    },
    toggle_default: () => {
      const c = cB();
      return { rect: new W.Toggle(0, 0, "T", c.getB, c.setB).rect };
    },
    toggle_w: () => {
      const c = cB();
      return { rect: new W.Toggle(11, 13, "T", c.getB, c.setB, 180).rect };
    },
    textfield_default: () => {
      const c = cS();
      return { rect: new W.TextField(0, 0, "Name", c.getS, c.setS).rect };
    },
    textfield_custom: () => {
      const c = cS();
      const tf = new W.TextField(2, 3, "N", c.getS, c.setS, 4, 140, 40);
      return { rect: tf.rect, extra: { maxlen: tf.maxlen, label_w: tf.label_w } };
    },
    iconstrip_default: () => {
      const c = cN();
      const ic = new W.IconStrip(50, 60, [0, 1, 2, 3, 4], c.getN, c.setN);
      return { rect: ic.rect, extra: { cell: ic.cell } };
    },
    iconstrip_cell: () => {
      const c = cN();
      const ic = new W.IconStrip(0, 0, ["x", "y"], c.getN, c.setN, 20);
      return { rect: ic.rect, extra: { cell: ic.cell } };
    },
    slider_default: () => {
      const c = cN();
      const sl = new W.Slider(0, 0, "S", [0, 5, 10, 15, 20], c.getN, c.setN);
      return { rect: sl.rect, extra: { track_x: sl.track_x, track_w: sl.track_w } };
    },
    slider_w: () => {
      const c = cN();
      const sl = new W.Slider(8, 9, "S", [1, 2, 3], c.getN, c.setN, 100);
      return { rect: sl.rect, extra: { track_x: sl.track_x, track_w: sl.track_w } };
    },
    radio_grid: () => {
      const c = cN();
      const rg = new W.RadioGroup(100, 50, ["~A", "~B", "~C", "~D", "~E"], c.getN, c.setN, 2, 80, 18);
      return {
        rect: rg.rect,
        extra: { cells: [0, 1, 2, 3, 4].map((i) => r4(rg._cell_rect(i))), accels: rg.cell_accels },
      };
    },
    radio_col: () => {
      const c = cN();
      const rg = new W.RadioGroup(0, 0, ["~One", "~Two", "~Three"], c.getN, c.setN);
      return {
        rect: rg.rect,
        extra: { cells: [0, 1, 2].map((i) => r4(rg._cell_rect(i))), accels: rg.cell_accels },
      };
    },
    frame_plain: () => ({ rect: new W.Frame(5, 6, 40, 30, "Hello").rect }),
    frame_capture: () => ({ rect: new W.Frame(5, 6, 40, 30, "", true).rect }),
  };

  for (const g of vec.geom) {
    it(`${g.name}`, () => {
      const b = builders[g.name];
      expect(b, `missing builder for ${g.name}`).toBeTruthy();
      const { rect, extra } = b();
      expect(r4(rect), `${g.name} rect`).toEqual(g.rect);
      if (g.cells !== undefined) expect(extra?.cells, `${g.name} cells`).toEqual(g.cells);
      if (g.accels !== undefined) expect(extra?.accels, `${g.name} accels`).toEqual(g.accels);
      if (g.cell !== undefined) expect(extra?.cell, `${g.name} cell`).toBe(g.cell);
      if (g.maxlen !== undefined) expect(extra?.maxlen, `${g.name} maxlen`).toBe(g.maxlen);
      if (g.label_w !== undefined) expect(extra?.label_w, `${g.name} label_w`).toBe(g.label_w);
      if (g.track_x !== undefined) expect(extra?.track_x, `${g.name} track_x`).toBe(g.track_x);
      if (g.track_w !== undefined) expect(extra?.track_w, `${g.name} track_w`).toBe(g.track_w);
    });
  }
});

describe("widgets: hit-testing (Widget.hit / collidepoint / radio cells)", () => {
  for (const h of vec.hit) {
    it(`${h.name}`, () => {
      if (h.name === "widget_box" || h.name === "widget_disabled") {
        const w = new W.Widget(10, 5, 60, 20, "x");
        if (h.name === "widget_disabled") w.enabled = false;
        expect(h.grid.map((p) => w.hit(p)), `${h.name} hits`).toEqual(h.hits);
      } else if (h.name === "radio_hit") {
        const rcell = new Cell(0);
        const rg = new W.RadioGroup(20, 10, ["a", "b", "c", "d"], rcell.getN, rcell.setN, 2, 40, 15);
        expect(h.grid.map((p) => rg.hit(p)), "radio_hit hits").toEqual(h.hits);
        const cellOf = h.grid.map((p) => {
          for (let i = 0; i < 4; i++) {
            if (rg._cell_rect(i).collidepoint(p)) return i;
          }
          return null;
        });
        expect(cellOf, "radio_hit cell_of").toEqual(h.cell_of);
      } else if (h.name === "frame_capture_hit") {
        const fc = new W.Frame(0, 0, 30, 20, "", true);
        expect(h.grid.map((p) => fc.hit(p)), "frame_capture_hit").toEqual(h.hits);
      } else if (h.name === "frame_plain_hit") {
        const fn = new W.Frame(0, 0, 30, 20, "", false);
        expect(h.grid.map((p) => fn.hit(p)), "frame_plain_hit").toEqual(h.hits);
      } else {
        throw new Error(`unknown hit case ${h.name}`);
      }
    });
  }
});

describe("widgets: Spinner clamp / adjust / on_click", () => {
  for (let i = 0; i < vec.spinner.length; i++) {
    const s = vec.spinner[i];
    it(`#${i} start=${s.cfg.start} lo=${s.cfg.lo} hi=${s.cfg.hi} step=${s.cfg.step}`, () => {
      const cell = new Cell(s.cfg.start);
      const sp = new W.Spinner(0, 0, "P", cell.getN, cell.setN, s.cfg.lo, s.cfg.hi, s.cfg.step, String, 260);
      expect(sp.rect.centerx, "centerx").toBe(s.centerx);
      // clamps
      const clampIn = [-100, s.cfg.lo - 1, s.cfg.lo, 0, s.cfg.hi, s.cfg.hi + 1, 100];
      expect(clampIn.map((v) => sp._clamp(v)), "clamps").toEqual(s.clamps);
      // adjust walk
      const deltas = [+1, +1, +1, +1, +1, +1, -1, -1, -1, -1, -1, -1, +1, -1];
      const seq: number[] = [];
      for (const d of deltas) {
        sp.adjust(d);
        seq.push(cell.v as number);
      }
      expect(seq, "adjust_seq").toEqual(s.adjust_seq);
      // on_click battery
      const clickScript: [number, number][] = [
        [0, 1], [130, 1], [200, 1], [139, 1], [140, 1], [141, 1], [5, 3], [250, 3], [140, 3],
      ];
      for (let k = 0; k < clickScript.length; k++) {
        const [px, button] = clickScript[k];
        const ret = sp.on_click([px, 0], button);
        expect(ret, `click#${k} ret`).toBe(s.clicks[k].ret);
        expect(cell.v, `click#${k} val`).toBe(s.clicks[k].val);
      }
      for (let k = 0; k < s.accel.length; k++) {
        const ret = sp.on_accel();
        expect(ret, `accel#${k} ret`).toBe(s.accel[k].ret);
        expect(cell.v, `accel#${k} val`).toBe(s.accel[k].val);
      }
    });
  }
});

describe("widgets: Selector cycle / on_click", () => {
  for (let i = 0; i < vec.selector.length; i++) {
    const s = vec.selector[i];
    it(`#${i} opts=${JSON.stringify(s.opts)}`, () => {
      const cell = new Cell(0);
      const sel = new W.Selector(0, 0, "S", s.opts, cell.getN, cell.setN);
      const deltas = [+1, +1, +1, +1, -1, -1, -1, -1, -1, +1];
      const cyc: number[] = [];
      for (const d of deltas) {
        sel.cycle(d);
        cyc.push(cell.v as number);
      }
      expect(cyc, "cycle").toEqual(s.cycle);
      const buttons = [1, 1, 3, 3, 1];
      for (let k = 0; k < buttons.length; k++) {
        const ret = sel.on_click([0, 0], buttons[k]);
        expect(ret, `click#${k} ret`).toBe(s.clicks[k].ret);
        expect(cell.v, `click#${k} val`).toBe(s.clicks[k].val);
      }
      for (let k = 0; k < s.accel.length; k++) {
        const ret = sel.on_accel();
        expect(ret, `accel#${k} ret`).toBe(s.accel[k].ret);
        expect(cell.v, `accel#${k} val`).toBe(s.accel[k].val);
      }
    });
  }
});

describe("widgets: Toggle on_click / on_accel", () => {
  for (let i = 0; i < vec.toggle.length; i++) {
    const s = vec.toggle[i];
    it(`#${i} start=${s.start}`, () => {
      const cell = new Cell(s.start);
      const tg = new W.Toggle(0, 0, "T", cell.getB, cell.setB);
      let k = 0;
      for (let n = 0; n < 5; n++, k++) {
        const ret = tg.on_click([0, 0], 1);
        expect(ret, `seq#${k} ret`).toBe(s.seq[k].ret);
        expect(cell.v, `seq#${k} val`).toBe(s.seq[k].val);
      }
      for (let n = 0; n < 3; n++, k++) {
        const ret = tg.on_accel();
        expect(ret, `seq#${k} ret`).toBe(s.seq[k].ret);
        expect(cell.v, `seq#${k} val`).toBe(s.seq[k].val);
      }
    });
  }
});

describe("widgets: Slider x<->index (banker's round), thumb, set_index, drag", () => {
  for (let i = 0; i < vec.slider.length; i++) {
    const s = vec.slider[i];
    it(`#${i} values=${JSON.stringify(s.values)}`, () => {
      const cell = new Cell(s.values[0]);
      const sl = new W.Slider(0, 0, "S", s.values, cell.getN, cell.setN, 240);
      // _x_to_index (includes exact-half x -> round-half-to-even)
      for (let k = 0; k < s.x2i.length; k++) {
        expect(sl._x_to_index(s.x2i[k].x), `x2i x=${s.x2i[k].x}`).toBe(s.x2i[k].i);
      }
      // _cur_index (first-wins tie) + _thumb_x over probe values
      for (const e of s.cur) {
        cell.v = e.v;
        expect(sl._cur_index(), `cur v=${e.v}`).toBe(e.cur);
        expect(sl._thumb_x(), `thumb v=${e.v}`).toBe(e.thumb);
      }
      // _set_index clamp
      cell.v = s.values[0];
      const setI = [-3, -1, 0, 1, s.values.length - 1, s.values.length, 99];
      for (let k = 0; k < setI.length; k++) {
        sl._set_index(setI[k]);
        expect(cell.v, `set_index i=${setI[k]}`).toBe(s.set_index[k].val);
      }
      // on_click / on_drag / on_release script (must match the dumper's sequence)
      cell.v = s.values[0];
      sl.dragging = false;
      const script: [string, number[] | null, number | null][] = [
        ["click", [0, 0], 3],
        ["click", [224, 0], 1],
        ["click", [sl._thumb_x(), 0], 1],
        ["drag", [8, 0], null],
        ["drag", [224, 0], null],
        ["drag", [116, 0], null],
        ["release", null, null],
        ["drag", [0, 0], null],
        ["click", [60, 0], 1],
      ];
      for (let k = 0; k < script.length; k++) {
        const [kind, pos, button] = script[k];
        const want = s.clicks[k];
        if (kind === "click") {
          const ret = sl.on_click(pos as [number, number], button as number);
          expect(ret, `click#${k} ret`).toBe(want.ret);
        } else if (kind === "drag") {
          sl.on_drag(pos as [number, number]);
        } else if (kind === "release") {
          sl.on_release();
        }
        expect(cell.v, `${kind}#${k} val`).toBe(want.val);
        expect(sl.dragging, `${kind}#${k} dragging`).toBe(want.dragging);
      }
      // on_accel forward steps
      cell.v = s.values[0];
      for (let k = 0; k < s.accel.length; k++) {
        const ret = sl.on_accel();
        expect(ret, `accel#${k} ret`).toBe(s.accel[k].ret);
        expect(cell.v, `accel#${k} val`).toBe(s.accel[k].val);
      }
    });
  }
});

describe("widgets: RadioGroup accel_hit / on_click", () => {
  for (let i = 0; i < vec.radio.length; i++) {
    const s = vec.radio[i];
    it(`#${i} labels=${JSON.stringify(s.labels)}`, () => {
      const cell = new Cell(0);
      // cols/cell_w/cell_h: the dumper used per-set values; reconstruct from name set.
      const cfg =
        i === 0 ? { cols: 1, cw: 150, ch: 20 } : i === 1 ? { cols: 2, cw: 80, ch: 18 } : { cols: 1, cw: 100, ch: 16 };
      const rg = new W.RadioGroup(20, 10, s.labels, cell.getN, cell.setN, cfg.cols, cfg.cw, cfg.ch);
      // accel_hit over the same character battery
      const chars = "abcdefghijklmnopqrstuvwxyz0".split("");
      for (let k = 0; k < chars.length; k++) {
        cell.v = -1;
        const hit = rg.accel_hit(chars[k]);
        expect(hit, `accel_hit ${chars[k]} hit`).toBe(s.accel_hit[k].hit);
        expect(cell.v, `accel_hit ${chars[k]} val`).toBe(s.accel_hit[k].val);
      }
      // on_click cell centres + outside
      cell.v = 0;
      const pts: [number, number][] = [];
      for (let k = 0; k < s.labels.length; k++) {
        const cr = rg._cell_rect(k);
        pts.push([cr.x + 3, cr.y + 3]);
      }
      pts.push([20 + cfg.cw * cfg.cols + 50, 10]);
      for (let k = 0; k < pts.length; k++) {
        const ret = rg.on_click(pts[k], 1);
        expect(ret, `click#${k} ret`).toBe(s.clicks[k].ret);
        expect(cell.v, `click#${k} val`).toBe(s.clicks[k].val);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Panel.handle event router. Each scenario rebuilds the EXACT widget set the
// dumper used (DOM-free widgets + Cell bindings) and replays the same scripted
// events, asserting (returned action, focus, bound cells, transient flags,
// text/capture-widget index) after every event.
// ---------------------------------------------------------------------------
type Built = { panel: W.Panel; cells: Cell[] };

function snapshot(panel: W.Panel, cells: Cell[]): Omit<PanelStep, "step" | "ret"> {
  const flags: { [k: string]: boolean } = {};
  panel.widgets.forEach((w, i) => {
    if (w instanceof W.Slider) flags[`w${i}_dragging`] = w.dragging;
    if (w instanceof W.Frame) flags[`w${i}_arming`] = w.arming;
    if (w instanceof W.TextField) flags[`w${i}_editing`] = w.editing;
  });
  return {
    focus: panel.focus,
    cells: cells.map((c) => c.v),
    flags,
    text_widget: panel.text_widget ? panel.widgets.indexOf(panel.text_widget) : -1,
    capture_widget: panel.capture_widget ? panel.widgets.indexOf(panel.capture_widget) : -1,
  };
}

// Frame.set_key takes (v: unknown) => void; a Cell's setter is (x: CellVal) =>
// void. The capture path only ever stores a string ("G"/"5"/...) so the widen is
// safe; bridge it once here.
const setKeyOf = (cell: Cell): ((v: unknown) => void) => (v: unknown) => cell.set(v as CellVal);

function buildScenario(name: string): Built {
  if (name === "focus_walk_step_esc") {
    const p = new W.Panel(0, 0, 400, 300, "Cfg", false, "back");
    const cells = [new Cell(5), new Cell(0), new Cell(false), new Cell(0)];
    p.add(new W.Spinner(0, 0, "P", cells[0].getN, cells[0].setN, 0, 10, 2, String, 260));
    p.add(new W.Selector(0, 30, "S", ["x", "y", "z"], cells[1].getN, cells[1].setN));
    p.add(new W.Toggle(0, 60, "T", cells[2].getB, cells[2].setB));
    p.add(new W.RadioGroup(0, 90, ["~A", "~B", "~C"], cells[3].getN, cells[3].setN));
    return { panel: p, cells };
  }
  if (name === "mouse_click_outside_accel") {
    const p = new W.Panel(50, 40, 300, 200, "M", false, "back");
    const cells = [new Cell(5), new Cell(0), new Cell(false)];
    p.add(new W.Spinner(60, 50, "~Power", cells[0].getN, cells[0].setN, 0, 10, 1, String, 260));
    p.add(new W.Selector(60, 80, "~Type", ["x", "y", "z"], cells[1].getN, cells[1].setN));
    p.add(new W.Toggle(60, 110, "~Sound", cells[2].getB, cells[2].setB));
    return { panel: p, cells };
  }
  if (name === "no_cancel") {
    const p = new W.Panel(10, 10, 200, 100, "NC", true, "back");
    const cells = [new Cell(0)];
    p.add(new W.Selector(20, 20, "S", ["a", "b"], cells[0].getN, cells[0].setN));
    return { panel: p, cells };
  }
  if (name === "slider_drag") {
    const p = new W.Panel(0, 0, 300, 120, "SL");
    const cells = [new Cell(0)];
    p.add(new W.Slider(0, 0, "S", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], cells[0].getN, cells[0].setN, 240));
    return { panel: p, cells };
  }
  if (name === "textfield_edit") {
    const p = new W.Panel(0, 0, 300, 80, "TF");
    const cells = [new Cell("")];
    p.add(new W.TextField(0, 0, "N", cells[0].getS, cells[0].setS, 3, 240, 40));
    return { panel: p, cells };
  }
  if (name === "frame_capture") {
    const p = new W.Panel(0, 0, 200, 120, "KEY");
    const cells = [new Cell("?")];
    p.add(new W.Frame(0, 0, 60, 30, "", true, cells[0].get, setKeyOf(cells[0])));
    p.add(new W.Frame(0, 40, 60, 30, "", true, cells[0].get, setKeyOf(cells[0])));
    return { panel: p, cells };
  }
  if (name === "panel_radio_accel") {
    const p = new W.Panel(0, 0, 200, 120, "RG");
    const cells = [new Cell(0), new Cell(false)];
    p.add(new W.RadioGroup(0, 0, ["~Red", "~Green", "~Blue"], cells[0].getN, cells[0].setN));
    p.add(new W.Toggle(0, 70, "~Done", cells[1].getB, cells[1].setB));
    return { panel: p, cells };
  }
  throw new Error(`unknown panel scenario ${name}`);
}

// Replay scripts -- mirror the dumper's per-scenario event lists exactly.
function scriptFor(name: string): W.PygameEvent[] {
  const kd = (key: number, unicode: string): W.PygameEvent => ({ type: KD, key, unicode });
  const md = (pos: [number, number], button: number): W.PygameEvent => ({ type: MD, pos, button });
  const mm = (pos: [number, number]): W.PygameEvent => ({ type: MM, pos });
  const mu = (pos: [number, number], button: number): W.PygameEvent => ({ type: MU, pos, button });
  switch (name) {
    case "focus_walk_step_esc":
      return [
        kd(pygame.K_TAB, "\t"),
        kd(pygame.K_DOWN, ""),
        kd(pygame.K_DOWN, ""),
        kd(pygame.K_DOWN, ""),
        kd(pygame.K_UP, ""),
        kd(pygame.K_UP, ""),
        kd(pygame.K_RIGHT, ""),
        kd(pygame.K_RIGHT, ""),
        kd(pygame.K_LEFT, ""),
        kd(pygame.K_TAB, "\t"),
        kd(pygame.K_RIGHT, ""),
        kd(pygame.K_LEFT, ""),
        kd(pygame.K_TAB, "\t"),
        kd(pygame.K_SPACE, " "),
        kd(pygame.K_TAB, "\t"),
        kd(pygame.K_RIGHT, ""),
        kd(pygame.K_RIGHT, ""),
        kd(pygame.K_RIGHT, ""),
        kd(pygame.K_LEFT, ""),
        kd(pygame.K_ESCAPE, "\x1b"),
      ];
    case "mouse_click_outside_accel":
      return [
        md([100, 55], 1),
        md([250, 55], 1),
        md([100, 55], 3),
        md([70, 85], 1),
        md([70, 85], 3),
        md([70, 115], 1),
        md([5, 5], 1),
        kd(pygame.K_p, "p"),
        kd(pygame.K_t, "t"),
        kd(pygame.K_s, "s"),
        kd(pygame.K_z, "z"),
      ];
    case "no_cancel":
      return [kd(pygame.K_ESCAPE, "\x1b"), md([0, 0], 1), md([25, 25], 1)];
    case "slider_drag":
      return [
        md([8, 20], 1),
        mm([116, 20]),
        mm([224, 20]),
        mu([224, 20], 1),
        mm([8, 20]),
        kd(pygame.K_LEFT, ""),
        kd(pygame.K_RIGHT, ""),
        md([60, 20], 3),
      ];
    case "textfield_edit":
      return [
        md([50, 5], 1),
        kd(pygame.K_a, "a"),
        kd(pygame.K_b, "b"),
        kd(pygame.K_c, "c"),
        kd(pygame.K_d, "d"),
        kd(pygame.K_BACKSPACE, "\b"),
        kd(pygame.K_RETURN, "\r"),
        kd(pygame.K_a, "a"),
      ];
    case "frame_capture":
      return [
        md([10, 10], 1),
        kd(pygame.K_g, "g"),
        md([10, 50], 1),
        kd(pygame.K_ESCAPE, "\x1b"),
        md([10, 10], 1),
        kd(pygame.K_5, "5"),
      ];
    case "panel_radio_accel":
      return [
        kd(pygame.K_g, "g"),
        kd(pygame.K_b, "b"),
        kd(pygame.K_r, "r"),
        kd(pygame.K_d, "d"),
        kd(pygame.K_x, "x"),
      ];
    default:
      throw new Error(`unknown panel scenario ${name}`);
  }
}

describe("widgets: Panel.handle event router", () => {
  for (const scenario of vec.panel) {
    it(`${scenario.name}`, () => {
      const { panel, cells } = buildScenario(scenario.name);
      const script = scriptFor(scenario.name);
      expect(script.length, `${scenario.name} script length`).toBe(scenario.log.length - 1);

      // step -1 is the initial snapshot (no event handled).
      const init = scenario.log[0];
      const s0 = snapshot(panel, cells);
      expect(s0.focus, `${scenario.name} init focus`).toBe(init.focus);
      expect(s0.cells, `${scenario.name} init cells`).toEqual(init.cells);
      expect(s0.flags, `${scenario.name} init flags`).toEqual(init.flags);

      for (let i = 0; i < script.length; i++) {
        const want = scenario.log[i + 1];
        const ret = panel.handle(script[i]);
        const got = snapshot(panel, cells);
        const lbl = `${scenario.name} ev#${i}`;
        expect(ret, `${lbl} ret`).toBe(want.ret);
        expect(got.focus, `${lbl} focus`).toBe(want.focus);
        expect(got.cells, `${lbl} cells`).toEqual(want.cells);
        expect(got.flags, `${lbl} flags`).toEqual(want.flags);
        expect(got.text_widget, `${lbl} text_widget`).toBe(want.text_widget);
        expect(got.capture_widget, `${lbl} capture_widget`).toBe(want.capture_widget);
      }
    });
  }
});

/**
 * DOM-free logic gate for src/widgets.ts -- the behavior the differential vector
 * gate (test/widgets.test.ts) does not reach because it scripts only value/focus
 * widgets through Panel.handle.
 *
 * This covers the remaining NON-DRAW, NON-DOM logic against the oracle
 * scorch/widgets.py (read directly, line cites below):
 *   - font() memoization (the Font ctor is DOM-free; only .size/.render need a
 *     Canvas, which these tests never call);
 *   - Widget base on_click/on_accel/draw (widgets.py:93-99);
 *   - IconStrip.on_click cell-index math (widgets.py:289);
 *   - TextField.on_text_key TAB/ESCAPE exits, the maxlen guard, the
 *     str.isprintable() reject, backspace-on-empty (widgets.py:261-266);
 *   - Frame.on_click non-capture return + take_key event.key fallback + null
 *     set_key (widgets.py:458-465);
 *   - Panel._focusables skipping a decorative Frame and the empty-focusables
 *     keypress path; arrow-stepping a focused Spinner (widgets.py:344-/handle);
 *   - draw_cursor + setCursorProvider/setMousePosProvider hotspot math and the
 *     build-once cache (widgets.py:628-641).
 *
 * The .draw() methods, _draw_accel_text, and the Label/Button constructors are
 * NOT here: they call pygame.font/draw/blit (Canvas2D), so they belong to the
 * Phase-3 visual gate (the module's pixelsDeferredToPhase3 stance). DOM is never
 * constructed in this file.
 */
import { describe, it, expect, vi } from "vitest";
import * as W from "../src/widgets";
import * as pygame from "../src/pygame";

// A tiny mutable binding cell (the get/set seam every value widget takes).
class NumCell {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
  get = (): number => this.v;
  set = (x: number): void => {
    this.v = x;
  };
}
class StrCell {
  v: string;
  constructor(v: string) {
    this.v = v;
  }
  get = (): string => this.v;
  set = (x: string): void => {
    this.v = x;
  };
}

const kd = (key: number, unicode = ""): W.PygameEvent => ({ type: pygame.KEYDOWN, key, unicode });

// ===========================================================================
// font() memoization (DOM-free: Font ctor only stores strings)
// ===========================================================================
describe("widgets.font() cache", () => {
  it("memoizes by (size,bold) and returns a pygame.Font with those metrics", () => {
    const a = W.font(15, false);
    expect(a).toBeInstanceOf(pygame.font.Font);
    expect(a.size_px).toBe(15);
    expect(a.bold).toBe(false);
    expect(W.font(15, false)).toBe(a); // same key -> cached identity
    expect(W.font(15, true)).not.toBe(a); // bold differs
    expect(W.font(16, false)).not.toBe(a); // size differs
    expect(W.font(15, true).bold).toBe(true);
  });
});

// ===========================================================================
// Widget base methods (widgets.py:93-99)
// ===========================================================================
describe("widgets.Widget base", () => {
  it("on_click and on_accel fire the action; base draw is inert", () => {
    const w = new W.Widget(0, 0, 10, 10, "L", "ACT");
    expect(w.on_click([1, 1], 1)).toBe("ACT");
    expect(w.on_accel()).toBe("ACT");
    expect(w.draw(null as unknown as pygame.Surface)).toBeUndefined(); // no-op, no DOM touched
  });

  it("a widget with no action returns null from on_click/on_accel", () => {
    const w = new W.Widget(0, 0, 10, 10, "L");
    expect(w.on_click([1, 1], 1)).toBeNull();
    expect(w.on_accel()).toBeNull();
  });

  it("hit respects enabled + bounds (right/bottom exclusive)", () => {
    const w = new W.Widget(10, 5, 60, 20, "x");
    expect(w.hit([10, 5])).toBe(true);
    expect(w.hit([69, 24])).toBe(true);
    expect(w.hit([70, 5])).toBe(false); // right edge exclusive
    w.enabled = false;
    expect(w.hit([10, 5])).toBe(false);
  });
});

// ===========================================================================
// IconStrip.on_click -- floor((x - rect.x)/cell), guarded 0..len (widgets.py:289)
// ===========================================================================
describe("widgets.IconStrip.on_click", () => {
  it("maps x to the cell index and selects it; out-of-strip clicks are ignored", () => {
    const sel = new NumCell(0);
    const strip = new W.IconStrip(50, 60, [0, 1, 2, 3, 4], sel.get, sel.set, 34);

    expect(strip.on_click([50, 60], 1)).toBeNull();
    expect(sel.v).toBe(0); // first cell
    strip.on_click([84, 60], 1); // 50 + 34
    expect(sel.v).toBe(1);
    strip.on_click([157, 60], 1); // 50 + 3*34 + 5 -> floor(107/34)=3
    expect(sel.v).toBe(3);

    // left of the strip -> floor(negative) < 0 -> no selection change
    strip.on_click([40, 60], 1);
    expect(sel.v).toBe(3);
    // past the last cell -> i == len -> no selection change
    strip.on_click([50 + 5 * 34 + 1, 60], 1);
    expect(sel.v).toBe(3);
  });
});

// ===========================================================================
// TextField.on_text_key -- editor key handling (widgets.py:261-266)
// ===========================================================================
describe("widgets.TextField.on_text_key", () => {
  function tf(initial = "", maxlen = 3): { t: W.TextField; cell: StrCell } {
    const cell = new StrCell(initial);
    return { t: new W.TextField(0, 0, "N", cell.get, cell.set, maxlen), cell };
  }

  it("TAB and ESCAPE end editing without mutating the value", () => {
    const { t, cell } = tf("ab");
    t.editing = true;
    t.on_text_key(kd(pygame.K_TAB, "\t"));
    expect(t.editing).toBe(false);
    expect(cell.v).toBe("ab");

    t.editing = true;
    t.on_text_key(kd(pygame.K_ESCAPE, "\x1b"));
    expect(t.editing).toBe(false);
    expect(cell.v).toBe("ab");
  });

  it("appends a printable char only while under maxlen", () => {
    const { t, cell } = tf("ab", 3);
    t.on_text_key({ type: pygame.KEYDOWN, key: 0, unicode: "c" });
    expect(cell.v).toBe("abc");
    t.on_text_key({ type: pygame.KEYDOWN, key: 0, unicode: "d" }); // at maxlen -> rejected
    expect(cell.v).toBe("abc");
  });

  it("rejects a non-printable (control) char (str.isprintable() guard)", () => {
    const { t, cell } = tf("", 5);
    t.on_text_key({ type: pygame.KEYDOWN, key: 0, unicode: "\x01" });
    expect(cell.v).toBe("");
  });

  it("backspace drops the last char and is a no-op on empty", () => {
    const { t, cell } = tf("x", 5);
    t.on_text_key(kd(pygame.K_BACKSPACE, "\b"));
    expect(cell.v).toBe("");
    t.on_text_key(kd(pygame.K_BACKSPACE, "\b")); // already empty
    expect(cell.v).toBe("");
  });
});

// ===========================================================================
// Frame.on_click / take_key (widgets.py:458-465)
// ===========================================================================
describe("widgets.Frame capture", () => {
  it("a non-capture frame's on_click returns null; a capture frame arms", () => {
    expect(new W.Frame(0, 0, 10, 10, "t", false).on_click([1, 1], 1)).toBeNull();
    const fc = new W.Frame(0, 0, 10, 10, "", true);
    expect(fc.on_click([1, 1], 1)).toBe("capture_key");
    expect(fc.arming).toBe(true);
  });

  it("take_key stores unicode.upper() when present, else falls back to event.key", () => {
    const stored: unknown[] = [];
    const fr = new W.Frame(0, 0, 10, 10, "", true, () => null, (v) => stored.push(v));
    fr.arming = true;
    fr.take_key({ type: pygame.KEYDOWN, key: 9, unicode: "g" });
    expect(stored.at(-1)).toBe("G");
    expect(fr.arming).toBe(false);

    fr.arming = true;
    fr.take_key({ type: pygame.KEYDOWN, key: 42, unicode: "" }); // no unicode -> raw key
    expect(stored.at(-1)).toBe(42);
    expect(fr.arming).toBe(false);
  });

  it("take_key with a null set_key is a no-op that still disarms", () => {
    const fr = new W.Frame(0, 0, 10, 10, "", true, null, null);
    fr.arming = true;
    expect(() => fr.take_key({ type: pygame.KEYDOWN, key: 5, unicode: "x" })).not.toThrow();
    expect(fr.arming).toBe(false);
  });
});

// ===========================================================================
// Panel: decorative-Frame skip in _focusables + empty-focusables keypress +
// arrow-stepping a focused Spinner (the handle paths the vector gate misses)
// ===========================================================================
describe("widgets.Panel handle (focus + value paths)", () => {
  it("a decorative (non-capture) Frame is not focusable; keypresses with no focusables return null", () => {
    const p = new W.Panel(0, 0, 200, 120, "Box");
    p.add(new W.Frame(0, 0, 50, 30, "Group", false)); // decorative -> skipped by _focusables
    expect(p.handle(kd(pygame.K_TAB))).toBeNull();
    expect(p.focus).toBe(0); // focus walk over an empty focusable set stays put
    expect(p.handle(kd(pygame.K_SPACE, " "))).toBeNull(); // empty-focusables activate path
  });

  it("LEFT/RIGHT arrow-steps a focused Spinner", () => {
    const cell = new NumCell(4);
    const p = new W.Panel(0, 0, 200, 120, "Cfg");
    p.add(new W.Spinner(0, 0, "P", cell.get, cell.set, 0, 10, 2));
    expect(p.handle(kd(pygame.K_RIGHT))).toBeNull();
    expect(cell.v).toBe(6); // 4 + step(2)
    expect(p.handle(kd(pygame.K_LEFT))).toBeNull();
    expect(cell.v).toBe(4); // back down a step
  });
});

// ===========================================================================
// draw_cursor + providers (widgets.py:628-641). No real Surface: a fake target
// records its blit args; a fake provider returns a stand-in cursor sprite. These
// `it`s SHARE module-level provider state and run in definition order: the no-op
// case (neither provider set) MUST be asserted before any provider is installed.
// ===========================================================================
describe("widgets.draw_cursor", () => {
  type BlitCall = { args: unknown[] };
  function fakeSurf(): { blit: ReturnType<typeof vi.fn>; calls: BlitCall[] } {
    const calls: BlitCall[] = [];
    const blit = vi.fn((...args: unknown[]) => {
      calls.push({ args });
    });
    return { blit, calls };
  }

  it("is a no-op until BOTH providers are set", () => {
    const s = fakeSurf();
    W.draw_cursor(s as unknown as pygame.Surface);
    expect(s.blit).not.toHaveBeenCalled();
  });

  it("blits the cursor sprite at (mouse - hotspot) and builds the sprite once", () => {
    const cursorSprite = { tag: "cursor" } as unknown as pygame.Surface;
    let built = 0;
    let mouse: [number, number] = [100, 60];
    W.setCursorProvider((rgb, scale) => {
      built++;
      expect(rgb).toEqual([255, 255, 255]); // draw_cursor asks for the white pointer
      expect(scale).toBe(1);
      return [cursorSprite, [3, 5]];
    });
    W.setMousePosProvider(() => mouse);

    const s = fakeSurf();
    W.draw_cursor(s as unknown as pygame.Surface);
    expect(built).toBe(1);
    expect(s.calls[0].args[0]).toBe(cursorSprite);
    expect(s.calls[0].args[1]).toEqual([97, 55]); // [100-3, 60-5]

    // cursor follows the mouse; sprite is cached (build count stays 1)
    mouse = [10, 20];
    W.draw_cursor(s as unknown as pygame.Surface);
    expect(built).toBe(1);
    expect(s.calls[1].args[1]).toEqual([7, 15]); // [10-3, 20-5]
  });

  it("setCursorProvider resets the build cache so a new provider rebuilds", () => {
    const sprite2 = { tag: "cursor2" } as unknown as pygame.Surface;
    let built2 = 0;
    W.setCursorProvider(() => {
      built2++;
      return [sprite2, [0, 0]];
    });
    // mouse provider from the previous test is still installed
    const s = fakeSurf();
    W.draw_cursor(s as unknown as pygame.Surface);
    expect(built2).toBe(1); // cache was invalidated by setCursorProvider
    expect(s.calls[0].args[0]).toBe(sprite2);
  });
});

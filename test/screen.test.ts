/**
 * Differential gate: TS Screen base class == Python scorch.screen.Screen.
 *
 * screen.py is a pure base/interface (38 lines): a class with an `opaque` flag
 * defaulting True and three methods (handle/update/draw) that the base leaves as
 * no-ops returning None.  There is no math, no state mutation, and no pixel
 * output in the BASE class -- the drawing lives in the subclasses (screens.ts /
 * main.ts / ingame.ts), which are separate modules and are NOT under test here.
 *
 * So the only numerically/behaviorally testable surface of THIS module is the
 * base contract, and that is what oracle/dump_screen.py records and this test
 * asserts, byte-for-byte:
 *   - `opaque` defaults to true (the recovered getattr(screen, "opaque", True)
 *     default the driver relies on -- main.py:74,400,696),
 *   - handle(event) returns null for every event in the battery,
 *   - update(dt) returns null for every dt in the battery,
 *   - draw(surf) returns nothing (Python None == TS undefined).
 *
 * EPSILON POLICY: every recorded value is a bool or null (None) -- there is no
 * float anywhere on this path -- so all assertions are EXACT (.toBe). No
 * epsilon is used.
 *
 * DOM / PIXELS: pygame.Surface cannot be constructed under Node (it needs a DOM;
 * see src/pygame.ts header), and the base draw() never touches its surface arg
 * (its body is `return;`).  So draw() is exercised with a null surface cast to
 * the Surface type -- this validates the base's return contract WITHOUT a DOM.
 * The literal pixels any drawing SUBCLASS produces are out of scope here and are
 * validated by the Phase-3 visual gate; the base class draws nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { Screen } from "../src/screen";
import type { ScreenEvent } from "../src/screen";
import type * as pygame from "../src/pygame";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, "..", "oracle", "vectors", "screen.json");

type HandleCase = { event: ScreenEvent; out: string | null };
type UpdateCase = { dt: number; out: string | null };
type ScreenVectors = {
  module: string;
  opaque_class: boolean;
  opaque_instance: boolean;
  opaque_default: boolean;
  handle: HandleCase[];
  update: UpdateCase[];
  draw_returns_none: boolean;
};

const vec = JSON.parse(readFileSync(VECTORS, "utf-8")) as ScreenVectors;

describe("screen: oracle invariants", () => {
  it("module tag matches the dumper", () => {
    expect(vec.module).toBe("screen");
  });
  it("vector battery is present (handle + update cases recorded)", () => {
    expect(vec.handle.length).toBeGreaterThan(0);
    expect(vec.update.length).toBeGreaterThan(0);
  });
});

describe("screen: Screen base `opaque` default", () => {
  it("defaults to true, matching the Python class attribute and getattr default", () => {
    // The driver reads getattr(screen, "opaque", True); the base must supply true
    // so an un-overridden screen is opaque (main.py:74,400,696).
    const s = new Screen();
    expect(s.opaque).toBe(vec.opaque_instance);
    expect(s.opaque).toBe(vec.opaque_class);
    expect(s.opaque).toBe(vec.opaque_default);
    expect(s.opaque).toBe(true);
  });

  it("is an own/instance-visible field a subclass can override (false), like Python", () => {
    // Subclasses set `opaque = false` for modal/overlay screens (screens.py:576,
    // main.py:290). Confirm the field is overridable per-instance/subclass.
    class Modal extends Screen {
      opaque = false;
    }
    expect(new Modal().opaque).toBe(false);
    // Base instances are unaffected (no shared-mutable-state leak).
    expect(new Screen().opaque).toBe(true);
  });
});

describe("screen: Screen.handle returns null for every battery event", () => {
  for (let i = 0; i < vec.handle.length; i++) {
    const c = vec.handle[i];
    it(`#${i} type=${c.event.type} -> ${JSON.stringify(c.out)}`, () => {
      const s = new Screen();
      // The base ignores the event; assert it equals the oracle (null) and that
      // the oracle itself recorded null (the base never returns an action).
      expect(c.out).toBe(null);
      expect(s.handle(c.event)).toBe(c.out);
    });
  }
});

describe("screen: Screen.update returns null for every battery dt", () => {
  for (let i = 0; i < vec.update.length; i++) {
    const c = vec.update[i];
    it(`#${i} dt=${c.dt} -> ${JSON.stringify(c.out)}`, () => {
      const s = new Screen();
      expect(c.out).toBe(null);
      expect(s.update(c.dt)).toBe(c.out);
    });
  }
});

describe("screen: Screen.draw returns nothing (None == undefined), no DOM needed", () => {
  it("draw(surf) returns undefined and never touches the surface in the base", () => {
    expect(vec.draw_returns_none).toBe(true);
    const s = new Screen();
    // The base draw() body is `return;` and never dereferences its arg, so a null
    // surface (cast to the Surface type) exercises the real method without a DOM.
    // A throw here would mean the base unexpectedly touched the surface.
    const out = s.draw(null as unknown as pygame.Surface);
    expect(out).toBeUndefined();
  });
});

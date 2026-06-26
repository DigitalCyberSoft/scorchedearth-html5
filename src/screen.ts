/**
 * Screen protocol for the mouse-driven out-of-game UI -- a faithful TypeScript
 * port of scorch-py/scorch/screen.py (the fidelity oracle).
 *
 * main.ts drives a STACK of screens.  Each screen:
 *   - handle(event) -> null, or an action string the driver acts on
 *         ('pop', 'push:sound', 'start_game', 'shop_done', ...).
 *         The convention for opening a submenu screen is 'push:<name>'.
 *         A panel screen returns 'pop' on Done/Esc/click-outside.
 *   - update(dt)    -> advance any animation/timers (no-op for static panels).
 *   - draw(surf)    -> render onto the logical surface, dimming/overlaying the
 *         background as appropriate (a modal panel dims behind itself).
 *
 * The action string is a thin contract; the driver (main.ts) owns stack
 * push/pop and any data hand-off.  Screens never call back into main directly.
 *
 * NUMERIC NOTE: this is a pure base/interface -- the three methods are no-ops
 * returning null and `opaque` is a flag.  There is no math, no state mutation,
 * and no pixel output in the base class itself (subclasses in screens.ts /
 * main.ts / ingame.ts do the drawing).  The differential gate
 * (test/screen.test.ts) therefore asserts only the base contract: the three
 * methods return null and `opaque` defaults to true, byte-for-byte with the
 * Python base class.
 */

import type * as pygame from "./pygame";

/**
 * A pygame-shaped UI event as main.ts builds it from a DOM event
 * (see pygame.keyToPygame / mouseButtonToPygame): a `type` from the
 * MOUSEBUTTONDOWN/MOUSEMOTION/KEYDOWN/... family plus the fields the handler
 * for that type reads (pos/button for mouse, key/mod/unicode for keys). The
 * base Screen ignores the event entirely; the type is here so subclass
 * signatures (and the driver) share one shape.  Kept permissive (extra fields
 * allowed) because each event type carries a different field subset, exactly as
 * pygame's event object does.
 */
export interface ScreenEvent {
  type: number;
  pos?: [number, number];
  button?: number;
  key?: number;
  mod?: number;
  unicode?: string;
  [extra: string]: unknown;
}

/**
 * The action string a screen returns from handle(), or null for "nothing
 * happened" (the Python contract: `return None` or an action string the driver
 * acts on).  Typed as `string | null` rather than a closed enum because the set
 * of actions is open ('pop', 'start_game', 'push:<name>', 'shop_done', ...) and
 * the driver parses it as a thin string protocol, matching screen.py.
 */
export type ScreenAction = string | null;

/**
 * Base screen.  Subclasses override handle/update/draw (and set `opaque`).
 *
 * `opaque` tells the driver whether the screens beneath need redrawing first:
 * a full-bleed screen (Main Menu) is opaque; a modal dialog is not (it dims
 * whatever is under it).
 *
 * Python expresses `opaque` as a class attribute (`opaque = True`) that
 * instances inherit and subclasses override (`opaque = False`); the driver
 * reads it as `getattr(screen, "opaque", True)` (main.py:74,400,696).  The
 * faithful TS mapping is an instance field defaulting to true, which every
 * instance carries and subclasses override the same way -- so `screen.opaque`
 * in the TS driver is exactly the recovered `getattr(..., "opaque", True)`.
 */
export class Screen {
  /** True = full-bleed (driver may skip redrawing below); false = modal/overlay. */
  opaque = true;

  /** Process one pygame event.  Return null or an action string. */
  handle(_event: ScreenEvent): ScreenAction {
    return null;
  }

  /** Advance time-based state.  dt is seconds since last frame. */
  update(_dt: number): ScreenAction {
    return null;
  }

  /** Render onto the logical surface `surf`. */
  draw(_surf: pygame.Surface): void {
    return;
  }
}

/**
 * Unit gate for the PURE, DOM-free helpers of the src/pygame.ts SDL shim.
 *
 * pygame.ts is the Canvas/Web-Audio replacement for pygame; most of it (Surface,
 * draw, surfarray) needs a real DOM and is exercised by the browser-render harness
 * (test-browser/) -- NOT here.  But keyToPygame() is pure: it maps a DOM
 * KeyboardEvent's {code,key} to the SDL keycode main.ts's input pump pushes onto its
 * event queue (main.ts:1238).  There is no Python oracle for the shim layer (it
 * stands in for SDL itself), so the ground truth is the SDL keysym definition:
 * printable ASCII keys carry their ASCII codepoint as the keycode (SDLK_a == 97 ==
 * 'a', SDLK_0 == 48, SDLK_SPACE == 32, SDLK_MINUS == 45, '[' == 91, ']' == 93).
 *
 * The browser harness only ever feeds keys whose physical `code` is in CODE_TO_SDL
 * (Enter / ArrowUp / Space / ...), so the `e.key`-based single-character fallback
 * (pygame.ts:1147-1156) -- the path that resolves a letter/digit typed at a name
 * field, or a key whose code the table lacks -- is never reached by the harness.
 * This gate drives exactly that fallback.  Every assertion is an exact integer
 * keycode; a drift (e.g. returning the uppercase ASCII for a letter, or 0 for a
 * digit) would corrupt in-game text + key handling, so each is meaningful.
 */
import { describe, it, expect } from "vitest";
import * as pygame from "../src/pygame";

// A minimal DOM-KeyboardEvent stand-in: keyToPygame only reads .code and .key.
// An EMPTY code is intentionally absent from CODE_TO_SDL, forcing the e.key path.
function ev(key: string, code = ""): KeyboardEvent {
  return { key, code } as unknown as KeyboardEvent;
}

describe("pygame.keyToPygame: single-character e.key fallback (SDL ASCII keycodes)", () => {
  it("maps a..z to their lowercase-ASCII keycode (97..122)", () => {
    for (let cc = 97; cc <= 122; cc++) {
      const ch = String.fromCharCode(cc);
      expect(pygame.keyToPygame(ev(ch)), `key '${ch}'`).toBe(cc);
    }
  });

  it("lowercases an UPPERCASE letter to the same keycode (k.toLowerCase())", () => {
    for (let cc = 65; cc <= 90; cc++) {
      const upper = String.fromCharCode(cc);
      expect(pygame.keyToPygame(ev(upper)), `key '${upper}'`).toBe(cc + 32);
    }
    expect(pygame.keyToPygame(ev("A"))).toBe(pygame.K_a);
    expect(pygame.keyToPygame(ev("Z"))).toBe(pygame.K_z);
  });

  it("maps 0..9 to their ASCII keycode (48..57)", () => {
    for (let cc = 48; cc <= 57; cc++) {
      const ch = String.fromCharCode(cc);
      expect(pygame.keyToPygame(ev(ch)), `digit '${ch}'`).toBe(cc);
    }
    expect(pygame.keyToPygame(ev("0"))).toBe(pygame.K_0);
    expect(pygame.keyToPygame(ev("9"))).toBe(pygame.K_9);
  });

  it("maps the punctuation the menus accept (space/-/[/]) when the code is unknown", () => {
    // key=" " with a code NOT equal to "Space" exercises the 1152 branch, not byCode.
    expect(pygame.keyToPygame(ev(" ")), "space").toBe(pygame.K_SPACE);
    expect(pygame.keyToPygame(ev("-")), "minus").toBe(pygame.K_MINUS);
    expect(pygame.keyToPygame(ev("[")), "bracket-left").toBe(pygame.K_LEFTBRACKET);
    expect(pygame.keyToPygame(ev("]")), "bracket-right").toBe(pygame.K_RIGHTBRACKET);
  });

  it("returns 0 for a single character outside the handled sets (fall-through)", () => {
    for (const ch of ["!", "/", "=", "@", "."]) {
      expect(pygame.keyToPygame(ev(ch)), `unhandled '${ch}'`).toBe(0);
    }
  });

  it("returns 0 for a multi-character key whose code is unmapped (length != 1)", () => {
    expect(pygame.keyToPygame(ev("Shift", "ShiftLeft")), "Shift").toBe(0);
    expect(pygame.keyToPygame(ev("Dead", "Unidentified")), "Dead").toBe(0);
  });

  it("still resolves a known physical code BEFORE the e.key fallback (precedence)", () => {
    // byCode wins even when e.key would also map: Enter -> K_RETURN, not the 'E' path.
    expect(pygame.keyToPygame(ev("Enter", "Enter")), "Enter").toBe(pygame.K_RETURN);
    expect(pygame.keyToPygame(ev(" ", "Space")), "Space code").toBe(pygame.K_SPACE);
  });
});

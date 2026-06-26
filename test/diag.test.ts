/**
 * Real-path gate for src/diag.ts -- the browser diagnostics layer (the analog of
 * scorch/diag.py, reduced to the browser's only sink: console.*).
 *
 * diag.ts has NO numeric oracle vector (its Python analog's outputs are log lines
 * and thread stacks -- environment artifacts, not game state; see the module
 * header). So this asserts against the module's DOCUMENTED CONTRACT and the
 * Python source behavior read from scorch/diag.py:
 *   - ConsoleLog level gate + printf-style %s/%d/%i/%f/%r/%% substitution (_fmt),
 *     None/undefined rendering (_str), captured off a console.* spy;
 *   - setup_logging / install_faulthandler / heartbeat / cancel_hang_watchdog
 *     (the no-ops that keep main.ts reading 1:1 with main.py);
 *   - FrameWatchdog slow-frame detection (timing mocked via performance.now);
 *   - log_exception (records + never suppresses) and state_snapshot (defensive,
 *     never throws) -- exact one-line crash summary;
 *   - FrameSampler env-gated FPS window emit, and the _now_ms Date.now fallback.
 *
 * One DIVERGENCE from diag.py is asserted-and-noted, not papered over: TS _str
 * renders booleans lowercase ("alive=true"), Python "%s" renders them Title-case
 * ("alive=True"). state_snapshot is a diagnostic log line (the carved-out
 * environment-artifact category), so the TS value is asserted as the contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as diag from "../src/diag";

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  diag.log.setLevel(20); // reset the module-singleton logger to INFO between tests
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===========================================================================
// 1. ConsoleLog._fmt -- printf-style substitution (captured via log.info)
// ===========================================================================
describe("diag.log _fmt printf substitution", () => {
  const lastInfo = (): string => String(infoSpy.mock.calls.at(-1)?.[0]);

  it("%s and %d substitute the string / truncated-int", () => {
    diag.log.info("%s=%d", "hp", 42);
    expect(lastInfo()).toBe("scorch: hp=42");
  });

  it("%i truncates toward zero; %f stringifies the number", () => {
    diag.log.info("%i %f", 3.9, 2.5);
    expect(lastInfo()).toBe("scorch: 3 2.5");
  });

  it("%r stringifies (no Python repr) and %% is a literal percent", () => {
    diag.log.info("%r and %%", { a: 1 });
    expect(lastInfo()).toBe("scorch: [object Object] and %");
  });

  it("a missing arg leaves the spec literal", () => {
    diag.log.info("%s %s", "only");
    expect(lastInfo()).toBe("scorch: only %s");
  });

  it("unconsumed args are appended space-separated", () => {
    diag.log.info("%s", "a", "b", "c");
    expect(lastInfo()).toBe("scorch: a b c");
  });

  it("null -> None, undefined -> ? (the _str defaults)", () => {
    diag.log.info("%s|%s", null, undefined);
    expect(lastInfo()).toBe("scorch: None|?");
  });
});

// ===========================================================================
// 2. ConsoleLog level gate
// ===========================================================================
describe("diag.log level gate", () => {
  it("at INFO(20): info+warning+error all emit to their console sink", () => {
    diag.log.info("i");
    diag.log.warning("w");
    diag.log.error("e");
    expect(infoSpy).toHaveBeenCalledWith("scorch: i");
    expect(warnSpy).toHaveBeenCalledWith("scorch: w");
    expect(errorSpy).toHaveBeenCalledWith("scorch: e");
  });

  it("at ERROR(40): info and warning are suppressed, error still emits", () => {
    diag.log.setLevel(40);
    diag.log.info("i");
    diag.log.warning("w");
    diag.log.error("e");
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("scorch: e");
  });

  it("at DEBUG(10): info emits", () => {
    diag.log.setLevel(10);
    diag.log.info("i");
    expect(infoSpy).toHaveBeenCalledWith("scorch: i");
  });
});

// ===========================================================================
// 3. setup_logging / install_faulthandler / heartbeat / cancel_hang_watchdog
// ===========================================================================
describe("diag setup + faulthandler no-ops", () => {
  it("setup_logging() logs the start line and returns the console placeholder", () => {
    const r = diag.setup_logging();
    expect(r).toBe("(console)");
    expect(infoSpy).toHaveBeenCalledWith(
      "scorch: logging started -> console (browser build; no file handler)",
    );
  });

  it("setup_logging(level) sets the level; a WARNING level gates its own start line", () => {
    const r = diag.setup_logging(30);
    expect(r).toBe("(console)");
    expect(diag.log.level).toBe(30);
    expect(infoSpy).not.toHaveBeenCalled(); // INFO start line gated at level 30
  });

  it("install_faulthandler() is a documented no-op returning the placeholder path", () => {
    const r = diag.install_faulthandler();
    expect(r).toBe("(none)");
    expect(infoSpy).toHaveBeenCalledWith(
      "scorch: faulthandler: unavailable in the browser (no-op); host owns hang recovery",
    );
  });

  it("heartbeat() and cancel_hang_watchdog() are silent no-ops (nothing to arm)", () => {
    expect(diag.heartbeat()).toBeUndefined();
    expect(diag.cancel_hang_watchdog()).toBeUndefined();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. FrameWatchdog -- timing-only slow-frame detector (performance.now mocked)
// ===========================================================================
describe("diag.FrameWatchdog", () => {
  it("constructor announces the threshold; default is 250ms", () => {
    const wd = new diag.FrameWatchdog();
    expect(wd.threshold_ms).toBe(250);
    expect(infoSpy).toHaveBeenCalledWith(
      "scorch: FrameWatchdog: slow-frame threshold 250ms (timing-only in browser)",
    );
  });

  it("a frame under threshold logs NO warning", () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1010);
    const wd = new diag.FrameWatchdog();
    wd.begin_frame();
    wd.end_frame();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("a frame at/over threshold logs a slow-frame WARNING with elapsed + phase", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1300);
    const wd = new diag.FrameWatchdog();
    wd.begin_frame();
    wd.end_frame("loop");
    expect(warnSpy).toHaveBeenCalledWith(
      "scorch: slow frame: loop took 300ms (no cross-thread stack in browser)",
    );
  });

  it("end_frame with no begin_frame is a no-op (no warning, no throw)", () => {
    const wd = new diag.FrameWatchdog();
    expect(() => wd.end_frame()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("honors a custom threshold", () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(100);
    const wd = new diag.FrameWatchdog(50);
    expect(wd.threshold_ms).toBe(50);
    expect(infoSpy).toHaveBeenCalledWith(
      "scorch: FrameWatchdog: slow-frame threshold 50ms (timing-only in browser)",
    );
    wd.begin_frame();
    wd.end_frame();
    expect(warnSpy).toHaveBeenCalledWith(
      "scorch: slow frame: frame took 100ms (no cross-thread stack in browser)",
    );
  });

  it("stop() is an inline-timing no-op (no thread to join)", () => {
    const wd = new diag.FrameWatchdog();
    expect(() => wd.stop()).not.toThrow();
  });
});

// ===========================================================================
// 5. log_exception -- records + never suppresses (caller re-raises)
// ===========================================================================
describe("diag.log_exception", () => {
  it("an Error logs name:message THEN the stack at ERROR", () => {
    const e = new Error("boom");
    diag.log_exception(e);
    expect(errorSpy.mock.calls[0][0]).toBe("scorch: unhandled exception: Error: boom");
    expect(errorSpy).toHaveBeenCalledTimes(2); // message line + stack line
    expect(String(errorSpy.mock.calls[1][0])).toContain("scorch: ");
  });

  it("a non-Error throwable logs typeof:String(exc) and emits no stack line", () => {
    diag.log_exception("oops");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe("scorch: unhandled exception: string: oops");
  });

  it("a number throwable renders type 'number'", () => {
    diag.log_exception(42);
    expect(errorSpy.mock.calls[0][0]).toBe("scorch: unhandled exception: number: 42");
  });

  it("with a state arg it appends the one-line state snapshot", () => {
    const e = new Error("x");
    const state = { phase: "AIM", round_index: 1, projectiles: [1], active_bolts: [], explosions: [] };
    diag.log_exception(e, state);
    const snap = diag.state_snapshot(state);
    expect(errorSpy).toHaveBeenCalledWith("scorch: game state at crash: " + snap);
  });
});

// ===========================================================================
// 6. state_snapshot -- defensive one-line summary; never throws
// ===========================================================================
describe("diag.state_snapshot", () => {
  it("formats a full state exactly (round_index, cfg.MAXROUNDS, shooter, tanks, queue lengths)", () => {
    const state = {
      phase: "AIM",
      round_index: 2,
      cfg: { MAXROUNDS: 10 },
      live_sky: 3,
      current_shooter: { name: "Alice" },
      tanks: [
        { name: "Alice", health: 80, alive: true },
        { name: "Bob", health: 0, alive: false },
      ],
      projectiles: [1, 2],
      active_bolts: [9],
      explosions: [],
    };
    expect(diag.state_snapshot(state)).toBe(
      "phase=AIM round=2/10 sky=3 shooter=Alice | " +
        "tanks[Alice(hp=80,alive=true), Bob(hp=0,alive=false)] | proj=2 bolts=1 expl=0",
    );
  });

  it("falls back to `round` when round_index is absent; null shooter -> None; empty tanks", () => {
    const state = {
      phase: "PLAY",
      round: 1,
      cfg: { MAXROUNDS: 5 },
      live_sky: 0,
      current_shooter: null,
      tanks: [],
      projectiles: [],
      active_bolts: [],
      explosions: [],
    };
    expect(diag.state_snapshot(state)).toBe(
      "phase=PLAY round=1/5 sky=0 shooter=None | tanks[] | proj=0 bolts=0 expl=0",
    );
  });

  it("missing fields degrade to ? defaults without throwing", () => {
    expect(diag.state_snapshot({})).toBe(
      "phase=? round=?/? sky=? shooter=None | tanks[] | proj=0 bolts=0 expl=0",
    );
  });

  it("a malformed (non-iterable) tanks field is caught, not thrown", () => {
    const snap = diag.state_snapshot({ tanks: 123 });
    expect(snap).toMatch(/^<state_snapshot failed: /);
  });

  it("degrades present-but-null collection fields to []/0 (the defensive reads)", () => {
    expect(
      diag.state_snapshot({ phase: "A", tanks: null, projectiles: null, active_bolts: [1], explosions: [] }),
    ).toBe("phase=A round=?/? sky=? shooter=None | tanks[] | proj=0 bolts=1 expl=0");
  });

  it("degrades a tank missing name/health/alive to ? in each field", () => {
    expect(
      diag.state_snapshot({ phase: "B", tanks: [{}], projectiles: [], active_bolts: [], explosions: [] }),
    ).toBe("phase=B round=?/? sky=? shooter=None | tanks[?(hp=?,alive=?)] | proj=0 bolts=0 expl=0");
  });
});

// ===========================================================================
// 7. FrameSampler -- env-gated FPS window (default OFF)
// ===========================================================================
describe("diag.FrameSampler", () => {
  it("interval 0 -> disabled: no constructor log, tick is a no-op (reads no clock)", () => {
    const fs = new diag.FrameSampler(0);
    expect(fs.enabled).toBe(false);
    expect(fs.interval_s).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
    const now = vi.spyOn(performance, "now");
    fs.tick(0.016);
    expect(now).not.toHaveBeenCalled(); // disabled tick returns before reading the clock
  });

  it("a positive interval logs an FPS line once the window elapses", () => {
    // ctor reset @0s, tick1 @0.5s (no emit), tick2 @1.0s (window full -> emit).
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(500)
      .mockReturnValueOnce(1000);
    const fs = new diag.FrameSampler(1);
    expect(fs.enabled).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith("scorch: FrameSampler: logging FPS every 1s");
    fs.tick(0.5);
    fs.tick(0.5);
    expect(infoSpy).toHaveBeenCalledWith(
      "scorch: fps=2 frames=2 mean=500ms max=500ms (1s window)",
    );
  });
});

// ===========================================================================
// 8. _now_ms Date.now fallback (no performance global)
// ===========================================================================
describe("diag _now_ms fallback", () => {
  it("uses Date.now when performance is unavailable", () => {
    vi.stubGlobal("performance", undefined);
    vi.spyOn(Date, "now").mockReturnValueOnce(2000).mockReturnValueOnce(2300);
    const wd = new diag.FrameWatchdog(100);
    wd.begin_frame();
    wd.end_frame("fallback");
    expect(warnSpy).toHaveBeenCalledWith(
      "scorch: slow frame: fallback took 300ms (no cross-thread stack in browser)",
    );
  });
});

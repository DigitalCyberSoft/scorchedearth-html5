/**
 * Diagnostics for the HTML5 port -- the browser analog of scorch-py/scorch/diag.py.
 *
 * diag.py exists for MODERN-HARDWARE instrumentation that only makes sense for the
 * native Python build: a faulthandler hang dump (dump_traceback_later), a background
 * daemon FrameWatchdog thread that snapshots the MAIN thread's Python stack via
 * sys._current_frames, and stdlib logging to BOTH stderr AND a logs/scorch.log FILE.
 *
 * NONE of that has a faithful browser counterpart, and faithfulness here means
 * NOT pretending it does:
 *   - There is no faulthandler / SIGSEGV stack-dump in a browser tab; a runaway
 *     frame is the host's problem (the page's own watchdog / the user's tab kill),
 *     not something this module can arm.  heartbeat / install_faulthandler /
 *     cancel_hang_watchdog therefore become no-ops (documented, not silent: the
 *     reason they are no-ops is that the mechanism does not exist in the sandbox).
 *   - There are no OS threads to snapshot and no synchronous filesystem to write a
 *     log file to, so FrameWatchdog OBSERVES via timing only and logs to the
 *     console; it never alters control flow (the same DTM 6.x design rule diag.py
 *     states: observe + log, never suppress).
 *   - logging -> stderr+file collapses to console.* (the browser's only sink).
 *
 * The PUBLIC SURFACE matches diag.py exactly (setup_logging, install_faulthandler,
 * heartbeat, cancel_hang_watchdog, FrameWatchdog, FrameSampler, log_exception,
 * state_snapshot, plus a `log` object with info/warning/error), so main.ts reads
 * 1:1 with main.py's `from . import diag` usage.  The boundary layer in main.ts's
 * run() still logs WITH the GameState snapshot and RE-RAISES -- this module never
 * swallows the error (DTM 6.1): log_exception only records, it does not return a
 * success value and the caller re-throws.
 *
 * NUMERIC NOTE: nothing here is on a game-math path.  state_snapshot is a pure
 * string formatter over defensive field reads (it must never throw out of a crash
 * handler, exactly as diag.py:347).  FrameSampler.tick is O(1) accounting that, when
 * enabled, emits an INFO line; off by default it is a no-op.  There is no oracle
 * vector for this module: it has no Python-numeric output to differentially compare
 * (its Python analog's outputs are log lines + thread stacks, which are environment
 * artifacts, not game state).
 */

// ---------------------------------------------------------------------------
// 1. logging -> console (the browser's only sink; diag.py writes stderr + file)
// ---------------------------------------------------------------------------

/** Console-backed logger mirroring the subset of stdlib `logging` main.py uses:
 *  log.info / log.warning / log.error with printf-style %s/%d substitution.  The
 *  level gate mirrors diag.py's log.setLevel (default INFO; env-less in browser). */
class ConsoleLog {
  // logging numeric levels (CPython logging): DEBUG=10 INFO=20 WARNING=30 ERROR=40.
  level = 20;

  setLevel(level: number): void {
    this.level = level;
  }

  info(fmt: string, ...args: unknown[]): void {
    if (this.level <= 20) {
      // eslint-disable-next-line no-console
      console.info("scorch: " + _fmt(fmt, args));
    }
  }

  warning(fmt: string, ...args: unknown[]): void {
    if (this.level <= 30) {
      // eslint-disable-next-line no-console
      console.warn("scorch: " + _fmt(fmt, args));
    }
  }

  error(fmt: string, ...args: unknown[]): void {
    if (this.level <= 40) {
      // eslint-disable-next-line no-console
      console.error("scorch: " + _fmt(fmt, args));
    }
  }
}

/** printf-style %s/%d/%f/%r substitution, matching the way diag.py / main.py call
 *  log.info("... %s ...", a, b).  Unconsumed args are appended; missing args leave
 *  the spec literal.  This is a logging convenience, not a game-numeric formatter. */
function _fmt(fmt: string, args: unknown[]): string {
  let i = 0;
  const out = fmt.replace(/%[sdifr%]/g, (spec) => {
    if (spec === "%%") {
      return "%";
    }
    if (i >= args.length) {
      return spec;
    }
    const v = args[i++];
    if (spec === "%d" || spec === "%i") {
      return String(Math.trunc(Number(v)));
    }
    if (spec === "%f") {
      return String(Number(v));
    }
    // %s and %r both stringify here (the browser has no Python repr).
    return _str(v);
  });
  if (i < args.length) {
    return out + " " + args.slice(i).map(_str).join(" ");
  }
  return out;
}

function _str(v: unknown): string {
  if (v === null) {
    return "None";
  }
  if (v === undefined) {
    return "?";
  }
  return String(v);
}

/** The module-level logger, the analog of diag.py's `log = logging.getLogger`. */
export const log = new ConsoleLog();

/**
 * setup_logging(level?) -- diag.py:52.  In the browser there is no logs/ directory
 * and no stderr handler to attach; logging goes to the console.  Idempotent: a
 * repeated call only updates the level.  Returns a placeholder "logs dir" string
 * (diag.py returns the path) so the call site's shape is unchanged.
 */
export function setup_logging(level?: number): string {
  if (level !== undefined) {
    log.setLevel(level);
  }
  log.info("logging started -> console (browser build; no file handler)");
  return "(console)";
}

// ---------------------------------------------------------------------------
// 2. faulthandler hang detector  -- NO browser equivalent (see header)
// ---------------------------------------------------------------------------

/**
 * install_faulthandler() -- diag.py:105.  No-op in the browser: faulthandler /
 * dump_traceback_later / SIGSEGV stack dumps do not exist in a tab.  A hung frame
 * is contained by the host (the page's own unresponsive-script watchdog), which is
 * outside this module's reach.  Returns a placeholder path for call-site parity.
 */
export function install_faulthandler(): string {
  log.info("faulthandler: unavailable in the browser (no-op); host owns hang recovery");
  return "(none)";
}

/**
 * heartbeat() -- diag.py:150.  In Python this resets the faulthandler hang
 * countdown each frame.  No faulthandler exists here, so this is a no-op (kept so
 * main.ts's run loop reads 1:1 with main.py:650 `diag.heartbeat()`).
 */
export function heartbeat(): void {
  /* no-op: no faulthandler timer to reset in the browser (see header). */
}

/**
 * cancel_hang_watchdog() -- diag.py:163.  No-op (no faulthandler timer to cancel).
 */
export function cancel_hang_watchdog(): void {
  /* no-op: nothing armed (see install_faulthandler). */
}

// ---------------------------------------------------------------------------
// 3. FrameWatchdog -- soft slow-frame detector (timing-only; logs, never alters)
// ---------------------------------------------------------------------------
// diag.py runs a background daemon thread that grabs the MAIN thread's Python
// stack the instant a frame passes its deadline.  A browser tab has no second
// thread that can read the main thread's JS stack, so the faithful intent (NOTICE
// a slow frame and LOG it) survives but the mechanism is reduced to timing the
// frame on the same thread and logging when it overran.  It never touches game
// state -- the same DTM 6.x rule diag.py states.

const DEFAULT_SLOWFRAME_MS = 250.0; // diag.py default (env SCORCH_SLOWFRAME_MS).

export class FrameWatchdog {
  readonly threshold_ms: number;
  private _frame_start: number | null = null;

  constructor(threshold_ms: number = DEFAULT_SLOWFRAME_MS) {
    this.threshold_ms = threshold_ms;
    log.info("FrameWatchdog: slow-frame threshold %dms (timing-only in browser)", this.threshold_ms);
  }

  begin_frame(): void {
    this._frame_start = _now_ms();
  }

  end_frame(phase: string = "frame"): void {
    if (this._frame_start === null) {
      return;
    }
    const elapsed = _now_ms() - this._frame_start;
    this._frame_start = null;
    if (elapsed >= this.threshold_ms) {
      // No live cross-thread stack in the browser; report the overrun + phase.
      log.warning("slow frame: %s took %dms (no cross-thread stack in browser)", phase, elapsed);
    }
  }

  stop(): void {
    /* no background thread to stop (timing is inline). */
  }
}

// ---------------------------------------------------------------------------
// 4. Exception + GameState snapshot  (diag.py:313)
// ---------------------------------------------------------------------------

/**
 * log_exception(exc, state?) -- diag.py:313.  Logs the error WITH a one-line
 * GameState snapshot.  Defensive throughout (it runs from a crash boundary and
 * MUST NOT itself throw).  Does NOT suppress: the caller (main.ts run() boundary)
 * re-raises after this returns.
 */
export function log_exception(exc: unknown, state?: unknown): void {
  const name = exc instanceof Error ? exc.name : typeof exc;
  const msg = exc instanceof Error ? exc.message : String(exc);
  log.error("unhandled exception: %s: %s", name, msg);
  if (exc instanceof Error && exc.stack) {
    log.error("%s", exc.stack);
  }
  if (state !== undefined && state !== null) {
    log.error("game state at crash: %s", state_snapshot(state));
  }
}

/**
 * state_snapshot(state) -- diag.py:324.  One-line GameState summary for crash
 * context.  Never throws: every field is read defensively (the JS analog of
 * diag.py's getattr-with-default chain).  Unknown shapes degrade to "?"/empty.
 */
export function state_snapshot(state: unknown): string {
  try {
    const s = state as { [k: string]: unknown };
    const get = (k: string, d: unknown): unknown => (s && s[k] !== undefined ? s[k] : d);
    const phase = get("phase", "?");
    const rnd = get("round_index", get("round", "?"));
    const cfg = get("cfg", null) as { [k: string]: unknown } | null;
    const maxr = cfg && cfg["MAXROUNDS"] !== undefined ? cfg["MAXROUNDS"] : "?";
    const sky = get("live_sky", "?");
    const cs = get("current_shooter", null) as { name?: unknown } | null;
    const csName = cs && cs.name !== undefined ? cs.name : null;
    const tanks = (get("tanks", []) as Array<{ [k: string]: unknown }>) || [];
    const tinfo: string[] = [];
    for (const t of tanks) {
      tinfo.push(`${_str(t.name ?? "?")}(hp=${_str(t.health ?? "?")},alive=${_str(t.alive ?? "?")})`);
    }
    const lenOf = (k: string): number => {
      const arr = get(k, []) as unknown[];
      return Array.isArray(arr) ? arr.length : 0;
    };
    return (
      `phase=${_str(phase)} round=${_str(rnd)}/${_str(maxr)} sky=${_str(sky)} ` +
      `shooter=${_str(csName)} | tanks[${tinfo.join(", ")}] | ` +
      `proj=${lenOf("projectiles")} bolts=${lenOf("active_bolts")} expl=${lenOf("explosions")}`
    );
  } catch (snapErr) {
    // The snapshot must never raise out of a crash handler (diag.py:347).
    return `<state_snapshot failed: ${String(snapErr)}>`;
  }
}

// ---------------------------------------------------------------------------
// 5. FrameSampler -- env-gated FPS sampler (diag.py:358); OFF by default
// ---------------------------------------------------------------------------
// diag.py reads SCORCH_FPS_SECS from the environment.  The browser has no env, so
// the sampler is constructed disabled unless the host passes a positive interval
// (e.g. from a `?fps=2` query param the integrator decodes).  When on it logs an
// INFO line per window exactly like diag.py; off it is O(1) no-op per frame.

export class FrameSampler {
  readonly interval_s: number;
  readonly enabled: boolean;
  private _window_start = 0;
  private _n = 0;
  private _sum_ms = 0;
  private _max_ms = 0;

  constructor(interval_s = 0) {
    this.interval_s = interval_s;
    this.enabled = interval_s > 0;
    this._reset(_now_ms() / 1000.0);
    if (this.enabled) {
      log.info("FrameSampler: logging FPS every %ds", this.interval_s);
    }
  }

  private _reset(now_s: number): void {
    this._window_start = now_s;
    this._n = 0;
    this._sum_ms = 0;
    this._max_ms = 0;
  }

  tick(dt: number): void {
    if (!this.enabled) {
      return;
    }
    const ms = dt * 1000.0;
    this._n += 1;
    this._sum_ms += ms;
    if (ms > this._max_ms) {
      this._max_ms = ms;
    }
    const now = _now_ms() / 1000.0;
    const elapsed = now - this._window_start;
    if (elapsed >= this.interval_s && this._n) {
      const mean = this._sum_ms / this._n;
      const fps = elapsed > 0 ? this._n / elapsed : 0.0;
      log.info(
        "fps=%f frames=%d mean=%fms max=%fms (%fs window)",
        fps,
        this._n,
        mean,
        this._max_ms,
        elapsed,
      );
      this._reset(now);
    }
  }
}

/** Monotonic-ish milliseconds.  performance.now() in a browser, Date.now() under
 *  Node (the vitest collection environment never constructs these, but importing
 *  the module must be Node-safe -- see pygame.ts's DOM-free-at-module-scope rule). */
function _now_ms(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Browser entry point + the top-level state machine -- a faithful TypeScript port
 * of scorch-py/scorch/main.py (the fidelity oracle), driven as a STACK of
 * mouse-driven Screens (the 4f19 modal model), against src/pygame.ts + src/assets.ts.
 *
 * main.py's App is GLUE: it sequences a GameState through new_game / shop /
 * begin_next_round / proceed_after_round, pushes/pops Screen overlays, and runs the
 * requestAnimationFrame-equivalent loop (App.run, main.py:642).  Two of its
 * dependencies are NOT ported to TS at this layer and are out of this agent's
 * bounds to author:
 *
 *   - scorch.game.GameState (the round/turn engine + add_player/new_game/fire/
 *     retreat/mass_kill/run_ai_buys/begin_next_round/proceed_after_round).  There
 *     is no src/game.ts; render.ts / ingame.ts / screens.ts all read a STRUCTURAL
 *     GameState through provider hooks for exactly this reason.  This module follows
 *     the SAME established pattern: a GameStateFactory the integrator supplies
 *     (setGameStateFactory) constructs the engine; App reproduces main.py's control
 *     flow around it verbatim.  App is NOT given a fake GameState (DTM 4.1 / 6.8: a
 *     fabricated engine would lie about behaviour).  Until a factory is wired, the
 *     menu still boots and option submenus / registration / calibration all work;
 *     "Start Game" surfaces a console error (no engine to start) rather than
 *     silently doing nothing.
 *   - scorch.sprites (window icon, tank/MTN/weapon-icon painters).  No src/sprites.ts
 *     exists; render.ts / screens.ts / ingame.ts already take a sprites provider.
 *     main.ts forwards an integrator-supplied sprites provider to all three on boot
 *     (setSpritesProvider on each module) and uses it for the window icon; absent it,
 *     the chrome draws without sprite cells (the modules' documented no-op path).
 *
 * Everything main.py contains that DOES have a TS counterpart is ported in full:
 *   * the dialog zoom-wipe (_wants_zoom_wipe + _ZoomWipe: scale/flash/frame math,
 *     compose/draw, the band-0xAA dialog flash on a LiveLUT) -- main.py:33-184,
 *   * the App stack helpers (push/pop/_compose/_draw, the opaque-from-top scan),
 *   * the action dispatch string protocol (_act, main.py:518-639) over the REAL
 *     ported screen classes (MainMenuScreen, OptionsScreen, TankInitScreen,
 *     ShopScreen, SellScreen, ConfigureTeamsScreen, InventoryScreen, Save/Restore,
 *     Registration, Calibrate, plus the in-round ingame screens),
 *   * the run loop dt = min(elapsed_s, 1/30), event pump, _wipe handling,
 *     stack update/draw/present (main.py:642),
 *   * fullscreen via the Fullscreen API (F11 / Alt+Enter; main.py:513),
 *   * browser input -> pygame-shaped events via the pygame.ts adapters,
 *   * ASSET BOOT (the .MTN / TALK*.CFG / icon fetch) wired into talk/sprites/render
 *     before the menu,
 *   * save/load -> IndexedDB (a SaveStoreProvider handed to screens.ts).
 *
 * NUMERIC SUBSTRATE vs DRAWN PIXELS / DOM (read before testing):
 *   The differential gate (test/main.test.ts) runs in Node, DOM-free.  What it
 *   exercises is the math that needs neither a GameState nor pygame surfaces:
 *   _wants_zoom_wipe (the opaque/panel predicate), the _ZoomWipe ANIMATION math
 *   (_ZoomWipeMath: the frame accumulator advance(), the linear _scale(), the
 *   triangular _flash_level(), the flash additive amount, TRANSITION_FRAMES /
 *   _FRAME_DT / _FLASH_PEAK), and the loop dt clamp.  That reproduces main.py's
 *   _ZoomWipe pure methods exactly.  The _ZoomWipe SURFACE side (subsurface crop,
 *   smoothscale, BLEND_RGB_ADD composite), the run loop, asset boot, IndexedDB, and
 *   every screen .draw() need a DOM / a real engine and defer to the Phase-3 visual
 *   gate + a live boot (pixelsDeferredToPhase3 = true).
 */
import * as pygame from "./pygame";
import * as assets from "./assets";
import * as diag from "./diag";
import * as talk from "./talk";
import * as ui from "./ui";
import * as ingame from "./ingame";
import * as C from "./constants";
import * as _pal from "./palette";
import { sfx } from "./sound";
import { Config } from "./config";
import { Renderer } from "./render";
import { Screen } from "./screen";
import type { ScreenEvent } from "./screen";
import {
  MainMenuScreen,
  OptionsScreen,
  TankInitScreen,
  ShopScreen,
  SellScreen,
  ConfigureTeamsScreen,
  InventoryScreen,
  SaveScreen,
  RestoreScreen,
  RegistrationScreen,
  CalibrateScreen,
  setSpritesProvider as setScreensSprites,
  setSaveStoreProvider,
  type SaveStoreProvider,
} from "./screens";
import { setSpritesProvider as setRenderSprites } from "./render";
import { createGameState, setMtnRanges } from "./game";
import * as sprites from "./sprites";

// ===========================================================================
// dialog zoom-wipe (main.py:33-184)
// ===========================================================================
// Missing animation #3 (RECOVERED_ANIMATIONS.md:55-57,528-548,566): v1.5 plays a
// zoom-wipe + speaker sweep when a popup dialog opens/closes; the port pops
// instantly.  This is an App-level overlay -- it never touches the Screen
// subclasses (screens.ts / ingame.ts are read-only here).
//
// GEOMETRY (FACT, from the recovered wipes): FUN_2917_0319.c:17-18 computes the
// dialog-rect CENTER and sweeps concentric rect edges from the center out (OPEN) /
// in (CLOSE) -- a center-origin box wipe.  FUN_2917_041d.c:12 runs the companion
// wipe over exactly 0x14 == 20 outer steps; reused as the frame budget.  The scale
// schedule is LINEAR.  **FACT.**
//
// WALL-CLOCK (RECONSTRUCTED, BLOCKED in RE -- the same MIPS-adaptive busy-wait that
// forces the port to a fixed dt): 20 frames * _FRAME_DT ~= 0.32 s, a watchable
// value chosen the way C.DT is.  Skippable so it never blocks input.
export const TRANSITION_FRAMES = 20; // FACT: 0x14 outer steps, FUN_2917_041d.c:12
export const _FRAME_DT = 1.0 / 60.0; // RECONSTRUCTED per-step wall-clock (see above)

/** A screen as the App's stack holds it.  The base Screen plus the optional
 *  members the wipe / dispatch read off concrete subclasses (panel.rect, result,
 *  sell_slot, tank, restored).  Permissive like screen.py's getattr probes. */
interface StackScreen {
  opaque?: boolean;
  panel?: { rect?: pygame.Rect } | null;
  handle(event: ScreenEvent): string | null;
  update(dt: number): string | null;
  draw(surf: pygame.Surface): void;
  [extra: string]: unknown;
}

/**
 * _wants_zoom_wipe(screen) -- main.py:62.  True iff `screen` is a popup DIALOG that
 * should get the zoom-wipe: non-opaque AND has a panel rect.  This captures the
 * boxed modal popups (OptionsScreen / CalibrateScreen / ConfigureTeamsScreen /
 * SellScreen / RetreatScreen / ReassignPlayersScreen) and EXCLUDES the full-bleed
 * roots (MainMenu/Registration/TankInit/Shop/Inventory, all opaque=True), the
 * in-play GameScreen (opaque, no panel), and the full-screen scoreboards
 * (Rankings/GameOver, no `.panel`).
 *
 * getattr(screen, "opaque", True): an absent `opaque` reads True (screen.py maps
 * the Python class attr to an instance field defaulting true), so `?? true`.
 */
export function _wants_zoom_wipe(screen: StackScreen): boolean {
  if (screen.opaque ?? true) {
    return false;
  }
  const panel = screen.panel;
  const rect = panel != null ? panel.rect : undefined;
  return rect !== undefined && rect !== null;
}

/**
 * _ZoomWipeMath -- the pure ANIMATION state of a _ZoomWipe, factored out of the
 * surface compositing so it is testable headless (DOM-free) and reused by the
 * browser draw path.  Mirrors main.py:81-150's frame/_accum/_scale/_flash_level
 * EXACTLY (same operations -> identical IEEE754 doubles).
 *
 * The band-0xAA dialog flash ramp (main.py:108-132) is a LiveLUT rotated one entry
 * per wipe frame.  The LiveLUT needs no DOM (it is a palette table), so it lives
 * here too; only the SURFACE composite is in _ZoomWipe below.
 */
export class _ZoomWipeMath {
  readonly rectW: number;
  readonly rectH: number;
  readonly opening: boolean;
  frame: number; // 0 .. TRANSITION_FRAMES
  private _accum: number;
  // Dialog open/close palette flash band (0xAA,0x1e ramp; FUN_2d4f_0258 cluster).
  readonly lut: _pal.LiveLUT;
  private readonly _dlgLo: number;
  private readonly _dlgHi: number;
  private readonly _lutBase: _pal.PaletteTable;

  constructor(rectW: number, rectH: number, opening: boolean) {
    this.rectW = rectW;
    this.rectH = rectH;
    this.opening = opening;
    this.frame = 0;
    this._accum = 0.0;
    this.lut = new _pal.LiveLUT();
    this._dlgLo = _pal.DIALOG_BAND_LO;
    this._dlgHi = _pal.DIALOG_BAND_HI;
    this._lutBase = this.lut.copy_table();
  }

  /** main.py:113. */
  get done(): boolean {
    return this.frame >= TRANSITION_FRAMES;
  }

  /** main.py:116 -- complete instantly (any key/click): jump to the last frame. */
  skip(): void {
    this.frame = TRANSITION_FRAMES;
  }

  /**
   * advance(dt) -- main.py:120.  Consume real time in _FRAME_DT steps so the
   * animation runs at the recovered 20-frame length regardless of host frame rate.
   * Steps the dialog flash band one entry per wipe frame; restores it on done.
   */
  advance(dt: number): void {
    this._accum += dt;
    while (this._accum >= _FRAME_DT && !this.done) {
      this._accum -= _FRAME_DT;
      this.frame += 1;
      this.lut.rotate_band(this._dlgLo, this._dlgHi, 1);
    }
    if (this.done) {
      // restore the band to its base rows (main.py:131 set_band slice).
      const rows: Array<[number, number, number]> = [];
      for (let i = this._dlgLo; i <= this._dlgHi; i++) {
        const row = this._lutBase[i];
        rows.push([row[0], row[1], row[2]]);
      }
      this.lut.set_band(this._dlgLo, this._dlgHi, rows);
    }
  }

  /**
   * _flash_level() -- main.py:134.  Brightness-flash level (0..1) tracking the band
   * ramp: a triangular pulse, peak at the midpoint, zero at both ends.
   */
  _flash_level(): number {
    let t = this.frame / TRANSITION_FRAMES; // 0..1
    t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
    return 1.0 - Math.abs(2.0 * t - 1.0);
  }

  /**
   * _scale() -- main.py:144.  Linear scale in (0,1].  OPEN: small->1.  CLOSE:
   * 1->small.  Never zero: starts at one device pixel (1/rectW).
   */
  _scale(): number {
    let t = this.frame / TRANSITION_FRAMES; // 0..1
    t = t < 0.0 ? 0.0 : t > 1.0 ? 1.0 : t;
    const s = this.opening ? t : 1.0 - t;
    return Math.max(1.0 / Math.max(1, this.rectW), s);
  }

  /** main.py:154 -- dialog-flash peak additive lift, capped below saturation. */
  static readonly _FLASH_PEAK = 60;

  /** The additive flash amount for the current frame (main.py:174 int(PEAK*lvl)). */
  flashAmount(): number {
    const lvl = this._flash_level();
    return lvl > 0.0 ? Math.trunc(_ZoomWipeMath._FLASH_PEAK * lvl) : 0;
  }
}

/**
 * _ZoomWipe -- main.py:81.  One in-flight dialog open/close animation: a frozen
 * BACKGROUND with the dialog CARD (cropped from the fully-drawn dialog frame)
 * scaled about the dialog-rect center.  OPEN grows a point to full size; CLOSE
 * shrinks it.  The math lives in _ZoomWipeMath; this owns the surfaces.
 *
 * DOM: subsurface / smoothscale / BLEND_RGB_ADD composite need a canvas -> this is
 * the browser-only side (Phase-3 visual gate).
 */
class _ZoomWipe {
  private bg: pygame.Surface; // everything behind the dialog
  private rect: pygame.Rect; // the dialog rect (zoom origin/extent)
  private card: pygame.Surface; // just the rect region of the drawn dialog frame
  private opening: boolean;
  readonly m: _ZoomWipeMath;

  constructor(background: pygame.Surface, foreground: pygame.Surface, rect: pygame.Rect, opening: boolean) {
    this.bg = background;
    this.rect = new pygame.Rect(rect);
    // the dialog CARD = just the rect region of the drawn dialog frame.
    this.card = foreground.subsurface(this.rect.clip(foreground.get_rect())).copy();
    this.opening = opening;
    this.m = new _ZoomWipeMath(this.rect.w, this.rect.h, opening);
  }

  get done(): boolean {
    return this.m.done;
  }

  skip(): void {
    this.m.skip();
  }

  advance(dt: number): void {
    this.m.advance(dt);
  }

  /** main.py:156. */
  draw(dst: pygame.Surface): void {
    dst.blit(this.bg, [0, 0]);
    if (this.m.done && this.opening) {
      dst.blit(this.card, this.rect.topleft); // settled: exact dialog
      return;
    }
    const s = this.m._scale();
    const rw = this.rect.w;
    const rh = this.rect.h;
    const sw = Math.max(1, Math.trunc(rw * s));
    const sh = Math.max(1, Math.trunc(rh * s));
    const small = _pygame_smoothscale(this.card, [sw, sh]);
    // keep the card centered on the dialog-rect center as it scales.
    dst.blit(small, [this.rect.centerx - Math.trunc(sw / 2), this.rect.centery - Math.trunc(sh / 2)]);
    // palette flash (band 0xAA,0x1e ramp): a brief scene-wide brightness pulse.
    // Under BLEND_RGB_ADD set_alpha is ignored, so the level is baked into the fill.
    const amt = this.m.flashAmount();
    if (amt > 0) {
      const ov = new pygame.Surface(dst.get_size());
      ov.fill([amt, amt, amt]);
      dst.blit(ov, [0, 0], null, pygame.BLEND_RGB_ADD);
    }
  }
}

/** main.py:180 -- smoothscale, falling back to nearest scale if it throws. */
function _pygame_smoothscale(surf: pygame.Surface, size: [number, number]): pygame.Surface {
  try {
    return pygame.transform.smoothscale(surf, size);
  } catch {
    return pygame.transform.scale(surf, size);
  }
}

// ===========================================================================
// integrator hooks for the unported engine + sprites (see header)
// ===========================================================================

/** The GameState the App sequences.  The integrator's ported scorch.game.GameState
 *  satisfies this (it is the same object render/ingame/screens already consume).
 *  Members are exactly the ones App.run / _act touch; permissive ([extra]) because
 *  the screen constructors read further fields the engine carries. */
export interface GameStateLike {
  cfg: Config;
  w: number;
  h: number;
  phase: string;
  current_shooter: unknown;
  tanks: unknown[];
  winner: { name?: string } | null;
  round_index?: number;
  live_sky?: string | null;
  rng: unknown;
  add_player(name: string, ai_class: number, team: number, tank_icon: number): void;
  new_game(): void;
  run_ai_buys(): void;
  begin_next_round(): void;
  proceed_after_round(): void;
  fire(): void;
  [extra: string]: unknown;
}

/** Builds a fresh GameState seeded the way main.py:474-483 does.  The integrator
 *  supplies this from the ported engine module; (cfg,w,h,seed) mirror the Python
 *  constructor + the random.seed/grng.seed call. */
export type GameStateFactory = (cfg: Config, w: number, h: number, seed: number) => GameStateLike;

let _gameStateFactory: GameStateFactory | null = null;

/** Integrator hook: supply the ported GameState constructor.  Until set, "Start
 *  Game" cannot build an engine (App logs the gap rather than fabricating one). */
export function setGameStateFactory(f: GameStateFactory | null): void {
  _gameStateFactory = f;
}

/** The full sprites provider shape: the union of what render.ts / screens.ts /
 *  ingame.ts each need, plus the window icon.  The integrator's ported scorch.sprites
 *  satisfies all of it; App fans it out to each module on boot. */
export interface SpritesBundle {
  // render.SpritesProvider
  draw_tank(
    surf: pygame.Surface,
    x: number,
    y: number,
    icon_index: number,
    color: [number, number, number],
    angle: number,
  ): void;
  load_title_mountain(name: string | null): pygame.Surface | null;
  get_sprite(
    table: string,
    index: number,
    opts: { color?: number; pal?: _pal.PaletteTable; scale?: number },
  ): pygame.Surface | null;
  weapon_icon_palette(): _pal.PaletteTable;
  WEAPON_ICON_BASE: number;
  // screens.SpritesProvider extras
  draw_tank_icon_cell(
    surf: pygame.Surface,
    box: pygame.Rect,
    color: [number, number, number],
    opts: { design_index: number; grayed?: boolean; scale?: number },
  ): void;
  // window icon (set_icon analog)
  get_window_icon?(scale?: number): pygame.Surface | null;
}

let _sprites: SpritesBundle | null = null;

/** Integrator hook: supply the ported scorch.sprites bundle.  Fanned out to
 *  render/screens (and used for the window icon) inside App boot. */
export function setSpritesBundle(b: SpritesBundle | null): void {
  _sprites = b;
}

// ===========================================================================
// IndexedDB save store (the browser analog of main.py's on-disk .sav files)
// ===========================================================================
// screens.ts SaveScreen/RestoreScreen do real os.listdir / open(wb) / read; the
// browser has no synchronous filesystem, so the actual bytes live in IndexedDB.
// The SaveStoreProvider screens.ts wants is SYNCHRONOUS (list/exists/write/read),
// but IndexedDB is async, so this store keeps an in-memory MIRROR of the save
// catalog that the sync provider reads, and writes through to IndexedDB
// asynchronously (fire-and-forget, with the failure logged -- never swallowed to
// look like success).  The mirror is hydrated once at boot from IndexedDB before
// the menu, so list()/read() are correct from the first Restore.

const IDB_NAME = "scorch-saves";
const IDB_STORE = "saves";

/** Open (and create on first use) the saves object store. */
function _idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE); // key = basename, value = Uint8Array
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read every (basename -> bytes) pair from IndexedDB.  Used once at boot to seed
 *  the synchronous mirror the SaveStoreProvider serves. */
async function _idbReadAll(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const db = await _idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        const v = c.value;
        if (v instanceof Uint8Array) {
          out.set(String(c.key), v);
        } else if (v instanceof ArrayBuffer) {
          out.set(String(c.key), new Uint8Array(v));
        }
        c.continue();
      } else {
        resolve();
      }
    };
    cur.onerror = () => reject(cur.error);
  });
  db.close();
  return out;
}

/** Async write-through of one save; the sync provider has already updated the
 *  mirror, so this persists in the background.  A failure is LOGGED (DTM 6.9):
 *  the in-memory save still works this session, but the durability gap is real and
 *  surfaced, not hidden behind a success return. */
async function _idbWrite(basename: string, bytes: Uint8Array): Promise<void> {
  const db = await _idbOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(bytes, basename);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** A synchronous SaveStoreProvider backed by an in-memory mirror of the IndexedDB
 *  catalog, with async write-through.  Hydrated at boot via hydrate(). */
class IndexedDbSaveStore implements SaveStoreProvider {
  private _mirror = new Map<string, Uint8Array>();

  /** Seed the mirror from IndexedDB (call once before the menu). */
  async hydrate(): Promise<void> {
    try {
      this._mirror = await _idbReadAll();
      diag.log.info("save store: hydrated %d save(s) from IndexedDB", this._mirror.size);
    } catch (e) {
      // No persisted saves available this session; surface it (not fatal).
      diag.log.warning("save store: IndexedDB hydrate failed (%s); saves are session-only", String(e));
    }
  }

  list(): string[] {
    return Array.from(this._mirror.keys());
  }

  exists(basename: string): boolean {
    return this._mirror.has(basename);
  }

  write(basename: string, bytes: Uint8Array): void {
    // Update the sync mirror immediately so list()/read() see it at once, then
    // persist asynchronously.  A persist failure is logged, never masked.
    this._mirror.set(basename, bytes);
    void _idbWrite(basename, bytes).catch((e) => {
      diag.log.error("save store: IndexedDB write of %s failed (%s)", basename, String(e));
    });
  }

  read(basename: string): Uint8Array | null {
    const v = this._mirror.get(basename);
    return v !== undefined ? v : null;
  }
}

// ===========================================================================
// App  (main.py:344)
// ===========================================================================

const SUBMENUS = new Set([
  "sound",
  "hardware",
  "economics",
  "landscape",
  "physics",
  "play_options",
  "weapons",
]); // main.py:210

export class App {
  cfg: Config;
  w: number;
  h: number;
  screen: pygame.Surface; // the logical 1024x768 backbuffer
  fullscreen: boolean;
  renderer: Renderer;
  gs: GameStateLike | null;
  stack: StackScreen[];
  running: boolean;
  watchdog: diag.FrameWatchdog;
  sampler: diag.FrameSampler;

  // player-setup + shop sequencing (main.py:373-376)
  private _setup: Array<[string, number, number, number]>;
  private _setup_i: number;
  private _shop_humans: unknown[];
  private _shop_i: number;

  // in-flight dialog zoom-wipe (null when no dialog is animating)
  private _wipe: _ZoomWipe | null;

  // loop time base (the analog of pygame.time.Clock: ms since boot via the host)
  private _lastMs: number | null;

  constructor(surface: pygame.Surface, fullscreen = false, mayhem = false, fpsSecs = 0) {
    // diagnostics first (DIAGNOSTICS.md / diag.py): logging + the soft watchdog.
    diag.setup_logging();
    diag.install_faulthandler(); // no-op in browser (see diag.ts)
    this.watchdog = new diag.FrameWatchdog();
    this.sampler = new diag.FrameSampler(fpsSecs);
    // Config is loaded by the boot sequence (async fetch) and passed in via the
    // factory below; here we adopt the already-loaded cfg off the surface owner.
    this.cfg = (surface as unknown as { _cfg?: Config })._cfg ?? Config.load(null);
    // `mayhem` give-all-weapons cheat (runtime attribute, not a saved field).
    (this.cfg as unknown as { mayhem: boolean }).mayhem = mayhem;
    this.w = surface.get_width();
    this.h = surface.get_height();
    this.screen = surface;
    diag.log.info("app start: resolution=%dx%d fullscreen=%s", this.w, this.h, fullscreen);
    // real SCORCH.ICO window icon (set_icon analog), if the sprites bundle is wired.
    try {
      if (_sprites && typeof _sprites.get_window_icon === "function") {
        const icon = _sprites.get_window_icon(1);
        if (icon) {
          _setWindowIcon(icon);
        }
      }
    } catch {
      /* icon is cosmetic; a failure must not block boot. */
    }
    this.fullscreen = fullscreen;
    this.renderer = new Renderer(this.cfg, this.w, this.h);
    this.gs = null;
    this.stack = [new MainMenuScreen(this.cfg as unknown as never, this.w, this.h) as unknown as StackScreen];
    this._setup = [];
    this._setup_i = 0;
    this._shop_humans = [];
    this._shop_i = 0;
    this.running = true;
    this._wipe = null;
    this._lastMs = null;
    // mixer gate from cfg.SOUND so the open/close sweep honors it (sound.py header).
    try {
      sfx.enabled = this.cfg.is_on("SOUND");
    } catch {
      /* sound is optional. */
    }
  }

  // ---- stack helpers (main.py:388) ----
  get top(): StackScreen {
    return this.stack[this.stack.length - 1];
  }

  /** main.py:393 -- render `stack` (lowest opaque upward) onto a fresh Surface. */
  private _compose(stack: StackScreen[]): pygame.Surface {
    const out = new pygame.Surface([this.w, this.h]);
    let start = 0;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].opaque ?? true) {
        start = i;
        break;
      }
    }
    for (let i = start; i < stack.length; i++) {
      stack[i].draw(out);
    }
    return out;
  }

  /** main.py:407. */
  push(screen: StackScreen): void {
    const wipe = _wants_zoom_wipe(screen);
    const bg = wipe ? this._compose(this.stack) : null;
    this.stack.push(screen);
    if (wipe) {
      this._begin_wipe(screen, bg as pygame.Surface, true);
    }
  }

  /** main.py:416. */
  pop(): void {
    if (this.stack.length > 1) {
      const leaving = this.stack[this.stack.length - 1];
      if (_wants_zoom_wipe(leaving)) {
        const fg = this._compose(this.stack);
        this.stack.pop();
        const bg = this._compose(this.stack);
        this._begin_wipe(leaving, bg, false, fg);
      } else {
        this.stack.pop();
      }
    }
  }

  /** main.py:429 -- arm a _ZoomWipe; degrade to no-op if the surfaces fail. */
  private _begin_wipe(
    screen: StackScreen,
    background: pygame.Surface,
    opening: boolean,
    foreground?: pygame.Surface,
  ): void {
    try {
      const fg = foreground ?? this._compose(this.stack);
      const rect = (screen.panel as { rect: pygame.Rect }).rect;
      this._wipe = new _ZoomWipe(background, fg, rect, opening);
    } catch {
      this._wipe = null; // graceful: just show the dialog instantly
      return;
    }
    try {
      sfx.play(opening ? "dialog_open" : "dialog_close", this.cfg.is_on("SOUND"));
    } catch {
      /* sound is optional. */
    }
  }

  private _make_submenu(name: string): StackScreen {
    return new OptionsScreen(this.cfg as unknown as never, this.w, this.h, name) as unknown as StackScreen;
  }

  /** main.py:451 -- the interim per-round rankings title. */
  private _rankings_title(): string {
    if (this.gs && this.gs.cfg.team_mode !== C.TEAM_NONE) {
      return "Team Rankings";
    }
    return "Player Rankings";
  }

  // ---- player setup sequence (main.py:459) ----
  private _start_setup(): void {
    this._setup = [];
    this._setup_i = 0;
    this.push(new TankInitScreen(this.cfg as unknown as never, this.w, this.h, 0) as unknown as StackScreen);
  }

  private _tank_done(): void {
    const result = (this.top as unknown as { result: [string, number, number, number] }).result;
    this._setup.push(result);
    this.pop();
    this._setup_i += 1;
    if (this._setup_i < this.cfg.MAXPLAYERS) {
      this.push(
        new TankInitScreen(this.cfg as unknown as never, this.w, this.h, this._setup_i) as unknown as StackScreen,
      );
    } else {
      this._build_game();
    }
  }

  /** main.py:474 -- build the GameState from the setup roster and seed the RNG. */
  private _build_game(): void {
    if (_gameStateFactory === null) {
      // No engine wired: cannot start.  Surface the gap loudly (the menu stays up).
      diag.log.error("cannot start game: no GameStateFactory wired (engine not integrated)");
      return;
    }
    const seed = _ticksMs();
    const gs = _gameStateFactory(this.cfg, this.w, this.h, seed);
    this.gs = gs;
    for (const [name, ai_class, team, tank_icon] of this._setup) {
      gs.add_player(name, ai_class, team, tank_icon);
    }
    gs.new_game();
    diag.log.info(
      "new game: players=%d rounds=%d seed=%d sky=%s phase=%s",
      gs.tanks.length,
      this.cfg.MAXROUNDS,
      seed,
      gs.live_sky ?? "?",
      gs.phase,
    );
    this.stack = [new GameScreen(this, gs) as unknown as StackScreen];
    // main.py:489 - if teams on, Configure Teams before the shop.
    if (this.cfg.team_mode !== C.TEAM_NONE) {
      this.push(new ConfigureTeamsScreen(gs as unknown as never, this.w, this.h) as unknown as StackScreen);
    } else if (gs.phase === SHOP) {
      this._enter_shop();
    }
  }

  // ---- shop sequence (main.py:494) ----
  private _enter_shop(): void {
    const gs = this.gs as GameStateLike;
    this._shop_humans = (gs.tanks as Array<{ ai_class: number }>).filter((t) => t.ai_class === C.AI_HUMAN);
    this._shop_i = 0;
    this._advance_shop();
  }

  private _advance_shop(): void {
    const gs = this.gs as GameStateLike;
    if (this._shop_i < this._shop_humans.length) {
      const tank = this._shop_humans[this._shop_i];
      this._shop_i += 1;
      this.push(new ShopScreen(gs as unknown as never, tank as never, this.w, this.h) as unknown as StackScreen);
    } else {
      gs.run_ai_buys();
      gs.begin_next_round(); // start_round (arms bought shields)
      diag.log.info(
        "round start: round=%s/%d sky=%s phase=%s",
        gs.round_index ?? "?",
        this.cfg.MAXROUNDS,
        gs.live_sky ?? "?",
        gs.phase,
      );
    }
  }

  // ---- fullscreen (main.py:512) ----
  private _toggle_fullscreen(): void {
    this.fullscreen = !this.fullscreen;
    _toggleFullscreenApi(this.fullscreen);
  }

  // ---- action dispatch (main.py:518) ----
  _act(action: string | null): void {
    if (!action) {
      return;
    }
    const gs = this.gs;
    if (action === "start_game") {
      this._start_setup();
    } else if (action === "save_changes") {
      // browser: persist the cfg body to localStorage (main.py writes scorch.cfg).
      _saveConfig(this.cfg);
    } else if (action === "register") {
      this.push(new RegistrationScreen(this.cfg as unknown as never, this.w, this.h) as unknown as StackScreen);
    } else if (action === "calibrate") {
      this.push(new CalibrateScreen(this.cfg as unknown as never, this.w, this.h) as unknown as StackScreen);
    } else if (action === "tank_done") {
      this._tank_done();
    } else if (action.startsWith("push:")) {
      const name = action.split(":", 2)[1];
      if (SUBMENUS.has(name)) {
        this.push(this._make_submenu(name));
      } else if (name === "control" && gs) {
        this.push(new ingame.ControlPanelScreen(gs as never, gs.current_shooter as never) as unknown as StackScreen);
      } else if (name === "system") {
        this.push(new ingame.SystemMenuScreen(gs as never) as unknown as StackScreen);
      } else if (name === "sell" && gs) {
        const slot = (this.top as unknown as { sell_slot?: number | null }).sell_slot;
        if (slot !== undefined && slot !== null) {
          const tank = (this.top as unknown as { tank: unknown }).tank;
          this.push(new SellScreen(gs as unknown as never, tank as never, slot, this.w, this.h) as unknown as StackScreen);
        }
      }
    } else if (action === "open_inventory" && gs) {
      this.push(
        new InventoryScreen(gs as unknown as never, gs.current_shooter as never, this.w, this.h) as unknown as StackScreen,
      );
    } else if (action === "shop_inventory" && gs) {
      if (this.top instanceof ShopScreen) {
        const tank = (this.top as unknown as { tank: unknown }).tank;
        this.push(new InventoryScreen(gs as unknown as never, tank as never, this.w, this.h) as unknown as StackScreen);
      }
    } else if (action === "retreat" && gs) {
      this.push(new ingame.RetreatScreen(gs as never) as unknown as StackScreen);
    } else if (action === "retreat_done") {
      this.pop(); // retreat() already advanced the phase
    } else if (action === "save_game" && gs) {
      if (this.top instanceof ingame.SystemMenuScreen) {
        this.pop(); // drop the menu before the dialog
      }
      this.push(new SaveScreen(gs as unknown as never, this.w, this.h) as unknown as StackScreen);
    } else if (action === "restore_game") {
      if (this.top instanceof ingame.SystemMenuScreen) {
        this.pop();
      }
      this.push(new RestoreScreen(gs as unknown as never, this.w, this.h) as unknown as StackScreen);
    } else if (action === "pop") {
      const was_shop = this.top instanceof ShopScreen;
      const was_teams = this.top instanceof ConfigureTeamsScreen;
      const restored =
        this.top instanceof RestoreScreen ? (this.top as unknown as { restored: unknown }).restored : null;
      this.pop();
      if (was_shop) {
        this._advance_shop();
      } else if (was_teams && gs && gs.phase === SHOP) {
        this._enter_shop(); // teams assigned -> pre-round shop
      } else if (restored !== null && restored !== undefined) {
        // Restore Game succeeded: adopt the rebuilt GameState, resume on a fresh
        // GameScreen (drop any overlay stack).
        const rgs = restored as GameStateLike;
        this.gs = rgs;
        this.renderer = new Renderer(rgs.cfg, rgs.w, rgs.h);
        this.stack = [new GameScreen(this, rgs) as unknown as StackScreen];
      }
    } else if (action === "fire") {
      this.pop();
      if (gs && gs.phase === AIM) {
        gs.fire();
      }
    } else if (action === "back") {
      this.pop();
    } else if (action === "round_end") {
      diag.log.info("round end: round=%s/%s", gs?.round_index ?? "?", this.cfg.MAXROUNDS);
      this.push(new RankingsScreen(this, this._rankings_title()) as unknown as StackScreen);
    } else if (action === "rankings_done") {
      this.pop();
      (gs as GameStateLike).proceed_after_round();
      if ((gs as GameStateLike).phase === GAME_OVER) {
        this.push(new GameOverScreen(this) as unknown as StackScreen);
      } else if ((gs as GameStateLike).phase === SHOP) {
        this._enter_shop();
      }
    } else if (action === "game_over") {
      const w = gs && gs.winner ? gs.winner.name : "?";
      diag.log.info("game over: winner=%s", w ?? "?");
      this.push(new GameOverScreen(this) as unknown as StackScreen);
    } else if (action === "to_menu" || action === "quit_game") {
      this.gs = null;
      this.stack = [new MainMenuScreen(this.cfg as unknown as never, this.w, this.h) as unknown as StackScreen];
    } else if (action === "new_game") {
      this.stack = [new MainMenuScreen(this.cfg as unknown as never, this.w, this.h) as unknown as StackScreen];
      this.gs = null;
    } else if (action === "reassign_teams" && gs) {
      if (this.top instanceof ingame.SystemMenuScreen) {
        this.pop();
      }
      this.push(new ConfigureTeamsScreen(gs as unknown as never, this.w, this.h) as unknown as StackScreen);
    } else if (action === "clear_screen" && gs) {
      if (this.top instanceof ingame.SystemMenuScreen) {
        this.pop();
      }
      ingame.clear_screen_effect(gs as never);
    } else if (action === "mass_kill" && gs) {
      if (this.top instanceof ingame.SystemMenuScreen) {
        this.pop();
      }
      ingame.do_mass_kill(gs as never);
      if ((gs as GameStateLike).phase === ROUND_END) {
        this.push(new RankingsScreen(this, this._rankings_title()) as unknown as StackScreen);
      }
    } else if (action === "reassign_players" && gs) {
      if (this.top instanceof ingame.SystemMenuScreen) {
        this.pop();
      }
      this.push(new ingame.ReassignPlayersScreen(gs as never, this.w, this.h) as unknown as StackScreen);
    }
  }

  // ---- main loop (main.py:642) ----
  /**
   * step(nowMs) -- one frame of the App.run loop, driven by requestAnimationFrame
   * (the browser's clock; main.py uses pygame.time.Clock.tick(60)).  dt = the real
   * elapsed seconds clamped to 1/30 (main.py:649).  Pumps the queued browser events
   * (already pygame-shaped), advances/draws the stack or the wipe, and presents.
   *
   * Returns false when the App has stopped (running=False), so the RAF driver can
   * halt.  The boundary (DTM 6.3b) logs WITH the state snapshot and RE-RAISES.
   */
  step(nowMs: number, events: ScreenEvent[]): boolean {
    if (!this.running) {
      return false;
    }
    const elapsed = this._lastMs === null ? 0 : (nowMs - this._lastMs) / 1000.0;
    this._lastMs = nowMs;
    const dt = Math.min(elapsed, 1 / 30.0);
    diag.heartbeat(); // no-op in browser
    this.sampler.tick(dt);
    this.watchdog.begin_frame();
    try {
      for (const e of events) {
        if (e.type === pygame.QUIT) {
          this.running = false;
        } else if (
          e.type === pygame.KEYDOWN &&
          (e.key === pygame.K_F11 ||
            (e.key === pygame.K_RETURN && ((e.mod ?? 0) & pygame.KMOD_ALT) !== 0))
        ) {
          this._toggle_fullscreen();
        } else if (this._wipe !== null) {
          // A dialog is animating: any key/click COMPLETES it instantly.
          if (e.type === pygame.KEYDOWN || e.type === pygame.MOUSEBUTTONDOWN) {
            this._wipe.skip();
          }
        } else {
          this._act(this.top.handle(e));
        }
      }
      if (this._wipe !== null) {
        this._wipe.advance(dt);
        if (this._wipe.done) {
          this._wipe = null; // settle onto the live screen
        }
      } else {
        this._act(this.top.update(dt));
      }
      this._draw();
      _present(this.screen);
    } catch (e) {
      diag.log_exception(e, this.gs); // boundary: log + RE-RAISE
      this.watchdog.end_frame(this.top.constructor.name);
      throw e;
    }
    this.watchdog.end_frame(this.top.constructor.name);
    return this.running;
  }

  /** main.py:687. */
  private _draw(): void {
    if (this._wipe !== null) {
      this._wipe.draw(this.screen);
      return;
    }
    let start = 0;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].opaque ?? true) {
        start = i;
        break;
      }
    }
    for (let i = start; i < this.stack.length; i++) {
      this.stack[i].draw(this.screen);
    }
  }
}

// ===========================================================================
// GameScreen (main.py:215) + RankingsScreen (289) + GameOverScreen (314)
// ===========================================================================
// Phase string constants (scorch.game module-level; game.py:51-65).  Defined here
// because the engine module is not ported at this layer; they are the literal
// strings the engine sets and App branches on.
const AIM = "aim";
const ROUND_END = "round_end";
const SHOP = "shop";
const GAME_OVER = "game_over";
const SIM_LIVE = "sim_live";

/** main.py:215 -- the live battlefield: renders the world + HUD, routes in-round
 *  input, advances the GameState, signals phase transitions to the App. */
class GameScreen extends Screen {
  override opaque = true;
  app: App;
  gs: GameStateLike;

  constructor(app: App, gs: GameStateLike) {
    super();
    this.app = app;
    this.gs = gs;
  }

  private _is_human_turn(): boolean {
    const gs = this.gs;
    const cs = gs.current_shooter as { ai_class?: number } | null;
    return gs.phase === AIM && cs !== null && cs !== undefined && cs.ai_class === C.AI_HUMAN;
  }

  override handle(event: ScreenEvent): string | null {
    const gs = this.gs;
    if (event.type === pygame.KEYDOWN && (event.key === pygame.K_F1 || event.key === pygame.K_ESCAPE)) {
      return "push:system";
    }
    if (gs.phase === SIM_LIVE) {
      if (event.type === pygame.KEYDOWN) {
        (gs as unknown as { _sim_human_keydown(k: number): void })._sim_human_keydown(event.key as number);
      }
      return null;
    }
    if (this._is_human_turn()) {
      const act = ingame.handle_game_event(gs as never, event as never);
      if (act === "open_control_panel") {
        return "push:control";
      }
      if (act === "open_inventory") {
        return "open_inventory";
      }
      if (act === "retreat") {
        return "retreat";
      }
    }
    return null;
  }

  override update(dt: number): string | null {
    const gs = this.gs;
    if (gs.phase === SIM_LIVE) {
      (gs as unknown as { _sim_human_input(keys: unknown, dt: number): void })._sim_human_input(
        _keyGetPressed(),
        dt,
      );
    } else if (this._is_human_turn()) {
      ingame.update_game_input(gs as never, dt, _keyGetPressed() as never);
    }
    (gs as unknown as { update(dt: number): void }).update(dt);
    if (gs.phase === ROUND_END) {
      return "round_end";
    }
    if (gs.phase === GAME_OVER) {
      return "game_over";
    }
    return null;
  }

  override draw(surf: pygame.Surface): void {
    this.app.renderer.render(surf, this.gs as never);
  }
}

/** main.py:289 -- interim rankings panel.  STATIC by ground truth (no per-row
 *  color cycle; see main.py:269-286). */
class RankingsScreen extends Screen {
  override opaque = false;
  app: App;
  title: string;

  constructor(app: App, title: string) {
    super();
    this.app = app;
    this.title = title;
  }

  override handle(event: ScreenEvent): string | null {
    if (event.type === pygame.KEYDOWN && (event.key === pygame.K_RETURN || event.key === pygame.K_SPACE)) {
      return "rankings_done";
    }
    if (event.type === pygame.MOUSEBUTTONDOWN) {
      return "rankings_done";
    }
    return null;
  }

  override update(_dt: number): string | null {
    return null; // static panel
  }

  override draw(surf: pygame.Surface): void {
    const gs = this.app.gs;
    // interim rankings shows "N rounds remain."; same formula as the shop top bar.
    const remain = gs ? (gs.cfg.MAXROUNDS - (gs.round_index ?? 0)) : null;
    ui.draw_rankings(surf, this.app.renderer as never, gs as never, this.title, remain);
  }
}

/** main.py:314 -- the game-end final-scoring screen. */
class GameOverScreen extends Screen {
  override opaque = false;
  app: App;
  quote: readonly [string, string] | null;

  constructor(app: App) {
    super();
    this.app = app;
    // End-of-game war quote: pick ONCE at construction (stable while shown), after
    // the round/scoring RNG has already run (main.py:319-323).
    const gs = app.gs;
    this.quote = gs !== null ? talk.war_quote(gs.rng as never) : null;
  }

  override handle(event: ScreenEvent): string | null {
    if (event.type === pygame.KEYDOWN || event.type === pygame.MOUSEBUTTONDOWN) {
      return "to_menu";
    }
    return null;
  }

  override update(_dt: number): string | null {
    return null; // static panel
  }

  override draw(surf: pygame.Surface): void {
    const gs = this.app.gs;
    // "Final Scoring" when a tank survives to win, else "No Winner" (main.py:339).
    const title = gs && gs.winner ? "Final Scoring" : "No Winner";
    ui.draw_rankings(
      surf,
      this.app.renderer as never,
      gs as never,
      title,
      null,
      this.quote as [string, string] | null,
    );
  }
}

// ===========================================================================
// Browser host glue: input pump, key state, present, fullscreen, icon, config
// ===========================================================================

/** pygame.key.get_pressed() analog: a live map keyed by SDL keycode, kept up to
 *  date by the window keydown/keyup listeners.  ingame/ui read keys[K_*]. */
const _keysHeld: { [code: number]: boolean } = {};

function _keyGetPressed(): { [code: number]: boolean } {
  return _keysHeld;
}

/** Monotonic ms since boot (pygame.time.get_ticks analog), used to seed the RNG. */
const _bootMs = _nowMs();
function _ticksMs(): number {
  return Math.trunc(_nowMs() - _bootMs);
}

function _nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/** Present the logical backbuffer to the on-screen #game canvas (pygame.display
 *  .flip analog).  The App renders to its own 1024x768 Surface; the visible canvas
 *  is letterboxed/scaled by CSS, so present is a 1:1 blit of the backbuffer pixels
 *  onto the page canvas. */
function _present(backbuffer: pygame.Surface): void {
  const page = document.getElementById("game") as HTMLCanvasElement | null;
  if (page === null) {
    return;
  }
  const ctx = page.getContext("2d");
  if (ctx === null) {
    return;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(backbuffer.canvas, 0, 0);
}

/** Set the page favicon to the decoded SCORCH.ICO surface (set_icon analog). */
function _setWindowIcon(icon: pygame.Surface): void {
  try {
    const url = icon.canvas.toDataURL("image/png");
    let link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
    if (link === null) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = url;
  } catch {
    /* favicon is cosmetic. */
  }
}

/** F11 / Alt+Enter -> the Fullscreen API (pygame.display.toggle_fullscreen). */
function _toggleFullscreenApi(wantFull: boolean): void {
  try {
    if (wantFull) {
      const el = (document.getElementById("game") as HTMLElement | null) ?? document.documentElement;
      void el.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  } catch {
    /* fullscreen may be blocked by the host; non-fatal. */
  }
}

const CFG_LS_KEY = "scorch.cfg";

/** save_changes: persist the cfg body (main.py writes scorch.cfg in the cwd; the
 *  browser has no cwd, so localStorage is the durable store). */
function _saveConfig(cfg: Config): void {
  try {
    localStorage.setItem(CFG_LS_KEY, cfg.save());
    diag.log.info("config saved to localStorage");
  } catch (e) {
    diag.log.error("config save failed (%s)", String(e));
  }
}

/** Load the persisted cfg body from localStorage, or null if none (the OSError /
 *  no-scorch.cfg branch -> built-in defaults). */
function _loadConfigText(): string | null {
  try {
    return localStorage.getItem(CFG_LS_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DOM event wiring: window keydown/keyup, canvas mousedown/up/move -> a queue of
// pygame-shaped events the App drains each frame (main.py's pygame.event.get()).
// ---------------------------------------------------------------------------

/** The per-frame event queue (drained by App.step), the analog of SDL's queue. */
const _eventQueue: ScreenEvent[] = [];

/** Canvas-relative pointer position in LOGICAL (1024x768) coordinates: the visible
 *  canvas is scaled by CSS, so a client point is mapped back through the canvas
 *  rect to logical pixels. */
function _logicalPos(canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  const sx = r.width > 0 ? canvas.width / r.width : 1;
  const sy = r.height > 0 ? canvas.height / r.height : 1;
  return [Math.trunc((clientX - r.left) * sx), Math.trunc((clientY - r.top) * sy)];
}

/** The live mouse state (pygame.mouse.get_pressed / get_pos analog) ingame reads. */
const _mousePressed: [boolean, boolean, boolean] = [false, false, false];
let _mousePos: [number, number] = [0, 0];

/** Wire the DOM listeners onto `canvas` + window.  Called once during boot. */
function _installInput(canvas: HTMLCanvasElement): void {
  window.addEventListener("keydown", (e) => {
    const key = pygame.keyToPygame(e);
    if (key !== 0) {
      _keysHeld[key] = true;
    }
    _eventQueue.push({
      type: pygame.KEYDOWN,
      key,
      mod: pygame.modsToPygame(e),
      unicode: pygame.unicodeFor(e),
    });
    // Keep the page from scrolling on Space / arrows while the game owns input.
    if (
      key === pygame.K_SPACE ||
      key === pygame.K_UP ||
      key === pygame.K_DOWN ||
      key === pygame.K_LEFT ||
      key === pygame.K_RIGHT ||
      key === pygame.K_F11
    ) {
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    const key = pygame.keyToPygame(e);
    if (key !== 0) {
      _keysHeld[key] = false;
    }
    _eventQueue.push({ type: pygame.KEYUP, key, mod: pygame.modsToPygame(e) });
  });
  canvas.addEventListener("mousedown", (e) => {
    const pos = _logicalPos(canvas, e.clientX, e.clientY);
    _mousePos = pos;
    const btn = pygame.mouseButtonToPygame(e.button);
    if (btn === 1) {
      _mousePressed[0] = true;
    } else if (btn === 2) {
      _mousePressed[1] = true;
    } else if (btn === 3) {
      _mousePressed[2] = true;
    }
    _eventQueue.push({ type: pygame.MOUSEBUTTONDOWN, button: btn, pos, mod: pygame.modsToPygame(e) });
    e.preventDefault();
  });
  window.addEventListener("mouseup", (e) => {
    const pos = _logicalPos(canvas, e.clientX, e.clientY);
    _mousePos = pos;
    const btn = pygame.mouseButtonToPygame(e.button);
    if (btn === 1) {
      _mousePressed[0] = false;
    } else if (btn === 2) {
      _mousePressed[1] = false;
    } else if (btn === 3) {
      _mousePressed[2] = false;
    }
    _eventQueue.push({ type: pygame.MOUSEBUTTONUP, button: btn, pos });
  });
  canvas.addEventListener("mousemove", (e) => {
    const pos = _logicalPos(canvas, e.clientX, e.clientY);
    _mousePos = pos;
    _eventQueue.push({ type: pygame.MOUSEMOTION, pos });
  });
  // Suppress the context menu so RIGHT-click is a game button, not a browser menu.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Honor a cleanly-closed tab as a QUIT (so the boundary's finally path runs).
  window.addEventListener("beforeunload", () => {
    _eventQueue.push({ type: pygame.QUIT });
  });
  // Feed ingame's mouse-state provider (pygame.mouse equivalent).
  ingame.setMouseStateProvider(() => ({ pressed: _mousePressed, pos: _mousePos }));
}

// ===========================================================================
// boot (main.py:703 main() + App.run) -- async asset load, then the RAF loop
// ===========================================================================

/**
 * Boot sequence (the browser analog of main() + App.__init__'s synchronous loads,
 * which the browser must do ASYNCHRONOUSLY before the menu):
 *   1. parse the query string for the `mayhem` cheat / `--fullscreen` / fps gate.
 *   2. fetch + decode the cfg (localStorage), build Config.
 *   3. ASSET BOOT: fetch the TALK*.CFG speech files (talk.load) and the .MTN list +
 *      bytes (forwarded to the sprites provider if wired); set the window icon.
 *   4. hydrate the IndexedDB save store; hand it to screens.ts.
 *   5. wire the sprites bundle (if the integrator supplied one) into render/screens.
 *   6. install DOM input listeners.
 *   7. construct App on a logical 1024x768 backbuffer Surface and run the RAF loop.
 *
 * ASSETS LOADED (reported): TALK1.CFG, TALK2.CFG (latin-1 text -> talk pools); the
 * 10 .MTN names via assets.listMtnFiles + bytes for the default title mountain;
 * SCORCH.ICO (icon) when the sprites bundle decodes it.  All via src/assets.ts.
 */
export async function boot(): Promise<void> {
  diag.setup_logging();
  // 1. query params (the browser's argv).
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const mayhem = params.has("mayhem");
  const fullscreen = params.has("fullscreen") || params.has("f");
  const fpsSecs = Number(params.get("fps") ?? "0") || 0;

  // 2. config.
  const cfg = Config.load(_loadConfigText());

  // 3. ASSET BOOT.  Talk speech files: resolve the cfg's attack/die filenames to
  //    the shipped uppercase data files, fetch latin-1, build the talk pools.
  let attackPool: string[] = [];
  let diePool: string[] = [];
  try {
    const attackName = _resolveTalkName(String(cfg.ATTACK_COMMENTS));
    const dieName = _resolveTalkName(String(cfg.DIE_COMMENTS));
    const [attackText, dieText] = await Promise.all([
      attackName ? assets.fetchText(attackName) : Promise.resolve(""),
      dieName ? assets.fetchText(dieName) : Promise.resolve(""),
    ]);
    attackPool = talk._parse(attackText);
    diePool = talk._parse(dieText);
    diag.log.info("assets: talk loaded attack=%d die=%d lines", attackPool.length, diePool.length);
  } catch (e) {
    diag.log.warning("assets: talk load failed (%s); taunts disabled this session", String(e));
  }
  // park the loaded pools so the engine integrator can build talk.TalkConfig from
  // them (the engine constructs the per-game TalkConfig from cfg + these pools).
  _talkPools = { attack: attackPool, die: diePool };

  // .MTN catalog: fetch every mountain file and register a SYNCHRONOUS byte source
  // with sprites, so sprites.load_title_mountain (called during the menu's sync
  // render) and the .MTN terrain path decode the ORIGINAL assets without an async
  // re-fetch.  (Previously only the cache was warmed; the byte source was never
  // wired, so the title panel fell back to a gradient with no mountain.)
  try {
    const names = await assets.listMtnFiles();
    const mtnBytes = new Map<string, Uint8Array>();
    await Promise.all(
      names.map(async (n) => {
        try {
          mtnBytes.set(n.toUpperCase(), await assets.fetchBytes(n));
        } catch (e) {
          diag.log.warning("assets: .MTN fetch failed %s (%s)", n, String(e));
        }
      }),
    );
    sprites.setMtnByteSource((nm) => mtnBytes.get(nm.toUpperCase()) ?? null);
    // Sorted by name to match Python's sorted(glob("1.5/*.MTN")) (game.py:127), so
    // .MTN terrain SELECTION (rng.pick into this array) is deterministic AND identical
    // to the oracle.  The Map's iteration order is async fetch-completion order, which
    // is neither -- the Phase-3 gate caught this as an .MTN-path divergence.
    setMtnRanges(
      [...mtnBytes]
        .map(([name, data]) => ({ name, data }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
    diag.log.info("assets: %d .MTN files, byte source + %d terrain ranges wired", names.length, mtnBytes.size);
  } catch (e) {
    diag.log.warning("assets: MTN preload failed (%s)", String(e));
  }

  // 4. IndexedDB save store -> screens.
  const saveStore = new IndexedDbSaveStore();
  try {
    await saveStore.hydrate();
  } catch {
    /* hydrate already logs; session-only saves still work. */
  }
  setSaveStoreProvider(saveStore);

  // 5. sprites bundle -> render + screens (no-op until the integrator wires one).
  if (_sprites !== null) {
    setRenderSprites(_sprites as never);
    setScreensSprites(_sprites as never);
    diag.log.info("assets: sprites bundle wired into render + screens");
  } else {
    diag.log.warning("assets: no sprites bundle wired; sprite cells render empty (chrome only)");
  }
  // Choose Target gate: render.ts reads ingame._in_choose_target via a predicate.
  // _in_choose_target is module-private in ingame.ts (only the higher-level
  // weapon_needs_target/in_target_mode are exported), so the integrator wires the
  // render predicate from the engine; left at its default here.

  // 6. input.
  const pageCanvas = document.getElementById("game") as HTMLCanvasElement;
  _installInput(pageCanvas);

  // 7. App on a logical 1024x768 backbuffer; carry the loaded cfg onto it so the
  //    App constructor adopts it (App reads surface._cfg).
  const [rw, rh] = cfg.resolution;
  const backbuffer = new pygame.Surface([rw, rh]);
  (backbuffer as unknown as { _cfg: Config })._cfg = cfg;
  const app = new App(backbuffer, fullscreen, mayhem, fpsSecs);

  diag.log.info(
    "boot complete: menu up (%dx%d, fullscreen=%s, mayhem=%s, saves=%d)",
    rw,
    rh,
    fullscreen,
    mayhem,
    saveStore.list().length,
  );

  // RAF loop: drain the event queue, step the App, request the next frame.  Stops
  // when App.step returns false (running=False).  An exception out of step()
  // propagates (the boundary already logged it) and halts the loop, surfacing the
  // crash rather than spinning a broken frame.
  const frame = (nowMs: number): void => {
    const events = _eventQueue.splice(0, _eventQueue.length);
    const cont = app.step(nowMs, events);
    if (cont) {
      requestAnimationFrame(frame);
    } else {
      diag.log.info("app stopped; loop halted");
    }
  };
  requestAnimationFrame(frame);
}

/** The talk pools loaded at boot, exposed for the engine integrator to build the
 *  per-game talk.TalkConfig (the engine owns when taunts fire). */
export let _talkPools: { attack: string[]; die: string[] } = { attack: [], die: [] };

/** Resolve a cfg talk filename ("talk1.cfg") to the shipped uppercase asset name
 *  in the .MTN-style asset dir, matching talk._resolve's DOS case-insensitive open.
 *  Returns the uppercased basename (the staged files ship uppercase). */
function _resolveTalkName(name: string): string | null {
  if (!name) {
    return null;
  }
  // strip any directory part; the assets dir is flat (public/assets/).
  const base = name.replace(/^.*[/\\]/, "");
  return base.toUpperCase();
}

// ---------------------------------------------------------------------------
// Auto-boot when loaded as the page entry (not under vitest/Node).  The DOM gate
// keeps this import-safe for the differential test (which imports the module to
// exercise _wants_zoom_wipe / _ZoomWipeMath and must NOT start a RAF loop).
// ---------------------------------------------------------------------------
if (typeof document !== "undefined" && document.getElementById("game") !== null) {
  // Integrator wiring: the seams (setGameStateFactory / setSpritesBundle) were
  // built before game.ts and sprites.ts existed; now they do, so supply the real
  // engine + art and boot.  Guarded by the DOM check so the vitest import of this
  // module (DOM-free, exercises only _ZoomWipeMath) neither wires nor boots.
  setGameStateFactory(createGameState);
  setSpritesBundle(sprites);
  void boot();
}

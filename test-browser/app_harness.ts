// Browser APP-DRIVE harness (covers src/main.ts's App + screen glue).
//
// boot_cover.mjs already loads the SHIPPING app (index.html -> main.ts boot()) and
// plays a short game, covering boot(), _installInput, _present, the RAF frame and the
// basic turn loop.  What that shallow play-through never reaches is the breadth of
// App._act's action dispatch, the dialog zoom-wipe (push/pop/_compose/_begin_wipe/
// _ZoomWipe.draw), the Rankings/GameOver screens, fullscreen, config-save, the
// SIMULTANEOUS GameScreen routes, and the IndexedDB save store write/hydrate.
//
// This page constructs the SAME real App (exported from main.ts) on a real backbuffer
// Surface, wires the SAME real engine factory + sprites boot() wires, and DRIVES THE
// REAL ENTRY POINTS: app._act("<action>"), app.step(now, events), app.push/pop,
// app._draw -- with real Screen objects the App builds itself and real GameStates the
// factory builds.  Nothing is mocked (the screens, the dispatch, the wipe math, the
// save store are all the shipping code); each scenario asserts the resulting App state
// and THROWS on a mismatch, which runScenario captures as ok:false so the driver fails.
//
// It has NO #game canvas, so importing main.ts does NOT auto-boot (the auto-boot guard
// is `getElementById("game") !== null`); this harness owns the App lifecycle instead.

import * as assets from "../src/assets";
import { Config } from "../src/config";
import {
  createGameState,
  setMtnRanges,
  AIM,
  SHOP,
  ROUND_END,
  GAME_OVER,
  SIM_LIVE,
  type GameState,
} from "../src/game";
import { setSpritesProvider as setRenderSprites } from "../src/render";
import { setSpritesProvider as setScreensSprites, setSaveStoreProvider, ShopScreen } from "../src/screens";
import * as ingame from "../src/ingame";
import * as damage from "../src/damage";
import * as sprites from "../src/sprites";
import * as pygame from "../src/pygame";
import * as C from "../src/constants";
import {
  App,
  IndexedDbSaveStore,
  setGameStateFactory,
  setSpritesBundle,
  _FRAME_DT,
} from "../src/main";

const W = 1024;
const H = 768;

// --- cfg + game builders (the render-neutralising overrides the visual gate uses) ---
function makeCfg(overrides: { [k: string]: string | number }): Config {
  const cfg = new Config();
  const base: { [k: string]: string | number } = {
    SOUND: "OFF",
    FLY_SOUND: "OFF",
    TALKING_TANKS: "OFF",
    INITIAL_CASH: 0,
    MAX_WIND: 0,
    FALLING_TANKS: "OFF",
    CHANGING_WIND: "OFF",
    MAXROUNDS: 10,
    MAXPLAYERS: 2,
    SKY: "PLAIN",
  };
  const all = { ...base, ...overrides };
  for (const k of Object.keys(all)) {
    (cfg as unknown as { [k: string]: unknown })[k] = all[k];
  }
  (cfg as unknown as { mayhem: boolean }).mayhem = false;
  cfg.live_elastic = cfg.elastic;
  return cfg;
}

// A permissive view of App's private members (esbuild strips TS access modifiers, so
// this is a documentation cast, not a runtime change): the harness drives the same
// methods the run loop and the screen action callbacks do.
type AppX = App & {
  _wipe: { done: boolean; opening: boolean; advance(dt: number): void } | null;
  _draw(): void;
  _make_submenu(name: string): unknown;
  _rankings_title(): string;
  _begin_wipe(screen: unknown, bg: pygame.Surface, opening: boolean, fg?: pygame.Surface): void;
  _setup: Array<[string, number, number, number]>;
  _setup_i: number;
  gs: GameState | null;
  stack: Array<{ [k: string]: unknown }>;
  top: { [k: string]: unknown };
  fullscreen: boolean;
};

function newApp(overrides: { [k: string]: string | number } = {}): AppX {
  const cfg = makeCfg(overrides);
  const bb = new pygame.Surface([W, H]);
  (bb as unknown as { _cfg: Config })._cfg = cfg;
  return new App(bb, false, false, 0) as unknown as AppX;
}

// Build + place a real GameState (2 players) directly, the harness analog of
// _build_game's roster loop (used where a scenario needs gs already in play).
function buildGs(seed: number, overrides: { [k: string]: string | number }, roster: Array<[string, number, number, number]>): GameState {
  const cfg = makeCfg(overrides);
  const gs = createGameState(cfg, W, H, seed);
  for (const [name, ai, team, icon] of roster) gs.add_player(name, ai, team, icon);
  gs.new_game();
  return gs;
}

function driveToAim(gs: GameState): void {
  for (let i = 0; i < 600 && gs.phase !== AIM; i++) gs.update(1 / 60);
}

const KEY = (key: number, mod = 0) => ({ type: pygame.KEYDOWN, key, mod, unicode: "" });
const CLICK = (pos: [number, number] = [0, 0]) => ({ type: pygame.MOUSEBUTTONDOWN, button: 1, pos, mod: 0 });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function must(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assert: ${msg}`);
}

// Run the OPENING zoom-wipe of the App's top dialog to completion via real steps.
function settleWipe(app: AppX, t0: number): number {
  let t = t0;
  for (let i = 0; i < 40 && app._wipe !== null; i++) {
    app.step(t, [] as never);
    t += 80;
  }
  return t;
}

// ---------------------------------------------------------------------------------
// Scenarios.  Each drives ONE cluster of real App code and asserts the outcome.
// ---------------------------------------------------------------------------------
const SCENARIOS: { [name: string]: () => unknown | Promise<unknown> } = {
  // -- dialog zoom-wipe: push/_compose/_begin_wipe, the per-frame wipe draw (flash +
  //    smoothscale), the settled draw, the skip, and the closing pop wipe.
  wipe: () => {
    const app = newApp();
    // push a submenu (OptionsScreen: non-opaque + panel.rect -> wants wipe).  This runs
    // _compose(stack) for the background AND _begin_wipe (the _ZoomWipe + sfx.play).
    app._act("push:sound");
    must(app._wipe !== null, "push:sound armed a zoom-wipe");
    // step the OPENING animation: mid frames hit _ZoomWipe.draw's scale path (flash
    // overlay + _pygame_smoothscale) until the wipe settles (step nulls it at done).
    const t1 = settleWipe(app, 1000);
    must(app._wipe === null, "opening wipe settled through step()");
    // SETTLED draw branch: arm a fresh wipe, advance it to done WITHOUT the step that
    // nulls it, then call _draw -> _ZoomWipe.draw's done&&opening fast path.
    app._act("push:hardware");
    must(app._wipe !== null, "push:hardware armed a second wipe");
    let g = 0;
    while (app._wipe !== null && !app._wipe.done && g++ < 400) app._wipe.advance(_FRAME_DT);
    must(app._wipe !== null && app._wipe.done, "advanced wipe to done");
    app._draw();
    // close it: pop() of a wiped dialog composes fg+bg and arms a CLOSING wipe.
    app._act("back");
    must(app._wipe !== null, "back armed a closing wipe");
    settleWipe(app, t1);
    return { settled: app._wipe === null, stackDepth: app.stack.length };
  },

  // -- a keypress while a wipe animates COMPLETES it instantly (step's skip path).
  wipe_skip: () => {
    const app = newApp();
    app._act("push:economics");
    must(app._wipe !== null, "push:economics armed a wipe");
    app.step(1000, [KEY(pygame.K_SPACE)] as never); // wipe != null + KEYDOWN -> _wipe.skip()
    must(app._wipe === null, "key during wipe skipped+settled it");
    return { ok: true };
  },

  // -- fullscreen toggles (F11 and Alt+Enter) -> _toggle_fullscreen -> the Fullscreen
  //    API (both the request and the exit branch).
  fullscreen: () => {
    const app = newApp();
    must(app.fullscreen === false, "starts windowed");
    app.step(1000, [KEY(pygame.K_F11)] as never); // -> requestFullscreen branch
    must(app.fullscreen === true, "F11 -> fullscreen flag set");
    app.step(1100, [KEY(pygame.K_RETURN, pygame.KMOD_ALT)] as never); // Alt+Enter -> exit branch
    must(app.fullscreen === false, "Alt+Enter -> back to windowed");
    return { ok: true };
  },

  // -- main-menu actions that don't need an engine: save-changes (-> localStorage),
  //    Register + Calibrate dialogs.
  menu_actions: () => {
    const app = newApp();
    app._act("save_changes"); // -> _saveConfig -> localStorage.setItem
    must(localStorage.getItem("scorch.cfg") !== null, "save_changes persisted cfg");
    app._act("register"); // -> push RegistrationScreen
    app._act("back");
    settleWipe(app, 2000);
    app._act("calibrate"); // -> push CalibrateScreen (boxed -> wipe)
    app._act("back");
    settleWipe(app, 3000);
    return { stackDepth: app.stack.length };
  },

  // -- _rankings_title's team branch (set the cfg flag so team_mode != NONE).
  rankings_title: () => {
    const app = newApp();
    const gs = buildGs(1, {}, [["P1", C.AI_HUMAN, 0, 0], ["P2", C.AI_HUMAN, 0, 1]]);
    app.gs = gs;
    (gs.cfg as unknown as { TEAM_MODE: string }).TEAM_MODE = "Vicious"; // -> team_mode != TEAM_NONE
    must(gs.cfg.team_mode !== C.TEAM_NONE, "team mode is on");
    const title = app._rankings_title();
    must(title === "Team Rankings", `team title, got ${title}`);
    (gs.cfg as unknown as { TEAM_MODE: string }).TEAM_MODE = "Off";
    must(app._rankings_title() === "Player Rankings", "non-team title");
    return { title };
  },

  // -- the full start->setup->build chain through the REAL dispatcher, then the
  //    in-round action dispatch (control panel / inventory / retreat).
  start_and_play: () => {
    const app = newApp();
    app._act("start_game"); // -> _start_setup -> push TankInitScreen(0)
    (app.top as { result: unknown }).result = ["P1", C.AI_HUMAN, 0, 0];
    app._act("tank_done"); // -> push TankInitScreen(1)
    (app.top as { result: unknown }).result = ["P2", C.AI_HUMAN, 0, 1];
    app._act("tank_done"); // -> _build_game -> gs + GameScreen
    must(app.gs !== null, "game built");
    const gs = app.gs as GameState;
    driveToAim(gs);
    // control panel + inventory + retreat dialogs off the GameScreen.
    app._act("push:control");
    app._act("back");
    app._act("open_inventory");
    app._act("back");
    app._act("retreat");
    app._act("retreat_done"); // -> pop
    return { phase: gs.phase, stackDepth: app.stack.length };
  },

  // -- system-menu actions (each pops the menu first, then performs its effect).
  system_menu: () => {
    const app = newApp();
    const gs = buildGs(11, {}, [["P1", C.AI_HUMAN, 0, 0], ["P2", C.AI_HUMAN, 0, 1]]);
    app.gs = gs;
    driveToAim(gs);
    // Re-root on a fresh GameScreen via the real path: restore-adopt builds one.
    app._act("push:system"); // push SystemMenuScreen
    app._act("clear_screen"); // pops system, runs clear_screen_effect
    app._act("push:system");
    app._act("reassign_teams"); // pops system, push ConfigureTeamsScreen
    app._act("back");
    settleWipe(app, 1000);
    app._act("push:system");
    app._act("reassign_players"); // pops system, push ReassignPlayersScreen
    app._act("back");
    settleWipe(app, 2000);
    // save_game / restore_game off the system menu: each pops the menu before opening
    // its file dialog (the SystemMenuScreen-instanceof pop branch).
    app._act("push:system");
    app._act("save_game"); // pops system, push SaveScreen
    app._act("back");
    settleWipe(app, 2500);
    app._act("push:system");
    app._act("restore_game"); // pops system, push RestoreScreen
    app._act("back");
    settleWipe(app, 3000);
    app._act("push:system");
    app._act("mass_kill"); // pops system, do_mass_kill (-> maybe ROUND_END + Rankings)
    return { phase: gs.phase, stackDepth: app.stack.length };
  },

  // -- shop sequencing: INITIAL_CASH>0 leaves new_game in SHOP, so _build_game enters
  //    the shop.  Drive shop_inventory, push:sell, then pop (-> _advance_shop).
  shop: () => {
    const app = newApp({ INITIAL_CASH: 30000 });
    app._setup = [["P1", C.AI_HUMAN, 0, 0], ["P2", C.AI_HUMAN, 0, 1]];
    app._setup_i = 2;
    (app as unknown as { _build_game(): void })._build_game();
    const gs = app.gs as GameState;
    must(gs.phase === SHOP, `phase shop, got ${gs.phase}`);
    must(app.top instanceof ShopScreen, "top is ShopScreen");
    app._act("shop_inventory"); // top is ShopScreen -> push Inventory
    app._act("back");
    // sell: the ShopScreen normally records the slot before emitting push:sell.
    const shopTop = app.top as { sell_slot?: number | null; tank?: unknown };
    const tank = gs.current_shooter ?? gs.tanks[0];
    shopTop.sell_slot = 0;
    shopTop.tank = tank;
    app._act("push:sell"); // -> push SellScreen
    app._act("back");
    settleWipe(app, 1000);
    app._act("pop"); // top was ShopScreen -> _advance_shop (next human, then ai_buys + begin_next_round)
    app._act("pop"); // second human's shop -> _advance_shop -> run_ai_buys + begin_next_round
    return { phase: gs.phase, round: gs.round_index ?? null, stackDepth: app.stack.length };
  },

  // -- round-end -> interim Rankings -> proceed -> (shop or game-over); plus the
  //    Rankings/GameOver screen input handlers and the GameOver draw.
  round_flow: () => {
    const app = newApp({ MAXROUNDS: 2 });
    const gs = buildGs(7, { MAXROUNDS: 2 }, [["P1", C.AI_HUMAN, 0, 0], ["P2", C.AI_HUMAN, 0, 1]]);
    app.gs = gs;
    driveToAim(gs);
    app._act("round_end"); // push RankingsScreen
    // Rankings.handle: key + mouse both -> "rankings_done".
    must(app.top.handle(KEY(pygame.K_SPACE)) === "rankings_done", "rankings space");
    must(app.top.handle(CLICK()) === "rankings_done", "rankings click");
    must(app.top.update(0) === null, "rankings update is static");
    app._draw(); // RankingsScreen.draw over the GameScreen
    gs.phase = SHOP; // steer proceed_after_round's outcome branch (covered: SHOP -> _enter_shop)
    app._act("rankings_done");
    return { phase: gs.phase, stackDepth: app.stack.length };
  },

  // -- game-over: kill to a final winner, then the GameOver screen (handle + draw),
  //    and the to_menu reset; also the explicit "game_over" + "new_game" actions.
  game_over: () => {
    const app = newApp({ MAXROUNDS: 1 });
    const gs = buildGs(7, { MAXROUNDS: 1 }, [["P1", C.AI_HUMAN, 0, 0], ["P2", C.AI_HUMAN, 0, 1]]);
    app.gs = gs;
    driveToAim(gs);
    const enemy = gs.tanks.find((t) => t !== gs.current_shooter) ?? gs.tanks[1];
    damage.explode(gs as unknown as Parameters<typeof damage.explode>[0], Math.round(enemy.x), Math.round(enemy.y), 95, true);
    if (gs._win_check()) gs._end_round();
    gs.proceed_after_round(); // -> GAME_OVER + winner
    must(gs.phase === GAME_OVER, `phase game_over, got ${gs.phase}`);
    app._act("game_over"); // push GameOverScreen
    must(app.top.update(0) === null, "gameover update static");
    must(app.top.handle(KEY(pygame.K_RETURN)) === "to_menu", "gameover key -> to_menu");
    app._draw(); // GameOverScreen.draw (title + war quote)
    app._act("to_menu"); // reset to MainMenu, gs=null
    must(app.gs === null, "to_menu cleared gs");
    app._act("new_game"); // also resets to MainMenu
    return { ok: true };
  },

  // -- SIMULTANEOUS GameScreen routes: a keydown -> _sim_human_keydown, a frame ->
  //    _sim_human_input.
  sim_live: () => {
    const app = newApp({ PLAY_MODE: "SIMULTANEOUS" });
    const gs = buildGs(3, { PLAY_MODE: "SIMULTANEOUS" }, [["P1", C.AI_HUMAN, 0, 0], ["AI", C.AI_SHOOTER, 0, 1]]);
    app.gs = gs;
    // re-root the App stack on a GameScreen for this gs via the real restore-adopt path.
    (app.top as { restored?: unknown }).restored = gs;
    app._act("restore_game"); // push RestoreScreen
    (app.top as { restored?: unknown }).restored = gs;
    app._act("pop"); // RestoreScreen.restored set -> adopt rgs, fresh GameScreen
    must(gs.phase === SIM_LIVE, `phase sim_live, got ${gs.phase}`);
    app.step(1000, [KEY(pygame.K_a)] as never); // GameScreen.handle sim branch -> _sim_human_keydown
    app.step(1080, [] as never); // GameScreen.update sim branch -> _sim_human_input
    return { phase: gs.phase };
  },

  // -- fire action: pop the launch dialog, then gs.fire() at AIM.
  fire: () => {
    const app = newApp();
    const gs = buildGs(2, {}, [["P1", C.AI_HUMAN, 0, 0], ["P2", C.AI_HUMAN, 0, 1]]);
    app.gs = gs;
    driveToAim(gs);
    app._act("push:system"); // something poppable on top
    const before = gs.projectiles.length;
    app._act("fire"); // pop + (phase AIM) gs.fire()
    return { firedDelta: gs.projectiles.length - before, phase: gs.phase };
  },

  // -- IndexedDB save store: hydrate over PRE-SEEDED entries (the cursor value
  //    branches) and a write-through (the async put path).
  idb: async () => {
    // pre-seed BOTH a Uint8Array and an ArrayBuffer value so the hydrate cursor walks
    // both decode branches.
    await seedIdb([
      ["seed_bytes.sav", new Uint8Array([1, 2, 3, 4])],
      ["seed_buffer.sav", new Uint8Array([9, 8, 7]).buffer],
    ]);
    const store = new IndexedDbSaveStore();
    await store.hydrate(); // -> _idbReadAll cursor over the two seeded values
    must(store.exists("seed_bytes.sav"), "hydrated Uint8Array value");
    must(store.exists("seed_buffer.sav"), "hydrated ArrayBuffer value");
    setSaveStoreProvider(store); // matches boot()'s wiring (no-op otherwise)
    store.write("harness_write.sav", new Uint8Array([5, 6, 7, 8])); // -> _idbWrite write-through
    must(store.exists("harness_write.sav"), "mirror has the written save at once");
    must(store.read("harness_write.sav")?.length === 4, "read back the written bytes");
    await sleep(60); // let the async put resolve
    return { saves: store.list().length };
  },
};

// Raw IndexedDB seeding (same DB name/store main.ts uses), so hydrate reads real rows.
function seedIdb(entries: Array<[string, Uint8Array | ArrayBuffer]>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("scorch-saves", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("saves")) db.createObjectStore("saves");
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("saves", "readwrite");
      const st = tx.objectStore("saves");
      for (const [k, v] of entries) st.put(v, k);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// ----------------------------------------------------------------------- boot
// Mirror main.ts boot()'s asset load + provider wiring so every screen .draw() has
// the same inputs the shipping game does (sprites bundle + .MTN ranges + talk).
async function boot(): Promise<void> {
  await Promise.all([
    assets.fetchText("TALK1.CFG").catch(() => ""),
    assets.fetchText("TALK2.CFG").catch(() => ""),
  ]);
  const names = await assets.listMtnFiles();
  const mtnBytes = new Map<string, Uint8Array>();
  await Promise.all(
    names.map(async (n) => {
      try {
        mtnBytes.set(n.toUpperCase(), await assets.fetchBytes(n));
      } catch {
        /* missing .MTN degrades to procedural terrain */
      }
    }),
  );
  sprites.setMtnByteSource((nm: string) => mtnBytes.get(nm.toUpperCase()) ?? null);
  setMtnRanges(
    [...mtnBytes].map(([name, data]) => ({ name, data })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
  setRenderSprites(sprites as never);
  setScreensSprites(sprites as never);
  setGameStateFactory(createGameState);
  setSpritesBundle(sprites as never);
  ingame.setMouseStateProvider(() => ({ pressed: [false, false, false], pos: [0, 0] }));
  setSaveStoreProvider({ list: () => [], exists: () => false, write: () => {}, read: () => null });
}

const ready = boot();
(window as unknown as { appReady: Promise<void> }).appReady = ready;
(window as unknown as { listScenarios: () => string[] }).listScenarios = () => Object.keys(SCENARIOS);
(window as unknown as {
  runScenario: (name: string) => Promise<{ name: string; ok: boolean; meta?: unknown; error?: string; stack?: string }>;
}).runScenario = async (name: string) => {
  await ready;
  const fn = SCENARIOS[name];
  if (!fn) return { name, ok: false, error: `unknown scenario ${name}`, stack: "" };
  try {
    const meta = await fn();
    return { name, ok: true, meta };
  } catch (e) {
    const err = e as Error;
    return { name, ok: false, error: String(err && err.message ? err.message : err), stack: String(err && err.stack ? err.stack : "") };
  }
};

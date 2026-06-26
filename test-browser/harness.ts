// Browser render-crash harness (TS PORT side).
//
// PURPOSE: drive the REAL Renderer + screens through every visual state IN A REAL
// BROWSER and FAIL on any thrown exception.  Per-module node mocks (test/*.test.ts)
// stub the GameState the renderer reads, so they cannot catch a crash that lives in
// the integration between a real GameState's effect arrays and the draw code -- e.g.
// the just-fixed _draw_death_tiles / add_death_fountain options-object bug
// (game.ts:2012 comment), which only fires when a tank is REALLY killed via
// damage.explode and the real renderer then walks state.death_fountains.
//
// This module loads assets exactly like src/main.ts boot() (TALK*.CFG, the 10 .MTN
// byte source + terrain ranges, the sprites bundle wired into render + screens),
// then exposes window functions that BUILD a real GameState for a seed and render
// each visual state through the REAL path:
//   (a) in-battle frame at phase AIM
//   (b) mid-flight projectile (real gs.fire + _step_flight)
//   (c) EXPLOSION frame (real damage.explode -> add_explosion -> _draw_explosion)
//   (d) TANK-DEATH animation across ~30 frames (real kill -> death_fountains +
//       throe_fx -> _draw_death_tiles / _draw_throe_fx)
//   (e) ROUND-END / WIN  -> the interim rankings panel (RankingsScreen.draw path)
//   (f) LOSS / game end  -> GameOver final-scoring panel (GameOverScreen.draw path)
//   (g) ShopScreen.draw (the real screen object)
//   (h) in-game SystemMenuScreen.draw + ControlPanelScreen.draw (the real screens)
//
// A render path that throws is a REAL src bug: the per-state runner CAPTURES the
// stack and returns it as data (it does NOT swallow it to look green) so the
// playwright driver can report it and exit non-zero.  Nothing in src/ is modified
// to dodge a crash.

import * as assets from "../src/assets";
import { Config } from "../src/config";
import {
  createGameState,
  setMtnRanges,
  AIM,
  GAME_OVER,
  type GameState,
} from "../src/game";
import { Renderer, setSpritesProvider as setRenderSprites, setChooseTargetPredicate } from "../src/render";
import {
  setSpritesProvider as setScreensSprites,
  setSaveStoreProvider,
  ShopScreen,
  OptionsScreen,
  RegistrationScreen,
  SellScreen,
  InventoryScreen,
  TankInitScreen,
  SaveScreen,
} from "../src/screens";
import * as ingame from "../src/ingame";
import * as ui from "../src/ui";
import * as talk from "../src/talk";
import * as damage from "../src/damage";
import * as sprites from "../src/sprites";
import * as pygame from "../src/pygame";
import * as widgets from "../src/widgets";

const W = 1024;
const H = 768;

let PAGE: HTMLCanvasElement;

// --------------------------------------------------------------------------- cfg
// Same render-neutralising overrides the visual gate uses (visual/scenario_spec
// .json): sound OFF, taunts OFF (so no die-bubble lingers and blocks _end_round),
// wind pinned to 0.  SKY + MAXROUNDS vary per state.  live_elastic MUST be
// re-derived after construction (config.ts:391 __post_init__ trap).
function makeCfg(overrides: { [k: string]: string | number }): Config {
  const cfg = new Config();
  const base: { [k: string]: string | number } = {
    SOUND: "OFF",
    FLY_SOUND: "OFF",
    TALKING_TANKS: "OFF",
    INITIAL_CASH: 0,
    MAX_WIND: 0,
    FALLING_TANKS: "ON",
    MAXROUNDS: 10,
    SKY: "PLAIN",
  };
  const all = { ...base, ...overrides };
  for (const k of Object.keys(all)) {
    (cfg as unknown as { [k: string]: unknown })[k] = all[k];
  }
  (cfg as unknown as { mayhem: boolean }).mayhem = false;
  cfg.live_elastic = cfg.elastic; // re-resolve after any ELASTIC/override change
  return cfg;
}

// Build a real, placed GameState: two HUMAN players (ai_class 0), new_game ->
// start_round (INITIAL_CASH==0 path) lays terrain, places tanks, sets phase
// TURN_START.  mtn_ranges is LEFT as the wired .MTN ranges so the real .MTN
// terrain path (_from_mtn) is exercised, not just procedural _midpoint.
function buildState(seed: number, overrides: { [k: string]: string | number } = {}): GameState {
  const cfg = makeCfg(overrides);
  const gs = createGameState(cfg, W, H, seed);
  gs.add_player("Player 1", 0, 0, 0);
  gs.add_player("Player 2", 0, 0, 1);
  gs.new_game();
  return gs;
}

// One update() from TURN_START transitions a human shooter to AIM (game.ts:451 ->
// update TURN_START branch -> _begin_turn -> phase AIM, awaiting_human=true).  Loop
// with a cap in case a future change adds intermediate phases.
function driveToAim(gs: GameState): number {
  for (let i = 0; i < 600; i++) {
    if (gs.phase === AIM) return i;
    gs.update(1 / 60);
  }
  return -1;
}

function freshRenderer(gs: GameState): Renderer {
  return new Renderer(gs.cfg as unknown as ConstructorParameters<typeof Renderer>[0], W, H);
}

// Render a battlefield frame through the REAL renderer onto a fresh Surface and
// blit it to #game exactly like main.ts _present (drawImage(backbuffer.canvas)).
function blit(surf: pygame.Surface): void {
  const ctx = PAGE.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(surf.canvas, 0, 0);
}

function newSurf(): pygame.Surface {
  return new pygame.Surface([W, H]);
}

// The non-shooter tank (the kill victim for the death / round-end states).
function enemyOf(gs: GameState): GameState["tanks"][number] {
  const cur = gs.current_shooter;
  return gs.tanks.find((t) => t !== cur) ?? gs.tanks[1];
}

interface StateMeta {
  [k: string]: unknown;
}

// Run every panel widget's setter through its REAL accelerator path (Selector /
// Toggle / Spinner on_accel -> bound set_*) and type one printable char into any
// TextField, so the screen-builder SET closures (screens.ts _enum_selector set_idx,
// _toggle set_, _num_spinner set, the `text` and `display_*` bindings) execute --
// drawing alone only runs their getters.  NO try/catch: a setter that throws is a
// real bug runState must surface.
function sweepSetters(panel: { widgets: unknown[] }): void {
  for (const wAny of panel.widgets) {
    const w = wAny as { on_accel?: () => unknown; on_text_key?: (e: unknown) => void };
    if (typeof w.on_accel === "function") {
      w.on_accel();
    }
    if (typeof w.on_text_key === "function") {
      w.on_text_key({ type: pygame.KEYDOWN, key: 120, unicode: "x" }); // 'x' -> set()
    }
  }
}

// Each entry renders ONE visual state through the real path and returns metadata.
// A throw propagates to runState, which captures the stack.  The renderer is built
// ONCE per state and reused across animation frames (the real App holds one
// renderer for the whole game; a fresh renderer per frame would re-seed the sky LUT
// every frame and is NOT how the app animates).
const STATES: { [name: string]: () => StateMeta } = {
  // (a) in-battle frame at phase AIM.
  aim: () => {
    const gs = buildState(1, { SKY: "PLAIN" });
    const frames = driveToAim(gs);
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    blit(surf);
    return { phase: gs.phase, framesToAim: frames, tanks: gs.tanks.length, shooter: gs.current_shooter?.name };
  },

  // (b) mid-flight projectile: real fire -> phase FIRING with a projectile, then a
  //     few real _step_flight frames (gs.update at FIRING).
  flight: () => {
    const gs = buildState(2, { SKY: "STARS" });
    driveToAim(gs);
    const r = freshRenderer(gs);
    gs.fire(); // launch current shooter's Baby Missile (ballistic)
    const surf = newSurf();
    r.render(surf, gs); // launch frame: projectile object at the muzzle
    blit(surf);
    const atLaunch = gs.projectiles.length;
    // advance the flight a few rendered frames while it is still airborne
    for (let i = 0; i < 6 && gs.projectiles.length > 0 && gs.explosions.length === 0; i++) {
      gs.update(1 / 60);
      r.render(surf, gs);
      blit(surf);
    }
    return {
      phase: gs.phase,
      projectilesAtLaunch: atLaunch,
      projectilesNow: gs.projectiles.length,
      explosionsNow: gs.explosions.length,
    };
  },

  // (c) EXPLOSION frame: real damage.explode adds a live explosion (carve=true ->
  //     state.add_explosion) which _draw_explosion renders; then age it through its
  //     phase 0->1->2 transitions via the real _animate_effects.
  explosion: () => {
    const gs = buildState(3, { SKY: "SUNSET" });
    driveToAim(gs);
    const r = freshRenderer(gs);
    // detonate mid-field, away from the tanks (a real shell impact would do this).
    const cx = Math.trunc(W * 0.4);
    const cy = Math.trunc(H * 0.55);
    damage.explode(gs as unknown as Parameters<typeof damage.explode>[0], cx, cy, 60, true);
    const surf = newSurf();
    r.render(surf, gs);
    blit(surf);
    const born = gs.explosions.length;
    let maxPhase = 0;
    for (let i = 0; i < 10 && gs.explosions.length > 0; i++) {
      gs._animate_effects();
      for (const e of gs.explosions) maxPhase = Math.max(maxPhase, (e as { phase?: number }).phase ?? 0);
      r.render(surf, gs);
      blit(surf);
    }
    return { phase: gs.phase, explosionsBorn: born, explosionPhaseReached: maxPhase };
  },

  // (d) TANK-DEATH animation: a REAL lethal hit (damage.explode r=95 on the enemy
  //     tank) runs apply_tank_damage -> kill_tank -> on_tank_destroyed ->
  //     death.death_sequence, which spawns state.death_fountains + state.throe_fx.
  //     The real renderer then walks _draw_death_tiles / _draw_throe_fx across the
  //     ~30-frame ascension.  THIS is the path that caught the recent kill crash.
  death: () => {
    const gs = buildState(42, { SKY: "STORMY" });
    driveToAim(gs);
    const r = freshRenderer(gs);
    const enemy = enemyOf(gs);
    damage.explode(
      gs as unknown as Parameters<typeof damage.explode>[0],
      Math.round(enemy.x),
      Math.round(enemy.y),
      95,
      true,
    );
    const fountains0 = gs.death_fountains.length;
    const throesFromRoulette = gs.throe_fx.length;
    // The rand(11) death roulette (death.death_sequence) only spawns ONE throe kind
    // (or none) per kill, so a single kill leaves most of _draw_throe_fx's five
    // kind branches (spiral/ring/geyser/sparkle/sink) unexercised.  Spawn one of
    // EACH via the real emitter gs.add_throe so every throe-render branch runs --
    // this is the draw code a kill crash would live in.
    const cx = Math.trunc(W * 0.5);
    const cy = Math.trunc(H * 0.45);
    for (const kind of ["spiral", "ring", "geyser", "sparkle", "sink"]) {
      gs.add_throe(kind, cx, cy, enemy.color ?? 15);
    }
    const throesSpawned = gs.throe_fx.length;
    const surf = newSurf();
    let frames = 0;
    // frame 0 = fresh death tiles + every throe kind (the crash frame), then age
    // through the longest throe life (THROE_LIFE max = 46) so each kind's per-frame
    // sub-paths render and retire.
    for (let i = 0; i < 50; i++) {
      r.render(surf, gs); // _draw_death_tiles + _draw_throe_fx (all kinds) over the climb
      blit(surf);
      frames++;
      gs._animate_effects(); // climb the fountain, advance throe frames, retire dead ones
    }
    return {
      phase: gs.phase,
      deadEnemy: !enemy.alive,
      deathFountainsAtKill: fountains0,
      throesFromRoulette,
      throesSpawned,
      throesRemaining: gs.throe_fx.length,
      framesRendered: frames,
    };
  },

  // (e) ROUND-END / WIN -> interim rankings panel.  Real path: kill the enemy, run
  //     the real win check + _end_round (scoring.survival_award + scoring.rank),
  //     then render the battlefield with the rankings modal on top -- byte-identical
  //     to main.ts RankingsScreen.draw (opaque=false modal over GameScreen).
  rankings: () => {
    const gs = buildState(7, { SKY: "CAVERN", MAXROUNDS: 10 });
    driveToAim(gs);
    const enemy = enemyOf(gs);
    damage.explode(
      gs as unknown as Parameters<typeof damage.explode>[0],
      Math.round(enemy.x),
      Math.round(enemy.y),
      95,
      true,
    );
    const won = gs._win_check();
    if (won) gs._end_round(); // -> phase ROUND_END, ranking populated
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs); // GameScreen background (RankingsScreen is a modal)
    // RankingsScreen.draw (main.ts:1069): interim title + "N rounds remain.".
    const title = (gs.cfg as { team_mode?: number }).team_mode ? "Team Rankings" : "Player Rankings";
    const remain = gs.cfg.MAXROUNDS - (gs.round_index ?? 0);
    ui.draw_rankings(surf, r as never, gs as never, title, remain);
    blit(surf);
    return { phase: gs.phase, winChecked: won, roundIndex: gs.round_index, ranked: gs.ranking?.length ?? 0, remain };
  },

  // (f) LOSS / game end -> GameOver final-scoring panel.  Real path: MAXROUNDS=1 so
  //     after the round resolves, proceed_after_round() sets winner + phase
  //     GAME_OVER; render exactly like main.ts GameOverScreen.draw (title by winner
  //     presence, the war-quote drawn from gs.rng).
  gameover: () => {
    const gs = buildState(7, { SKY: "PLAIN", MAXROUNDS: 1 });
    driveToAim(gs);
    const enemy = enemyOf(gs);
    damage.explode(
      gs as unknown as Parameters<typeof damage.explode>[0],
      Math.round(enemy.x),
      Math.round(enemy.y),
      95,
      true,
    );
    if (gs._win_check()) gs._end_round();
    gs.proceed_after_round(); // round_index(1) >= MAXROUNDS(1) -> GAME_OVER + winner
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    const title = gs.winner ? "Final Scoring" : "No Winner";
    const quote = talk.war_quote(gs.rng as never) as [string, string];
    ui.draw_rankings(surf, r as never, gs as never, title, null, quote);
    blit(surf);
    return { phase: gs.phase, isGameOver: gs.phase === GAME_OVER, winner: gs.winner?.name ?? null, quote: quote[0] };
  },

  // (g) ShopScreen.draw -- the REAL screen object (screens.ts:1467).  gs satisfies
  //     ShopState (economy/cfg/round_index); the current shooter is the buying tank.
  //     Shop is opaque (full-bleed) but render the battlefield first anyway so any
  //     stray background read is exercised.
  shop: () => {
    const gs = buildState(5, { SKY: "PLAIN", INITIAL_CASH: 50000 });
    // INITIAL_CASH>0 leaves new_game in SHOP phase; tanks exist + are funded.
    // ShopScreen is OPAQUE (full-bleed): the real app never renders the battlefield
    // under it, so draw it onto a clean surface, matching main's stack.
    const tank = gs.current_shooter ?? gs.tanks[0];
    const surf = newSurf();
    const screen = new ShopScreen(gs as never, tank as never, W, H);
    screen.draw(surf);
    blit(surf);
    return { phase: gs.phase, tankCash: tank.cash, items: screen.items.length, category: screen.category };
  },

  // (h1) in-game SystemMenuScreen.draw -- the real modal (ingame.ts:1395), drawn
  //      over a live battlefield (its opaque=false dims behind itself).
  systemmenu: () => {
    const gs = buildState(11, { SKY: "STARS" });
    driveToAim(gs);
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    const screen = new ingame.SystemMenuScreen(gs as never);
    screen.draw(surf);
    blit(surf);
    return { phase: gs.phase };
  },

  // (h2) in-game ControlPanelScreen.draw -- the real control panel (ingame.ts:1005)
  //      for the current shooter, drawn over the battlefield.
  controlpanel: () => {
    const gs = buildState(11, { SKY: "STARS" });
    driveToAim(gs);
    const tank = gs.current_shooter ?? gs.tanks[0];
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    const screen = new ingame.ControlPanelScreen(gs as never, tank as never);
    screen.draw(surf);
    blit(surf);
    return { phase: gs.phase, tank: tank.name };
  },

  // (i) pygame primitive conformance -- the DOM-backed Surface paths the per-module
  //     node tests cannot reach (no canvas in vitest's node env) AND no game-render
  //     state happens to hit: Surface.get_rect(opts), the CSS-string color parse
  //     (normColor -> cssToRgba), the set_colorkey blit (_withColorkeyStripped), and
  //     the surfarray.blit_array length guard.  These are REAL assertions (a throw is
  //     captured by runState as ok:false -> non-zero exit), checked against pygame's
  //     documented semantics, then a multi-band surface is painted so the blank gate
  //     passes.  This is the sanctioned "add the state to test-browser" path for a
  //     browser-only pygame branch.
  pygame_primitives: () => {
    const fail = (m: string): never => {
      throw new Error(`pygame_primitives: ${m}`);
    };

    // -- Surface.get_rect(opts): a "virtual attribute" in opts MOVES the rect (keeps
    //    its w,h), matching pygame (pygame.ts:375-382).
    const s = new pygame.Surface([40, 30]);
    const rt = s.get_rect({ topleft: [5, 7] });
    if (rt.x !== 5 || rt.y !== 7 || rt.w !== 40 || rt.h !== 30) fail(`get_rect topleft ${rt.x},${rt.y},${rt.w}x${rt.h}`);
    const rc = s.get_rect({ center: [100, 80] });
    if (rc.centerx !== 100 || rc.centery !== 80 || rc.w !== 40 || rc.h !== 30) fail(`get_rect center ${rc.centerx},${rc.centery}`);

    // -- CSS string color -> RGBA via normColor/cssToRgba (pygame.ts:78-96).  First
    //    use builds the 1x1 probe canvas; a distinct color reuses it; a repeat hits
    //    the string cache.  Verify by painting the named color and reading it back.
    pygame.draw.rect(s, "red", new pygame.Rect(0, 0, 40, 30));
    let px = s.get_at([1, 1]);
    if (px[0] !== 255 || px[1] !== 0 || px[2] !== 0) fail(`css "red" -> ${px[0]},${px[1]},${px[2]}`);
    pygame.draw.rect(s, "lime", new pygame.Rect(0, 0, 40, 30)); // distinct: probe reused
    px = s.get_at([1, 1]);
    if (px[0] !== 0 || px[1] !== 255 || px[2] !== 0) fail(`css "lime" -> ${px[0]},${px[1]},${px[2]}`);
    pygame.draw.rect(s, "red", new pygame.Rect(0, 0, 40, 30)); // repeat: cache hit
    px = s.get_at([1, 1]);
    if (px[0] !== 255 || px[1] !== 0 || px[2] !== 0) fail(`css "red" (cached) -> ${px[0]},${px[1]},${px[2]}`);

    // -- set_colorkey blit: pixels equal to the key are made transparent on blit
    //    (_withColorkeyStripped, pygame.ts:459,468-482), so the destination shows
    //    through there while non-key pixels paint.
    const src = new pygame.Surface([10, 10]); // constructed opaque BLACK [0,0,0]
    pygame.draw.rect(src, [9, 9, 9], new pygame.Rect(0, 0, 5, 10)); // left half non-key
    src.set_colorkey([0, 0, 0]); // black is the key (the right half stays black)
    const dst = new pygame.Surface([10, 10]);
    dst.fill([200, 100, 50]); // background the keyed pixels must reveal
    dst.blit(src, [0, 0]);
    const keyed = dst.get_at([7, 5]); // right half was the key -> background reveals
    if (keyed[0] !== 200 || keyed[1] !== 100 || keyed[2] !== 50) fail(`colorkey NOT stripped: ${keyed[0]},${keyed[1]},${keyed[2]}`);
    const kept = dst.get_at([2, 5]); // left half non-key -> painted over
    if (kept[0] !== 9 || kept[1] !== 9 || kept[2] !== 9) fail(`colorkey OVER-stripped: ${kept[0]},${kept[1]},${kept[2]}`);

    // -- surfarray.blit_array length guard (pygame.ts:762-765): a mis-sized buffer
    //    MUST throw (silent mispaint is the failure mode it guards).
    let guardThrew = false;
    try {
      pygame.surfarray.blit_array(new pygame.Surface([4, 4]), new Uint8Array(4 * 4 * 3 - 1));
    } catch (e) {
      guardThrew = true;
      const msg = String((e as Error).message);
      if (!msg.includes("blit_array")) fail(`blit_array guard wrong error: ${msg}`);
    }
    if (!guardThrew) fail("blit_array length guard did not throw");

    // paint a multi-band surface so the driver's non-blank gate passes.
    const page = newSurf();
    for (let i = 0; i < 8; i++) {
      page.fill([(i * 30) & 255, (255 - i * 20) & 255, (i * 53) & 255], new pygame.Rect(i * 128, 0, 128, H));
    }
    blit(page);

    return {
      getRectTopleft: [rt.x, rt.y],
      getRectCenter: [rc.centerx, rc.centery],
      cssRoundTrip: true,
      colorkeyStripped: true,
      blitArrayGuardThrew: guardThrew,
    };
  },

  // ===========================================================================
  // SCREENS / WIDGETS build+draw states (cluster: screens,ingame,ui,widgets).
  // The per-module node tests cannot construct font-measured widgets (no canvas in
  // vitest's node env), and the boot driver only walks MainMenu -> TankInit(human)
  // -> battlefield, so the Option submenus, the Registration/Sell/Inventory/Save
  // panels, the AI-radio Tank-Init branch, and the Simultaneous key-capture Frames
  // are never built or drawn.  Each state builds the REAL screen through its real
  // (font-measuring) constructor and draws it; a throw is captured by runState
  // (ok:false -> non-zero exit), and the painted panel passes the blank gate.
  // ===========================================================================

  // (s1) Hardware submenu: covers OptionsScreen._hw_attrs init, _build's enum /
  //      toggle / enum_hw_pointer / float / int / action arms, the _enum_selector /
  //      _toggle / _num_spinner builders + _f2 (float fmt), and -- via the second
  //      _build call with synthetic display rows -- the display_int / display_toggle
  //      arms (a documented widget kind no SUBMENUS spec currently uses; the Python
  //      oracle carries the same branches at screens.py:638,649).  draw runs every
  //      getter; sweepSetters runs every setter.
  options_hardware: () => {
    const cfg = makeCfg({});
    const screen = new OptionsScreen(cfg as never, W, H, "hardware");
    (screen as unknown as { _build(rows: unknown[]): void })._build([
      ["display_int", "_hw_hardware_delay", "~HW Delay:", 0, 500],
      ["display_toggle", "_hw_mouse_enabled", "~Mouse Enabled"],
    ]);
    const surf = newSurf();
    surf.fill(widgets.C_BG);
    screen.draw(surf);
    sweepSetters((screen as unknown as { panel: { widgets: unknown[] } }).panel);
    screen.draw(surf); // re-render after the setter sweep mutated the bindings
    blit(surf);
    return { spec: "hardware", widgets: (screen as unknown as { panel: { widgets: unknown[] } }).panel.widgets.length };
  },

  // (s2) Play Options submenu: covers the `text` row arm (editable filename
  //      TextField); sweepSetters' on_text_key runs the bound string setter.
  options_play: () => {
    const cfg = makeCfg({});
    const screen = new OptionsScreen(cfg as never, W, H, "play_options");
    const surf = newSurf();
    surf.fill(widgets.C_BG);
    screen.draw(surf);
    sweepSetters((screen as unknown as { panel: { widgets: unknown[] } }).panel);
    screen.draw(surf);
    blit(surf);
    return { spec: "play_options", attack: String((cfg as unknown as { ATTACK_COMMENTS: unknown }).ATTACK_COMMENTS) };
  },

  // (s3) Weapons submenu: covers the weapon_list build (_build_weapon_list /
  //      _refresh_weapon_toggles incl the scroll-window break), the wheel-scroll
  //      handler, and the "(scroll for more weapons)" draw hint.
  options_weapons: () => {
    const cfg = makeCfg({});
    const screen = new OptionsScreen(cfg as never, W, H, "weapons");
    const h = screen as unknown as { handle(e: unknown): unknown; scroll: number };
    h.handle({ type: pygame.MOUSEBUTTONDOWN, button: 5, pos: [W / 2, 300] }); // wheel down
    h.handle({ type: pygame.MOUSEBUTTONDOWN, button: 5, pos: [W / 2, 300] });
    h.handle({ type: pygame.MOUSEBUTTONDOWN, button: 4, pos: [W / 2, 300] }); // wheel up
    const surf = newSurf();
    surf.fill(widgets.C_BG);
    screen.draw(surf);
    blit(surf);
    return { spec: "weapons", scroll: h.scroll };
  },

  // (s4) Registration / about panel: covers the ctor's widest-line font.size() loop
  //      and the draw's per-line blit loop (RegistrationScreen).
  registration: () => {
    const cfg = makeCfg({});
    const screen = new RegistrationScreen(cfg as never, W, H);
    const surf = newSurf();
    screen.draw(surf); // RegistrationScreen.draw fills C_BG itself
    blit(surf);
    return { opaque: (screen as unknown as { opaque: boolean }).opaque };
  },

  // (s5) Inventory panel: covers screens._owned_offensive (the in-ctor weapon-slot
  //      build), drawn over a live battlefield.
  inventory: () => {
    const gs = buildState(13, { SKY: "STARS" });
    driveToAim(gs);
    const tank = gs.current_shooter ?? gs.tanks[0];
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    const screen = new InventoryScreen(gs as never, tank as never, W, H);
    screen.draw(surf);
    blit(surf);
    return { phase: gs.phase, slots: (screen as unknown as { weapon_slots: number[] }).weapon_slots.length };
  },

  // (s6) Sell Equipment dialog: covers the quantity Spinner's bound setter
  //      (SellScreen.setq, this.qty = trunc(v)) via a real adjust, plus _offer/draw.
  sell: () => {
    const gs = buildState(13, { SKY: "STARS" });
    driveToAim(gs);
    const tank = gs.current_shooter ?? gs.tanks[0];
    const slot = 1; // Missile (offensive); fund it so owned >= 1
    (tank as unknown as { inventory: number[] }).inventory[slot] = 5;
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    const screen = new SellScreen(gs as never, tank as never, slot, W, H);
    (screen as unknown as { qty_spin: { adjust(d: number): void } }).qty_spin.adjust(3); // -> setq
    screen.draw(surf);
    blit(surf);
    return { qty: (screen as unknown as { qty: number }).qty, slot };
  },

  // (s7) Tank-Init in SIMULTANEOUS mode (human): the panel builds six capture Frames
  //      (the 6-key bind block).  Drawing the panel covers widgets.Frame.draw -- both
  //      the title-tab branch and the capture branch; frame[0] is armed first so the
  //      "press a key..." (arming) sub-branch and the C_SEL border also render.
  tankinit_sim: () => {
    const cfg = makeCfg({ PLAY_MODE: "SIMULTANEOUS" });
    const screen = new TankInitScreen(cfg as never, W, H, 0);
    const frames = (screen as unknown as { sim_frames: { arming: boolean }[] }).sim_frames;
    if (frames.length > 0) {
      frames[0].arming = true; // exercise Frame.draw's arming sub-branch + C_SEL
    }
    const surf = newSurf();
    screen.draw(surf);
    blit(surf);
    return { simFrames: frames.length, isComputer: (screen as unknown as { is_computer: boolean }).is_computer };
  },

  // (s8) Tank-Init with the AI (Computer) top region selected: covers the
  //      is_computer draw branch that _covers the name slot via _rect_union
  //      (screens._rect_union, the Rect.union helper).
  tankinit_cpu: () => {
    const cfg = makeCfg({});
    const screen = new TankInitScreen(cfg as never, W, H, 1);
    (screen as unknown as { is_computer: boolean }).is_computer = true;
    const surf = newSurf();
    screen.draw(surf);
    blit(surf);
    return { isComputer: (screen as unknown as { is_computer: boolean }).is_computer };
  },

  // (s9) Save dialog with an EXISTING file: the commit raises the yes/no confirm
  //      instead of clobbering (SaveScreen._commit's exists() branch + _build_confirm
  //      modal).  Wire a save store whose exists() is true for this state only.
  save_confirm: () => {
    setSaveStoreProvider({
      list: () => [],
      exists: () => true, // force the "file exists -> confirm" branch
      write: () => {},
      read: () => null,
    });
    const gs = buildState(13, { SKY: "STARS" });
    driveToAim(gs);
    const r = freshRenderer(gs);
    const surf = newSurf();
    r.render(surf, gs);
    const screen = new SaveScreen(gs as never, W, H);
    (screen as unknown as { name: string }).name = "savetest";
    (screen as unknown as { _commit(): unknown })._commit(); // -> _build_confirm
    const confirm = (screen as unknown as { _confirm: { draw(s: pygame.Surface, f: boolean): void } | null })._confirm;
    screen.draw(surf);
    if (confirm) {
      confirm.draw(surf, true); // ensure the confirm modal paints
    }
    blit(surf);
    // restore the neutral (no-op) save store so later states are unaffected.
    setSaveStoreProvider({ list: () => [], exists: () => false, write: () => {}, read: () => null });
    return { hasConfirm: confirm !== null };
  },
};

// ----------------------------------------------------------------------- boot
// Mirror src/main.ts boot() asset loading + provider wiring so every render path
// has the same inputs the shipping game does.
async function boot(): Promise<void> {
  // TALK speech files (latin-1).  Not strictly needed (taunts are OFF) but loaded
  // to match the app boot and keep the talk module's asset path exercised.
  await Promise.all([
    assets.fetchText("TALK1.CFG").catch(() => ""),
    assets.fetchText("TALK2.CFG").catch(() => ""),
  ]);

  // The 10 .MTN files -> sprites byte source + game terrain ranges (main.ts:1385).
  const names = await assets.listMtnFiles();
  const mtnBytes = new Map<string, Uint8Array>();
  await Promise.all(
    names.map(async (n) => {
      try {
        mtnBytes.set(n.toUpperCase(), await assets.fetchBytes(n));
      } catch {
        /* a missing .MTN degrades to procedural terrain; not fatal here */
      }
    }),
  );
  sprites.setMtnByteSource((nm: string) => mtnBytes.get(nm.toUpperCase()) ?? null);
  setMtnRanges(
    [...mtnBytes]
      .map(([name, data]) => ({ name, data }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );

  // sprites bundle -> render + screens (main.ts:1423-1424).
  setRenderSprites(sprites as never);
  setScreensSprites(sprites as never);

  // Neutral save store + mouse state + choose-target predicate, matching the boot
  // seams main.ts wires (so a screen that reads them gets a real, neutral value
  // instead of hitting an unwired hook -- that would be a HARNESS bug, not a src
  // bug).  A no-op save store is correct: the shop/menu draws never read it.
  setSaveStoreProvider({
    list: () => [],
    exists: () => false,
    write: () => {},
    read: () => null,
  });
  ingame.setMouseStateProvider(() => ({ pressed: [false, false, false], pos: [0, 0] }));
  setChooseTargetPredicate(() => false);

  PAGE = document.getElementById("game") as HTMLCanvasElement;
  PAGE.width = W;
  PAGE.height = H;
}

const ready = boot();

(window as unknown as { harnessReady: Promise<void> }).harnessReady = ready;
(window as unknown as { listStates: () => string[] }).listStates = () => Object.keys(STATES);

// Run ONE state through the real render path.  Captures any thrown error WITH its
// stack and returns it as data -- the driver treats ok:false as a FAIL and exits
// non-zero.  This is reporting a real bug, not suppressing it (the canvas is left
// at whatever the last successful blit produced so the driver can still inspect it).
(window as unknown as {
  runState: (name: string) => Promise<{ name: string; ok: boolean; meta?: StateMeta; error?: string; stack?: string }>;
}).runState = async (name: string) => {
  await ready;
  const fn = STATES[name];
  if (!fn) return { name, ok: false, error: `unknown state ${name}`, stack: "" };
  try {
    const meta = fn();
    return { name, ok: true, meta };
  } catch (e) {
    const err = e as Error;
    return { name, ok: false, error: String(err && err.message ? err.message : err), stack: String(err && err.stack ? err.stack : "") };
  }
};

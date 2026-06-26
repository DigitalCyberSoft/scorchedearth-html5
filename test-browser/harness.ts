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
import { setSpritesProvider as setScreensSprites, setSaveStoreProvider, ShopScreen } from "../src/screens";
import * as ingame from "../src/ingame";
import * as ui from "../src/ui";
import * as talk from "../src/talk";
import * as damage from "../src/damage";
import * as sprites from "../src/sprites";
import * as pygame from "../src/pygame";

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

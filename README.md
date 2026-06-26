# Scorched Earth - HTML5 / TypeScript Port

A browser reimplementation of **Scorched Earth v1.5** (1995, DOS) by **Wendell Hicken** -
"The Mother of All Games" - running natively on TypeScript + Canvas2D + Web Audio.
No plugins, no WASM, no Python or DOS runtime: open it and play.

### Play it now: https://digitalcybersoft.github.io/scorchedearth-html5/

Nothing to install - it is a static HTML5 page that runs in the browser.

It reproduces the original's turn-based tank artillery - destructible terrain, the
weapon shop, the computer players, the physics and wind, the economy and scoring -
reconstructed function-for-function and verified against the original's behavior.

## Credit: Wendell Hicken

Scorched Earth, subtitled "The Mother of All Games," was created by **Wendell Hicken**
and distributed as shareware for DOS. The original is Copyright (c) 1991-1995 Wendell
Hicken. All rights to Scorched Earth - its name, design, artwork, sound, terrain data,
and original code - belong to him. His site is `whicken.com`.

This project is an independent, **non-commercial tribute**. It is **not affiliated
with, endorsed by, or supported by Wendell Hicken**. The game design is entirely his;
this port only re-expresses its mechanics in TypeScript so the game can run in a
browser today. If you want the genuine article, seek out Wendell Hicken's original.

## How it was built, and how faithful it is

This is not a fresh interpretation - it is a *verified reimplementation*:

1. The original DOS binary was reverse-engineered **statically** (it is never executed)
   into a function-for-function **Python/pygame port**
   ([scorchedearth-python](https://github.com/DigitalCyberSoft/scorchedearth-python)),
   itself differential-tested against the recovered machine code.
2. This HTML5 build is a TypeScript rewrite of that Python port, with the Python port
   as the **oracle**: every module is proven to reproduce its Python counterpart.

The verification:

- **15,064 differential tests** (`npm test`, vitest) assert the TypeScript reproduces
  the Python port's output **exactly** (integers, pixels, bytes) or within a tight
  epsilon (transcendental math only). The RNG reproduces CPython's Mersenne Twister
  bit-for-bit; the game engine is checked by 25,814 turn/round state snapshots; the
  sprites by ~8M pixel assertions.
- A **visual regression gate** (`visual/`, `bash visual/run_gate.sh`) renders identical
  seeded game states through both the TypeScript Canvas renderer and the Python pygame
  renderer and pixel-diffs them. The game **world** - sky, terrain, tanks - comes out
  **byte-identical** (zero channel delta). Only on-screen text differs, because a
  browser's font rasterizer is not pygame's; that is expected and reported separately.

The original binary is never run by anything in this repository.

## Play

Open **https://digitalcybersoft.github.io/scorchedearth-html5/** in any modern browser.
There is nothing to install - it is a static HTML5 page (Canvas2D + Web Audio +
JavaScript). A short loading bar fetches the assets, then the menu appears.

Controls: Left/Right aim the turret, Up/Down adjust power, Tab cycles weapons,
Space or Enter fires, number keys select a tank, F11 toggles fullscreen, Esc backs
out. The menus, the weapon shop, and the in-game control panel (battery, parachute,
shield) are mouse-driven.

## Building from source (developers only)

The game is written in TypeScript and compiled **once** to the browser JavaScript that
ships above; players never run any of this. It is only for modifying the code.

```bash
npm install
npm run dev          # dev server at http://localhost:5173
npm run build        # static bundle into dist/ (what GitHub Pages serves)
npm test             # the 15,064 differential tests against the Python oracle
```

## The original assets

This repository **includes** Wendell Hicken's original v1.5 data files under
`public/assets/` - the 10 `.MTN` digitized mountains, `TALK1.CFG` / `TALK2.CFG` tank
taunts, and `SCORCH.ICO` - so the game plays with the genuine landscapes and taunts out
of the box. **These files are Wendell Hicken's property**, included only to keep this
tribute faithful and immediately playable; they are not the authors' to license. The
engine also runs without them (procedural terrain, gradient title, no taunts).

## How the code is organized

| Module | Reverses |
|--------|----------|
| `rng.ts` | CPython Mersenne Twister, bit-exact (the determinism linchpin) |
| `constants.ts` | byte-verified physics / damage / scoring / color-band constants |
| `terrain.ts` | the pixel framebuffer, terrain generation, carve / deposit / settle |
| `physics.ts` | the projectile integrator (gravity, wind, viscosity, speed clamp) |
| `weapons.ts`, `weapon_behaviors.ts` | the 48-item table; rollers, diggers, MIRV, laser, riot |
| `damage.ts`, `death.ts`, `hazard.ts` | radial damage, shields, fall damage, death throes, sky hazards |
| `ai.ts`, `guidance.ts` | the seven computer types and the aiming oracle |
| `economy.ts`, `scoring.ts` | the free-market shop, interest, scoring and rankings |
| `game.ts` | the round / turn loop, fire / impact pipeline, win test |
| `pygame.ts` | a faithful pygame API over Canvas2D (Surface, draw, surfarray, font) |
| `render.ts`, `ui.ts`, `widgets.ts`, `screens.ts`, `ingame.ts` | rendering, HUD, menus, shop, dialogs |
| `sprites.ts`, `palette.ts`, `sound.ts` | the recovered art + `.MTN` decoder, color tables, Web Audio |
| `mtn.ts` | the `.MTN` terrain-photo decoder |
| `main.ts` | the requestAnimationFrame loop, input, state machine, asset boot, IndexedDB saves |

`oracle/` holds the Python vector dumpers; `test/` the differential suite; `visual/`
the rendering gate.

## License and use

The TypeScript, HTML, and CSS authored in this repository are the authors' own work
and grant no rights to Scorched Earth itself. Game mechanics and rules, as distinct
from a specific implementation, are generally understood not to be protected by
copyright in the US; this port reimplements only the mechanics. Scorched Earth, its
name, and all of its assets remain the property of Wendell Hicken. Please treat this
as a personal, non-commercial tribute for play and study.

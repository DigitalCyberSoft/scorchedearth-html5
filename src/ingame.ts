/**
 * In-game (in-round) mouse/keyboard input -- a faithful TypeScript port of
 * scorch-py/scorch/ingame.py (the fidelity oracle), drawn against src/pygame.ts.
 *
 * Mirrors the v1.5 in-round interaction model (port/INTERACTION.md: pickers
 * FUN_1a69_0002 + FUN_54e7_0533 and the manual SCORCH.DOC), plus the two
 * direct-from-round modal dialogs (Tank Control Panel, System Menu) and the
 * Reassign Players / Retreat / confirm screens.
 *
 * BUTTON CONVENTION (INTERACTION.md "The button-bit convention"; FUN_54e7_0533 ->
 * INT 33h fn 03h: bit0=LEFT, bit1=RIGHT):
 *   LEFT click  = decrease / previous          (pygame event.button == 1)
 *   RIGHT click = increase / next              (pygame event.button == 3)
 *   BOTH buttons down at once = FIRE           (mask == 3; via mouse.get_pressed())
 *
 * NUMERIC SUBSTRATE vs DRAWN PIXELS / DOM (read before testing):
 *   The differential gate (test/ingame.test.ts) runs in Node, DOM-free, so it
 *   exercises only the LOGIC that touches neither pygame.font (Canvas2D) nor the
 *   mouse-state provider nor pygame.draw: the weapon-cycle owned-list rotation,
 *   the Choose-Target sub-mode (gate / nearest-tank / by-number / set_target),
 *   the fuel move sub-mode key router, the info box, the status-cell control
 *   effects, battery-discharge value logic, and the Clear-Screen / Mass-Kill
 *   effects. That LOGIC reproduces the oracle exactly.
 *
 *   The HUD hit-box geometry (hud_hitboxes) measures pygame.font (DOM) and the
 *   bar-click / hold-ramp paths read the mouse-state provider, so they are NOT in
 *   the node gate; their pixels + live-mouse behaviour defer to the Phase-3 visual
 *   gate (pixelsDeferredToPhase3 = true). The four Screen classes build
 *   widgets.Panel with font-measured Label/Button, so -- exactly like the widgets/
 *   ui screens -- they can only be CONSTRUCTED in a browser (DOM); their full
 *   Panel.handle routing also defers to Phase 3.
 *
 * MOUSE-STATE HOOK (integrator): the Python module reads pygame.mouse.get_pressed()
 *   / get_pos(). The shim (src/pygame.ts) has no pygame.mouse, and this agent may
 *   only touch ingame.ts, so the mouse state is wired to an integrator-supplied
 *   provider (setMouseStateProvider) exactly as widgets.ts wires the cursor / mouse
 *   position. Until a provider is set, both-buttons / hold-ramp default to "no
 *   mouse held" (an empty result), so a pure-keyboard session works unchanged.
 *
 * Public surface (what the main loop calls):
 *   handle_game_event(state, e)  -> action string | null
 *   update_game_input(state, dt, keys)
 *   ControlPanelScreen(state, tank)
 *   SystemMenuScreen()
 *
 * Action strings returned by handle_game_event:
 *   "open_control_panel" - LEFT-click on the player's name (or 't').
 *   "open_inventory"     - RIGHT-click on the player's name (or 'i').
 *   "target_set"         - a Choose Target pick was stored.
 *   "target_cancel"      - target mode left without a pick.
 *   "retreat"            - 'r' pressed.
 *   null                 - nothing actionable for the caller (the input was
 *                          applied in place: power/angle/weapon change, info box,
 *                          or fire).
 * Action strings returned by ControlPanelScreen.handle:
 *   "fire"  - ~Launch pressed (the caller should run state.fire())
 *   "back"  - Engage / ~Quit / Esc (leave the panel without firing)
 * Action strings returned by SystemMenuScreen.handle:
 *   "clear_screen", "mass_kill", "quit_game", "reassign_players",
 *   "reassign_teams", "save_game", "restore_game", "new_game", "back"
 */
import * as pygame from "./pygame";

import * as C from "./constants";
import * as movement from "./movement";
import * as weapons from "./weapons";
import * as widgets from "./widgets";
import { HumanController } from "./ui";

// ---------------------------------------------------------------------------
// Duck-typed structural shapes (the subset of fields the ported code reads).
// main.ts / the ported game-state supplies concrete objects with these members.
// ---------------------------------------------------------------------------

/** A pygame-shaped event as main.ts builds it (subset of fields read here). */
export interface IngameEvent {
  type: number;
  pos?: pygame.Point;
  button?: number;
  key?: number;
  unicode?: string;
}

/** A pygame.key.get_pressed()-shaped lookup: keys[K_*] is truthy when held. */
export type KeyState = { [code: number]: boolean } | boolean[];

/** The Tank fields the in-round input layer reads / mutates (objects.Tank). */
export interface Tank {
  // identity / control
  name: string;
  ai_class: number;
  player_index: number;
  // kinematics
  x: number;
  y: number;
  half_width: number;
  angle: number;
  power: number;
  // life
  health: number;
  alive: boolean;
  mobile: boolean;
  // defenses / selection
  shield_hp: number;
  shield_item: number;
  shield_push: boolean;
  shield_deflect: boolean;
  shield_laserproof: boolean;
  shield_failproof: boolean;
  parachute_deployed: boolean;
  contact_trigger: boolean;
  selected_guidance: number | null;
  guidance_target: Tank | null;
  guidance_target_pt: [number, number] | null;
  // economy / weapons
  inventory: number[];
  selected_weapon: number;
  fuel: number;
  fuel_remainder: number;
  cash: number;
  /** read-only derived count = inventory[SLOT_BATTERY] (objects.Tank.batteries). */
  readonly batteries: number;
  // scoring / display (read by ui.HumanController / the rankings, kept for the
  // HumanState structural bridge)
  color: number;
  win_counter: number;
  score: number;
  // methods
  has_ammo(slot: number): boolean;
}

/** The config object the input layer reads (Config dataclass). */
export interface Cfg {
  /** derived index: PLAY_MODE token -> 0/1/2 (SIMULTANEOUS == 2). */
  readonly play_mode: number;
  is_on(key: string): boolean;
  [key: string]: unknown;
}

/** The GameState subset the in-round input layer reads / mutates. */
export interface GameState {
  phase: string;
  current_shooter: Tank | null;
  tanks: Tank[];
  cfg: Cfg;
  w: number;
  h: number;
  terrain: movement.MovementTerrain;
  // transient round flags (created/cleared by this module + the renderer)
  target_mode?: boolean;
  move_mode?: boolean;
  info_box?: InfoBox | null;
  speech?: unknown;
  _hud_hitboxes?: { [control: string]: pygame.Rect } | null;
  _aim_hold?: { a: number; p: number; af: number; pf: number };
  // methods the orchestrator supplies
  fire(): void;
  retreat(tank: Tank): void;
  mass_kill(): void;
  _settle_tank(tank: Tank): void;
}

/** The info-box payload parked on state.info_box for the renderer. */
export interface InfoBox {
  tank: Tank;
  name: string;
  ai_class: number;
  score: number;
  shield: string;
  power: number;
}

/** The live mouse state the integrator supplies (pygame.mouse equivalent):
 *  `pressed` = [left, middle, right] held flags, `pos` = [x, y]. */
export interface MouseState {
  pressed: [boolean, boolean, boolean];
  pos: [number, number];
}

// ---------------------------------------------------------------------------
// Mouse-state integrator hook (the shim has no pygame.mouse; see header).
// ---------------------------------------------------------------------------
let _mouseStateProvider: (() => MouseState) | null = null;

/** Integrator hook: supply the live mouse state (pygame.mouse.get_pressed /
 *  get_pos equivalent). Until set, the bar uses "no mouse held" (keyboard-only). */
export function setMouseStateProvider(p: () => MouseState): void {
  _mouseStateProvider = p;
}

/** The current mouse state, or a neutral default (nothing held, cursor at 0,0)
 *  when no provider is wired -- a pure-keyboard session then behaves unchanged. */
function _mouseState(): MouseState {
  if (_mouseStateProvider === null) {
    return { pressed: [false, false, false], pos: [0, 0] };
  }
  return _mouseStateProvider();
}

// --------------------------------------------------------------------------
// In-round HUD hit-boxes (faithful to FUN_38b5_096e + section 8a/5b)
// --------------------------------------------------------------------------
// render.py records the rects it actually draws into state._hud_hitboxes each
// frame (keys: name, weapon, status_batt/para/shld/guid/trig/fuel).  The mouse
// layer tests against those live rects so clicks line up at any resolution.
// When no frame has been drawn yet (headless / pre-first-render), the rects are
// computed from the SAME formulas render.py uses, with a font built to match the
// renderer's (SysFont consolas/couriernew/monospace size 14, NOT the widgets
// default 15) so the fallback geometry is identical.
let _HUD_FONT: pygame.Font | null = null;
const _BAR_H = 22; // mirrors render.Renderer.BAR_H

function _hud_font(): pygame.Font {
  if (_HUD_FONT === null) {
    _HUD_FONT = pygame.font.SysFont("consolas,couriernew,monospace", 14);
  }
  return _HUD_FONT;
}

/** The readout text render.py draws.  FUN_38b5_1298.c:26-35 picks the format by
 *  slot: slot 0 (Baby Missile) is the NAME ALONE ("%s", DS 0x57d8); every other
 *  slot is "<count>: <name>" ("%d: %s", DS 0x57db). */
export function _weapon_label(t: Tank): string {
  const slot = t.selected_weapon;
  const item = weapons.ITEMS[slot];
  if (slot === weapons.SLOT_BABY_MISSILE) {
    return item.name;
  }
  return `${t.inventory[slot]}: ${item.name}`;
}

/** Return {control: pygame.Rect} for the clickable in-round HUD controls.
 *
 *  Prefers the rects render.py recorded this frame (state._hud_hitboxes); falls
 *  back to computing them from render.py's layout formulas when nothing has been
 *  drawn yet.  Status-bar cells are present only when cfg STATUS_BAR is ON.
 *
 *  DOM: this measures pygame.font (Canvas2D), so it is browser-only; the node gate
 *  does not call it (its pixels defer to Phase 3). */
export function hud_hitboxes(state: GameState): { [control: string]: pygame.Rect } {
  const rec = state._hud_hitboxes;
  if (rec) {
    return rec;
  }
  const t = state.current_shooter;
  const boxes: { [control: string]: pygame.Rect } = {};
  if (t === null) {
    return boxes;
  }
  const f = _hud_font();
  const w = state.w;
  // Power word (left cluster) - render.py: f"Power: {int(t.power)}" at x=6,y=4
  const elev = t.angle <= 90 ? t.angle : 180 - t.angle;
  const side = t.angle <= 90 ? "R" : "L";
  const pw_txt = `Power: ${Math.trunc(t.power)}`;
  boxes["power"] = new pygame.Rect(6, 4, f.size(pw_txt)[0], f.get_height());
  // Angle word - render.py: f"Angle: {elev}{side}" at x=150,y=4
  const an_txt = `Angle: ${elev}${side}`;
  boxes["angle"] = new pygame.Rect(150, 4, f.size(an_txt)[0], f.get_height());
  // name (centre of the top bar) - render.py: w//2 - nr.w//2, y=4
  const nr = f.size(t.name);
  const nx = Math.floor(w / 2) - Math.floor(nr[0] / 2);
  boxes["name"] = new pygame.Rect(nx, 4, nr[0], f.get_height());
  // weapon readout (far right) - render.py: x_icon = w-8-tw-icon_w-4, icon_w=14
  const label = _weapon_label(t);
  const tw = f.size(label)[0];
  const icon_w = 14;
  const x_icon = w - 8 - tw - icon_w - 4;
  boxes["weapon"] = new pygame.Rect(x_icon, 2, w - 8 - x_icon, f.get_height() + 2);
  // status-bar cells (only when enabled) - mirror render._draw_status_bar
  if (state.cfg.is_on("STATUS_BAR")) {
    const maxv = t.health <= 0 ? 0 : Math.trunc(t.power) * 10;
    const batt = t.inventory[weapons.SLOT_BATTERY];
    const para = t.inventory[weapons.SLOT_PARACHUTE];
    let shld_n = 0;
    for (const s of weapons.SHIELD_SLOTS) {
      shld_n += t.inventory[s];
    }
    const shld_pct = _shield_pct(t);
    let guid = 0;
    for (let i = 0; i < weapons.NUM_ITEMS; i++) {
      if (weapons.ITEMS[i].category === "guidance") {
        guid += t.inventory[i];
      }
    }
    const trig = t.inventory[weapons.SLOT_CONTACT_TRIGGER];
    const fuel = t.inventory[weapons.SLOT_FUEL];
    const cells: Array<[string | null, string]> = [
      [null, `Max: ${maxv}`],
      ["status_batt", `${batt} [batt]`],
      ["status_para", `${para} [para]`],
      ["status_shld", `${shld_n} [shlds] ${shld_pct}%`],
      ["status_guid", `${guid} [guid]`],
      ["status_trig", `${trig} [trig]`],
      ["status_fuel", `${fuel} [fuel]`],
    ];
    const sep_w = f.size("   ")[0];
    let x = 6;
    const ty = _BAR_H + 2;
    for (const [key, text] of cells) {
      const cw = f.size(text)[0];
      if (key !== null) {
        boxes[key] = new pygame.Rect(x, ty, cw, f.get_height());
      }
      x += cw + sep_w;
    }
  }
  return boxes;
}

/** Active shield HP as a percent of full (mirrors render._shield_pct). */
export function _shield_pct(t: Tank): number {
  if (t.shield_hp <= 0 || !t.shield_item) {
    return 0;
  }
  const params = weapons.ITEMS[t.shield_item].params;
  const full = typeof params["hp"] === "number" ? (params["hp"] as number) : 100;
  return Math.trunc(Math.max(0, Math.min(100, (t.shield_hp * 100) / Math.max(1, full))));
}

// --------------------------------------------------------------------------
// Button-mask helpers (INTERACTION.md "The button-bit convention")
// --------------------------------------------------------------------------
// pygame mouse buttons: 1 = left, 2 = middle, 3 = right.  The original's bit0 is
// LEFT, bit1 is RIGHT (FUN_54e7_0533 -> INT 33h fn 03h).  Detect both-buttons via
// the mouse-state provider (a single MOUSEBUTTONDOWN event carries only one).

/** True when LEFT and RIGHT are held simultaneously (= FIRE, mask 3). */
function _both_buttons_down(): boolean {
  const pressed = _mouseState().pressed;
  return Boolean(pressed[0]) && Boolean(pressed[2]);
}

/** LEFT button (event.button == 1) = decrease / previous (bit0). */
function _is_decrease(event: IngameEvent): boolean {
  return event.button === 1;
}

/** RIGHT button (event.button == 3) = increase / next (bit1). */
function _is_increase(event: IngameEvent): boolean {
  return event.button === 3;
}

// --------------------------------------------------------------------------
// Mouse hold-repeat for the Power / Angle words (INTERACTION.md TABLE A)
// --------------------------------------------------------------------------
// "As long as you hold the key or button, the number will continue to increase"
// (DOC:L451-463, cited in TABLE A).  The ramp is NOT reimplemented: a held mouse
// button over the Power/Angle word is mapped to the matching arrow key, and the
// existing ui.HumanController.update_continuous ramp consumes it.  Mapping:
//   Power word: RIGHT button -> UP arrow (power+), LEFT button -> DOWN arrow.
//   Angle word: RIGHT button -> RIGHT arrow (CW),  LEFT button -> LEFT arrow.
// So a press-and-hold accelerates exactly like the keyboard hold.

/** Wraps the real keys lookup and reports synthesized arrow keys as held while a
 *  mouse button is held over the Power/Angle word.  update_continuous reads
 *  through this proxy so there is one ramp, one state._aim_hold, identical
 *  acceleration to the keys (Python's immutable ScancodeWrapper analog). */
class _MouseKeyProxy {
  private _real: KeyState;
  private _extra: { [code: number]: boolean };

  constructor(real_keys: KeyState, extra: { [code: number]: boolean }) {
    this._real = real_keys;
    this._extra = extra;
  }

  // ui.keyHeld does `keys[code]`; a Proxy reproduces __getitem__ on indexing.
  static wrap(real_keys: KeyState, extra: { [code: number]: boolean }): KeyState {
    const inner = new _MouseKeyProxy(real_keys, extra);
    return new Proxy({} as { [code: number]: boolean }, {
      get(_target, prop): boolean {
        const key = Number(prop);
        if (inner._extra[key]) {
          return true;
        }
        return Boolean((inner._real as { [k: number]: boolean })[key]);
      },
    });
  }
}

/** Return the dict of arrow keys the currently-held mouse button maps to, given
 *  where the cursor is over the bar.  Empty when no relevant hold. */
function _mouse_hold_keys(state: GameState): { [code: number]: boolean } {
  const ms = _mouseState();
  const left = Boolean(ms.pressed[0]);
  const right = Boolean(ms.pressed[2]);
  if (left === right) {
    // neither, or both (both = FIRE, not a ramp)
    return {};
  }
  const boxes = hud_hitboxes(state);
  const pos = ms.pos;
  const extra: { [code: number]: boolean } = {};
  let r = boxes["power"];
  if (r !== undefined && r.collidepoint(pos)) {
    // RIGHT = power+ (UP), LEFT = power- (DOWN)
    extra[right ? pygame.K_UP : pygame.K_DOWN] = true;
  }
  r = boxes["angle"];
  if (r !== undefined && r.collidepoint(pos)) {
    // RIGHT = CW (RIGHT arrow), LEFT = CCW (LEFT arrow)
    extra[right ? pygame.K_RIGHT : pygame.K_LEFT] = true;
  }
  return extra;
}

/** Route one in-round input event, faithful to INTERACTION.md.
 *
 *  Returns an action string ('open_control_panel', 'open_inventory', 'target_set',
 *  'target_cancel', 'retreat') or null. */
export function handle_game_event(state: GameState, event: IngameEvent): string | null {
  if (state.phase !== "aim" || state.current_shooter === null) {
    return null;
  }
  if (state.current_shooter.ai_class !== C.AI_HUMAN) {
    return null;
  }

  if (event.type === pygame.MOUSEBUTTONDOWN && (event.button === 1 || event.button === 3)) {
    // 0. BOTH buttons at once = FIRE (mask 3; DOC:L201,L491).  Checked first so
    //    the second of the two presses fires rather than aiming.
    if (_both_buttons_down()) {
      state.fire();
      return null;
    }
    // 1. Choose Target picker owns clicks for guided weapons (TABLE E)
    if (_in_choose_target(state)) {
      return _handle_target_click(state, event);
    }
    // 2. HUD bar clicks (Power/Angle/name/weapon/status)
    const hud = _handle_hud_click(state, event);
    if (hud !== null) {
      return hud === "_consumed" ? null : hud;
    }
    // 3. tank body click -> info box (LEFT only; TABLE B, DOC:L538-541).  A
    //    LEFT-click off any tank dismisses an open box.
    if (_is_decrease(event)) {
      const tank = _tank_at(state, event.pos as pygame.Point);
      if (tank !== null) {
        show_info_box(state, tank);
      } else if (state.info_box !== undefined && state.info_box !== null) {
        show_info_box(state, null);
      }
    }
    return null;
  }

  if (event.type === pygame.KEYDOWN) {
    if (
      event.key === pygame.K_ESCAPE &&
      state.info_box !== undefined &&
      state.info_box !== null
    ) {
      show_info_box(state, null); // Esc closes the identify window
      return null;
    }
    if (event.key === pygame.K_t) {
      return "open_control_panel"; // 't' = Tank Control Panel
    }
    if (event.key === pygame.K_i) {
      return "open_inventory"; // 'i' = Inventory
    }
    if (event.key === pygame.K_r) {
      return "retreat"; // 'r' = retreat (SCORCH.DOC L520-528)
    }
    // 'f' = fuel-move sub-mode (manual DOC L1430 / INTERACTION.md TABLE F).
    // Inside it the bare LEFT/RIGHT arrows MOVE the tank; 'f'/Esc/Enter leave.
    const m = _handle_move_key(state, event);
    if (m !== null) {
      return m === "_consumed" ? null : m;
    }
    if (_in_choose_target(state)) {
      if (event.key === pygame.K_ESCAPE) {
        exit_target_mode(state);
        return "target_cancel";
      }
      if ((event.key as number) >= pygame.K_1 && (event.key as number) <= pygame.K_9) {
        return target_by_number(state, (event.key as number) - pygame.K_0);
      }
      if (event.key === pygame.K_0) {
        return target_by_number(state, 10);
      }
      return null;
    }
    HumanController.handle(state, event);
  }
  return null;
}

/** Per-frame held-input aim.  Reuses ui.HumanController.update_continuous (the
 *  slow, gently-accelerating ramp is the authority and is not duplicated): a
 *  mouse button held over the Power/Angle word is folded in via a key proxy so the
 *  bar's press-and-hold ramps identically to the arrow keys (TABLE A). */
export function update_game_input(state: GameState, dt: number, keys: KeyState): void {
  if (state.phase !== "aim" || state.current_shooter === null) {
    return;
  }
  if (state.current_shooter.ai_class !== C.AI_HUMAN) {
    return;
  }
  const extra = _mouse_hold_keys(state);
  if (Object.keys(extra).length > 0) {
    keys = _MouseKeyProxy.wrap(keys, extra);
  }
  HumanController.update_continuous(state, keys, dt);
}

// --------------------------------------------------------------------------
// Weapon cycling (click the weapon readout; INTERACTION.md TABLE A)
// --------------------------------------------------------------------------
// Cycle over OWNED OFFENSIVE weapons only (guidance, shields and utilities are
// not weapons; Baby Missile is always owned).  RIGHT-click = next (= TAB);
// LEFT-click = previous (= SHIFT-TAB).  No mouse-wheel cycle in the original.

function _owned_offensive(t: Tank): number[] {
  const out: number[] = [];
  for (let i = 0; i < weapons.NUM_ITEMS; i++) {
    if (weapons.ITEMS[i].offensive && t.has_ammo(i)) {
      out.push(i);
    }
  }
  return out;
}

/** Step the current shooter's selected weapon by +1 (next) or -1 (prev) over the
 *  owned offensive set.  Returns the new slot, or null if nothing to do. */
export function cycle_weapon(state: GameState, direction: number): number | null {
  const t = state.current_shooter;
  if (t === null) {
    return null;
  }
  const owned = _owned_offensive(t);
  if (owned.length === 0) {
    return null;
  }
  if (owned.includes(t.selected_weapon)) {
    const i = owned.indexOf(t.selected_weapon);
    t.selected_weapon = owned[pyMod(i + direction, owned.length)];
  } else {
    t.selected_weapon = owned[0];
  }
  return t.selected_weapon;
}

// --------------------------------------------------------------------------
// Fuel-move sub-mode  (manual DOC L1430; INTERACTION.md TABLE F: the move strip)
// --------------------------------------------------------------------------
// 'f' from the in-round HUD opens the move strip; while it is open the bare LEFT/
// RIGHT arrows step the tank 1px (FUN_3667_0443), consuming fuel; 'f'/Esc/Enter
// close it.  Gated on movement.can_move (FUN_27a8_00f2: mobile AND has fuel).

export function in_move_mode(state: GameState): boolean {
  return Boolean(state.move_mode);
}

/** Handle 'f' (toggle the move strip) and, while it is open, the LEFT/RIGHT
 *  arrows (= move 1px) and 'f'/Esc/Enter (= leave).  Returns '_consumed' when the
 *  key was a move-strip key (caller treats it as null), or null to fall through to
 *  the normal aim/weapon handlers. */
function _handle_move_key(state: GameState, event: IngameEvent): string | null {
  const t = state.current_shooter as Tank;
  if (event.key === pygame.K_f) {
    if (in_move_mode(state)) {
      state.move_mode = false; // 'f' again = leave the strip
    } else if (movement.can_move(t as unknown as movement.MovementTank)) {
      state.move_mode = true; // FUN_27a8_00f2 gate
    }
    return "_consumed"; // 'f' is always a move-strip key
  }
  if (!in_move_mode(state)) {
    return null; // arrows aim normally outside it
  }
  if (
    event.key === pygame.K_ESCAPE ||
    event.key === pygame.K_RETURN ||
    event.key === pygame.K_KP_ENTER
  ) {
    state.move_mode = false; // "Fuel Left" / finish moving
    return "_consumed";
  }
  if (event.key === pygame.K_LEFT) {
    movement.move_tank(state, t as unknown as movement.MovementTank, -1); // 1px left
    return "_consumed";
  }
  if (event.key === pygame.K_RIGHT) {
    movement.move_tank(state, t as unknown as movement.MovementTank, 1); // 1px right
    return "_consumed";
  }
  return null; // other keys: ignore in move mode
}

// --------------------------------------------------------------------------
// Choose Target  (faithful to FUN_1a69_0002, SCREENS.md section 15)
// --------------------------------------------------------------------------
// The original Choose Target picker: click an enemy tank (hit-test) or press its
// number; it stores the target into player +0xae/+0xb0 (target tank ptr) and
// +0x3a/+0x3c (click x/y).  Here Tank.guidance_target / Tank.guidance_target_pt.
// Which weapons NEED a target: the guidance items Heat/Bal/Horz/Vert/Lazy Boy
// (category 'guidance'); selecting one via the control panel arms a guidance.

const _TARGETABLE_GUIDANCE: Set<number> = (() => {
  const s = new Set<number>();
  for (let i = 0; i < weapons.ITEMS.length; i++) {
    if (weapons.ITEMS[i].category === "guidance") {
      s.add(i);
    }
  }
  return s;
})();

/** True when the current shooter has a guidance armed that wants a target. */
export function weapon_needs_target(state: GameState): boolean {
  const t = state.current_shooter;
  if (t === null) {
    return false;
  }
  return t.selected_guidance !== null && _TARGETABLE_GUIDANCE.has(t.selected_guidance);
}

export function in_target_mode(state: GameState): boolean {
  return Boolean(state.target_mode);
}

/** True while the Choose Target sub-mode is live: either a caller explicitly
 *  entered it, OR a guided weapon is armed and play mode is not Simultaneous (the
 *  entry gate in FUN_38b5_0fe1.c:15-24, INTERACTION.md TABLE E). */
function _in_choose_target(state: GameState): boolean {
  if (in_target_mode(state)) {
    return true;
  }
  if (state.cfg.play_mode === C.PLAYMODE_SIMULTANEOUS) {
    return false;
  }
  return weapon_needs_target(state);
}

/** Begin the Choose Target picker explicitly.  Returns true if a human shooter is
 *  active (so a caller can show the prompt), else false. */
export function enter_target_mode(state: GameState): boolean {
  const t = state.current_shooter;
  if (t === null || t.ai_class !== C.AI_HUMAN || state.phase !== "aim") {
    return false;
  }
  state.target_mode = true;
  return true;
}

export function exit_target_mode(state: GameState): void {
  state.target_mode = false;
}

/** The enemy tank whose body the point lands on, or null.  Mirrors the tank
 *  collision bbox (half_width wide, 0..10 tall up from the base) widened a little
 *  for a comfortable click target. */
function _tank_at(state: GameState, pos: pygame.Point): Tank | null {
  const x = pos[0];
  const y = pos[1];
  const shooter = state.current_shooter;
  for (const t of state.tanks) {
    if (!t.alive || t === shooter) {
      continue;
    }
    if (Math.abs(x - t.x) <= t.half_width + 4 && y - t.y >= -16 && y - t.y <= 4) {
      return t;
    }
  }
  return null;
}

/** Nearest LIVE tank (excluding the shooter) whose centre-of-base is within
 *  `radius` px of (x, y), or null.  Faithful to FUN_2fa0_0091(x,y,100): scans the
 *  tanks and returns the closest within the radius (FUN_2fa0_0091.c:18-30). */
function _nearest_tank_within(
  state: GameState,
  x: number,
  y: number,
  radius: number,
): Tank | null {
  const shooter = state.current_shooter;
  let best: Tank | null = null;
  let best_d = radius;
  for (const t of state.tanks) {
    if (!t.alive || t === shooter) {
      continue;
    }
    const d = Math.hypot(t.x - x, t.y - 4 - y); // centre of base (+0x3a/+0x3c)
    if (d <= best_d) {
      best_d = d;
      best = t;
    }
  }
  return best;
}

/** Store the chosen target on the shooter (player +0xae/+0xb0 and +0x3a/+0x3c
 *  analogs) and leave target mode. */
export function set_target(state: GameState, tank: Tank | null, pos: pygame.Point): void {
  const shooter = state.current_shooter;
  if (shooter === null) {
    return;
  }
  shooter.guidance_target = tank; // +0xae/+0xb0 (target ptr)
  shooter.guidance_target_pt = [Math.trunc(pos[0]), Math.trunc(pos[1])]; // +0x3a/+0x3c (x/y)
  exit_target_mode(state);
}

/** Choose Target sub-mode click handler, matching FUN_1a69_0002.c:49 exactly:
 *
 *    (button & 1) == 0  (RIGHT) -> nearest tank within 100 px is the homing
 *                                  target; its base x/y is stored; beep if none.
 *    else               (LEFT)  -> aim at the raw click point; tank-target cleared.
 *
 *  Returns 'target_set' (RIGHT found a tank, or LEFT stored a point) or null
 *  (RIGHT with no tank in range -> the original beeps and waits). */
function _handle_target_click(state: GameState, e: IngameEvent): string | null {
  if (e.type !== pygame.MOUSEBUTTONDOWN || (e.button !== 1 && e.button !== 3)) {
    return null;
  }
  const pos = e.pos as pygame.Point;
  if (_is_increase(e)) {
    // RIGHT: (button & 1) == 0
    const tank = _nearest_tank_within(state, pos[0], pos[1], 100);
    if (tank !== null) {
      set_target(state, tank, [tank.x, tank.y - 4]); // base centre
      return "target_set";
    }
    return null; // no tank in range: beep, wait
  }
  // LEFT: raw point; clear the tank target (+0xae/+0xb0 = 0)
  set_target(state, null, pos);
  return "target_set";
}

/** Press a tank's number to target it (faithful to the digit-key path in
 *  FUN_1a69_0002.c:81-89).  n is 1-based player number.  Returns 'target_set' or
 *  null. */
export function target_by_number(state: GameState, n: number): string | null {
  const idx = n - 1;
  const shooter = state.current_shooter;
  if (0 <= idx && idx < state.tanks.length) {
    const tank = state.tanks[idx];
    if (tank.alive && tank !== shooter) {
      set_target(state, tank, [tank.x, tank.y - 4]);
      return "target_set";
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Tank info box  (INTERACTION.md TABLE B; DOC:L538-541)
// --------------------------------------------------------------------------
// LEFT-click on a tank in the playfield shows that tank's info box: a small popup
// with name / owner / score / shield.  It is NOT the control panel.  The data is
// parked on state.info_box so the renderer can draw it.

/** Park a tank's info box on the GameState for the renderer to draw.  Set to null
 *  to clear.  Shape: {tank, name, ai_class, score, shield, power}. */
export function show_info_box(state: GameState, tank: Tank | null): void {
  if (tank === null) {
    state.info_box = null;
    return;
  }
  const shield_name = tank.shield_item ? weapons.ITEMS[tank.shield_item].name : "None";
  state.info_box = {
    tank: tank,
    name: tank.name,
    ai_class: tank.ai_class,
    score: tank.score,
    shield: shield_name,
    power: Math.trunc(tank.power),
  };
}

// --------------------------------------------------------------------------
// Status-bar cell clicks  (section 5b: fast access to control-panel items)
// --------------------------------------------------------------------------
// Each cell performs the same action as its Tank Control Panel control:
//   battery cell  -> discharge one battery for +10 health (section 7)
//   parachute     -> toggle parachute_deployed
//   trigger       -> toggle contact_trigger
//   shield/guid/fuel cells are read-only here (no single-click toggle in the
//     panel) -> a click there opens the control panel.

/** One battery -> +10 health, capped at full (matches ControlPanelScreen and
 *  ui.HumanController._use_battery). */
function _discharge_battery(t: Tank): boolean {
  if (t.inventory[weapons.SLOT_BATTERY] > 0 && t.health < C.TANK_DEFAULT_HEALTH) {
    t.inventory[weapons.SLOT_BATTERY] -= 1;
    t.health = Math.min(C.TANK_DEFAULT_HEALTH, t.health + 10);
    return true;
  }
  return false;
}

/** Run the control mapped to a status-bar cell.  Returns an action string
 *  ('open_control_panel' for the selector-backed cells) or null. */
export function _handle_status_click(state: GameState, key: string): string | null {
  const t = state.current_shooter;
  if (t === null) {
    return null;
  }
  if (key === "status_batt") {
    _discharge_battery(t);
    return null;
  }
  if (key === "status_para") {
    t.parachute_deployed = !t.parachute_deployed;
    return null;
  }
  if (key === "status_trig") {
    t.contact_trigger = !t.contact_trigger;
    return null;
  }
  // shield / guidance / fuel: panel-only controls -> open the panel
  return "open_control_panel";
}

/** Route a single LEFT/RIGHT click that landed on a top-bar / status-bar control,
 *  faithful to INTERACTION.md TABLE A.  Returns:
 *    'open_control_panel' / 'open_inventory'  - name clicks,
 *    '_consumed'  - the click was applied to a bar value in place; caller -> null,
 *    null         - the click was not on any HUD control (fall through).
 *
 *  DOM: calls hud_hitboxes (font), so it is browser-only; node gate skips it. */
function _handle_hud_click(state: GameState, e: IngameEvent): string | null {
  if (e.type !== pygame.MOUSEBUTTONDOWN || (e.button !== 1 && e.button !== 3)) {
    return null;
  }
  const t = state.current_shooter;
  if (t === null) {
    return null;
  }
  const boxes = hud_hitboxes(state);
  const pos = e.pos as pygame.Point;
  const inc = _is_increase(e); // RIGHT = increase/next
  // Power word: LEFT = power-1, RIGHT = power+1 (DOC:L451-463)
  let r = boxes["power"];
  if (r !== undefined && r.collidepoint(pos)) {
    t.power = Math.trunc(Math.max(0, Math.min(1000, t.power + (inc ? 1 : -1))));
    return "_consumed";
  }
  // Angle word: RIGHT = CW (arrow RIGHT, internal angle -1), LEFT = CCW (+1)
  r = boxes["angle"];
  if (r !== undefined && r.collidepoint(pos)) {
    t.angle = Math.trunc(Math.max(0, Math.min(180, t.angle + (inc ? -1 : 1))));
    return "_consumed";
  }
  // weapon readout: RIGHT = next (TAB), LEFT = previous (SHIFT-TAB)
  r = boxes["weapon"];
  if (r !== undefined && r.collidepoint(pos)) {
    cycle_weapon(state, inc ? 1 : -1);
    return "_consumed";
  }
  // player name: LEFT = Tank Control Panel ('t'), RIGHT = Inventory ('i')
  r = boxes["name"];
  if (r !== undefined && r.collidepoint(pos)) {
    return inc ? "open_inventory" : "open_control_panel";
  }
  // status-bar cells (any button; one keyed action per cell, TABLE C)
  for (const key of [
    "status_batt",
    "status_para",
    "status_shld",
    "status_guid",
    "status_trig",
    "status_fuel",
  ]) {
    r = boxes[key];
    if (r !== undefined && r.collidepoint(pos)) {
      const act = _handle_status_click(state, key);
      return act !== null ? act : "_consumed";
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Tank Control Panel  (SCREENS.md section 7)
// --------------------------------------------------------------------------
// Verbatim control pool [V]: Remaining Power, Energy Left, ~Fuel Remaining,
// ~Guidance (None when off), ~Parachutes, ~Triggers, ~Batteries, Shields, and the
// exit buttons ~Launch / Engage / ~Quit (NO "~Go").  Buying-free: it selects/
// toggles the tank's current defenses and guidance and can fire (~Launch).
//
// DOM: this builds widgets.Panel with font-measured Label/Button, so (like the
// widgets/ui screens) it can only be CONSTRUCTED in a browser; its Panel.handle
// routing + pixels defer to the Phase-3 gate.

const _GUIDANCE_SLOTS: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < weapons.ITEMS.length; i++) {
    if (weapons.ITEMS[i].category === "guidance") {
      out.push(i);
    }
  }
  return out;
})();

/** A Screen-protocol object (handle/update/draw), as the main loop expects. */
interface Screen {
  opaque?: boolean;
  handle(event: IngameEvent): string | null;
  update(dt: number): void;
  draw(surf: pygame.Surface): void;
}

/** Numeric modal for the manual battery discharge: "Batteries to discharge:"
 *  (DS 0x58c86).  A Spinner bounded 1..owned + ~Ok / ~Cancel.  On Ok, spends
 *  `count` batteries and adds +10 health each, capped at full
 *  (TANK_DEFAULT_HEALTH=100; recharge applier FUN_3a16_0fe8 += 10 at +0xa2).
 *
 *  Returns 'done' on Ok (after applying), 'back' on cancel/Esc, null otherwise. */
export class _BatteryDischargeScreen implements Screen {
  static readonly PROMPT = "Batteries to discharge:";

  state: GameState;
  tank: Tank;
  count: number;
  panel: widgets.Panel;

  constructor(state: GameState, tank: Tank) {
    this.state = state;
    this.tank = tank;
    this.count = 1;
    this.panel = this._build();
  }

  _owned(): number {
    return this.tank.inventory[weapons.SLOT_BATTERY];
  }

  _build(): widgets.Panel {
    const w = this.state.w;
    const h = this.state.h;
    const pw = Math.max(300, widgets.font(15).size(_BatteryDischargeScreen.PROMPT)[0] + 60);
    const ph = 110;
    const px = Math.floor((w - pw) / 2);
    const py = Math.floor((h - ph) / 2);
    const p = new widgets.Panel(px, py, pw, ph, "");
    p.add(new widgets.Label(px + 16, py + 16, _BatteryDischargeScreen.PROMPT));
    const owned = Math.max(1, this._owned());
    p.add(
      new widgets.Spinner(
        px + 16,
        py + 44,
        "",
        () => this.count,
        (v: number) => {
          this.count = Math.trunc(v);
        },
        1,
        owned,
        1,
        String,
        pw - 32,
      ),
    );
    p.add(new widgets.Button(px + 16, py + ph - 30, "~Ok", "ok", null, true));
    p.add(new widgets.Button(px + pw - 90, py + ph - 30, "~Cancel", "back"));
    return p;
  }

  _apply(): void {
    const t = this.tank;
    const n = Math.max(1, Math.min(this.count, this._owned()));
    for (let i = 0; i < n; i++) {
      if (t.inventory[weapons.SLOT_BATTERY] <= 0) {
        break;
      }
      if (t.health >= C.TANK_DEFAULT_HEALTH) {
        break; // full: stop spending (no waste)
      }
      t.inventory[weapons.SLOT_BATTERY] -= 1;
      t.health = Math.min(C.TANK_DEFAULT_HEALTH, t.health + 10);
    }
  }

  handle(event: IngameEvent): string | null {
    const act = this.panel.handle(event);
    if (act === "ok") {
      this._apply();
      return "done";
    }
    if (act === "back") {
      return "back";
    }
    return null;
  }

  update(_dt: number): void {
    /* static modal: nothing to advance */
  }

  draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    widgets.draw_cursor(surf);
  }
}

/** Modal Tank Control Panel built on widgets.Panel.  Conforms to the Screen
 *  protocol: handle(event)->action|null, update(dt), draw(surf). */
export class ControlPanelScreen implements Screen {
  state: GameState;
  tank: Tank;
  action: string | null;
  /** set when the panel closes with a guidance armed that needs a target
   *  (section 15 Choose Target).  Additive: the existing action strings are
   *  unchanged; the caller MAY read this after a 'back' to call enter_target_mode. */
  wants_target: boolean;
  /** overlay numeric modal for multi-battery discharge; null unless open. */
  discharge_modal: _BatteryDischargeScreen | null;
  panel!: widgets.Panel;

  // private selection-state mirrors built each _build()
  private _g_slots: (number | null)[] = [];
  private _s_slots: number[] = [];

  constructor(state: GameState, tank: Tank) {
    this.state = state;
    this.tank = tank;
    this.action = null;
    this.wants_target = false;
    this.discharge_modal = null;
    this.panel = this._build();
  }

  // ---- guidance options: [None] + the owned/known guidance items ----
  _guidance_options(): string[] {
    const opts: string[] = ["None"];
    const slots: (number | null)[] = [null];
    for (const slot of _GUIDANCE_SLOTS) {
      opts.push(weapons.ITEMS[slot].name);
      slots.push(slot);
    }
    this._g_slots = slots;
    return opts;
  }

  _g_index(): number {
    const cur = this.tank.selected_guidance;
    const i = this._g_slots.indexOf(cur);
    return i >= 0 ? i : 0;
  }

  _g_set(i: number): void {
    this.tank.selected_guidance = this._g_slots[pyMod(i, this._g_slots.length)];
  }

  // ---- shields: cycle owned shield slots (+ None); arm the chosen one ----
  _shield_options(): string[] {
    const opts: string[] = ["None"];
    const slots: number[] = [0];
    for (const slot of weapons.SHIELD_SLOTS) {
      opts.push(weapons.ITEMS[slot].name);
      slots.push(slot);
    }
    this._s_slots = slots;
    return opts;
  }

  _s_index(): number {
    const cur = this.tank.shield_item;
    const i = this._s_slots.indexOf(cur);
    return i >= 0 ? i : 0;
  }

  _s_set(i: number): void {
    const slot = this._s_slots[pyMod(i, this._s_slots.length)];
    const t = this.tank;
    if (slot === 0) {
      t.shield_item = 0;
      t.shield_hp = 0;
      return;
    }
    const p = weapons.ITEMS[slot].params;
    t.shield_item = slot;
    t.shield_hp = typeof p["hp"] === "number" ? (p["hp"] as number) : 100;
    t.shield_push = Boolean(p["push"]);
    t.shield_deflect = Boolean(p["deflect"]);
    t.shield_laserproof = Boolean(p["laserproof"]);
    t.shield_failproof = Boolean(p["failproof"]);
  }

  // ---- battery discharge: spend one battery for +10 health (section 7) ----
  _discharge_battery(): void {
    const t = this.tank;
    if (t.inventory[weapons.SLOT_BATTERY] > 0 && t.health < C.TANK_DEFAULT_HEALTH) {
      t.inventory[weapons.SLOT_BATTERY] -= 1;
      t.health = Math.min(C.TANK_DEFAULT_HEALTH, t.health + 10);
    }
  }

  _build(): widgets.Panel {
    const t = this.tank;
    const w = this.state.w;
    const h = this.state.h;
    const pw = 360;
    const ph = 320;
    const px = Math.floor((w - pw) / 2);
    const py = Math.floor((h - ph) / 2);
    const p = new widgets.Panel(px, py, pw, ph, "Tank Control Panel");
    const x = px + 16;
    let y = py + 32;
    const row = 26;

    // Remaining Power: spinner (player power 0..1000, step 5)
    p.add(
      new widgets.Spinner(
        x,
        y,
        "Remaining Power:",
        () => t.power,
        (v: number) => {
          t.power = Math.trunc(v);
        },
        0,
        1000,
        5,
        String,
        pw - 32,
      ),
    );
    y += row;
    // Energy Left: read-only (health); shown as a label
    p.add(new widgets.Label(x, y, `Energy Left: ${Math.max(0, Math.trunc(t.health))}`));
    y += row;
    // Fuel Remaining: live unit count + move strip.  'f' from the panel (manual
    // DOC L1430): a mobile tank with fuel gets left/right move buttons; a fixed
    // emplacement or an empty tank shows the count only (movement.can_move gates).
    p.add(new widgets.Label(x, y, `~Fuel Remaining: ${t.fuel}`));
    if (movement.can_move(t as unknown as movement.MovementTank)) {
      const bw = 40;
      p.add(new widgets.Button(px + pw - 16 - 2 * bw - 6, y - 2, "< Move", "move_left", bw));
      p.add(new widgets.Button(px + pw - 16 - bw, y - 2, "Move >", "move_right", bw));
    }
    y += row;
    // Guidance: None + the guidance items
    p.add(
      new widgets.Selector(
        x,
        y,
        "~Guidance",
        this._guidance_options(),
        () => this._g_index(),
        (i: number) => this._g_set(i),
        pw - 32,
      ),
    );
    y += row;
    // Parachutes: toggle parachute_deployed (count shown)
    p.add(
      new widgets.Toggle(
        x,
        y,
        `~Parachutes (${t.inventory[weapons.SLOT_PARACHUTE]})`,
        () => t.parachute_deployed,
        (v: boolean) => {
          t.parachute_deployed = Boolean(v);
        },
        pw - 32,
      ),
    );
    y += row;
    // Triggers: toggle contact_trigger (count shown)
    p.add(
      new widgets.Toggle(
        x,
        y,
        `~Triggers (${t.inventory[weapons.SLOT_CONTACT_TRIGGER]})`,
        () => t.contact_trigger,
        (v: boolean) => {
          t.contact_trigger = Boolean(v);
        },
        pw - 32,
      ),
    );
    y += row;
    // Batteries: discharge button (one battery -> +10 health)
    p.add(
      new widgets.Button(
        x,
        y,
        `~Batteries: ${t.inventory[weapons.SLOT_BATTERY]} (discharge +10)`,
        "discharge",
        pw - 32,
      ),
    );
    y += row;
    // Shields: cycle owned shields and arm the chosen one
    p.add(
      new widgets.Selector(
        x,
        y,
        "Shields",
        this._shield_options(),
        () => this._s_index(),
        (i: number) => this._s_set(i),
        pw - 32,
      ),
    );
    y += row + 6;

    // exit / commit buttons: ~Launch / Engage / ~Quit  (NO ~Go)
    const by = py + ph - 30;
    p.add(new widgets.Button(px + 14, by, "~Launch", "fire", null, true));
    p.add(new widgets.Button(px + 130, by, "Engage", "back"));
    p.add(new widgets.Button(px + pw - 80, by, "~Quit", "back"));
    return p;
  }

  // ---- Screen protocol ----------------------------------------------
  handle(event: IngameEvent): string | null {
    // a discharge-count modal is open: route events to it until it closes
    if (this.discharge_modal !== null) {
      const res = this.discharge_modal.handle(event);
      if (res === "done" || res === "back") {
        this.discharge_modal = null;
        this.panel = this._build(); // refresh the battery/health labels
      }
      return null;
    }
    const act = this.panel.handle(event);
    if (act === "discharge") {
      // >1 battery owned -> prompt for the count; exactly 1 (or none) -> discharge
      // directly, no prompt needed (gap 3).
      if (this.tank.inventory[weapons.SLOT_BATTERY] > 1) {
        this.discharge_modal = new _BatteryDischargeScreen(this.state, this.tank);
      } else {
        this._discharge_battery();
        this.panel = this._build(); // refresh the battery/health labels
      }
      return null;
    }
    if (act === "move_left" || act === "move_right") {
      movement.move_tank(
        this.state,
        this.tank as unknown as movement.MovementTank,
        act === "move_left" ? -1 : 1,
      );
      this.panel = this._build(); // refresh fuel count / drop buttons if empty
      return null;
    }
    if (act === "fire") {
      this.action = "fire";
      this._note_target_need();
      return "fire";
    }
    if (act === "back" || act === null) {
      if (act === "back") {
        this.action = "back";
        this._note_target_need();
      }
      return act;
    }
    return act;
  }

  /** On close, flag whether a guidance is armed that wants a target and none is
   *  set yet (additive; the caller MAY act on self.wants_target). */
  _note_target_need(): void {
    const g = this.tank.selected_guidance;
    this.wants_target = g !== null && _TARGETABLE_GUIDANCE.has(g) && this.tank.guidance_target === null;
  }

  update(_dt: number): void {
    /* static modal: nothing to advance */
  }

  draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    if (this.discharge_modal !== null) {
      this.discharge_modal.draw(surf); // overlay the count prompt on top
    } else {
      widgets.draw_cursor(surf);
    }
  }
}

// --------------------------------------------------------------------------
// System Menu  (SCREENS.md section 9)
// --------------------------------------------------------------------------
// Verbatim labels [V]: ~Clear Screen, ~Mass Kill, ~Quit Game, Reassign ~Players,
// Reassign ~Teams, Save ~Game, ~Restore Game, ~New Game.  Confirms use only ~Yes.

/** A System-Menu row triple. */
type MenuItem = [string, string, string | null];

/** Small modal confirm box: one prompt + a single ~Yes affirmative (the only
 *  confirm string in the binary).  Esc / click-outside cancels.  Returns the
 *  supplied action on Yes, 'back' on cancel. */
export class _ConfirmScreen implements Screen {
  state: SizeLike;
  prompt: string;
  on_yes: string;
  panel: widgets.Panel;

  constructor(state: SizeLike, prompt: string, on_yes_action: string) {
    this.state = state;
    this.prompt = prompt;
    this.on_yes = on_yes_action;
    this.panel = this._build();
  }

  _build(): widgets.Panel {
    const w = this.state.w;
    const h = this.state.h;
    const pw = Math.max(260, widgets.font(15).size(this.prompt)[0] + 40);
    const ph = 90;
    const px = Math.floor((w - pw) / 2);
    const py = Math.floor((h - ph) / 2);
    const p = new widgets.Panel(px, py, pw, ph, "");
    p.add(new widgets.Label(px + 16, py + 18, this.prompt));
    p.add(new widgets.Button(px + Math.floor(pw / 2) - 30, py + ph - 30, "~Yes", "yes", null, true));
    return p;
  }

  handle(event: IngameEvent): string | null {
    const act = this.panel.handle(event);
    if (act === "yes") {
      return this.on_yes;
    }
    if (act === "back") {
      return "back";
    }
    return null;
  }

  update(_dt: number): void {
    /* static modal */
  }

  draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    widgets.draw_cursor(surf);
  }
}

/** Two-step retreat confirm (the r-key).  Prompt 1 -> prompt 2 -> state.retreat().
 *  Single ~Yes at each step; Esc / click-outside aborts.  opaque=false so the
 *  battlefield shows dimmed behind it (SCORCH.DOC L520-528). */
export class RetreatScreen implements Screen {
  opaque = false;

  state: GameState;
  step: number;
  confirm: _ConfirmScreen;

  constructor(state: GameState) {
    this.state = state;
    this.step = 0;
    this.confirm = new _ConfirmScreen(state, "Do you want to retreat?", "yes");
  }

  handle(event: IngameEvent): string | null {
    const res = this.confirm.handle(event);
    if (res === null) {
      return null;
    }
    if (res === "back") {
      return "back"; // cancelled -> App pops back to AIM
    }
    if (this.step === 0) {
      this.step = 1; // prompt 1 confirmed -> prompt 2
      this.confirm = new _ConfirmScreen(
        this.state,
        "You seriously want to disgrace and humiliate yourself by retreating?",
        "yes",
      );
      return null;
    }
    this.state.retreat(this.state.current_shooter as Tank); // prompt 2 confirmed
    return "retreat_done";
  }

  update(_dt: number): void {
    /* static modal */
  }

  draw(surf: pygame.Surface): void {
    this.confirm.draw(surf);
  }
}

/** The System Menu dropdown (Alt-S / F1).  Conforms to the Screen protocol.
 *  Returns action strings the main loop handles; confirmed items raise an inner
 *  confirm box first (only ~Yes), and the confirmed action string is returned when
 *  the box is accepted.
 *
 *  Real System Menu layout, byte-resolved from the binary builder FUN_4891_01e8:
 *  TWO columns.  LEFT: Clear Screen, Mass Kill, Reassign Players, Reassign Teams,
 *  Sound(toggle).  RIGHT: Save Game, Restore Game, New Game, Quit Game. */
export class SystemMenuScreen implements Screen {
  static readonly LEFT: MenuItem[] = [
    ["~Clear Screen", "clear_screen", null],
    ["~Mass Kill", "mass_kill", "Mass kill everyone?"],
    ["Reassign ~Players", "reassign_players", null],
    ["Reassign ~Teams", "reassign_teams", null],
  ];
  static readonly RIGHT: MenuItem[] = [
    ["Save ~Game", "save_game", null],
    ["~Restore Game", "restore_game", null],
    ["~New Game", "new_game", "Do you really want to restart the game?"],
    ["~Quit Game", "quit_game", "Do you want to quit?"],
  ];

  state: GameState | null;
  _w: number;
  _h: number;
  confirm: _ConfirmScreen | null;
  panel!: widgets.Panel;
  _action_by_label: { [label: string]: [string, string | null] } = {};

  constructor(state: GameState | null = null) {
    // state is optional; only used to centre confirm boxes.  A tiny stub is used
    // for sizing if the caller omits it.
    this.state = state;
    this._w = state && typeof state.w === "number" ? state.w : 640;
    this._h = state && typeof state.h === "number" ? state.h : 480;
    this.confirm = null;
    this.panel = this._build();
  }

  _build(): widgets.Panel {
    const colw = 190;
    const gap = 12;
    const pw = 16 + colw * 2 + gap + 16;
    const ph = 26 * 5 + 36; // 5 rows (left column is the tallest)
    const px = Math.floor((this._w - pw) / 2);
    const py = Math.floor((this._h - ph) / 2);
    const p = new widgets.Panel(px, py, pw, ph, "System Menu");
    this._action_by_label = {};
    const lx = px + 16;
    const rx = px + 16 + colw + gap;
    const y0 = py + 28;
    for (let i = 0; i < SystemMenuScreen.LEFT.length; i++) {
      const [label, action, prompt] = SystemMenuScreen.LEFT[i];
      this._action_by_label[label] = [action, prompt];
      p.add(new widgets.Button(lx, y0 + i * 26, label, label, colw));
    }
    // Sound TOGGLE: left column row 5 (FUN_4891_01e8 L row5 = FUN_4f19_2f39).
    const cfg = this.state ? this.state.cfg : null;
    if (cfg !== null && cfg !== undefined) {
      p.add(
        new widgets.Toggle(
          lx,
          y0 + 4 * 26,
          "~Sound:",
          () => cfg.is_on("SOUND"),
          (v: boolean) => {
            (cfg as unknown as { SOUND: string }).SOUND = v ? "ON" : "OFF";
          },
          colw,
        ),
      );
    }
    for (let i = 0; i < SystemMenuScreen.RIGHT.length; i++) {
      const [label, action, prompt] = SystemMenuScreen.RIGHT[i];
      this._action_by_label[label] = [action, prompt];
      p.add(new widgets.Button(rx, y0 + i * 26, label, label, colw));
    }
    return p;
  }

  // ---- Screen protocol ----------------------------------------------
  handle(event: IngameEvent): string | null {
    // if a confirm box is up, route to it first
    if (this.confirm !== null) {
      const res = this.confirm.handle(event);
      if (res === null) {
        return null;
      }
      this.confirm = null;
      if (res === "back") {
        return null; // cancelled the confirm; stay in menu
      }
      return res; // confirmed action string
    }
    const act = this.panel.handle(event);
    if (act === null) {
      return null;
    }
    if (act === "back") {
      return "back";
    }
    const entry = this._action_by_label[act];
    const action = entry ? entry[0] : act;
    const prompt = entry ? entry[1] : null;
    if (prompt !== null) {
      this.confirm = new _ConfirmScreen(
        this.state !== null ? this.state : new _SizeStub(this._w, this._h),
        prompt,
        action,
      );
      return null;
    }
    return action;
  }

  update(_dt: number): void {
    /* static modal */
  }

  draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    if (this.confirm !== null) {
      this.confirm.draw(surf);
    } else {
      widgets.draw_cursor(surf);
    }
  }
}

/** Minimal w/h carrier so a confirm box can centre itself. */
interface SizeLike {
  w: number;
  h: number;
}

/** Minimal stand-in carrying just w/h so a confirm box can centre itself when
 *  SystemMenuScreen was built without a GameState. */
class _SizeStub implements SizeLike {
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
}

// --------------------------------------------------------------------------
// System Menu action effects  (SCORCH.DOC:L1449-1545; labels L1323-1336)
// --------------------------------------------------------------------------
// In-place effects the App._act System-Menu branch runs after it pops the menu.

/** ~Clear Screen (SCORCH.DOC:L1455-1460): "erase whatever traces are currently on
 *  the screen".
 *
 *  PORT DIVERGENCE (faithful intent, different mechanism).  The DOS build draws
 *  trace pixels into the persistent VGA framebuffer, so a wipe removes them.  The
 *  port re-composites terrain+sky every frame and trails live on the projectile,
 *  so there is no burned-in trace layer; what lingers on the GameState are the
 *  transient HUD overlays (info box, speech bubble), so Clear Screen drops them.
 *  Returns true (an effect ran) so the caller can confirm completion. */
export function clear_screen_effect(state: GameState): boolean {
  let cleared = false;
  if (state.info_box !== undefined && state.info_box !== null) {
    state.info_box = null;
    cleared = true;
  }
  if (state.speech !== undefined && state.speech !== null) {
    state.speech = null;
    cleared = true;
  }
  return cleared;
}

/** ~Mass Kill (SCORCH.DOC:L1461-1469): "kills everyone on the screen, giving them
 *  all an equal portion of whatever points remained to be won in the round, but
 *  giving no single tank credit for surviving the round."  Ends the round.
 *
 *  game.py / scoring.py are owned by the orchestrator (out of bounds here), so
 *  this calls a state.mass_kill() the orchestrator MUST add; if it is absent this
 *  throws (a loud signal) rather than silently doing nothing. */
export function do_mass_kill(state: GameState): string {
  state.mass_kill();
  return "mass_kill";
}

// --------------------------------------------------------------------------
// Reassign Players  (SCORCH.DOC:L1519-1530; System Menu -> Reassign ~Players)
// --------------------------------------------------------------------------
// Lists every tank with an editable name field + a controller selector (Human /
// the 8 AI types), applied in place to the live GameState tanks.
//
// DOM: builds widgets.Panel with TextField/Selector/Button; constructible only in
// a browser, like the other screens.

// Controller options in firing order: Human(0) then the 8 AI classes (1..8),
// matching constants.AI_HUMAN / AI_NAMES.  index in this list == ai_class.
const _CONTROLLER_OPTIONS: string[] = (() => {
  const out: string[] = ["Human"];
  for (let i = 1; i < 9; i++) {
    out.push(C.AI_NAMES[i]);
  }
  return out;
})();

/** System Menu -> Reassign ~Players.  Lists every tank with an editable name field
 *  and a controller selector (Human / the 8 AI types), applied in place to the
 *  live GameState tanks.  Conforms to the Screen protocol.
 *
 *  Returns: 'back' on ~Done / Esc (changes are already applied live). */
export class ReassignPlayersScreen implements Screen {
  opaque = false;

  state: GameState;
  w: number;
  h: number;
  panel: widgets.Panel;

  constructor(state: GameState, w: number | null = null, h: number | null = null) {
    this.state = state;
    this.w = w !== null ? w : typeof state.w === "number" ? state.w : 640;
    this.h = h !== null ? h : typeof state.h === "number" ? state.h : 480;
    this.panel = this._build();
  }

  _build(): widgets.Panel {
    const tanks = this.state.tanks;
    const rows = Math.max(1, tanks.length);
    const row_h = 30;
    const pw = 420;
    const ph = 60 + rows * row_h + 40;
    const px = Math.floor((this.w - pw) / 2);
    const py = Math.max(8, Math.floor((this.h - ph) / 2));
    const p = new widgets.Panel(px, py, pw, ph, "Reassign Players");
    let y = py + 28;
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      // editable name (faithful to the Player-Init name field, max ~8)
      p.add(
        new widgets.TextField(
          px + 16,
          y,
          `${i + 1}:`,
          () => t.name,
          (v: string) => {
            t.name = v;
          },
          8,
          200,
        ),
      );
      // controller selector: index == ai_class (Human=0, AI 1..8)
      p.add(
        new widgets.Selector(
          px + 224,
          y,
          "",
          _CONTROLLER_OPTIONS,
          () => t.ai_class,
          (idx: number) => {
            t.ai_class = idx;
          },
          pw - 240,
        ),
      );
      y += row_h;
    }
    p.add(new widgets.Button(px + Math.floor(pw / 2) - 30, py + ph - 30, "~Done", "back", null, true));
    return p;
  }

  // ---- Screen protocol ----------------------------------------------
  handle(event: IngameEvent): string | null {
    const act = this.panel.handle(event);
    if (act === "back") {
      return "back";
    }
    return null;
  }

  update(_dt: number): void {
    /* static modal */
  }

  draw(surf: pygame.Surface): void {
    this.panel.draw(surf, true);
    widgets.draw_cursor(surf);
  }
}

// ---------------------------------------------------------------------------
// Python-semantics helper (kept private; preserves the oracle's arithmetic).
// ---------------------------------------------------------------------------

/** Python `%`: result takes the sign of the divisor (always >= 0 for n > 0). */
function pyMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

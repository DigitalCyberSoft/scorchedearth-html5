/**
 * Tank death sequence -- a faithful TypeScript port of scorch-py/scorch/death.py
 * (the fidelity oracle, itself byte-verified against 1.5/SCORCH.EXE), which ports
 * FUN_3ef5_029a (segment 3ef5 = tank-death FX).
 *
 * Ground truth: scorch-re/decompiles/FUN_3ef5_029a.c (+ siblings _067b/_06d4/_0742),
 * catalog 20_inventory_ac.md:48-53, FLOW.md s.6.3, FUNCTIONS.md:454-456,
 * catalog 11_damage_terrain.md (the FUN_4d1e_015a explosion the sequence calls).
 *
 * WHAT THE ORIGINAL DOES (byte-confirmed, FUN_3ef5_029a.c):
 *   1. :20-31  recolor the DAC explosion/body registers (cosmetic; the port works in
 *              palette-index space, so this maps to the explosion's own color band).
 *   2. :32-41  spin the turret to angle 0x5a (90deg, straight up) via FUN_3a16_12e0
 *              -- the barrel snaps vertical before the tank blows.
 *   3. :42-52  erase a 3px barrel stub at (tank+0x12, tank+0x14).
 *   4. :53     *(tank+0x18) = 0  -> clear in-play flag (== tank.alive=False; already
 *              done by damage.kill_tank BEFORE on_tank_destroyed runs).
 *   5. :54-59  if sound on (DAT_5f38_ef46): 10x FUN_5571_0007(0x14,0) tone +
 *              FUN_1000_9af6 delay -- the death "shake"/buzz.
 *   6. :60-77  THE DEBRIS FOUNTAIN.  local_6 = tank X; for iVar6 from tank Y UP to the
 *              top clip (DAT_5f38_ef40-7): iVar4 = FUN_3bf9_048b(3) - 1  (in {-1,0,+1}),
 *              local_6 += iVar4 (the column wanders), then stamp+erase the 5x6 debris
 *              sprite (FUN_3ef5_067b / _06d4) four times with tone ticks between.  A
 *              pillar of scattered debris rises from the tank straight up the screen,
 *              jittering left/right by +-1 px per scanline.
 *   7. :78-82  erase the barrel-stub region again (FUN_42c2_1519 sky restore).
 *   8. :96     FUN_4d1e_015a(tankX, tankY, DAT_5f38_120e, 1) -> the STANDARD EXPLOSION
 *              (carve crater + linear radial damage; param_4=1 => also dirt-settle).
 *   9. :97     DAT_5f38_e340 -= 1  -> decrement the live count.
 *   10. :98    FUN_2a4a_23f8() -> physics resettle (tank fall after the crater).
 *
 * There is exactly ONE death animation in the binary.  The only RNG in the sequence is
 * FUN_3bf9_048b(3) at :62, which is the per-scanline horizontal jitter of the debris
 * column -- NOT a death-type selector.  No death-effect table, switch, or roulette pick
 * exists in segment 3ef5 (confirmed: FUN_3ef5_029a's only callees are the debris helpers
 * _067b/_06d4/_0742, the explosion FUN_4d1e_015a, the tone FUN_5571_0007, the turret
 * FUN_3a16_12e0, and the one rand FUN_3bf9_048b -- _callgraph.tsv row FUN_3ef5_029a).
 *
 * The task brief asked for a "randomly selected per-kill death effect (several death
 * animations)".  That premise is NOT supported by the decompiles -- see RECONSTRUCTED
 * below for how the variety layer is provided and flagged.
 *
 * NOT IMPLEMENTED HERE (separate systems, by design -- see on_tank_destroyed hook note
 * at the bottom of this file):
 *   * death SOUND  -> sound.Sound.play('death')          (port sound.py:272)
 *   * die TAUNT    -> talk.die_taunt(victim, cfg, rng)    (port talk.py:233)
 * The byte-confirmed in-sequence tone (FUN_5571_0007 at :56) is the port's death sfx
 * event; it fires at the on_tank_destroyed call site, not inside the animation builder.
 *
 * ============================================================================
 * NUMERIC NOTES (load-bearing for the differential gate, test/death.test.ts):
 *
 *  - This module itself has NO transcendental math (no sin/cos/pow/sqrt/atan2).
 *    Every quantity it computes is an integer: Python `int(x)` truncates TOWARD
 *    ZERO -> Math.trunc(x) (the radius casts in _blast_radius), and the throe /
 *    fountain / explosion params are integer arithmetic.  So every value this
 *    module produces is asserted EXACT in the test.
 *
 *  - The ONE transcendental dependency is INSIDE damage.explode (called by
 *    _final_blast): the radial-damage law round((R - d)*100/R) uses math.hypot.
 *    But the engine measures blast distance between INTEGER pixel coordinates
 *    (tank (x,y) and the integer blast center), so dx,dy are integers,
 *    dx*dx+dy*dy is an exact integer, and damage.ts's Math.sqrt of the squared
 *    sum reproduces CPython math.hypot BIT-FOR-BIT (the damage.ts NUMERIC NOTES
 *    result, already a green differential gate).  The dealt-damage integers
 *    (and the kills/scores they trigger) are therefore asserted EXACT.
 * ============================================================================
 *
 * Provenance comments (FUN_<seg>_<off> / DAT_ refs) are preserved verbatim from the
 * Python source so the disassembly lineage survives the language port.
 */
import * as damage from "./damage";
import { eff_radius } from "./weapon_behaviors";
import type { Item } from "./weapons";

// ---------------------------------------------------------------------------
// Duck-typed structural shapes the death module reads/mutates.  These mirror
// exactly the fields scorch/death.py touches (a superset of damage.Tank that
// also carries the `color` palette index the throe/fountain emitters read), so
// the differential dumper/test can drive the port with the same lightweight
// mocks the oracle builds.  (Kept as interfaces, not classes: the port is
// duck-typed like the Python.)
// ---------------------------------------------------------------------------

/** The dying tank: a damage.Tank plus the `color` index handed to the throe /
 *  fountain emitters (FUN_3ef5_029a.c:28-29 -- the debris body renders in the
 *  dying tank's own colour).  `color` is optional with a 15 default, exactly as
 *  getattr(tank, "color", 15) in the Python. */
export interface DTank extends damage.Tank {
  color?: number;
}

/** The game-state surface death threads through.  Superset of damage.State (the
 *  sequence calls damage.explode -> apply_tank_damage -> kill_tank ->
 *  on_tank_destroyed, the full damage chain).  Adds:
 *   - `w` (playfield width): read by the _debris_fountain FALLBACK clamp
 *     (death.py:140 `min(state.w - 1, tank.x)`); the real GameState exposes it
 *     (game.py:99).
 *   - explosion_scale: the resolution scalar _blast_radius multiplies the
 *     fallback radius by (getattr(state, "explosion_scale", 1.0)).
 *   - rng.pick: the FUN_271b_0005 rand(11) throe roulette.
 *   - add_throe / add_death_fountain: the frame-driven emitters the throe /
 *     ascension-rise visuals register into (game.py:1710 / :1678). */
export interface DState extends damage.State {
  tanks: DTank[];
  w: number;
  explosion_scale?: number;
  rng: { pick(n: number): number };
  // add_explosion is inherited from damage.State (cx,cy,radius); the death
  // module additionally passes the dirt_only keyword on the fallback path, so
  // widen the signature here to accept it (a superset; damage.State's call sites
  // pass no kwargs, which remains valid).
  add_explosion(cx: number, cy: number, radius: number, kw?: { [k: string]: unknown }): void;
  add_throe(kind: string, x: number, y: number, color: number): void;
  add_death_fountain?: (
    x: number,
    y: number,
    top: number,
    kw?: { color?: number; stride?: number; scatter?: number }
  ) => void;
}

// --------------------------------------------------------------------------- //
// Tunables.  The debris geometry is read from FUN_3ef5_029a.c; the values that
// are NOT byte-pinned (sprite size in the port's coarser pixel space, number of
// sub-puffs) are reconstructed and flagged RECONSTRUCTED below.
// --------------------------------------------------------------------------- //

// FUN_3ef5_067b/_06d4 stamp a 5(w) x 6(h) byte grid (0x60c3); columns iVar1 in
// [-2,4), rows iVar2 in [0,5).  The fountain marches UP one row per step from the
// tank to the top clip (FUN_3ef5_029a.c:61).  The port renders debris as small
// explosion puffs queued into state.explosions, so we sample the column at a
// stride rather than every scanline (one puff per PORT pixel row would be hundreds
// of identical 2px circles; the renderer animates each puff over its own radius).
export const DEBRIS_PUFF_RADIUS = 2; // 5x6 sprite ~ a 2px puff in the port's space
export const DEBRIS_ROW_STRIDE = 6; // sample the rising column every ~sprite-height rows
export const DEBRIS_TOP_MARGIN = 7; // :61 stops at DAT_5f38_ef40 - 7 (top clip - 7)

// FUN_4d1e_015a(:96) is called with DAT_5f38_120e = the CURRENT weapon's effective
// radius word, NOT a fixed death radius.  The killing weapon's blast carves the
// grave.  When the kill did not come from a weapon detonation (fall damage, dirt
// burial, squash) there is no current weapon radius, so a default is used.
export const DEATH_BLAST_FALLBACK = 18; // px (matches the port's prior fixed death crater)

// --------------------------------------------------------------------------- //
// The binary has EXACTLY ONE tank-death animation (FUN_3ef5_029a: a rising debris
// fountain + a weapon-scaled blast), confirmed by disassembly 2026-06-25: the
// sequence takes only the dying-tank pointer, branches on nothing death-style
// related, and its fountain sprites FUN_3ef5_067b/_06d4 are called by no other
// function (no death-effect table, no roulette).  The visible per-kill VARIETY a
// player sees comes from the killing WEAPON's own detonation (nuke mushroom
// FUN_3770_041d, funky scatter FUN_3319_0516, standard ring FUN_4d1e_015a) --
// handled in weapon_behaviors, NOT here -- plus the weapon-scaled grave radius
// (DAT_5f38_120e at FUN_3ef5_029a.c:96).  A prior port added a fabricated
// RANDOM_DEATH_EFFECTS layer (big-mushroom / debris-scatter / chain-cookoff); it
// had NO decompile basis and was never enabled (no cfg writer), so it was REMOVED
// 2026-06-25.  Adding tank-death variety would be fabrication; do not re-add it.
// --------------------------------------------------------------------------- //
export const STANDARD = 0; // the sole, byte-confirmed death effect

/**
 * The grave-crater radius.
 *
 * FUN_3ef5_029a.c:96 calls the explosion with DAT_5f38_120e == the CURRENT
 * weapon's effective-radius word (catalog 11 s.1.1).  When the caller knows the
 * detonating weapon (an Item with .blast), use weapon_behaviors.eff_radius on it
 * -- the same path every other detonator uses (weapon_behaviors.py:18).  For a
 * non-weapon kill (fall damage / dirt burial / squash) no weapon is in play, so
 * fall back to DEATH_BLAST_FALLBACK scaled by EXPLOSION_SCALE.
 */
export function _blast_radius(state: DState, weapon: Item | null = null): number {
  if (weapon !== null) {
    // weapon_behaviors.eff_radius(state, weapon) == abs(weapon.blast) * scale.
    // eff_radius reads state.explosion_scale; DState carries it (optional, but a
    // weapon kill always comes from a real GameState which sets it).  The cast
    // narrows DState to the eff_radius parameter shape (it only reads
    // explosion_scale + weapon.blast).
    const r = eff_radius(
      state as unknown as Parameters<typeof eff_radius>[0],
      weapon
    );
    if (r && r > 0) {
      return Math.trunc(r);
    }
  }
  // int(DEATH_BLAST_FALLBACK * getattr(state, "explosion_scale", 1.0))
  const scale = state.explosion_scale ?? 1.0;
  return Math.trunc(DEATH_BLAST_FALLBACK * scale);
}

// The fountain's top clip.  FUN_3ef5_029a.c:61 marches from the tank UP to
// DAT_5f38_ef40 - 7 (ef40 = the top of the playfield), so the binary's column does
// span most of the screen height.  The port previously stamped that ENTIRE column in
// ONE frame, which read on screen as a static floor-to-ceiling vertical streak -- the
// user reported it as "the lightning" (bug B).  The binary instead RISES the debris
// one scanline per frame (4 passes/row with tone ticks, :65-76) and ERASES the
// leading edge behind the head (FUN_3ef5_06d4), so only a moving band is visible at
// once.  The port now registers a frame-driven emitter (state.add_death_fountain)
// that releases the column over time; each puff is a short-lived dirt-band stamp that
// ages out behind the rising head, so at any instant only a climbing cluster shows,
// never the whole line.  The top clip is the playfield-top analogue (ef40-7).
export const PLAYFIELD_TOP = 2; // port has no status-bar inset above the field here

/**
 * Port of FUN_3ef5_029a.c:60-77 -- the RISING ascension tile.
 *
 * Registers a frame-driven emitter (game.add_death_fountain) that climbs the
 * single 6x5 sprite at data 0x60c3 (decoded byte-exact 2026-06-25) UP from the
 * tank to the top clip (ef40-7), drifting X by FUN_3bf9_048b(3)-1 in {-1,0,+1}
 * per step (state.rng.pick(3)-1).  The sprite BODY renders in the dying tank's
 * own colour (FUN_3ef5_029a.c:28-29), so the tank's `color` index is handed to
 * the emitter; render._draw_death_tiles owns the pixel shape + the grey cap.
 * Driven per frame in game._step_death_fountains so the tile CLIMBS over time and
 * the terrain recomposite erases the prior position -- one tile ascends with no
 * trail (the binary's stamp/erase/move loop), NOT the prior colourless dirt-puff
 * column (the bug-B streak), NOT a tombstone.  `scatter` widens the per-step
 * drift (RECONSTRUCTED flavour 2).
 */
export function _debris_fountain(state: DState, tank: DTank, scatter = false): void {
  const top = Math.max(PLAYFIELD_TOP, PLAYFIELD_TOP + DEBRIS_TOP_MARGIN); // ef40-7 analogue
  if (state.add_death_fountain === undefined) {
    // defensive fallback (a GameState stub without the emitter): stamp once at
    // the tank so a debris puff still appears, never the full-height streak.
    state.add_explosion(
      Math.max(0, Math.min(state.w - 1, tank.x)),
      tank.y,
      DEBRIS_PUFF_RADIUS,
      { dirt_only: true }
    );
    return;
  }
  state.add_death_fountain(tank.x, tank.y, top, {
    color: tank.color ?? 15,
    stride: DEBRIS_ROW_STRIDE,
    scatter: scatter ? 3 : 1,
  });
}

/**
 * Port of FUN_3ef5_029a.c:96 -- the standard explosion FUN_4d1e_015a at the
 * tank center with param_4=1 (carve crater + radial damage + settle).  Uses the
 * port's damage.explode, which carves the crater, queues the fireball, AND runs
 * the linear (R-d)*100/R radial damage loop.  damage.explode already guarantees
 * add_explosion + carve_circle for radius > 0 (damage.py:129-142).
 */
export function _final_blast(state: DState, tank: DTank, radius: number): void {
  damage.explode(state, tank.x, tank.y, radius, true);
}

// --------------------------------------------------------------------------- //
// Effect implementations.  Each MUST queue >=1 explosion and produce a crater.
// --------------------------------------------------------------------------- //

/** Byte-confirmed FUN_3ef5_029a: debris fountain, then the weapon blast. */
export function _effect_standard(state: DState, tank: DTank, radius: number): void {
  _debris_fountain(state, tank, false);
  _final_blast(state, tank, radius);
}

// The REAL per-kill variety is the FUN_271b_0005 roulette (rand(11) -> 1 of 11
// throes; jump table file 0x1df4d, see [[scorch-death-throes]]).  _spawn_throe
// dispatches it; the geometry is RECONSTRUCTED to each case's decoded character
// (several handlers are FP-mangled).  An earlier port had a FABRICATED
// big-mushroom/scatter/cookoff layer with no decompile basis (removed); this
// replaces it with the byte-grounded 11-way roulette.
/**
 * Dispatch the FUN_271b_0005 roulette result `throe` (0-10) to its visual.
 * Cases 0-2 = plain blast (no extra flourish; the grave blast in death_sequence
 * is the whole effect); 3 = triple, 4 = big expanding ball (explosions); 5-10 =
 * the distinct throe animations via game.add_throe (spiral/sparkle/geyser/sink/
 * ring).  Mapping + character per [[scorch-death-throes]]; geometry RECONSTRUCTED.
 */
export function _spawn_throe(state: DState, tank: DTank, throe: number, radius: number): void {
  const x = tank.x;
  const y = tank.y;
  const col = tank.color ?? 15;
  if (throe === 3) {
    // triple explosion (FUN_4d1e_015a x3)
    for (const off of [-7, 7]) {
      state.add_explosion(x + off, y - 3, Math.max(4, radius - 5));
    }
  } else if (throe === 4) {
    // expanding filled ball (case 4)
    state.add_explosion(x, y, radius + 8);
  } else if (throe === 5) {
    state.add_throe("spiral", x, y, col);
  } else if (throe === 6) {
    state.add_throe("sparkle", x, y, col);
  } else if (throe === 7) {
    state.add_throe("geyser", x, y, col);
  } else if (throe === 8) {
    state.add_throe("sink", x, y, col);
  } else if (throe === 9 || throe === 10) {
    state.add_throe("ring", x, y, col);
  }
  // cases 0, 1, 2: no extra flourish (the plain weapon blast is the death).
}

// --------------------------------------------------------------------------- //
// Public entry point.
// --------------------------------------------------------------------------- //

/**
 * Run the tank death FX (port of FUN_3ef5_029a) for `tank`.
 *
 * `weapon` (optional) is the detonating weapon Item; when supplied, the grave
 * crater uses its effective radius (the binary's DAT_5f38_120e at :96).  Left
 * null for non-weapon kills (fall/burial), which use the fallback radius.
 *
 * Decrements nothing scoring-related: the kill award already happened in
 * damage.kill_tank -> scoring.award_kill, and tank.alive was already cleared
 * there (== FUN_3ef5_029a.c:53).  This routine owns ONLY the visual/terrain FX
 * and the post-blast resettle, matching the binary's split.
 *
 * Death = the FUN_271b_0005 rand(11) roulette (the VARYING throe, _spawn_throe)
 * OVER the 0x60c3 ascension rise (_debris_fountain) and the weapon-scaled grave
 * blast (_final_blast).  The throe geometry is RECONSTRUCTED to each case's
 * decoded character (jump table file 0x1df4d; see [[scorch-death-throes]]).  The
 * blast queues >=1 explosion into state.explosions AND carves a crater.
 */
export function death_sequence(state: DState, tank: DTank, weapon: Item | null = null): number {
  const radius = _blast_radius(state, weapon);
  const throe = state.rng.pick(11); // FUN_271b_0005 rand(11) roulette
  _spawn_throe(state, tank, throe, radius); // the varying death animation
  _debris_fountain(state, tank, false); // 0x60c3 ascension rise (finalize)
  _final_blast(state, tank, radius); // weapon-scaled grave crater

  // FUN_3ef5_029a.c:97  DAT_5f38_e340 -= 1  (the global live count).  The port's
  // live count is derived (GameState.alive_count() == sum of t.alive), and
  // tank.alive was already set False in damage.kill_tank, so the decrement is
  // implicit -- there is no separate counter to subtract.  Documented, not
  // duplicated, to avoid a double-decrement.

  // FUN_3ef5_029a.c:98  FUN_2a4a_23f8() physics resettle (tank fall after the
  // crater) is driven by the port's own settle path (game._settle / terrain.settle)
  // at end-of-resolution; it is NOT re-invoked here to avoid re-entrancy.
  return throe;
}

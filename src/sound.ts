/**
 * PC-speaker sound emulation for the Scorched Earth HTML5 port -- a faithful
 * TypeScript+WebAudio port of scorch-py/scorch/sound.py (the fidelity oracle,
 * itself recovered from the DOS binary).
 *
 * GROUND TRUTH (scorch-re/catalogs/19_sound_runtime.md + caller decompiles):
 *   The original drives the IBM PC speaker via the 8253/8254 PIT.  The canonical
 *   tone primitive is FUN_5571_0007(freq, dur) (seg 0x5571, the SOUND module): a
 *   *gated one-shot square-wave tone*.  Mechanism (catalog 19 s.1.1):
 *     out(0x43, 0xb6)              # PIT command: channel 2, lo/hi, MODE 3 (square)
 *     out(0x42, lo); out(0x42, hi) # ch2 reload = divisor
 *     out(0x61, x | 3)             # speaker gate ON  -> tone sounds
 *     out(0x61, x & 0xfc)          # speaker gate OFF -> silence
 *   divisor = 1193181 / freqHz (PIT input clock 0x1234dd).  Mode 3 = SQUARE WAVE
 *   in hardware, so the faithful waveform is a square wave -- this module
 *   synthesises that (Math.sign(Math.sin(phase)) per sample) and plays it through
 *   the WebAudio AudioContext as an AudioBuffer source.
 *
 *   FUN_5571_0007 body (catalog 19 s.1.3): `if (DAT_5f38_ef46 == 0) return;` then
 *   a281(freq) tone-on, 9af6(dur) busy-wait, 0168() tone-off.  DAT_5f38_ef46 is
 *   the master SOUND gate (0 = silent); `beep` below is the one-to-one analog.
 *
 *   Frequency clamp (FACT): FUN_1000_a281 skips freq <= 0x12 (18); FUN_5571_0111
 *   clamps freq < 0x13 (19) up to 19.  Below ~19 Hz the original emits nothing
 *   audible, so synthesis drops freq < MIN_FREQ_HZ rather than making sub-audio.
 *
 * PER-EVENT TONES -- RECOVERED FROM THE CALLER DECOMPILES.  FACT == the literal
 *   (freq,dur) is present in the decompile; cites are file:line.  Table preserved
 *   verbatim from sound.py:
 *
 *   | event           | original tone (freq Hz, dur PIT-tick unit)          | cite (decompile)              |
 *   |-----------------|-----------------------------------------------------|-------------------------------|
 *   | ui_beep         | 0007(200, 0x28)  steady 200 Hz                      | FUN_1a69_0002.c:58 (+~25 more)|
 *   | fire/launch     | a281 stepped UP for(i=0;i<100;i+=0xf): 0,15..90 Hz  | FUN_2a4a_02f2.c:39-43         |
 *   | explosion(big)  | a281 ALTERNATING 100/200 Hz (grow + flash loop)     | FUN_4d1e_03e3.c:30,44-49      |
 *   | explosion(std)  | a281() -- freq arg DROPPED (BLOCKED); 100/200 x-ref | FUN_4d1e_015a.c:34,46,60,63   |
 *   | nuke            | a281() -- freq arg DROPPED (BLOCKED); 100/200 x-ref | FUN_3770_041d.c:39,48,51      |
 *   | plasma          | 0007(i*1000,10) UP then 0007((10-i)*1000,10) DOWN   | FUN_3f76_03bd.c:18,22         |
 *   | shield_collapse | 51x 0007(f,0x14) f=6000 step -100 then 0007(1000,10)| FUN_4191_0034.c:41-46         |
 *   | shield_deploy   | 51x 0007(f,0x14) f=1000 step +100 -> ~6000  (UP)    | FUN_4191_0455.c:58-62         |
 *   | battery         | 0007(100,0xf),0007(200,10),0007(100,0x14) arpeggio  | FUN_3a16_0f44.c:17-21         |
 *   | parachute       | 0007(2000,0x1e)  steady 2000 Hz                     | FUN_2975_048c.c:165           |
 *   | dirt_settle     | 0007(0x1e,0)=30 Hz per drop, 0007(0x14,5)=20 settle | FUN_3667_06d1.c:39,52         |
 *   | death           | 20 Hz rumble 0007(0x14,0) x N + debris ticks        | FUN_3ef5_029a.c:54-77,96      |
 *   | teleport        | a281(rand%100*100+1000) random 1000..10900 Hz x100  | FUN_262c_013e.c:19            |
 *   | turn/confirm    | 0007(0x14,100)  steady 20 Hz (next-player/select)   | FUN_38b5_13c0.c:30; _145b.c:27|
 *   | lightning       | a281(2000)  steady 2000 Hz strike                   | FUN_480f_0219.c:20            |
 *   | victory         | 5571_0111 sweep UP 5000->15000 Hz (divide variant)  | FUN_352c_00c9.c:90-119        |
 *   | shield_hit      | NO original tone -- absorb path SILENT; port-added  | FUN_4191_0034.c (no 5571 call)|
 *   | bounce          | 0007() in restitution branch -- freq DROPPED        | FUN_2a4a_0b1f.c (BLOCKED)     |
 *   | fizzle/mirv     | 0007() one tick -- freq DROPPED (BLOCKED)           | FUN_35d5_041b.c:29            |
 *
 *   FLY_SOUND (continuous in-flight whine), recovered byte-exact:
 *   | VEL (cfg==1) | a281(|v|): pitch = sqrt(vx^2+vy^2)            | FUN_2a4a_0b1f.c (5146==1)     |
 *   | POS (cfg==2) | a281((launch_y - y)*8 + 1000, floored at 50) | FUN_2a4a_1349.c:163 (5146==2) |
 *   DAT_5f38_5146 is the FLY_SOUND gate; 1=VEL, 2=POS (catalog 19 s.1.4/s.1.7).
 *
 * DURATION CALIBRATION (NOT byte-pinned -- RECONSTRUCTED): the original `dur` is a
 *   PIT-tick budget consumed by the busy-wait FUN_1000_9af6, NOT milliseconds; its
 *   wall-clock length depends on the MIPS-adaptive tick (catalog 19 s.1.5), a
 *   measured runtime quantity (BLOCKED).  This port keeps the FREQUENCIES and the
 *   SHAPE (sweep direction, alternation, step sign, ordering) byte-exact and picks
 *   watchable ms whose RELATIVE order matches the dur units (0x28>0x1e>0x14>0xf).
 *
 * This module imports with NO audio device.  The AudioContext is created lazily on
 * the first play; in a headless/Node env (no AudioContext) every call degrades to
 * a silent no-op (audio is never load-bearing for game state) -- this is what
 * keeps the Phase-1 logic suites green.  init() returns false and every public
 * method returns undefined when there is no context, mirroring sound.py degrading
 * to a no-op when pygame.mixer / numpy is absent.
 *
 * SYNTHESIS NUMERICS (the differentially-tested substrate): the per-sample math is
 * computed identically to sound.py's numpy path -- Math.sign(Math.sin(2*pi*f*t))
 * with t=i/rate, a numpy-exact linspace fade envelope, and a numpy-exact int16
 * truncation (Math.trunc).  test/sound.test.ts asserts the int16 sample arrays and
 * the raw sin floats reproduce the Python oracle (oracle/dump_sound.py).
 */

// AMPLITUDE/MIN_FREQ/etc are local to the sound module in sound.py (not in
// constants.py), so they live here too -- matched value-for-value.
export const SAMPLE_RATE = 44100;
export const CHANNELS = 2; // mixer default is stereo; match it
export const AMPLITUDE = 0.28; // square waves are loud; keep headroom
export const MIN_FREQ_HZ = 19; // FUN_1000_a281/0111 clamp (catalog 19 s.1.3)
export const MAX_FREQ_HZ = 12000; // keep tones in a sane speaker-ish band

export const UI_BEEP_HZ = 200; // FUN_5571_0007(200, 0x28) -- FACT
export const UI_BEEP_MS = 64; // 0x28 dur -> RECON ms (see header)

/** A (freq, ms[, f_end]) blip descriptor -- the faithful analog of the original
 * reprogramming a281/0007 once per step. */
export type Tone = [number, number] | [number, number, number];

function _clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * numpy.linspace(start, stop, num) reproduced bit-for-bit: step = (stop-start)/
 * (num-1); y[i] = start + step*i (a MULTIPLY, not i/(num-1) divide -- the ordering
 * differs by 1 ULP and would desync the int16 cast); the final element is forced
 * exactly to `stop`.  Verified 0 mismatches vs numpy across the fade lengths used.
 */
function _linspace(start: number, stop: number, num: number): Float64Array {
  const y = new Float64Array(num);
  if (num === 1) {
    y[0] = start;
    return y;
  }
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) y[i] = start + step * i;
  y[num - 1] = stop;
  return y;
}

// The WebAudio context type is only present in a browser/DOM env.  Reference it
// loosely so this module type-checks under @types/node with no DOM lib.
type AudioCtx = {
  sampleRate: number;
  currentTime: number;
  destination: unknown;
  state: string;
  createBuffer(channels: number, length: number, rate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  resume?(): Promise<void> | void;
};
type AudioBufferLike = { getChannelData(ch: number): Float32Array };
type AudioBufferSourceLike = {
  buffer: AudioBufferLike | null;
  loop: boolean;
  connect(dest: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
};

/** Look up an AudioContext constructor without assuming the DOM lib is present. */
function _audioCtxCtor(): (new () => AudioCtx) | null {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioCtx;
    webkitAudioContext?: new () => AudioCtx;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * Module singleton (`sfx`).  Square-wave PC-speaker emulation over WebAudio.
 *
 * Gating: `enabled` is the SOUND master gate (DAT_5f38_ef46 analog); `fly_mode`
 * mirrors cfg.FLY_SOUND.  Both are also accepted per-call so a caller can read
 * cfg.SOUND / cfg.FLY_SOUND at the site and pass it in.
 *
 * Public surface matches sound.py's _Sfx: enabled/fly_mode/field_height and the
 * methods init/beep/play/set_launch_y/start_fly/fly_tone/stop_fly.
 */
export class Sfx {
  // ---- public gating state (matches _Sfx.__init__) ----
  enabled = true; // SOUND on/off (set from cfg.SOUND)
  fly_mode = "OFF"; // cfg.FLY_SOUND: OFF / POS / VEL
  field_height = 480; // set by the game once per round

  // ---- private audio/cache state ----
  private _ready = false; // context init attempted + ok
  private _init_failed = false; // init attempted + failed (don't retry)
  private _ctx: AudioCtx | null = null;
  // sample-rate the context actually opened at (mirrors _mix_rate); SAMPLE_RATE
  // until a context exists, exactly like sound.py's getattr fallback.
  private _mix_rate = SAMPLE_RATE;
  private _mix_channels = CHANNELS;

  private _tone_cache = new Map<string, AudioBufferLike>(); // (freq,ms) -> buffer
  private _sweep_cache = new Map<string, AudioBufferLike>(); // (f0,f1,ms) -> buffer
  private _seq_cache = new Map<string, AudioBufferLike>(); // (tones) -> buffer

  // ---- flight-tone state (continuous looped whine) ----
  private _fly_source: AudioBufferSourceLike | null = null;
  private _fly_freq = 0; // last freq the loop was set to
  private _fly_launch_y: number | null = null; // launch y for POS pitch (DAT_5f38_ce96)

  // ---- lazy context init (FUN_5571_0007 has no init; WebAudio needs one) -----
  /**
   * Initialise the AudioContext if possible.  Idempotent; safe to call before any
   * device/user-gesture exists.  Returns true when audio is usable.
   *
   * Degrades gracefully: if no AudioContext constructor exists (Node/test env) or
   * construction throws, it records the failure and every later call is a silent
   * no-op.  Never raises.  Mirrors sound.py's init() returning False with no mixer.
   */
  init(): boolean {
    if (this._ready) return true;
    if (this._init_failed) return false;
    const Ctor = _audioCtxCtor();
    if (Ctor === null) {
      this._init_failed = true;
      return false;
    }
    try {
      const ctx = new Ctor();
      this._ctx = ctx;
      // honour whatever the context actually opened (it may coerce the rate)
      this._mix_rate = ctx.sampleRate || SAMPLE_RATE;
      this._mix_channels = CHANNELS;
      this._ready = true;
      return true;
    } catch {
      // No audio device / construction blocked.  Do not retry.
      this._init_failed = true;
      return false;
    }
  }

  // ---- square-wave synthesis (pure; the differentially-tested substrate) -----
  /**
   * Return an n-sample float array in [-1,1] for a square tone (or a linear-chirp
   * sweep freq -> f_end).  No envelope/stacking; helper for the builders below so
   * a multi-blip sequence shares one fade scheme.  Identical math to sound.py
   * _square_wave: Math.sign(Math.sin(phase)), t = i/rate.
   */
  _square_wave(freq: number, n: number, rate: number, f_end?: number | null): Float64Array {
    const out = new Float64Array(n);
    if (f_end === undefined || f_end === null || f_end === freq) {
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const phase = 2.0 * Math.PI * freq * t;
        out[i] = Math.sign(Math.sin(phase));
      }
    } else {
      const dur_s = n / rate;
      const k = dur_s > 0 ? (f_end - freq) / dur_s : 0.0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const phase = 2.0 * Math.PI * (freq * t + 0.5 * k * t * t);
        out[i] = Math.sign(Math.sin(phase));
      }
    }
    return out;
  }

  /** 3 ms linear fade in/out to kill the click at gate on/off (sound.py
   * _envelope).  Skipped when n <= 2*fade -- short blips keep their full square. */
  _envelope(wave: Float64Array, n: number, rate: number): Float64Array {
    const fade = Math.max(1, Math.trunc(rate * 0.003));
    if (n > 2 * fade) {
      const up = _linspace(0.0, 1.0, fade);
      const dn = _linspace(1.0, 0.0, fade);
      for (let i = 0; i < fade; i++) {
        wave[i] = wave[i] * up[i];
        wave[n - fade + i] = wave[n - fade + i] * dn[i];
      }
    }
    return wave;
  }

  /**
   * Apply amplitude + numpy-exact int16 truncation, returning a per-channel
   * Int16Array (mono).  numpy `np.int16(x)` truncates toward zero -> Math.trunc.
   * The original stereo-stacks (column_stack); for synthesis equivalence the
   * channels are identical, so the playback side simply duplicates this mono plane
   * into both AudioBuffer channels.  This returns the canonical mono int16 plane
   * that the differential test asserts (matches sound.py's per-channel column).
   */
  _finish(wave: Float64Array, n: number): Int16Array {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.trunc(wave[i] * AMPLITUDE * 32767);
    }
    return out;
  }

  /** int16 sample plane for a square tone (or sweep when f_end given) of `ms`
   * milliseconds.  Mirrors sound.py _square_array (the per-channel column). */
  _square_array(freq: number, ms: number, f_end?: number | null): Int16Array {
    const rate = this._mix_rate;
    const n = Math.max(1, Math.trunc((rate * ms) / 1000.0));
    const wave = this._envelope(this._square_wave(freq, n, rate, f_end), n, rate);
    return this._finish(wave, n);
  }

  /**
   * int16 sample plane for a SEQUENCE of square blips played back-to-back -- the
   * faithful analog of the original reprogramming a281/0007 once per step.  Sub-19
   * Hz blips become silence of the same length (a281 skips freq<=18, so the
   * original is silent for that span but the timing is preserved).  Mirrors
   * sound.py _seq_array.
   */
  _seq_array(tones: Tone[]): Int16Array {
    const rate = this._mix_rate;
    const parts: Float64Array[] = [];
    for (const tn of tones) {
      const f0 = tn[0];
      const ms = tn[1];
      const f1: number | null = tn.length > 2 ? (tn[2] as number) : null;
      const n = Math.max(1, Math.trunc((rate * ms) / 1000.0));
      if (f0 < MIN_FREQ_HZ && (f1 === null || f1 < MIN_FREQ_HZ)) {
        parts.push(new Float64Array(n)); // original emits nothing here
        continue;
      }
      const f0c = _clamp(f0, MIN_FREQ_HZ, MAX_FREQ_HZ);
      const f1c = f1 === null ? null : _clamp(f1, MIN_FREQ_HZ, MAX_FREQ_HZ);
      parts.push(this._envelope(this._square_wave(f0c, n, rate, f1c), n, rate));
    }
    let total = 0;
    for (const p of parts) total += p.length;
    let wave: Float64Array;
    if (total === 0) {
      wave = new Float64Array(1);
    } else {
      wave = new Float64Array(total);
      let off = 0;
      for (const p of parts) {
        wave.set(p, off);
        off += p.length;
      }
    }
    return this._finish(wave, wave.length);
  }

  // ---- WebAudio buffer construction + playback ----------------------------
  /** Build a stereo AudioBuffer from a mono int16 plane (both channels = plane,
   * matching the original's column_stack duplication), normalised back to float. */
  private _buffer(plane: Int16Array): AudioBufferLike | null {
    const ctx = this._ctx;
    if (ctx === null) return null;
    const n = plane.length;
    try {
      const buf = ctx.createBuffer(this._mix_channels, n, this._mix_rate);
      for (let c = 0; c < this._mix_channels; c++) {
        const data = buf.getChannelData(c);
        for (let i = 0; i < n; i++) data[i] = plane[i] / 32768.0;
      }
      return buf;
    } catch {
      return null;
    }
  }

  private _tone_buffer(freq: number, ms: number): AudioBufferLike | null {
    if (!this.init()) return null;
    const f = Math.trunc(_clamp(freq, MIN_FREQ_HZ, MAX_FREQ_HZ));
    const m = Math.trunc(Math.max(1, ms));
    const key = `${f}:${m}`;
    let buf = this._tone_cache.get(key);
    if (buf === undefined) {
      const b = this._buffer(this._square_array(f, m));
      if (b === null) return null;
      buf = b;
      this._tone_cache.set(key, buf);
    }
    return buf;
  }

  private _sweep_buffer(f0: number, f1: number, ms: number): AudioBufferLike | null {
    if (!this.init()) return null;
    const a = Math.trunc(_clamp(f0, MIN_FREQ_HZ, MAX_FREQ_HZ));
    const b = Math.trunc(_clamp(f1, MIN_FREQ_HZ, MAX_FREQ_HZ));
    const m = Math.trunc(Math.max(1, ms));
    const key = `${a}:${b}:${m}`;
    let buf = this._sweep_cache.get(key);
    if (buf === undefined) {
      const made = this._buffer(this._square_array(a, m, b));
      if (made === null) return null;
      buf = made;
      this._sweep_cache.set(key, buf);
    }
    return buf;
  }

  private _seq_buffer(tones: Tone[]): AudioBufferLike | null {
    if (!this.init()) return null;
    const key = JSON.stringify(tones);
    let buf = this._seq_cache.get(key);
    if (buf === undefined) {
      const made = this._buffer(this._seq_array(tones));
      if (made === null) return null;
      buf = made;
      this._seq_cache.set(key, buf);
    }
    return buf;
  }

  /** Play a one-shot buffer (a fresh source per shot -- AudioBufferSourceNode is
   * single-use).  Returns the source, or null if audio is down.  Never raises. */
  private _play_buffer(buf: AudioBufferLike | null): AudioBufferSourceLike | null {
    const ctx = this._ctx;
    if (buf === null || ctx === null) return null;
    try {
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        ctx.resume();
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      return src;
    } catch {
      return null;
    }
  }

  // ---- FUN_5571_0007 analog -----------------------------------------------
  /**
   * Gated one-shot square tone == FUN_5571_0007(freq, dur).
   *
   * `freq` in Hz, `ms` in milliseconds (the original `dur` is PIT ticks; this port
   * uses ms).  Sub-19 Hz is dropped (the original's clamp).  `enabled` overrides
   * the master gate for this call (pass cfg.is_on('SOUND') at the site); when
   * undefined the persistent `enabled` gate applies.
   *
   * Returns void.  No-op (silent) when gated off or there is no audio context;
   * never raises.  (sound.py returns the pygame Channel/None; no caller consumes
   * the value, and the Phase-1 no-op contract requires undefined here.)
   */
  beep(freq: number, ms: number, enabled?: boolean): void {
    const gate = enabled === undefined ? this.enabled : enabled;
    if (!gate || freq < MIN_FREQ_HZ) return;
    this._play_buffer(this._tone_buffer(freq, ms));
  }

  private _play_sweep(f0: number, f1: number, ms: number): void {
    this._play_buffer(this._sweep_buffer(f0, f1, ms));
  }

  /** Play a SEQUENCE of square blips (the original's per-step a281/0007
   * reprogramming).  `tones` = list of (freq, ms[, f_end]).  Gated. */
  private _play_tones(tones: Tone[], gate: boolean): void {
    if (!gate) return;
    this._play_buffer(this._seq_buffer(tones));
  }

  // ---- named events --------------------------------------------------------
  /**
   * Play a named game-event sound.  Frequencies and shapes are byte-exact to the
   * caller decompiles where recoverable (see module header table); durations are
   * RECONSTRUCTED watchable ms (the original dur is the BLOCKED MIPS-adaptive
   * PIT-tick budget).
   *
   * kw.size (explosion): blast radius in px -> more/longer alternations.
   *
   * `enabled` overrides the SOUND gate for this call (read cfg.is_on('SOUND') at
   * the site).  Returns void; never raises.
   */
  play(event: string, enabled?: boolean, kw?: { size?: number }): void {
    const gate = enabled === undefined ? this.enabled : enabled;
    if (!gate) return;

    if (event === "fire") {
      // FUN_2a4a_02f2.c:39-43 -- a281 stepped UP for(i=0;i<100;i+=0xf):
      // 0,15,30,45,60,75,90 Hz (0 and 15 are sub-19, silent in a281).  FACT for
      // the frequencies; ms per step RECON (~14 ms ~= one 9af6 tick).
      const steps: Tone[] = [];
      for (let f = 0; f < 100; f += 0xf) steps.push([f, 14]); // 0,15,30,45,60,75,90
      return this._play_tones(steps, gate);
    }

    if (event === "explosion" || event === "nuke") {
      // FUN_4d1e_03e3.c:30,44-49 (large) -- a281 ALTERNATING 100/200 Hz over the
      // grow + flash loop.  Standard blast FUN_4d1e_015a.c uses the same loop
      // shape with the freq args DROPPED by Ghidra (BLOCKED); 100/200 is the
      // sibling-verified vocabulary (INTERP for std/nuke literal, FACT for _03e3).
      // Bigger size -> more alternations + longer.  RECON durations.
      const size = Number(kw?.size ?? 20) || 20;
      const reps = Math.trunc(_clamp(4 + size / 8.0, 4, 14)); // grow-ring count proxy
      const ms = Math.trunc(_clamp(22 + size * 0.4, 22, 60)); // RECON per-blip ms
      const seq: Tone[] = [];
      for (let i = 0; i < reps; i++) seq.push([i % 2 === 0 ? 200 : 100, ms]);
      return this._play_tones(seq, gate);
    }

    if (event === "plasma") {
      // FUN_3f76_03bd.c:18,22 -- 0007(i*1000,10) rising for i=1..9 then
      // 0007((10-i)*1000,10) falling: a 1000->9000->1000 Hz siren.  FACT freqs;
      // 10-ms RECON per blip.
      const seq: Tone[] = [];
      for (let i = 1; i < 10; i++) seq.push([i * 1000, 16]); // 1000..9000
      for (let i = 1; i < 10; i++) seq.push([(10 - i) * 1000, 16]); // 9000..1000
      return this._play_tones(seq, gate);
    }

    if (event === "shield_collapse") {
      // FUN_4191_0034.c:41-46 -- 51x 0007(f,0x14), f=6000 stepping -100 (down to
      // ~4900), then 0007(1000,10): a descending sweep + low thud.  FACT (start
      // 6000, step -100, 0x33=51 steps, final 1000).  ms per step RECON.
      const seq = this._sweep_steps(6000, -100, 0x33, 6);
      seq.push([1000, 40]);
      return this._play_tones(seq, gate);
    }

    if (event === "shield_deploy") {
      // FUN_4191_0455.c:58-62 -- 51x 0007(f,0x14), f=1000 stepping +100 (up to
      // ~6000): a rising sweep.  FACT (start 1000, step +100, 0x33=51).  RECON ms.
      return this._play_tones(this._sweep_steps(1000, 100, 0x33, 6), gate);
    }

    if (event === "shield_hit") {
      // NO original tone: the shield-ABSORB branch of FUN_4191_0034 makes no 5571
      // call (only the collapse branch does).  PORT-ADDED cue (a brief metallic
      // chink) so a non-breaking hit is audible; NOT byte-exact, no cite.  RECON.
      return this.beep(900, 40, gate);
    }

    if (event === "throe_front") {
      // FUN_271b_03b5 (file 0x1df65): 40 loop ticks, tone starts 1000 Hz,
      // += 200 per tick, wrapping to 1000 past 4000 (0xfa0) -- the kill
      // roulette's rising lead-in for cases 0-5.  FACT freqs/steps/count
      // (notes_death_throe_roulette.md s.2.3); ms per blip RECON.
      const seq: Tone[] = [];
      let f = 1000;
      for (let i = 0; i < 40; i++) {
        seq.push([f, 12]);
        f += 200;
        if (f > 4000) {
          f = 1000;
        }
      }
      return this._play_tones(seq, gate);
    }

    if (event === "throe_thud") {
      // Roulette case 0 (file 0x1dcce): 5571:0007(0x64, 0xa) -- a single
      // 100 Hz thud.  FACT freq; RECON ms.
      return this._play_tones([[100, 90]], gate);
    }

    if (event === "sink") {
      // Roulette case 8, FUN_352c_00c9: falling tones 5000 -> 300 Hz while
      // the corpse sinks.  FACT endpoints; step/ms RECON.
      return this._play_tones(this._sweep_steps(5000, -200, 24, 10), gate);
    }

    if (event === "death") {
      // FUN_3ef5_029a.c:54-77 -- 20 Hz rumble: 0007(0x14,0) repeated with a
      // growing 9af6 delay, plus debris ticks at 0007(0x14,0).  FACT (20 Hz).
      // 20 Hz is just above the 19 Hz clamp -> a low sub-bass buzz.  RECON the
      // rumble as a run of 20 Hz blips with lengthening gaps.
      const seq: Tone[] = [];
      for (let i = 10; i < 0x14; i++) {
        // the for(iVar6=10;<0x14) loop
        seq.push([0x14, 22]); // 20 Hz blip
        seq.push([0, (i - 10) * -2 + 0x19]); // the decreasing 9af6 gap
      }
      return this._play_tones(seq, gate);
    }

    if (event === "battery") {
      // FUN_3a16_0f44.c:17-21 -- 0007(100,0xf),0007(200,10),0007(100,0x14): a
      // 100/200/100 Hz arpeggio.  FACT freqs; dur order 0xf<10<0x14 preserved as
      // RECON ms 22<28<34.
      return this._play_tones(
        [
          [100, 22],
          [200, 28],
          [100, 34],
        ],
        gate
      );
    }

    if (event === "parachute") {
      // FUN_2975_048c.c:165 -- 0007(2000,0x1e): a steady 2000 Hz, dur 0x1e.  FACT.
      // RECON ms.
      return this.beep(2000, 48, gate);
    }

    if (event === "dirt_settle") {
      // FUN_3667_06d1.c:39,52 -- 0007(0x1e,0)=30 Hz per gravity drop step, then
      // 0007(0x14,5)=20 Hz at settle.  FACT.  RECON ms.
      return this._play_tones(
        [
          [0x1e, 18],
          [0x1e, 18],
          [0x14, 30],
        ],
        gate
      );
    }

    if (event === "teleport") {
      // FUN_262c_013e.c:19 -- a281(rand%100*100 + 1000): random 1000..10900 Hz,
      // 100 iterations (a warble), gated.  FACT formula.  RECON: a short run of
      // pseudo-random blips (a fixed pattern so the buffer caches).
      const seq: Tone[] = [];
      // deterministic glibc LCG.  BigInt is REQUIRED for parity with sound.py:
      // f*1103515245 exceeds 2^53 once f>~2^22, so Number math silently drops
      // low bits BEFORE the 31-bit mask and desyncs the warble after the first
      // step (Number gives 4200.. where the exact-int oracle gives 10800..).
      // (f*1103515245 + 12345) & 0x7fffffff in big-int matches scorch.sound.
      let f = 1000n;
      for (let i = 0; i < 12; i++) {
        f = (f * 1103515245n + 12345n) & 0x7fffffffn;
        seq.push([Number(f % 100n) * 100 + 1000, 10]);
      }
      return this._play_tones(seq, gate);
    }

    if (event === "lightning") {
      // FUN_480f_0219.c:20 -- a281(2000) ground strike (STORMY gate).  FACT.
      return this.beep(2000, 70, gate);
    }

    if (event === "thunder") {
      // FUN_480f_0148.c -- 0007(rand 100) heat-lightning flicker, 2-5 flashes
      // (rand(4)+2).  FACT (freq is a rand(100) low tone).  RECON pattern.
      return this._play_tones(
        [
          [70, 24],
          [40, 30],
          [90, 22],
          [50, 28],
        ],
        gate
      );
    }

    if (event === "laser") {
      // FUN_3581_00d4.c:67-72 -- a281(local_2c) rising, start 1000 +0x96(150) per
      // pixel, capped 20000.  FACT (rising, start/step/cap).  RECON the beam as a
      // fast rising chirp 1000 -> ~6000.
      return this._play_sweep(1000, 6000, 90);
    }

    if (event === "bounce" || event === "fizzle" || event === "mirv") {
      // FUN_2a4a_0b1f.c (bounce, restitution branch) and FUN_35d5_041b.c:29 (mirv
      // split) call 0007() with the freq arg DROPPED by Ghidra -> BLOCKED.  These
      // are PORT-CHOSEN placeholders (a short blip), NOT byte-exact, flagged
      // because the original literal is unrecoverable.  RECON.
      if (event === "bounce") return this.beep(520, 36, gate); // mid ricochet tick
      if (event === "mirv") return this.beep(700, 30, gate); // cluster-split tick
      return this.beep(300, 40, gate); // fizzle dud
    }

    if (event === "victory") {
      // FUN_352c_00c9.c:90-119 -- FUN_5571_0111(5000) then (300), then a ramp
      // local_a 5000 -> 15000 (rising fanfare via the divide-variant tone).  FACT
      // (rising sweep, endpoints).  RECON ms.
      return this._play_sweep(5000, 15000, 260);
    }

    if (event === "ui_beep") {
      // FUN_5571_0007(200,0x28) -- the buy-fail / menu-reject / select-empty beep,
      // reused at ~25 call sites.  FACT.
      return this.beep(UI_BEEP_HZ, UI_BEEP_MS, gate);
    }

    if (event === "turn" || event === "menu_move" || event === "select") {
      // FUN_38b5_13c0.c:30 / FUN_38b5_145b.c:27 -- 0007(0x14,100): a steady 20 Hz,
      // dur 100, on next-player / weapon-select-confirm.  FACT (20 Hz, long dur).
      // 20 Hz is a near-sub-bass buzz.  RECON ms.
      return this.beep(0x14, 70, gate);
    }

    if (event === "dialog_open" || event === "dialog_close") {
      // Dialog OPEN/CLOSE zoom-wipe sweep (RECOVERED_ANIMATIONS.md:530-537 / #18;
      // the speaker side of missing-animation #3).
      //
      // GROUND TRUTH of the v1.5 dialog audio (FACT): the open/close wipe families
      // do NOT call the smooth-glide primitive FUN_5571_00c8.  The 2917 line/box
      // wipes carry NO tone at all (callgraph: only FUN_1000_9af6).  The 2d4f
      // option-dialog wipe emits one FUN_5571_0007(rand(0x32)) per drawn frame --
      // a burst of tones at a RANDOM freq in [0,50) Hz, every one at/below
      // MIN_FREQ_HZ, so the raw v1.5 dialog "sound" is a near-inaudible sub-bass
      // buzz, not a melodic chirp.
      //
      // RECONSTRUCTED (labelled): play the *direction* the wipe implies as an
      // audible square glide via _play_sweep -- the numpy/WebAudio analog of the
      // real sliding-delay sweep primitive FUN_5571_00c8 (UP if end>start else
      // DOWN).  Open = rising (box scales OUT), close = falling (box collapses IN).
      // Freqs/durations are a port choice; NOT byte-exact.
      if (event === "dialog_open") return this._play_sweep(260, 720, 150); // rising "zoom-out"
      return this._play_sweep(720, 260, 150); // falling "zoom-in"
    }

    return;
  }

  // ---- stepped-sweep helpers (shield sweeps) ------------------------------
  /**
   * Build the (freq, ms) blip list for the shield sweeps: `count` blips, freq =
   * start + step*i, clamped to the audible band.  Mirrors the original's per-step
   * 0007(f,0x14) reprogramming (FUN_4191_0034/_0455).  `blip_ms` is RECON.
   */
  _sweep_steps(start: number, step: number, count: number, blip_ms: number): Tone[] {
    const out: Tone[] = [];
    let f = start;
    for (let i = 0; i < count; i++) {
      out.push([Math.trunc(_clamp(f, MIN_FREQ_HZ, MAX_FREQ_HZ)), blip_ms]);
      f += step;
    }
    return out;
  }

  // ---- continuous flight tone (FLY_SOUND) ---------------------------------
  /** Record the projectile launch height for POS-mode pitch (the original stashes
   * it in DAT_5f38_ce96 in FUN_2a4a_02f2 before the flight loop). */
  set_launch_y(y: number): void {
    this._fly_launch_y = y;
  }

  /**
   * Compute the flight-tone frequency for the current projectile state, byte-exact
   * to the original.
   *
   * POS (DAT_5f38_5146==2, FUN_2a4a_1349.c:163):
   *   pitch = (launch_y - cur_y)*8 + 1000, floored at 0x32 (50).
   * VEL (DAT_5f38_5146==1, FUN_2a4a_0b1f.c):
   *   pitch = |v| = sqrt(vx^2 + vy^2).
   * (cfg.FLY_SOUND strings POS/VEL map onto modes 2/1.)
   */
  _fly_freq_for(mode: string, proj: { sx?: number; sy?: number; vx?: number; vy?: number }): number {
    if (mode === "POS") {
      const sy = proj.sy ?? 0;
      // launch_y: prefer the recorded value; fall back to field top so the formula
      // degrades sanely if the game has not called set_launch_y.
      const launch_y = this._fly_launch_y !== null ? this._fly_launch_y : 0;
      let pitch = (launch_y - sy) * 8 + 1000;
      if (pitch < 0x32) pitch = 0x32; // the original's floor
      return Math.trunc(_clamp(pitch, MIN_FREQ_HZ, MAX_FREQ_HZ));
    }
    // VEL (default for any non-OFF, non-POS value): pitch = speed magnitude.
    const speed = Math.hypot(proj.vx ?? 0.0, proj.vy ?? 0.0);
    return Math.trunc(_clamp(speed, MIN_FREQ_HZ, MAX_FREQ_HZ));
  }

  /**
   * Begin the continuous flight whine if FLY_SOUND is POS/VEL and SOUND is on.
   * `mode` overrides fly_mode for this flight (pass cfg.FLY_SOUND); `enabled`
   * overrides the SOUND gate (pass cfg.is_on('SOUND')).  No-op when gated off or
   * audio is down.  Idempotent: a second call does not stack.
   */
  start_fly(mode?: string, enabled?: boolean): void {
    const gate = enabled === undefined ? this.enabled : enabled;
    const m = (mode !== undefined ? mode : this.fly_mode) || "OFF";
    this.fly_mode = m;
    if (!gate || m === "OFF" || !this.init()) return;
    // a short looped tone re-pitched every frame by fly_tone(); seed at a mid pitch
    // so there is sound even before the first fly_tone() update.
    const buf = this._tone_buffer(300, 60);
    const ctx = this._ctx;
    if (buf === null || ctx === null) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(ctx.destination);
      src.start();
      this._fly_source = src;
      this._fly_freq = 300;
    } catch {
      this._fly_source = null;
    }
  }

  /**
   * Update the in-flight whine to match `proj` (call once per physics frame while
   * a shell is airborne).  `mode` in OFF / POS / VEL (read cfg.FLY_SOUND); `proj`
   * is the live Projectile.
   *
   * Lazily starts the loop if not running, re-pitches it (swaps the looped buffer
   * only when the integer frequency actually changes, so the cache does the work
   * and we are not rebuilding buffers every frame), and stops it when mode is OFF.
   * No-op / silent when gated off.
   */
  fly_tone(
    mode: string,
    proj: { sx?: number; sy?: number; vx?: number; vy?: number },
    enabled?: boolean
  ): void {
    const gate = enabled === undefined ? this.enabled : enabled;
    const m = mode || "OFF";
    this.fly_mode = m;
    if (!gate || m === "OFF") {
      this.stop_fly();
      return;
    }
    if (!this.init()) return;
    if (this._fly_source === null) {
      this.start_fly(m, gate);
      if (this._fly_source === null) return;
    }
    const freq = this._fly_freq_for(m, proj);
    if (freq !== this._fly_freq) {
      const buf = this._tone_buffer(freq, 60);
      const ctx = this._ctx;
      if (buf !== null && ctx !== null) {
        // AudioBufferSourceNode is single-use; swap the looped source.
        try {
          if (this._fly_source !== null) this._fly_source.stop();
        } catch {
          /* already stopped */
        }
        try {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(ctx.destination);
          src.start();
          this._fly_source = src;
          this._fly_freq = freq;
        } catch {
          /* leave the previous source running */
        }
      }
    }
  }

  /** Stop the flight whine (call on impact / when no shell is airborne).  Safe to
   * call when nothing is playing. */
  stop_fly(): void {
    if (this._fly_source !== null) {
      try {
        this._fly_source.stop();
      } catch {
        /* already stopped */
      }
    }
    this._fly_source = null;
    this._fly_freq = 0;
  }
}

/** Module-level singleton.  Import as `import { sfx } from "./sound";`. */
export const sfx = new Sfx();

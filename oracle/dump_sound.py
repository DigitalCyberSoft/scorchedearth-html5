#!/usr/bin/env python3
"""Oracle vector dumper for the `sound` module.

Drives scorch/sound.py's _Sfx synthesis (the fidelity reference) headless and
writes golden vectors to vectors/sound.json.  The TS differential gate
(test/sound.test.ts) asserts src/sound.ts reproduces every int16 sample array
EXACTLY and every raw sin float within 1e-12.

WHY THE SYNTHESIS IS NUMERICALLY TESTABLE WITHOUT AUDIO:  _Sfx() constructed with
no mixer leaves `_mix_rate`/`_mix_channels` unset, so `getattr(self, "_mix_rate",
SAMPLE_RATE)` falls back to SAMPLE_RATE=44100 and the synthesis (_square_wave ->
_envelope -> _finish -> _square_array / _seq_array) is fully deterministic and
device-independent.  Playback (pygame.mixer / WebAudio) is NOT node-testable; we
dump the SAMPLE GENERATION only, exactly as the brief requires.

The per-channel int16 column is dumped (sound.py column_stacks two identical
channels; the TS _finish returns that same mono plane, which the WebAudio side
duplicates into both buffer channels).

Run (from scorch-html5/):
    SDL_VIDEODRIVER=dummy PYTHONPATH="../scorch-py" \
        "../.venv/bin/python" oracle/dump_sound.py
"""
import json
import math
import os
import sys

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

_HERE = os.path.dirname(os.path.abspath(__file__))
_VECTORS = os.path.join(_HERE, "vectors")
_SCORCH_PY = os.path.normpath(os.path.join(_HERE, "..", "..", "scorch-py"))
if _SCORCH_PY not in sys.path:
    sys.path.insert(0, _SCORCH_PY)


def _write(module, payload):
    os.makedirs(_VECTORS, exist_ok=True)
    path = os.path.join(_VECTORS, module + ".json")
    with open(path, "w") as fh:
        json.dump(payload, fh)
    print(f"  wrote vectors/{module}.json")


def _left(arr):
    """Per-channel int16 column as a Python int list.  sound.py stereo-stacks two
    identical channels, so column 0 is the canonical synthesis plane."""
    import numpy as np
    a = np.asarray(arr)
    if a.ndim == 2:
        a = a[:, 0]
    return a.astype(int).tolist()


def dump_sound():
    import numpy as np
    from scorch import sound

    sfx = sound._Sfx()  # NO mixer -> _mix_rate=44100, _mix_channels=2 via getattr

    # --- module constants (exact-equality lock) ---------------------------
    consts = {
        "SAMPLE_RATE": sound.SAMPLE_RATE,
        "CHANNELS": sound.CHANNELS,
        "AMPLITUDE": sound.AMPLITUDE,
        "MIN_FREQ_HZ": sound.MIN_FREQ_HZ,
        "MAX_FREQ_HZ": sound.MAX_FREQ_HZ,
        "UI_BEEP_HZ": sound.UI_BEEP_HZ,
        "UI_BEEP_MS": sound.UI_BEEP_MS,
    }

    # --- _square_array battery (steady tones): full int16 plane -----------
    # Spans: sub-clamp (19), low (20), the UI/event freqs, high, clamp ceiling,
    # plus n<=2*fade short blips (no-envelope branch) and n>2*fade (envelope).
    TONE_BATT = [
        (200, 64), (2000, 48), (100, 22), (9000, 16), (20, 22), (6000, 6),
        (19, 5), (440, 50), (5000, 12), (15000, 3), (12000, 40), (3000, 100),
        (50, 5), (7000, 7), (11000, 33), (200, 1), (1000, 8), (30, 18),
        (520, 36), (700, 30), (300, 40), (900, 40), (70, 24), (40, 30),
    ]
    square = []
    for (freq, ms) in TONE_BATT:
        plane = _left(sfx._square_array(freq, ms))
        square.append({"freq": freq, "ms": ms, "n": len(plane), "plane": plane})

    # --- _square_array sweeps (f_end given): chirp int16 plane ------------
    SWEEP_BATT = [
        (1000, 90, 6000), (5000, 260, 15000), (260, 150, 720), (720, 150, 260),
        (100, 12, 6000), (6000, 6, 1000),
    ]
    sweep = []
    for (f0, ms, f1) in SWEEP_BATT:
        plane = _left(sfx._square_array(f0, ms, f_end=f1))
        sweep.append({"f0": f0, "ms": ms, "f1": f1, "n": len(plane), "plane": plane})

    # --- raw _square_wave sin floats (epsilon-tested) --------------------
    # _square_wave returns sign(sin); the EPSILON requirement of the brief is for
    # the underlying transcendental, so dump the raw sin(phase) the TS recomputes,
    # asserted within 1e-12.  Formula identical to sound.py _square_wave.
    def raw_sin(freq, n, f_end=None, rate=44100):
        t = np.arange(n, dtype=np.float64) / rate
        if f_end is None or f_end == freq:
            phase = 2.0 * math.pi * freq * t
        else:
            dur_s = n / float(rate)
            k = (f_end - freq) / dur_s if dur_s > 0 else 0.0
            phase = 2.0 * math.pi * (freq * t + 0.5 * k * t * t)
        return np.sin(phase)

    SIN_BATT = [(440, 64, None), (200, 40, None), (7000, 20, None),
                (1000, 30, 6000), (5000, 24, 15000)]
    raw = []
    for (freq, ms, f_end) in SIN_BATT:
        n = max(1, int(44100 * ms / 1000.0))
        s = raw_sin(freq, n, f_end).tolist()
        raw.append({"freq": freq, "ms": ms, "f_end": f_end, "n": n, "sin": s})

    # --- _seq_array battery (sub-19 silence, clamp, concat, sweep blip) ---
    SEQ_BATT = {
        "sub19": [[5, 10], [18, 10], [19, 10], [20, 10]],
        "clamp": [[99999, 8], [0, 8], [13000, 8]],
        "sweepblip": [[1000, 12, 6000]],
        "death0": [[0x14, 22], [0, 21]],
        "mixed": [[100, 22], [200, 28], [100, 34]],
        "empty_silence": [[0, 5]],
    }
    seq = []
    for name, tones in SEQ_BATT.items():
        plane = _left(sfx._seq_array(tuple(tuple(t) for t in tones)))
        seq.append({"name": name, "tones": tones, "n": len(plane), "plane": plane})

    # --- _sweep_steps (shield sweeps): the (freq,ms) blip list ------------
    SWEEP_STEPS = [
        (6000, -100, 0x33, 6), (1000, 100, 0x33, 6), (1000, 100, 5, 12),
        (50, -100, 4, 8),  # clamp-to-floor at the bottom
    ]
    sweep_steps = []
    for (start, step, count, blip_ms) in SWEEP_STEPS:
        out = [list(t) for t in sfx._sweep_steps(start, step, count, blip_ms)]
        sweep_steps.append({"start": start, "step": step, "count": count,
                            "blip_ms": blip_ms, "out": out})

    # --- _fly_freq_for: POS (floored at 50) + VEL (hypot), with clamps ----
    class _P:
        def __init__(self, sy=0, vx=0.0, vy=0.0):
            self.sy = sy
            self.vx = vx
            self.vy = vy

    fly = []
    # POS cases: vary launch_y (set_launch_y) and sy.
    POS_CASES = [
        (400, 300), (400, 400), (400, -5000), (None, 10000), (0, 0),
        (100, 50), (200, 250), (1000, 1000),
    ]
    for (launch, sy) in POS_CASES:
        sfx._fly_launch_y = launch
        f = sfx._fly_freq_for("POS", _P(sy=sy))
        fly.append({"mode": "POS", "launch": launch, "sy": sy, "out": int(f)})
    sfx._fly_launch_y = None
    # VEL cases: hypot then clamp [19,12000], truncated to int.
    VEL_CASES = [
        (30.0, 40.0), (3.0, 4.0), (9000.0, 9000.0), (0.0, 0.0), (50.9, 0.0),
        (12.0, 16.0), (700.5, 700.5), (10.0, 10.0),
    ]
    for (vx, vy) in VEL_CASES:
        f = sfx._fly_freq_for("VEL", _P(vx=vx, vy=vy))
        fly.append({"mode": "VEL", "vx": vx, "vy": vy, "out": int(f)})

    # --- end-to-end EVENT TONE TABLES ------------------------------------
    # play() returns a Channel, not samples, so reconstruct each event's tone list
    # with the SAME formulas as sound.py play() and dump the int16 plane the
    # builder produces.  The TS test rebuilds the identical tone list in
    # src/sound.ts via _seq_array/_square_array/_sweep_steps + beep's _square_array
    # and asserts byte-equality.  Every list here is a verbatim transcription of a
    # play()/beep() branch (cites in sound.py).
    def _clamp(v, lo, hi):
        return lo if v < lo else hi if v > hi else v

    events = {}

    # fire: a281 stepped UP 0,15..90 (FUN_2a4a_02f2.c:39-43)
    fire = [(f, 14) for f in range(0, 100, 0xf)]
    events["fire"] = {"kind": "seq", "tones": [list(t) for t in fire],
                      "plane": _left(sfx._seq_array(tuple(fire)))}

    # explosion default size 20 (FUN_4d1e_03e3): reps/ms from size
    for size in (None, 10, 20, 100):
        s = float(20 if size is None else size) or 20.0
        reps = int(_clamp(4 + s / 8.0, 4, 14))
        ms = int(_clamp(22 + s * 0.4, 22, 60))
        seqx = [(200 if i % 2 == 0 else 100, ms) for i in range(reps)]
        key = "explosion" if size is None else f"explosion_{size}"
        events[key] = {"kind": "seq", "tones": [list(t) for t in seqx],
                       "plane": _left(sfx._seq_array(tuple(seqx)))}

    # plasma: up 1000..9000 then down 9000..1000 (FUN_3f76_03bd.c:18,22)
    up = [(i * 1000, 16) for i in range(1, 10)]
    down = [((10 - i) * 1000, 16) for i in range(1, 10)]
    plasma = up + down
    events["plasma"] = {"kind": "seq", "tones": [list(t) for t in plasma],
                        "plane": _left(sfx._seq_array(tuple(plasma)))}

    # shield_collapse: _sweep_steps(6000,-100,0x33,6) + (1000,40) (FUN_4191_0034)
    sc = sfx._sweep_steps(6000, -100, 0x33, 6) + [(1000, 40)]
    events["shield_collapse"] = {"kind": "seq", "tones": [list(t) for t in sc],
                                 "plane": _left(sfx._seq_array(tuple(sc)))}

    # shield_deploy: _sweep_steps(1000,100,0x33,6) (FUN_4191_0455)
    sd = sfx._sweep_steps(1000, 100, 0x33, 6)
    events["shield_deploy"] = {"kind": "seq", "tones": [list(t) for t in sd],
                               "plane": _left(sfx._seq_array(tuple(sd)))}

    # death: 20Hz blips + decreasing gaps (FUN_3ef5_029a.c:54-77)
    death = []
    for i in range(10, 0x14):
        death.append((0x14, 22))
        death.append((0, (i - 10) * -2 + 0x19))
    events["death"] = {"kind": "seq", "tones": [list(t) for t in death],
                       "plane": _left(sfx._seq_array(tuple(death)))}

    # battery (FUN_3a16_0f44.c:17-21)
    battery = [(100, 22), (200, 28), (100, 34)]
    events["battery"] = {"kind": "seq", "tones": [list(t) for t in battery],
                         "plane": _left(sfx._seq_array(tuple(battery)))}

    # dirt_settle (FUN_3667_06d1.c:39,52)
    dirt = [(0x1e, 18), (0x1e, 18), (0x14, 30)]
    events["dirt_settle"] = {"kind": "seq", "tones": [list(t) for t in dirt],
                             "plane": _left(sfx._seq_array(tuple(dirt)))}

    # teleport: deterministic LCG warble (FUN_262c_013e.c:19)
    tele = []
    f = 1000
    for i in range(12):
        f = (f * 1103515245 + 12345) & 0x7fffffff
        tele.append(((f % 100) * 100 + 1000, 10))
    events["teleport"] = {"kind": "seq", "tones": [list(t) for t in tele],
                          "plane": _left(sfx._seq_array(tuple(tele)))}

    # thunder (FUN_480f_0148.c)
    thunder = [(70, 24), (40, 30), (90, 22), (50, 28)]
    events["thunder"] = {"kind": "seq", "tones": [list(t) for t in thunder],
                         "plane": _left(sfx._seq_array(tuple(thunder)))}

    # --- single-tone events (beep) -> _square_array(freq, ms) ------------
    # Each is a beep(freq, ms) branch; the int16 plane is _square_array(freq, ms)
    # after beep's int(_clamp)/int(max(1,ms)).  (freq below MIN is dropped by beep;
    # all these are >= MIN so the plane is produced.)
    BEEP_EVENTS = {
        "shield_hit": (900, 40),
        "parachute": (2000, 48),
        "lightning": (2000, 70),
        "ui_beep": (sound.UI_BEEP_HZ, sound.UI_BEEP_MS),
        "turn": (0x14, 70),
        "bounce": (520, 36),
        "mirv": (700, 30),
        "fizzle": (300, 40),
    }
    for name, (freq, ms) in BEEP_EVENTS.items():
        # beep() clamps freq to [MIN,MAX] and ms to >=1 before synthesis; store the
        # CLAMPED values so the TS test rebuilds the identical plane (the raw label
        # would desync a near-zero-crossing sample if it crossed the 12000 ceiling).
        fr = int(_clamp(freq, sound.MIN_FREQ_HZ, sound.MAX_FREQ_HZ))
        m = int(max(1, ms))
        events[name] = {"kind": "tone", "freq": fr, "ms": m,
                        "plane": _left(sfx._square_array(fr, m))}

    # --- sweep events (laser/victory/dialog) -> _square_array(f0,ms,f_end) -
    SWEEP_EVENTS = {
        "laser": (1000, 6000, 90),
        "victory": (5000, 15000, 260),
        "dialog_open": (260, 720, 150),
        "dialog_close": (720, 260, 150),
    }
    for name, (f0, f1, ms) in SWEEP_EVENTS.items():
        # _sweep() clamps both endpoints to [MIN,MAX] and ms to >=1 before
        # synthesis (victory's 15000 -> 12000 ceiling).  Store the CLAMPED
        # endpoints so the TS test's _square_array(f0,ms,f1) rebuild reproduces the
        # synthesized plane byte-for-byte -- the raw 15000 produces a different
        # chirp whose sign at one near-zero-crossing sample legitimately differs.
        a = int(_clamp(f0, sound.MIN_FREQ_HZ, sound.MAX_FREQ_HZ))
        b = int(_clamp(f1, sound.MIN_FREQ_HZ, sound.MAX_FREQ_HZ))
        m = int(max(1, ms))
        events[name] = {"kind": "sweep", "f0": a, "f1": b, "ms": m,
                        "plane": _left(sfx._square_array(a, m, f_end=b))}

    payload = {
        "module": "sound",
        "consts": consts,
        "square": square,
        "sweep": sweep,
        "raw": raw,
        "seq": seq,
        "sweep_steps": sweep_steps,
        "fly": fly,
        "events": events,
    }
    _write("sound", payload)
    nsamp = (sum(s["n"] for s in square) + sum(s["n"] for s in sweep)
             + sum(len(s["sin"]) for s in raw) + sum(s["n"] for s in seq)
             + sum(len(e["plane"]) for e in events.values()))
    print(f"  sound: {nsamp} sample/float assertions across "
          f"{len(square)} tones, {len(sweep)} sweeps, {len(seq)} seqs, "
          f"{len(events)} events, {len(fly)} fly cases")


if __name__ == "__main__":
    dump_sound()

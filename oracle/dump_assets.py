#!/usr/bin/env python3
"""Golden vectors for src/assets.ts -- the latin-1 decode bridge.

assets.ts has no whole-module Python counterpart (the browser fetch+decode layer
is browser-only), but its byte-fidelity claim DOES have an oracle: fetchText /
latin1Decode reproduce scorch/talk.py:144 `fh.read().decode("latin-1")`.  This
dumps the latin-1 decode of two byte corpora so the TS test asserts EXACT, not
against a hand-rolled table:

  - full256:    bytes 0x00..0xff -> the 256 latin-1 code points U+0000..U+00FF.
  - crosschunk: a 32778-byte (= 0x8000 + 10) ramp (byte i = i % 256) that crosses
                latin1Decode's 0x8000-char String.fromCharCode chunk boundary, so
                the chunked decode is proven to reassemble byte-exact at the seam.

The TS side regenerates the identical inputs (documented, deterministic) and
compares latin1Decode(input) === output.
"""
import json
import os

OUT = os.path.join(os.path.dirname(__file__), "vectors", "assets.json")

CROSSCHUNK_LEN = 0x8000 + 10  # cross the 32 KiB fromCharCode chunk seam


def main():
    full256 = bytes(range(256)).decode("latin-1")
    crosschunk = bytes((i % 256) for i in range(CROSSCHUNK_LEN)).decode("latin-1")
    vec = {
        "module": "assets",
        "source": "scorch/talk.py:144 .decode('latin-1')",
        "full256": full256,
        "crosschunk_len": CROSSCHUNK_LEN,
        "crosschunk": crosschunk,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(vec, fh, ensure_ascii=False)
    print("wrote", OUT, "full256=%d crosschunk=%d" % (len(full256), len(crosschunk)))


if __name__ == "__main__":
    main()

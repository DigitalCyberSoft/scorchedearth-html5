/**
 * Random number generator -- a bit-exact TypeScript reimplementation of CPython's
 * `random.Random` (MT19937), which is what the Python port's scorch/rng.py wraps.
 *
 * WHY EXACT CPYTHON MT, NOT A SIMPLE LCG:
 *   The Python port (the fidelity oracle for this HTML5 build) could not recover
 *   the original DOS RNG's LCG constants (scorch/rng.py:5-6: "wraps Python's
 *   Mersenne Twister ... RECONSTRUCTED generator, faithful interface"). So the
 *   reference RNG stream IS CPython's MT19937. To get differential equivalence on
 *   every stochastic path (terrain generation, AI aiming, talk picks, weapon
 *   spread), this generator must reproduce CPython's stream value-for-value:
 *   the same seeding (init_by_array on the little-endian 32-bit words of |seed|),
 *   the same getrandbits/_randbelow rejection loop, the same 53-bit random().
 *
 * Reference: CPython Modules/_randommodule.c (genrand_uint32, init_genrand,
 * init_by_array, random_seed, random_getrandbits, random_random) and
 * Lib/random.py (Random._randbelow_with_getrandbits, randrange, uniform).
 *
 * Interface mirrors scorch/rng.py (Rng): seed, pick, chance, uniform, roulette.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class Rng {
  private mt: Uint32Array = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed?: number) {
    if (seed !== undefined) this.seed(seed);
  }

  /** init_genrand(s) -- _randommodule.c. */
  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = (this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)) >>> 0;
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  /** init_by_array(init_key) -- _randommodule.c. */
  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(N, key.length);
    for (; k; k--) {
      const prev = (this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)) >>> 0;
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev, 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (k = N - 1; k; k--) {
      const prev = (this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)) >>> 0;
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev, 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  /**
   * seed(a) for an integer a -- CPython random_seed: key = little-endian 32-bit
   * words of |a| (a==0 -> [0]), then init_by_array. BigInt split is used so seeds
   * wider than 32 bits match CPython exactly.
   */
  seed(a: number): void {
    let v = BigInt(Math.abs(Math.trunc(a)));
    const key: number[] = [];
    if (v === 0n) {
      key.push(0);
    } else {
      while (v > 0n) {
        key.push(Number(v & 0xffffffffn));
        v >>= 32n;
      }
    }
    this.initByArray(key);
  }

  /** genrand_uint32() -- the tempered MT19937 word. */
  genrandUint32(): number {
    if (this.mti >= N) {
      const mt = this.mt;
      let y: number;
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      y = ((mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK)) >>> 0;
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    let y = this.mt[this.mti++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** getrandbits(k) -- CPython random_getrandbits (k in 1..32 fast path; >32 via words). */
  getrandbits(k: number): number {
    if (k <= 0) throw new RangeError("number of bits must be greater than zero");
    if (k <= 32) return this.genrandUint32() >>> (32 - k);
    // k > 32: assemble little-endian 32-bit words into a JS number (safe for the
    // game's actual usage, which never exceeds ~32 bits, but kept general).
    let result = 0;
    let shift = 0;
    let bits = k;
    while (bits > 0) {
      const take = bits < 32 ? bits : 32;
      const word = this.genrandUint32() >>> (32 - take);
      result += word * Math.pow(2, shift);
      shift += 32;
      bits -= 32;
    }
    return result;
  }

  /** _randbelow_with_getrandbits(n) -- Lib/random.py. */
  private randbelow(n: number): number {
    if (n <= 0) return 0;
    const k = 32 - Math.clz32(n); // n.bit_length() for n in [1, 2**32)
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** FUN_3bf9_048b: uniform int in [0, n). Mirrors rng.py Rng.pick (randrange(n)). */
  pick(n: number): number {
    if (n <= 0) return 0;
    return this.randbelow(n);
  }

  /** num/den probability. Mirrors rng.py Rng.chance (randrange(den) < num). */
  chance(num: number, den: number): boolean {
    return this.randbelow(den) < num;
  }

  /** random() -- CPython random_random: 53-bit double in [0, 1). */
  random(): number {
    const a = this.genrandUint32() >>> 5; // 27 bits
    const b = this.genrandUint32() >>> 6; // 26 bits
    return (a * 67108864.0 + b) / 9007199254740992.0;
  }

  /** uniform(a, b) -- Lib/random.py: a + (b-a)*random(). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** FUN_3bf9_0165 normalized pick. Mirrors rng.py Rng.roulette. */
  roulette(weights: number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return this.randbelow(weights.length);
    const t = this.uniform(0, total);
    let acc = 0.0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (t <= acc) return i;
    }
    /* v8 ignore next 1 -- unreachable tail: total>0 here and `acc` sums `weights` in the SAME order as `total`, so acc == total on the final i; t = uniform(0,total) < total <= acc forces an in-loop return. Kept as the type-required fallthrough. */
    return weights.length - 1;
  }
}

/** Module-level shared instance (the game uses one global RNG, seeded at boot). */
export const rng = new Rng();

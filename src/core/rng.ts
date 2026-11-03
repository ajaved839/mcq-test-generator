/**
 * Seeded pseudo-random numbers.
 *
 * Every saved test stores its seed, and every shuffle is derived from that seed, so a test
 * reprints identically years later. Math.random is never used for anything a paper depends on.
 */

/** 32-bit string hash (cyrb53 folded to 32 bits); deterministic across platforms. */
export function hashString(value: string): number {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export interface Rng {
  /** Uniform unsigned 32-bit integer. */
  nextUint32(): number;
  /** Uniform integer in [0, n) without modulo bias. */
  nextInt(n: number): number;
  /** Uniform float in [0, 1). */
  next(): number;
}

/** sfc32: small, fast, passes PractRand; state seeded from four hashed words. */
export function createRng(seed: number | string): Rng {
  const base = typeof seed === 'number' ? `n:${seed}` : `s:${seed}`;
  let a = hashString(`${base}:a`);
  let b = hashString(`${base}:b`);
  let c = hashString(`${base}:c`);
  let d = hashString(`${base}:d`) | 1;

  const nextUint32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const result = (t + d) | 0;
    c = (c + result) | 0;
    return result >>> 0;
  };

  // Warm up so similar seeds diverge quickly.
  for (let i = 0; i < 15; i++) nextUint32();

  const nextInt = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) {
      throw new RangeError(`nextInt bound must be an integer in 1..2^32, got ${n}`);
    }
    // Rejection sampling: discard the top partial bucket to remove modulo bias.
    const limit = 0x100000000 - (0x100000000 % n);
    let value = nextUint32();
    while (value >= limit) value = nextUint32();
    return value % n;
  };

  return {
    nextUint32,
    nextInt,
    next: () => nextUint32() / 0x100000000,
  };
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Derives an independent stream for a named purpose (e.g. "version:B"). */
export function deriveRng(seed: number | string, purpose: string): Rng {
  return createRng(`${seed}|${purpose}`);
}

/** A fresh random seed for "Regenerate"; uses crypto when available. */
export function randomSeed(): number {
  const cryptoObj = (
    globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }
  ).crypto;
  if (cryptoObj?.getRandomValues) {
    return cryptoObj.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x100000000);
}

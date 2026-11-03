import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, hashString, shuffled } from '../../src/core/rng';
import { plain } from '../../src/core/richtext';
import {
  buildVersions,
  isPinnedLast,
  optionLockReason,
  referencesLetters,
  shuffleOptionOrder,
  type ShuffleQuestion,
} from '../../src/core/shuffle';

const q = (
  id: string,
  options: string[],
  correct = 0,
  extra: Partial<ShuffleQuestion> = {},
): ShuffleQuestion => ({
  id,
  subject: 'Biology',
  options: options.map(plain),
  correct,
  lockOptions: false,
  ...extra,
});

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = createRng(123);
    const b = createRng(123);
    expect([a.nextUint32(), a.nextUint32()]).toEqual([b.nextUint32(), b.nextUint32()]);
    expect(createRng('x').nextUint32()).not.toBe(createRng('y').nextUint32());
    expect(hashString('abc')).toBe(hashString('abc'));
  });

  it('nextInt stays in range and rejects bad bounds', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(() => rng.nextInt(0)).toThrow();
    expect(() => rng.nextInt(1.5)).toThrow();
  });

  it('shuffle is a permutation', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer(), (items, seed) => {
        const out = shuffled(items, createRng(seed));
        expect([...out].sort()).toEqual([...items].sort());
      }),
    );
  });
});

describe('option locks', () => {
  it('detects "all/none of the above"', () => {
    expect(isPinnedLast(plain('All of the above'))).toBe(true);
    expect(isPinnedLast(plain('None of these'))).toBe(true);
    expect(isPinnedLast(plain('Both of the above'))).toBe(true);
    expect(isPinnedLast(plain('Mitochondrion'))).toBe(false);
  });

  it('detects options that cite letters', () => {
    for (const value of [
      'Both a and b',
      'Both (a) and (c)',
      'a and b',
      'A, B and C',
      'Neither A nor B',
      'Option b',
      '(a) only',
      'All except c',
    ]) {
      expect(referencesLetters(plain(value)), value).toBe(true);
    }
    for (const value of [
      'A cell wall',
      'Both are mammals',
      'All of the above',
      'Vitamin A',
      'Only plants',
    ]) {
      expect(referencesLetters(plain(value)), value).toBe(false);
    }
  });

  it('keeps "None of the above" last', () => {
    const question = q('q1', ['Red', 'Green', 'Blue', 'None of the above'], 3);
    for (let seed = 0; seed < 200; seed++) {
      expect(shuffleOptionOrder(question, createRng(seed))[3]).toBe(3);
    }
  });

  it('keeps letter-referencing questions in their original order', () => {
    const question = q('q1', ['Lungs', 'Gills', 'Skin', 'Both a and b'], 3);
    expect(optionLockReason(question)).toBe('letter-reference');
    for (let seed = 0; seed < 50; seed++) {
      expect(shuffleOptionOrder(question, createRng(seed))).toEqual([0, 1, 2, 3]);
    }
  });

  it('locks when a pinned option is not already last', () => {
    expect(optionLockReason(q('q', ['None of the above', 'Red', 'Blue']))).toBe('pinned-not-last');
  });

  it('honours the manual lock', () => {
    const question = q('q', ['1', '2', '3', '4'], 0, { lockOptions: true });
    expect(shuffleOptionOrder(question, createRng(5))).toEqual([0, 1, 2, 3]);
  });
});

describe('paper versions', () => {
  const questions = Array.from({ length: 30 }, (_, i) =>
    q(`q${i}`, [`w${i}`, `x${i}`, `y${i}`, `z${i}`], i % 4, {
      subject: i < 15 ? 'Biology' : 'Physics',
    }),
  );

  it('produces 1 to 4 versions with distinct question order and their own key', () => {
    const versions = buildVersions(questions, { versions: 4, seed: 77 });
    expect(versions.map((v) => v.letter)).toEqual(['A', 'B', 'C', 'D']);
    const orders = versions.map((v) => v.questions.map((x) => x.questionId).join());
    expect(new Set(orders).size).toBe(4);
    for (const version of versions) {
      for (const vq of version.questions) {
        const original = questions.find((x) => x.id === vq.questionId)!;
        expect(vq.optionOrder[vq.correctPos]).toBe(original.correct);
        expect(vq.correctLetter).toBe('ABCDE'[vq.correctPos]);
      }
    }
  });

  it('reprints identically from the same seed', () => {
    expect(buildVersions(questions, { versions: 3, seed: 'abc' })).toEqual(
      buildVersions(questions, { versions: 3, seed: 'abc' }),
    );
  });

  it('keeps subject sections together by default', () => {
    const [a] = buildVersions(questions, { versions: 1, seed: 1 });
    const subjects = a.questions.map((x) => questions.find((y) => y.id === x.questionId)!.subject);
    expect(subjects.slice(0, 15).every((s) => s === 'Biology')).toBe(true);
  });

  it('rejects a version count outside 1 to 4', () => {
    expect(() => buildVersions(questions, { versions: 5, seed: 1 })).toThrow();
    expect(() => buildVersions(questions, { versions: 0, seed: 1 })).toThrow();
  });

  it('every version contains every question exactly once (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer(),
        (n, versions, seed) => {
          const qs = Array.from({ length: n }, (_, i) =>
            q(`q${i}`, ['a1', 'b1', 'c1', 'None of the above'], i % 4),
          );
          for (const v of buildVersions(qs, { versions, seed })) {
            expect(new Set(v.questions.map((x) => x.questionId)).size).toBe(n);
            for (const vq of v.questions) {
              expect(vq.optionOrder[3]).toBe(3);
              expect([...vq.optionOrder].sort()).toEqual([0, 1, 2, 3]);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('statistical fairness', () => {
  it('answer positions are uniform over 100,000 seeded shuffles (chi-square)', () => {
    const question = q('q', ['w', 'x', 'y', 'z'], 0);
    const counts = [0, 0, 0, 0];
    const rng = createRng('chi-square');
    const n = 100_000;
    for (let i = 0; i < n; i++) counts[shuffleOptionOrder(question, rng).indexOf(0)] += 1;
    const expected = n / 4;
    const chi = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    // Critical value for 3 degrees of freedom at p = 0.001 is 16.27.
    expect(chi).toBeLessThan(16.27);
  });

  it('nextInt is uniform for a non power of two (chi-square)', () => {
    const rng = createRng(2026);
    const counts = Array(6).fill(0);
    const n = 120_000;
    for (let i = 0; i < n; i++) counts[rng.nextInt(6)] += 1;
    const expected = n / 6;
    const chi = counts.reduce((sum: number, c: number) => sum + (c - expected) ** 2 / expected, 0);
    // 5 degrees of freedom at p = 0.001 is 20.52.
    expect(chi).toBeLessThan(20.52);
  });
});

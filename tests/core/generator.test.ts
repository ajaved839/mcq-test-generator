import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  expandBlueprint,
  apportion,
  validateBlueprint,
  type Bucket,
} from '../../src/core/blueprint';
import { generateTest } from '../../src/core/generator';
import { computeOverlap } from '../../src/core/overlap';
import type { GeneratorQuestion, RepeatRule, TestRef } from '../../src/core/types';
import { SUBJECTS, syntheticGeneratorBank } from '../helpers/synthetic';

const each: RepeatRule = { mode: 'each', limitPct: 20, denominator: 'new' };
const combined: RepeatRule = { mode: 'combined', limitPct: 20, denominator: 'new' };

const bucket = (subject: string, count: number, extra: Partial<Bucket> = {}): Bucket => ({
  key: `${subject}:${extra.difficulty ?? 'any'}`,
  label: subject,
  subject,
  topics: [],
  difficulty: null,
  count,
  sectionIndex: 0,
  ...extra,
});

function runSeries(
  bank: GeneratorQuestion[],
  buckets: Bucket[],
  rule: RepeatRule,
  maxTests: number,
  strategy: 'fresh-first' | 'stretch' = 'fresh-first',
): TestRef[] {
  const history: TestRef[] = [];
  for (let i = 0; i < maxTests; i++) {
    const result = generateTest({ bank, buckets, compared: history, rule, seed: i, strategy });
    if (!result.ok) break;
    history.push({
      id: `t${i}`,
      title: `Test ${i}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}`,
      kind: 'generated',
      questionIds: result.questionIds,
    });
  }
  return history;
}

describe('blueprint', () => {
  it('apportions exactly with largest remainder', () => {
    expect(apportion(10, [30, 50, 20])).toEqual([3, 5, 2]);
    expect(apportion(7, [1, 1, 1])).toEqual([3, 2, 2]);
    expect(apportion(5, [0, 0])).toEqual([0, 0]);
  });

  it('expands a difficulty mix while keeping section totals exact', () => {
    const buckets = expandBlueprint({
      sections: [
        { subject: 'Biology', count: 33, topics: [] },
        { subject: 'Physics', count: 17, topics: ['Optics'] },
      ],
      difficultyMix: { easy: 30, medium: 50, hard: 20 },
    });
    const bio = buckets.filter((b) => b.subject === 'Biology');
    expect(bio.reduce((s, b) => s + b.count, 0)).toBe(33);
    expect(buckets.filter((b) => b.subject === 'Physics').reduce((s, b) => s + b.count, 0)).toBe(
      17,
    );
    expect(buckets.find((b) => b.subject === 'Physics')!.label).toContain('Optics');
  });

  it('validates blueprints in plain words', () => {
    expect(validateBlueprint({ sections: [], difficultyMix: null })[0]).toMatch(
      /at least one subject/,
    );
    expect(
      validateBlueprint({
        sections: [{ subject: 'Biology', count: 10, topics: [] }],
        difficultyMix: { easy: 50, medium: 30, hard: 10 },
      })[0],
    ).toMatch(/100%/);
  });
});

describe('generator', () => {
  const bank = syntheticGeneratorBank(1000);

  it('matches per-subject counts exactly', () => {
    const buckets = [bucket('Biology', 40), bucket('Chemistry', 30), bucket('Physics', 30)];
    const result = generateTest({ bank, buckets, compared: [], rule: each, seed: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.questionIds).toHaveLength(100);
    expect(result.byBucket['Biology:any']).toHaveLength(40);
    const subjectOf = new Map(bank.map((q) => [q.id, q.subject]));
    expect(result.byBucket['Chemistry:any'].every((id) => subjectOf.get(id) === 'Chemistry')).toBe(
      true,
    );
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const buckets = [bucket('Biology', 20)];
    const a = generateTest({ bank, buckets, compared: [], rule: each, seed: 42 });
    const b = generateTest({ bank, buckets, compared: [], rule: each, seed: 42 });
    const c = generateTest({ bank, buckets, compared: [], rule: each, seed: 43 });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.questionIds).toEqual(b.questionIds);
      expect(a.questionIds).not.toEqual(c.questionIds);
    }
  });

  it('takes never-used questions first', () => {
    const small = syntheticGeneratorBank(60, 3, ['Biology']);
    const first = generateTest({
      bank: small,
      buckets: [bucket('Biology', 30)],
      compared: [],
      rule: each,
      seed: 1,
    });
    if (!first.ok) throw new Error('expected success');
    const history: TestRef[] = [
      {
        id: 't1',
        title: 'T1',
        createdAt: '2026-01-01',
        kind: 'generated',
        questionIds: first.questionIds,
      },
    ];
    const second = generateTest({
      bank: small,
      buckets: [bucket('Biology', 30)],
      compared: history,
      rule: each,
      seed: 2,
    });
    if (!second.ok) throw new Error('expected success');
    expect(second.reusedCount).toBe(0);
  });

  it('explains shortages instead of breaking the rule', () => {
    const small = syntheticGeneratorBank(52, 3, ['Biology']);
    const history: TestRef[] = [
      {
        id: 't1',
        title: 'T1',
        createdAt: '2026-01-01',
        kind: 'generated',
        questionIds: small.slice(0, 40).map((q) => q.id),
      },
    ];
    const result = generateTest({
      bank: small,
      buckets: [bucket('Biology', 30)],
      compared: history,
      rule: each,
      seed: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 12 fresh + at most 6 reused (20% of 30) = 18 placed.
    expect(result.shortages[0].placed).toBe(18);
    expect(result.messages[0]).toBe(
      'Biology needs 30 questions but only 18 fit the 20% rule. Add Biology questions or raise the limit.',
    );
  });

  it('reports when the bank simply lacks matching questions', () => {
    const result = generateTest({
      bank,
      buckets: [bucket('Biology', 10, { topics: ['No such topic'] })],
      compared: [],
      rule: each,
      seed: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.shortages[0].reason).toBe('not-enough-questions');
  });

  it('never uses reserved or archived questions unless allowed', () => {
    const custom: GeneratorQuestion[] = bank.slice(0, 50).map((q, i) => ({
      ...q,
      subject: 'Biology',
      reserved: i < 10,
      status: i >= 40 ? 'archived' : 'active',
    }));
    const r = generateTest({
      bank: custom,
      buckets: [bucket('Biology', 30)],
      compared: [],
      rule: each,
      seed: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const banned = new Set(
        custom.filter((q) => q.reserved || q.status === 'archived').map((q) => q.id),
      );
      expect(r.questionIds.some((id) => banned.has(id))).toBe(false);
    }
    const finals = generateTest({
      bank: custom,
      buckets: [bucket('Biology', 40)],
      compared: [],
      rule: each,
      seed: 5,
      allowReserved: true,
    });
    expect(finals.ok).toBe(true);
  });

  it('stretch strategy spends the repeat allowance on least-used questions', () => {
    const small = syntheticGeneratorBank(200, 9, ['Biology']);
    const history = runSeries(small, [bucket('Biology', 50)], combined, 1);
    const r = generateTest({
      bank: small,
      buckets: [bucket('Biology', 50)],
      compared: history,
      rule: combined,
      seed: 99,
      strategy: 'stretch',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reusedCount).toBe(10);
  });

  it('supports the plan capacity estimates in shape (each mode lasts far longer)', () => {
    const single = syntheticGeneratorBank(1000, 11, ['Biology']);
    const eachRuns = runSeries(single, [bucket('Biology', 200)], each, 40);
    const combinedRuns = runSeries(single, [bucket('Biology', 200)], combined, 40);
    expect(eachRuns.length).toBeGreaterThan(combinedRuns.length);
    expect(combinedRuns.length).toBeGreaterThanOrEqual(5);
    expect(combinedRuns.length).toBeLessThanOrEqual(6);
  });
});

describe('generator properties', () => {
  const arbScenario = fc.record({
    bankSize: fc.integer({ min: 5, max: 300 }),
    bankSeed: fc.integer(),
    counts: fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 3 }),
    limitPct: fc.integer({ min: 0, max: 100 }),
    mode: fc.constantFrom<'each' | 'combined'>('each', 'combined'),
    denominator: fc.constantFrom<'new' | 'smaller'>('new', 'smaller'),
    strategy: fc.constantFrom<'fresh-first' | 'stretch'>('fresh-first', 'stretch'),
    history: fc.integer({ min: 0, max: 8 }),
    seed: fc.integer(),
  });

  it('no saved test exceeds the limit, counts are exact, no question repeats', () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const subjects = SUBJECTS.slice(0, s.counts.length);
        const bank = syntheticGeneratorBank(s.bankSize, s.bankSeed, subjects);
        const buckets = s.counts.map((count, i) => ({
          ...bucket(subjects[i], count),
          sectionIndex: i,
        }));
        const rule: RepeatRule = { mode: s.mode, limitPct: s.limitPct, denominator: s.denominator };
        const history: TestRef[] = [];
        for (let t = 0; t <= s.history; t++) {
          const result = generateTest({
            bank,
            buckets,
            compared: history,
            rule,
            seed: s.seed + t,
            strategy: s.strategy,
          });
          if (!result.ok) {
            // Impossible requests are reported, never met by breaking a rule.
            expect(result.shortages.length).toBeGreaterThan(0);
            for (const shortage of result.shortages)
              expect(shortage.placed).toBeLessThan(shortage.needed);
            return;
          }
          const total = s.counts.reduce((a, b) => a + b, 0);
          expect(result.questionIds).toHaveLength(total);
          expect(new Set(result.questionIds).size).toBe(total);
          buckets.forEach((b) => expect(result.byBucket[b.key]).toHaveLength(b.count));
          const independent = computeOverlap(result.questionIds, history, rule);
          expect(independent.passes).toBe(true);
          history.push({
            id: `t${t}`,
            title: `T${t}`,
            createdAt: `2026-02-${String(t + 1).padStart(2, '0')}`,
            kind: 'generated',
            questionIds: result.questionIds,
          });
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a request that fits a fresh bank always succeeds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.integer(), (count, seed) => {
        const bank = syntheticGeneratorBank(count * 5, seed, ['Biology']);
        const result = generateTest({
          bank,
          buckets: [bucket('Biology', count)],
          compared: [],
          rule: each,
          seed,
        });
        expect(result.ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

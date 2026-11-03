import { describe, expect, it } from 'vitest';
import { compareTwo, computeOverlap, maxShared, withinLimit } from '../../src/core/overlap';
import type { RepeatRule, TestRef } from '../../src/core/types';

const ids = (prefix: string, n: number, start = 0): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${start + i}`);

const test = (id: string, questionIds: string[], createdAt = '2026-01-01'): TestRef => ({
  id,
  title: id,
  createdAt,
  kind: 'generated',
  questionIds,
});

const each: RepeatRule = { mode: 'each', limitPct: 20, denominator: 'new' };

describe('repeat rule math', () => {
  it('uses integer caps', () => {
    expect(maxShared(20, 100)).toBe(20);
    expect(maxShared(20, 99)).toBe(19);
    expect(maxShared(20, 5)).toBe(1);
    expect(withinLimit(20, 20, 100)).toBe(true);
    expect(withinLimit(21, 20, 100)).toBe(false);
  });

  it('passes the plan example: 18 of 100 shared is 18%', () => {
    const newIds = ids('q', 100);
    const t3 = test('Test 3', [...ids('q', 18), ...ids('x', 82)]);
    const report = computeOverlap(newIds, [t3], each);
    expect(report.perTest[0].pct).toBe(18);
    expect(report.passes).toBe(true);
  });

  it('blocks the plan example: 21 of 100 shared', () => {
    const report = computeOverlap(ids('q', 100), [test('Test 3', ids('q', 21))], each);
    expect(report.passes).toBe(false);
    expect(report.violations[0]).toContain('Test 3');
  });

  it('20 of 100 is exactly at the limit and passes', () => {
    expect(computeOverlap(ids('q', 100), [test('t', ids('q', 20))], each).passes).toBe(true);
  });

  it('each mode checks every test separately', () => {
    const newIds = ids('q', 100);
    const a = test('a', ids('q', 15, 0));
    const b = test('b', ids('q', 15, 15));
    const report = computeOverlap(newIds, [a, b], each);
    expect(report.passes).toBe(true);
    expect(report.reusedIds).toHaveLength(30);
  });

  it('combined mode counts the union of reused questions', () => {
    const newIds = ids('q', 100);
    const a = test('a', ids('q', 15, 0));
    const b = test('b', ids('q', 15, 15));
    const report = computeOverlap(newIds, [a, b], { ...each, mode: 'combined' });
    expect(report.combinedPct).toBe(30);
    expect(report.passes).toBe(false);
  });

  it('the stricter "smaller test" denominator stops a final absorbing a quiz', () => {
    const final = ids('q', 200);
    const quiz = test('quiz', ids('q', 40));
    expect(computeOverlap(final, [quiz], each).passes).toBe(true); // 40/200 = 20%
    const strict = computeOverlap(final, [quiz], { ...each, denominator: 'smaller' });
    expect(strict.passes).toBe(false); // 40/40 = 100%
    expect(strict.perTest[0].cap).toBe(8);
  });

  it('rejects duplicate question ids and empty tests', () => {
    expect(() => computeOverlap(['a', 'a'], [], each)).toThrow();
    expect(computeOverlap([], [], each).passes).toBe(false);
  });

  it('rejects invalid limits', () => {
    expect(() => computeOverlap(['a'], [], { ...each, limitPct: 120 })).toThrow();
    expect(() => computeOverlap(['a'], [], { ...each, limitPct: 12.5 })).toThrow();
  });

  it('reports the highest overlap first', () => {
    const newIds = ids('q', 100);
    const report = computeOverlap(
      newIds,
      [test('low', ids('q', 3)), test('high', ids('q', 14)), test('mid', ids('q', 9))],
      each,
    );
    expect(report.perTest.map((t) => t.testId)).toEqual(['high', 'mid', 'low']);
    expect(report.highestPct).toBe(14);
    expect(report.freshCount).toBe(86);
  });

  it('compares two tests both ways', () => {
    const r = compareTwo(test('a', ids('q', 10)), test('b', ids('q', 40)));
    expect(r.shared).toHaveLength(10);
    expect(r.pctOfA).toBe(100);
    expect(r.pctOfB).toBe(25);
  });
});

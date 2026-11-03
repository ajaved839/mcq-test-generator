import type { RepeatRule, TestRef } from './types';

/**
 * The repeat rule.
 *
 *   overlap = questions shared with the earlier test / questions in the new test x 100%
 *
 * 'each' mode: the overlap with every compared test must be at most the limit.
 * 'combined' mode: questions of the new test that appeared in ANY compared test, as a share of
 * the new test, must be at most the limit.
 *
 * All comparisons use integer arithmetic (shared * 100 <= limit * denominator) so 20% of 100 is
 * exactly 20 and never 20.000000004.
 */

export interface TestOverlap {
  testId: string;
  title: string;
  createdAt: string;
  kind: TestRef['kind'];
  shared: number;
  sharedIds: string[];
  denominator: number;
  /** Rounded to one decimal for display. */
  pct: number;
  /** Most questions this test may share under the rule. */
  cap: number;
  passes: boolean;
}

export interface OverlapReport {
  rule: RepeatRule;
  newCount: number;
  perTest: TestOverlap[];
  /** Questions of the new test found in at least one compared test. */
  reusedIds: string[];
  combinedPct: number;
  combinedCap: number;
  /** Highest per-test percentage (the headline number on the preview screen). */
  highestPct: number;
  highestTestId: string | null;
  freshCount: number;
  passes: boolean;
  /** Plain-language reasons the test cannot be saved; empty when it passes. */
  violations: string[];
}

export function maxShared(limitPct: number, denominator: number): number {
  // floor(limit * denom / 100) with integers only.
  return Math.floor((limitPct * denominator) / 100);
}

export function withinLimit(shared: number, limitPct: number, denominator: number): boolean {
  return shared * 100 <= limitPct * denominator;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function validateRule(rule: RepeatRule): void {
  if (!Number.isInteger(rule.limitPct) || rule.limitPct < 0 || rule.limitPct > 100) {
    throw new RangeError('The repeat limit must be a whole percent from 0 to 100.');
  }
}

export function denominatorFor(rule: RepeatRule, newCount: number, earlierCount: number): number {
  if (rule.mode === 'each' && rule.denominator === 'smaller') {
    return Math.max(1, Math.min(newCount, earlierCount));
  }
  return newCount;
}

export function computeOverlap(
  newQuestionIds: readonly string[],
  compared: readonly TestRef[],
  rule: RepeatRule,
): OverlapReport {
  validateRule(rule);
  const newSet = new Set(newQuestionIds);
  if (newSet.size !== newQuestionIds.length) {
    throw new Error('A test cannot contain the same question twice.');
  }
  const newCount = newSet.size;
  const reused = new Set<string>();
  const perTest: TestOverlap[] = compared.map((test) => {
    const earlier = new Set(test.questionIds);
    const sharedIds = [...newSet].filter((id) => earlier.has(id));
    sharedIds.forEach((id) => reused.add(id));
    const denominator = denominatorFor(rule, newCount, earlier.size);
    const cap = maxShared(rule.limitPct, denominator);
    return {
      testId: test.id,
      title: test.title,
      createdAt: test.createdAt,
      kind: test.kind,
      shared: sharedIds.length,
      sharedIds,
      denominator,
      pct: denominator ? round1((sharedIds.length * 100) / denominator) : 0,
      cap,
      passes: rule.mode === 'combined' || withinLimit(sharedIds.length, rule.limitPct, denominator),
    };
  });

  const combinedCap = maxShared(rule.limitPct, newCount);
  const combinedPasses = withinLimit(reused.size, rule.limitPct, newCount);
  const violations: string[] = [];

  if (rule.mode === 'each') {
    for (const t of perTest) {
      if (!t.passes) {
        violations.push(
          `Shares ${t.shared} questions (${t.pct}%) with "${t.title}"; the limit is ${rule.limitPct}% (${t.cap} questions).`,
        );
      }
    }
  } else if (!combinedPasses) {
    violations.push(
      `${reused.size} questions (${round1((reused.size * 100) / Math.max(1, newCount))}%) appeared in earlier tests; the limit is ${rule.limitPct}% (${combinedCap} questions).`,
    );
  }

  let highest: TestOverlap | null = null;
  for (const t of perTest) if (!highest || t.pct > highest.pct) highest = t;

  return {
    rule,
    newCount,
    perTest: perTest.sort((a, b) => b.pct - a.pct || b.createdAt.localeCompare(a.createdAt)),
    reusedIds: [...reused],
    combinedPct: newCount ? round1((reused.size * 100) / newCount) : 0,
    combinedCap,
    highestPct: highest?.pct ?? 0,
    highestTestId: highest?.testId ?? null,
    freshCount: newCount - reused.size,
    passes: violations.length === 0 && newCount > 0,
    violations: newCount === 0 ? ['The test has no questions.'] : violations,
  };
}

/** Overlap between any two tests, for the overlap checker (FR-13). */
export function compareTwo(
  a: TestRef,
  b: TestRef,
): { shared: string[]; pctOfA: number; pctOfB: number } {
  const bSet = new Set(b.questionIds);
  const shared = [...new Set(a.questionIds)].filter((id) => bSet.has(id));
  return {
    shared,
    pctOfA: a.questionIds.length ? round1((shared.length * 100) / new Set(a.questionIds).size) : 0,
    pctOfB: b.questionIds.length ? round1((shared.length * 100) / bSet.size) : 0,
  };
}

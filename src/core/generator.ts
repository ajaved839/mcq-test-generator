import type { Bucket } from './blueprint';
import { apportion } from './blueprint';
import {
  computeOverlap,
  denominatorFor,
  maxShared,
  validateRule,
  type OverlapReport,
} from './overlap';
import { createRng, shuffled } from './rng';
import type { GeneratorQuestion, RepeatRule, TestRef } from './types';

/**
 * Test generator.
 *
 * Picks never-used questions first, then the least-used ones in random order, and adds a reused
 * question only while every repeat-rule limit still holds. The result is re-verified with the
 * same overlap code the preview uses before it is returned, so a test that breaks the rule can
 * never come out of this function: impossible requests are reported as shortages instead.
 */

export type PickStrategy = 'fresh-first' | 'stretch';

export interface GenerateInput {
  bank: readonly GeneratorQuestion[];
  buckets: readonly Bucket[];
  compared: readonly TestRef[];
  rule: RepeatRule;
  seed: number | string;
  /**
   * 'fresh-first' (default) saves reused questions for when fresh ones run out.
   * 'stretch' deliberately spends the allowed repeat share on least-used questions, which keeps
   * fresh questions for later tests and stretches how many tests a bank supports.
   */
  strategy?: PickStrategy;
  /** Finals may draw on questions reserved for finals. */
  allowReserved?: boolean;
  excludeIds?: readonly string[];
}

export interface Shortage {
  bucketKey: string;
  label: string;
  subject: string;
  needed: number;
  /** Eligible questions matching the bucket's filters. */
  matching: number;
  /** How many the generator could place without breaking the rule. */
  placed: number;
  reason: 'not-enough-questions' | 'repeat-limit';
  message: string;
}

export interface GenerateSuccess {
  ok: true;
  questionIds: string[];
  byBucket: Record<string, string[]>;
  report: OverlapReport;
  freshCount: number;
  reusedCount: number;
}

export interface GenerateFailure {
  ok: false;
  shortages: Shortage[];
  messages: string[];
}

export type GenerateResult = GenerateSuccess | GenerateFailure;

const norm = (value: string): string => value.trim().toLowerCase();

export function matchesBucket(question: GeneratorQuestion, bucket: Bucket): boolean {
  if (norm(question.subject) !== norm(bucket.subject)) return false;
  if (bucket.difficulty && question.difficulty !== bucket.difficulty) return false;
  if (bucket.topics.length) {
    const topic = norm(question.topic);
    if (!bucket.topics.some((t) => norm(t) === topic)) return false;
  }
  return true;
}

export function generateTest(input: GenerateInput): GenerateResult {
  const { bank, buckets, compared, rule } = input;
  validateRule(rule);
  const strategy = input.strategy ?? 'fresh-first';
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total <= 0) {
    return { ok: false, shortages: [], messages: ['The test needs at least one question.'] };
  }

  const rng = createRng(input.seed);
  const excluded = new Set(input.excludeIds ?? []);
  const eligible = bank.filter(
    (q) => q.status === 'active' && (input.allowReserved || !q.reserved) && !excluded.has(q.id),
  );

  // usage[questionId] = indexes of compared tests that contain it.
  const usage = new Map<string, number[]>();
  compared.forEach((test, index) => {
    for (const id of new Set(test.questionIds)) {
      const list = usage.get(id);
      if (list) list.push(index);
      else usage.set(id, [index]);
    }
  });

  // Per-test caps are fixed up front because the new test's size is fixed.
  const caps = compared.map((test) =>
    maxShared(rule.limitPct, denominatorFor(rule, total, new Set(test.questionIds).size)),
  );
  const combinedCap = maxShared(rule.limitPct, total);
  const sharedCount = compared.map(() => 0);
  let reusedTotal = 0;

  const chosen = new Set<string>();
  const byBucket: Record<string, string[]> = {};
  for (const b of buckets) byBucket[b.key] = [];

  const canAdd = (id: string): boolean => {
    const used = usage.get(id);
    if (!used) return true;
    if (rule.mode === 'combined') return reusedTotal + 1 <= combinedCap;
    return used.every((testIndex) => sharedCount[testIndex] + 1 <= caps[testIndex]);
  };

  const add = (bucket: Bucket, id: string): void => {
    chosen.add(id);
    byBucket[bucket.key].push(id);
    const used = usage.get(id);
    if (used) {
      reusedTotal += 1;
      for (const testIndex of used) sharedCount[testIndex] += 1;
    }
  };

  // Candidate pools per bucket: fresh in random order, reused by ascending use then random.
  const pools = new Map<string, { fresh: string[]; reused: string[]; matching: number }>();
  for (const bucket of buckets) {
    const candidates = shuffled(
      eligible.filter((q) => matchesBucket(q, bucket)).map((q) => q.id),
      rng,
    );
    const fresh = candidates.filter((id) => !usage.has(id));
    const reused = candidates
      .filter((id) => usage.has(id))
      .map((id, order) => ({ id, order, uses: usage.get(id)!.length }))
      .sort((a, b) => a.uses - b.uses || a.order - b.order)
      .map((entry) => entry.id);
    pools.set(bucket.key, { fresh, reused, matching: candidates.length });
  }

  const deficit = (bucket: Bucket): number => bucket.count - byBucket[bucket.key].length;

  const fillFresh = (bucket: Bucket): void => {
    const pool = pools.get(bucket.key)!;
    for (const id of pool.fresh) {
      if (deficit(bucket) <= 0) break;
      if (!chosen.has(id)) add(bucket, id);
    }
  };

  const fillReused = (bucket: Bucket, limit: number): void => {
    const pool = pools.get(bucket.key)!;
    let taken = 0;
    for (const id of pool.reused) {
      if (deficit(bucket) <= 0 || taken >= limit) break;
      if (!chosen.has(id) && canAdd(id)) {
        add(bucket, id);
        taken += 1;
      }
    }
  };

  // Scarce buckets pick first so a broad bucket cannot take what a narrow one needs.
  const ordered = [...buckets].sort((a, b) => {
    const slackA = pools.get(a.key)!.fresh.length - a.count;
    const slackB = pools.get(b.key)!.fresh.length - b.count;
    return slackA - slackB || a.sectionIndex - b.sectionIndex;
  });

  if (strategy === 'stretch') {
    const share = apportion(
      combinedCap,
      ordered.map((b) => b.count),
    );
    ordered.forEach((bucket, i) => fillReused(bucket, share[i]));
  }
  for (const bucket of ordered) fillFresh(bucket);
  for (const bucket of ordered) fillReused(bucket, Number.POSITIVE_INFINITY);

  const shortBuckets = buckets.filter((b) => deficit(b) > 0);
  if (shortBuckets.length) {
    const shortages = shortBuckets.map((bucket): Shortage => {
      const pool = pools.get(bucket.key)!;
      const placed = byBucket[bucket.key].length;
      const reason = pool.matching < bucket.count ? 'not-enough-questions' : 'repeat-limit';
      const message =
        reason === 'not-enough-questions'
          ? `${bucket.label} needs ${bucket.count} questions but the bank has only ${pool.matching} that match. Add ${bucket.subject} questions or change the filters.`
          : `${bucket.label} needs ${bucket.count} questions but only ${placed} fit the ${rule.limitPct}% rule. Add ${bucket.subject} questions or raise the limit.`;
      return {
        bucketKey: bucket.key,
        label: bucket.label,
        subject: bucket.subject,
        needed: bucket.count,
        matching: pool.matching,
        placed,
        reason,
        message,
      };
    });
    return { ok: false, shortages, messages: shortages.map((s) => s.message) };
  }

  const questionIds = buckets.flatMap((b) => byBucket[b.key]);
  const report = computeOverlap(questionIds, compared, rule);

  // Re-verify independently of the picking bookkeeping. These are invariants, not user errors.
  if (!report.passes) {
    throw new Error(`Generator invariant broken: ${report.violations.join(' ')}`);
  }
  if (questionIds.length !== total || new Set(questionIds).size !== total) {
    throw new Error('Generator invariant broken: counts or uniqueness.');
  }

  return {
    ok: true,
    questionIds,
    byBucket,
    report,
    freshCount: report.freshCount,
    reusedCount: report.reusedIds.length,
  };
}

import type { GeneratorQuestion, TestRef } from './types';

/**
 * Bank health for the Home screen: how many questions each subject has, how many were never
 * used, and a plain-language estimate of how many more papers the bank supports.
 *
 * Rule of thumb from the plan: keep each subject's pool at least 7 times the questions it
 * contributes to a paper.
 */

export const POOL_MULTIPLIER = 7;

export interface SubjectCapacity {
  subject: string;
  active: number;
  fresh: number;
  used: number;
  reserved: number;
  byDifficulty: Record<'easy' | 'medium' | 'hard', number>;
  /** Questions this subject contributed to the most recent generated test, or null. */
  recentShare: number | null;
  /** Pool needed for the 7x rule at the recent share. */
  recommendedPool: number | null;
  /** Further papers possible with all-new questions at the recent share. */
  freshPapersLeft: number | null;
  status: 'healthy' | 'low' | 'unknown';
}

export function subjectCapacity(
  bank: readonly GeneratorQuestion[],
  tests: readonly TestRef[],
): SubjectCapacity[] {
  const used = new Set(tests.flatMap((t) => t.questionIds));
  const latest = [...tests]
    .filter((t) => t.kind === 'generated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const latestIds = new Set(latest?.questionIds ?? []);
  const bySubject = new Map<string, SubjectCapacity>();

  for (const q of bank) {
    if (q.status !== 'active') continue;
    let entry = bySubject.get(q.subject);
    if (!entry) {
      entry = {
        subject: q.subject,
        active: 0,
        fresh: 0,
        used: 0,
        reserved: 0,
        byDifficulty: { easy: 0, medium: 0, hard: 0 },
        recentShare: latest ? 0 : null,
        recommendedPool: null,
        freshPapersLeft: null,
        status: 'unknown',
      };
      bySubject.set(q.subject, entry);
    }
    entry.active += 1;
    entry.byDifficulty[q.difficulty] += 1;
    if (q.reserved) entry.reserved += 1;
    if (used.has(q.id)) entry.used += 1;
    else entry.fresh += 1;
    if (latestIds.has(q.id) && entry.recentShare !== null) entry.recentShare += 1;
  }

  for (const entry of bySubject.values()) {
    if (entry.recentShare) {
      entry.recommendedPool = entry.recentShare * POOL_MULTIPLIER;
      entry.freshPapersLeft = Math.floor(entry.fresh / entry.recentShare);
      entry.status = entry.active >= entry.recommendedPool ? 'healthy' : 'low';
    }
  }
  return [...bySubject.values()].sort((a, b) => a.subject.localeCompare(b.subject));
}

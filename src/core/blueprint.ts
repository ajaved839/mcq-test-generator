import { DIFFICULTIES, type Difficulty } from './types';

/** One subject section of a test, as the admin enters it in the blueprint step. */
export interface BlueprintSection {
  subject: string;
  count: number;
  /** Empty means any topic. */
  topics: string[];
  /** Optional per-section override of the test-wide difficulty mix. */
  difficultyMix?: DifficultyMix | null;
}

/** Percentages that sum to 100, or null for "any difficulty". */
export type DifficultyMix = Record<Difficulty, number>;

export interface Blueprint {
  sections: BlueprintSection[];
  difficultyMix: DifficultyMix | null;
}

/** A unit the generator fills exactly: subject + optional topics + optional difficulty. */
export interface Bucket {
  key: string;
  label: string;
  subject: string;
  topics: string[];
  difficulty: Difficulty | null;
  count: number;
  sectionIndex: number;
}

export function blueprintTotal(blueprint: Blueprint): number {
  return blueprint.sections.reduce((sum, s) => sum + s.count, 0);
}

/**
 * Largest-remainder apportionment: splits `total` by `weights` into integers that sum to
 * exactly `total`. Ties go to the earlier weight so results are deterministic.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remaining = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    floors[index] += 1;
    remaining -= 1;
  }
  return floors;
}

export function validateBlueprint(blueprint: Blueprint): string[] {
  const errors: string[] = [];
  if (!blueprint.sections.length) errors.push('Add at least one subject to the blueprint.');
  blueprint.sections.forEach((s) => {
    if (!s.subject.trim()) errors.push('Every blueprint row needs a subject.');
    if (!Number.isInteger(s.count) || s.count < 1) {
      errors.push(`${s.subject || 'A subject'} needs a whole number of questions, at least 1.`);
    }
  });
  const mixes = [blueprint.difficultyMix, ...blueprint.sections.map((s) => s.difficultyMix)];
  for (const mix of mixes) {
    if (!mix) continue;
    const sum = DIFFICULTIES.reduce((acc, d) => acc + mix[d], 0);
    if (DIFFICULTIES.some((d) => mix[d] < 0) || sum !== 100) {
      errors.push('The difficulty mix must add up to 100%.');
      break;
    }
  }
  return errors;
}

function sectionLabel(section: BlueprintSection): string {
  return section.topics.length
    ? `${section.subject} (${section.topics.join(', ')})`
    : section.subject;
}

/** Expands a blueprint into exact buckets. Section counts are preserved exactly. */
export function expandBlueprint(blueprint: Blueprint): Bucket[] {
  const buckets: Bucket[] = [];
  blueprint.sections.forEach((section, sectionIndex) => {
    const mix = section.difficultyMix ?? blueprint.difficultyMix;
    const base = sectionLabel(section);
    if (!mix) {
      buckets.push({
        key: `${sectionIndex}`,
        label: base,
        subject: section.subject,
        topics: section.topics,
        difficulty: null,
        count: section.count,
        sectionIndex,
      });
      return;
    }
    const counts = apportion(
      section.count,
      DIFFICULTIES.map((d) => mix[d]),
    );
    DIFFICULTIES.forEach((difficulty, i) => {
      if (counts[i] === 0) return;
      buckets.push({
        key: `${sectionIndex}:${difficulty}`,
        label: `${base}, ${difficulty}`,
        subject: section.subject,
        topics: section.topics,
        difficulty,
        count: counts[i],
        sectionIndex,
      });
    });
  });
  return buckets;
}

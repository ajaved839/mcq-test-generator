import { createRng } from '../../src/core/rng';
import { plain } from '../../src/core/richtext';
import type { BankQuestion, Difficulty, GeneratorQuestion } from '../../src/core/types';

/**
 * Synthetic data only. Tests never use real exam content.
 */

export const SUBJECTS = ['Biology', 'Chemistry', 'Physics', 'English', 'Logical Reasoning'];
const DIFFS: Difficulty[] = ['easy', 'medium', 'hard'];

export function syntheticGeneratorBank(
  size: number,
  seed = 1,
  subjects: string[] = SUBJECTS,
): GeneratorQuestion[] {
  const rng = createRng(seed);
  return Array.from({ length: size }, (_, i) => ({
    id: `q${i}`,
    subject: subjects[i % subjects.length],
    topic: `Topic ${rng.nextInt(5) + 1}`,
    difficulty: DIFFS[rng.nextInt(3)],
    reserved: false,
    status: 'active' as const,
  }));
}

export function syntheticBankQuestion(
  i: number,
  overrides: Partial<BankQuestion> = {},
): BankQuestion {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: `q${i}`,
    stem: plain(`Synthetic question number ${i} about concept ${i * 7}?`),
    options: [plain(`Alpha ${i}`), plain(`Beta ${i}`), plain(`Gamma ${i}`), plain(`Delta ${i}`)],
    correct: i % 4,
    explanation: [],
    lockOptions: false,
    subject: SUBJECTS[i % SUBJECTS.length],
    topic: `Topic ${(i % 5) + 1}`,
    difficulty: DIFFS[i % 3],
    tags: [],
    source: 'Synthetic',
    reserved: false,
    status: 'active',
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

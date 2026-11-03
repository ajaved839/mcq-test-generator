import { plain } from '../../src/core/richtext';
import { createQuestion } from '../../src/main/db/questions';
import type { Workspace } from '../../src/main/db/workspace';
import type { GenerateRequest, QuestionInput } from '../../src/shared/schemas';

/** Synthetic workspace fixtures shared by integration tests. */

const ctx = { actor: 'Test Staff', osUser: 'tester' };
const subjects = ['Biology', 'Chemistry', 'Physics', 'English', 'Logical Reasoning'];

export function questionInput(i: number, overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    stem: plain(`Synthetic question ${i}: which value matches concept ${i * 13}?`),
    options: [plain(`Alpha ${i}`), plain(`Beta ${i}`), plain(`Gamma ${i}`), plain(`Delta ${i}`)],
    correct: i % 4,
    explanation: [],
    lockOptions: false,
    subject: subjects[i % 3],
    topic: `Topic ${i % 4}`,
    difficulty: (['easy', 'medium', 'hard'] as const)[i % 3],
    tags: [],
    source: 'Synthetic',
    reserved: false,
    ...overrides,
  };
}

export function seedBank(ws: Workspace, n: number): string[] {
  return ws.transaction(() =>
    Array.from({ length: n }, (_, i) => createQuestion(ws, ctx, questionInput(i)).id),
  );
}

export const request = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
  title: 'Mock Test',
  code: 'MT-1',
  blueprint: {
    sections: [
      { subject: 'Biology', count: 10, topics: [] },
      { subject: 'Physics', count: 10, topics: [] },
    ],
    difficultyMix: null,
  },
  rule: { mode: 'each', limitPct: 20, denominator: 'new' },
  strategy: 'fresh-first',
  versions: 2,
  allowReserved: false,
  groupBySubject: true,
  scope: { excludedTestIds: [], from: null, to: null },
  instructions: 'Answer all questions.',
  durationMinutes: 30,
  seed: 1234,
  ...overrides,
});

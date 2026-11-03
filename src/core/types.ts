import type { RichText } from './richtext';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type OptionLetter = (typeof OPTION_LETTERS)[number];
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;

export interface QuestionContent {
  stem: RichText;
  /** 2 to 5 options in their original (bank) order. */
  options: RichText[];
  /** Index into `options` of the single best answer. */
  correct: number;
  explanation: RichText;
  /** Staff override: never shuffle this question's options. */
  lockOptions: boolean;
}

export interface QuestionMeta {
  subject: string;
  topic: string;
  difficulty: Difficulty;
  tags: string[];
  source: string;
  /** Reserved for finals: regular tests never use it. */
  reserved: boolean;
}

export type QuestionStatus = 'active' | 'archived';

export interface BankQuestion extends QuestionContent, QuestionMeta {
  id: string;
  status: QuestionStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The fields the generator needs; kept small so a 10,000-question bank stays fast. */
export interface GeneratorQuestion {
  id: string;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  reserved: boolean;
  status: QuestionStatus;
}

/** An earlier test as seen by the repeat rule: just its identity and question IDs. */
export interface TestRef {
  id: string;
  title: string;
  createdAt: string;
  kind: 'generated' | 'outside';
  questionIds: string[];
}

export type RuleMode = 'each' | 'combined';

export interface RepeatRule {
  mode: RuleMode;
  /** Whole percent, 0 to 100. */
  limitPct: number;
  /**
   * 'new' divides by the new test's size (the default). 'smaller' divides by the smaller of the
   * two tests, so a long final cannot absorb a whole short quiz. Only used in 'each' mode.
   */
  denominator: 'new' | 'smaller';
}

export const DEFAULT_RULE: RepeatRule = { mode: 'each', limitPct: 20, denominator: 'new' };

export function letterFor(index: number): OptionLetter {
  const letter = OPTION_LETTERS[index];
  if (!letter) throw new RangeError(`No option letter for index ${index}`);
  return letter;
}

export function indexForLetter(letter: string): number {
  return OPTION_LETTERS.indexOf(letter.toUpperCase() as OptionLetter);
}

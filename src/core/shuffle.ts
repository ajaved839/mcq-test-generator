import type { RichText } from './richtext';
import { toPlainText } from './richtext';
import { deriveRng, shuffled, type Rng } from './rng';
import { letterFor, type OptionLetter } from './types';

/**
 * Safe shuffling of questions and options into paper versions (FR-10, FR-11).
 *
 * - "All of the above" / "None of the above" style options stay last.
 * - Questions whose options refer to other options by letter ("Both a and b") keep their order,
 *   because moving options would change what the letters point at.
 * - Each version is derived from the test seed, so reprints are identical.
 */

export const VERSION_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type VersionLetter = (typeof VERSION_LETTERS)[number];

const PINNED_LAST =
  /^\s*(?:all|none|both|neither|any)\s+(?:of\s+)?(?:the\s+)?(?:above|these|them|those|the\s+options)\b/i;

const LETTER = String.raw`\(?[a-e]\)?`;
const LETTER_REFERENCE = [
  // "Both a and b", "Either (a) or (c)", "Neither A nor B"
  new RegExp(
    String.raw`\b(?:both|either|neither)\s+${LETTER}\s*(?:and|or|nor|&|,)\s*${LETTER}`,
    'i',
  ),
  // "a and b", "A, B and C", "(a) & (c) only"
  new RegExp(
    String.raw`^\s*${LETTER}\s*(?:,|and|&|or)\s*${LETTER}(?:\s*(?:,|and|&|or)\s*${LETTER})*\s*(?:only|both|are\s+correct|are\s+true)?\s*\.?\s*$`,
    'i',
  ),
  // "Option a", "options b and c", "choice (d)"
  new RegExp(String.raw`\b(?:options?|choices?|answers?)\s+${LETTER}(?![a-z])`, 'i'),
  // "(a) only", "Only b"
  new RegExp(String.raw`^\s*(?:only\s+${LETTER}|${LETTER}\s+only)\s*\.?\s*$`, 'i'),
  // "All except c", "All but (b)"
  new RegExp(String.raw`\ball\s+(?:except|but)\s+${LETTER}(?![a-z])`, 'i'),
];

export function isPinnedLast(option: RichText): boolean {
  return PINNED_LAST.test(toPlainText(option));
}

export function referencesLetters(option: RichText): boolean {
  const value = toPlainText(option);
  return LETTER_REFERENCE.some((re) => re.test(value));
}

export interface ShuffleQuestion {
  id: string;
  subject: string;
  options: RichText[];
  correct: number;
  lockOptions: boolean;
}

export type OptionLockReason = 'manual' | 'letter-reference' | 'pinned-not-last' | null;

/** Why a question's options must keep their bank order, if they must. */
export function optionLockReason(
  q: Pick<ShuffleQuestion, 'options' | 'lockOptions'>,
): OptionLockReason {
  if (q.lockOptions) return 'manual';
  if (q.options.some(referencesLetters)) return 'letter-reference';
  // A pinned option that is not already in the trailing block would change meaning if moved.
  const pinned = q.options.map(isPinnedLast);
  const firstPinned = pinned.indexOf(true);
  if (firstPinned !== -1 && pinned.slice(firstPinned).some((p) => !p)) return 'pinned-not-last';
  return null;
}

/** Returns display order: displayOrder[pos] = index of the bank option shown at `pos`. */
export function shuffleOptionOrder(q: ShuffleQuestion, rng: Rng): number[] {
  const identity = q.options.map((_, i) => i);
  if (optionLockReason(q)) return identity;
  const pinned = identity.filter((i) => isPinnedLast(q.options[i]));
  const movable = identity.filter((i) => !isPinnedLast(q.options[i]));
  return [...shuffled(movable, rng), ...pinned];
}

export interface VersionQuestion {
  questionId: string;
  /** displayOrder[pos] = original option index shown at position `pos`. */
  optionOrder: number[];
  /** Position (0-based) of the correct answer in this version. */
  correctPos: number;
  correctLetter: OptionLetter;
}

export interface PaperVersion {
  letter: VersionLetter;
  questions: VersionQuestion[];
}

export interface VersionOptions {
  versions: number;
  seed: number | string;
  /** Keep subject sections together and shuffle within each (default true). */
  groupBySubject?: boolean;
  /** Version A keeps the generated order when false (default true: every version shuffled). */
  shuffleFirstVersion?: boolean;
}

function shuffleQuestionOrder(
  questions: readonly ShuffleQuestion[],
  rng: Rng,
  groupBySubject: boolean,
): ShuffleQuestion[] {
  if (!groupBySubject) return shuffled(questions, rng);
  const sections: ShuffleQuestion[][] = [];
  const index = new Map<string, number>();
  for (const q of questions) {
    let i = index.get(q.subject);
    if (i === undefined) {
      i = sections.length;
      index.set(q.subject, i);
      sections.push([]);
    }
    sections[i].push(q);
  }
  return sections.flatMap((section) => shuffled(section, rng));
}

const signature = (v: VersionQuestion[]): string =>
  v.map((q) => `${q.questionId}:${q.optionOrder.join('')}`).join('|');

const orderSignature = (v: VersionQuestion[]): string => v.map((q) => q.questionId).join('|');

/**
 * Builds 1 to 4 versions. Later versions retry (deterministically) until their question order
 * differs from every earlier version whenever the paper has enough questions to allow it.
 */
export function buildVersions(
  questions: readonly ShuffleQuestion[],
  options: VersionOptions,
): PaperVersion[] {
  const count = options.versions;
  if (!Number.isInteger(count) || count < 1 || count > VERSION_LETTERS.length) {
    throw new RangeError('Papers have 1 to 4 versions.');
  }
  const groupBySubject = options.groupBySubject ?? true;
  const shuffleFirst = options.shuffleFirstVersion ?? true;
  const versions: PaperVersion[] = [];
  const seenOrders = new Set<string>();
  const seenFull = new Set<string>();

  for (let v = 0; v < count; v++) {
    const letter = VERSION_LETTERS[v];
    let built: VersionQuestion[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const rng = deriveRng(options.seed, `version:${letter}:${attempt}`);
      const order =
        v === 0 && !shuffleFirst
          ? questions.slice()
          : shuffleQuestionOrder(questions, rng, groupBySubject);
      built = order.map((q) => {
        const optionOrder =
          v === 0 && !shuffleFirst ? q.options.map((_, i) => i) : shuffleOptionOrder(q, rng);
        const correctPos = optionOrder.indexOf(q.correct);
        if (correctPos < 0) throw new Error(`Question ${q.id} has no correct option.`);
        return { questionId: q.id, optionOrder, correctPos, correctLetter: letterFor(correctPos) };
      });
      const orderSig = orderSignature(built);
      if (!seenOrders.has(orderSig) && !seenFull.has(signature(built))) break;
    }
    seenOrders.add(orderSignature(built));
    seenFull.add(signature(built));
    versions.push({ letter, questions: built });
  }
  return versions;
}

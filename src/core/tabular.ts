import { plain, type RichText } from './richtext';
import { DIFFICULTIES, MAX_OPTIONS, OPTION_LETTERS, type Difficulty } from './types';

/**
 * Excel/CSV rows to MCQs (FR-1). Each row is validated on its own and every problem names
 * the row, the column and the fix. Nothing is saved here; callers stage rows for review.
 */

export const TEMPLATE_COLUMNS = [
  'Question',
  'Option A',
  'Option B',
  'Option C',
  'Option D',
  'Option E',
  'Correct',
  'Subject',
  'Topic',
  'Difficulty',
  'Explanation',
  'Source',
] as const;

export type Field =
  | 'question'
  | 'optionA'
  | 'optionB'
  | 'optionC'
  | 'optionD'
  | 'optionE'
  | 'correct'
  | 'subject'
  | 'topic'
  | 'difficulty'
  | 'explanation'
  | 'source'
  | 'tags';

export const FIELDS: Field[] = [
  'question',
  'optionA',
  'optionB',
  'optionC',
  'optionD',
  'optionE',
  'correct',
  'subject',
  'topic',
  'difficulty',
  'explanation',
  'source',
  'tags',
];

export const FIELD_LABELS: Record<Field, string> = {
  question: 'Question',
  optionA: 'Option A',
  optionB: 'Option B',
  optionC: 'Option C',
  optionD: 'Option D',
  optionE: 'Option E',
  correct: 'Correct',
  subject: 'Subject',
  topic: 'Topic',
  difficulty: 'Difficulty',
  explanation: 'Explanation',
  source: 'Source',
  tags: 'Tags',
};

const OPTION_FIELDS: Field[] = ['optionA', 'optionB', 'optionC', 'optionD', 'optionE'];
const REQUIRED: Field[] = ['question', 'optionA', 'optionB', 'correct', 'subject'];

/** Column index for each field, or -1 when the sheet has no such column. */
export type ColumnMapping = Record<Field, number>;

const ALIASES: Record<Field, string[]> = {
  question: ['question', 'questions', 'question text', 'stem', 'mcq', 'statement', 'q'],
  optionA: ['option a', 'a', 'option 1', 'choice a', 'opt a', 'optiona', '(a)'],
  optionB: ['option b', 'b', 'option 2', 'choice b', 'opt b', 'optionb', '(b)'],
  optionC: ['option c', 'c', 'option 3', 'choice c', 'opt c', 'optionc', '(c)'],
  optionD: ['option d', 'd', 'option 4', 'choice d', 'opt d', 'optiond', '(d)'],
  optionE: ['option e', 'e', 'option 5', 'choice e', 'opt e', 'optione', '(e)'],
  correct: ['correct', 'answer', 'ans', 'correct answer', 'correct option', 'key', 'right answer'],
  subject: ['subject', 'course', 'paper'],
  topic: ['topic', 'chapter', 'unit', 'section'],
  difficulty: ['difficulty', 'level', 'difficulty level'],
  explanation: ['explanation', 'solution', 'rationale', 'reason'],
  source: ['source', 'reference', 'book'],
  tags: ['tags', 'tag', 'keywords', 'labels'],
};

const headerKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');

/** Maps known header names to fields; unknown columns stay unmapped. */
export function detectMapping(headers: readonly string[]): ColumnMapping {
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, -1])) as ColumnMapping;
  const keys = headers.map(headerKey);
  for (const field of FIELDS) {
    const index = keys.findIndex(
      (k, i) => ALIASES[field].includes(k) && !Object.values(mapping).includes(i),
    );
    mapping[field] = index;
  }
  return mapping;
}

export function missingRequired(mapping: ColumnMapping): Field[] {
  return REQUIRED.filter((f) => mapping[f] < 0);
}

export interface RowIssue {
  field: Field;
  message: string;
}

export interface TabularCandidate {
  stem: RichText;
  options: RichText[];
  correct: number;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  explanation: RichText;
  source: string;
  tags: string[];
}

export type RowResult =
  | { row: number; ok: true; value: TabularCandidate; warnings: RowIssue[] }
  | { row: number; ok: false; errors: RowIssue[]; warnings: RowIssue[] };

export interface ValidateOptions {
  /** Subjects from Settings; rows naming another subject are rejected with a suggestion. */
  subjects: readonly string[];
  defaultSource?: string;
}

const cell = (row: readonly unknown[], index: number): string => {
  if (index < 0) return '';
  const value = row[index];
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
};

function closest(value: string, choices: readonly string[]): string | null {
  const v = value.toLowerCase();
  let best: { choice: string; distance: number } | null = null;
  for (const choice of choices) {
    const d = levenshtein(v, choice.toLowerCase());
    if (!best || d < best.distance) best = { choice, distance: d };
  }
  return best && best.distance <= Math.max(2, Math.floor(value.length / 3)) ? best.choice : null;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return dp[b.length];
}

export function parseDifficulty(value: string): Difficulty | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (['easy', 'e', '1', 'low', 'simple'].includes(v)) return 'easy';
  if (['medium', 'm', '2', 'moderate', 'average', 'med'].includes(v)) return 'medium';
  if (['hard', 'h', '3', 'high', 'difficult', 'tough'].includes(v)) return 'hard';
  return (DIFFICULTIES as readonly string[]).includes(v) ? (v as Difficulty) : null;
}

/** Accepts "B", "b", "(b)", "2", "Option B" or the exact text of the option. */
export function parseCorrect(value: string, options: readonly string[]): number | null {
  const v = value.trim();
  const letter = /^(?:option\s*)?[([]?\s*([a-e])\s*[)\]]?\.?$/i.exec(v);
  if (letter) return letter[1].toUpperCase().charCodeAt(0) - 65;
  if (/^[1-5]$/.test(v)) return Number(v) - 1;
  const byText = options.findIndex((o) => o.trim().toLowerCase() === v.toLowerCase());
  return byText >= 0 ? byText : null;
}

export function validateRow(
  row: readonly unknown[],
  rowNumber: number,
  mapping: ColumnMapping,
  options: ValidateOptions,
): RowResult {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const question = cell(row, mapping.question);
  if (!question)
    errors.push({ field: 'question', message: 'Question is empty. Type the question text.' });

  const rawOptions = OPTION_FIELDS.map((f) => cell(row, mapping[f]));
  let lastFilled = -1;
  rawOptions.forEach((value, i) => {
    if (value) lastFilled = i;
  });
  for (let i = 0; i < lastFilled; i++) {
    if (!rawOptions[i]) {
      errors.push({
        field: OPTION_FIELDS[i],
        message: `Option ${OPTION_LETTERS[i]} is empty but Option ${OPTION_LETTERS[lastFilled]} is filled. Move the options up so there are no gaps.`,
      });
    }
  }
  const optionTexts = rawOptions.slice(0, lastFilled + 1);
  if (optionTexts.filter(Boolean).length < 2) {
    errors.push({
      field: 'optionB',
      message: 'An MCQ needs at least 2 options. Fill Option A and Option B.',
    });
  }
  if (optionTexts.length > MAX_OPTIONS) {
    errors.push({ field: 'optionE', message: 'At most 5 options (A to E) are supported.' });
  }
  const lower = optionTexts.map((o) => o.toLowerCase());
  lower.forEach((o, i) => {
    if (o && lower.indexOf(o) !== i) {
      errors.push({
        field: OPTION_FIELDS[i],
        message: `Option ${OPTION_LETTERS[i]} repeats Option ${OPTION_LETTERS[lower.indexOf(o)]}. Make every option different.`,
      });
    }
  });

  const correctRaw = cell(row, mapping.correct);
  let correct: number | null = null;
  if (!correctRaw) {
    errors.push({
      field: 'correct',
      message: 'Correct is empty. Enter the letter of the right option (A to E).',
    });
  } else {
    correct = parseCorrect(correctRaw, optionTexts);
    if (correct === null) {
      errors.push({
        field: 'correct',
        message: `Correct is "${correctRaw}". Enter a letter A to E or the exact text of the right option.`,
      });
    } else if (!optionTexts[correct]) {
      errors.push({
        field: 'correct',
        message: `Correct is ${OPTION_LETTERS[correct]} but Option ${OPTION_LETTERS[correct]} is empty. Fix the letter or fill that option.`,
      });
    }
  }

  const subjectRaw = cell(row, mapping.subject);
  let subject = subjectRaw;
  if (!subjectRaw) {
    errors.push({
      field: 'subject',
      message: 'Subject is empty. Enter one of the subjects from Settings.',
    });
  } else if (options.subjects.length) {
    const match = options.subjects.find((s) => s.toLowerCase() === subjectRaw.toLowerCase());
    if (match) {
      subject = match;
    } else {
      const suggestion = closest(subjectRaw, options.subjects);
      errors.push({
        field: 'subject',
        message: suggestion
          ? `Subject "${subjectRaw}" is not in the subject list. Did you mean "${suggestion}"?`
          : `Subject "${subjectRaw}" is not in the subject list. Add it in Settings or correct the spelling.`,
      });
    }
  }

  const difficultyRaw = cell(row, mapping.difficulty);
  let difficulty = parseDifficulty(difficultyRaw);
  if (!difficultyRaw) {
    difficulty = 'medium';
    warnings.push({ field: 'difficulty', message: 'Difficulty is empty, so Medium was used.' });
  } else if (!difficulty) {
    errors.push({
      field: 'difficulty',
      message: `Difficulty is "${difficultyRaw}". Use Easy, Medium or Hard.`,
    });
  }

  if (errors.length) return { row: rowNumber, ok: false, errors, warnings };

  const tagsRaw = cell(row, mapping.tags);
  return {
    row: rowNumber,
    ok: true,
    warnings,
    value: {
      stem: plain(question),
      options: optionTexts.map(plain),
      correct: correct!,
      subject,
      topic: cell(row, mapping.topic),
      difficulty: difficulty!,
      explanation: plain(cell(row, mapping.explanation)),
      source: cell(row, mapping.source) || options.defaultSource || '',
      tags: tagsRaw
        ? tagsRaw
            .split(/[,;]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    },
  };
}

/** Skips fully blank rows; `firstDataRow` is the spreadsheet row number of rows[0]. */
export function validateRows(
  rows: readonly (readonly unknown[])[],
  mapping: ColumnMapping,
  options: ValidateOptions,
  firstDataRow = 2,
): RowResult[] {
  const results: RowResult[] = [];
  rows.forEach((row, i) => {
    if (row.every((value) => cell([value], 0) === '')) return;
    results.push(validateRow(row, firstDataRow + i, mapping, options));
  });
  return results;
}

/** CSV text for the downloadable template, with one synthetic example row. */
export function templateCsv(): string {
  const example = [
    'Which organelle is the main site of ATP synthesis?',
    'Ribosome',
    'Mitochondrion',
    'Golgi body',
    'Lysosome',
    '',
    'B',
    'Biology',
    'Cell biology',
    'Easy',
    'Oxidative phosphorylation occurs in the mitochondrion.',
    'Sample',
  ];
  const escape = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${TEMPLATE_COLUMNS.join(',')}\n${example.map(escape).join(',')}\n`;
}

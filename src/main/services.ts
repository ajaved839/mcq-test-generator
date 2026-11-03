import { DuplicateIndex } from '../core/duplicates';
import {
  parseMcqLines,
  type AnswerConvention,
  type ParsedMcq,
  type ParseResult,
  type SourceLine,
} from '../core/mcq-parser';
import { plain, toPlainText, type RichText } from '../core/richtext';
import { detectMapping, validateRows, type ColumnMapping, type RowResult } from '../core/tabular';
import type { BankQuestion, Difficulty } from '../core/types';
import { allComparable, getQuestion } from './db/questions';
import type { ReviewCandidate } from './db/imports';
import type { Workspace } from './db/workspace';

/** Glue between importers, the core engine and the review queue. */

export interface ImportDefaults {
  subject: string;
  topic: string;
  difficulty: Difficulty;
  source: string;
}

export function mcqToCandidate(mcq: ParsedMcq, defaults: ImportDefaults): ReviewCandidate {
  return {
    stem: mcq.stem,
    options: mcq.options.slice(0, 5),
    correct: mcq.correct,
    explanation: mcq.explanation,
    subject: defaults.subject,
    topic: defaults.topic,
    difficulty: defaults.difficulty,
    tags: [],
    source: defaults.source,
    lockOptions: false,
    reserved: false,
    warnings:
      mcq.options.length > 5
        ? [...mcq.warnings, 'More than 5 options were found; only A to E were kept.']
        : mcq.warnings,
    refs: mcq.refs,
    pages: mcq.pages,
    number: mcq.number,
  };
}

export function rowToCandidate(
  result: RowResult,
  row: readonly unknown[],
  mapping: ColumnMapping,
  defaults: ImportDefaults,
): ReviewCandidate {
  if (result.ok) {
    return {
      ...result.value,
      lockOptions: false,
      reserved: false,
      warnings: result.warnings.map((w) => w.message),
      refs: [`row ${result.row}`],
      pages: [],
      number: null,
    };
  }
  // Rows with problems still go to review, filled as far as possible, with the reasons shown.
  const cell = (i: number): string => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');
  const options = [
    mapping.optionA,
    mapping.optionB,
    mapping.optionC,
    mapping.optionD,
    mapping.optionE,
  ]
    .map(cell)
    .filter(Boolean)
    .map(plain);
  return {
    stem: plain(cell(mapping.question)),
    options:
      options.length >= 2
        ? options
        : [...options, ...Array.from({ length: 2 - options.length }, () => [] as RichText)],
    correct: null,
    explanation: plain(cell(mapping.explanation)),
    subject: cell(mapping.subject) || defaults.subject,
    topic: cell(mapping.topic),
    difficulty: defaults.difficulty,
    tags: [],
    source: cell(mapping.source) || defaults.source,
    lockOptions: false,
    reserved: false,
    warnings: [...result.errors, ...result.warnings].map((e) => e.message),
    refs: [`row ${result.row}`],
    pages: [],
    number: null,
  };
}

export interface TablePreview {
  sheets: Array<{ name: string; headers: string[]; rowCount: number; sample: string[][] }>;
  mapping: ColumnMapping;
}

export function previewTable(sheets: Array<{ name: string; rows: unknown[][] }>): TablePreview {
  const asText = (v: unknown): string =>
    v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const first = sheets[0];
  return {
    sheets: sheets.map((s) => ({
      name: s.name,
      headers: (s.rows[0] ?? []).map(asText),
      rowCount: Math.max(0, s.rows.length - 1),
      sample: s.rows.slice(1, 6).map((r) => r.map(asText)),
    })),
    mapping: detectMapping((first?.rows[0] ?? []).map(asText)),
  };
}

export function validateTable(rows: unknown[][], mapping: ColumnMapping, subjects: string[]) {
  const results = validateRows(rows.slice(1), mapping, { subjects });
  return {
    results,
    valid: results.filter((r) => r.ok).length,
    invalid: results
      .filter((r) => !r.ok)
      .map((r) => ({ row: r.row, errors: r.ok ? [] : r.errors.map((e) => e.message) })),
    warnings: results.filter((r) => r.warnings.length).length,
  };
}

export function parseLines(lines: SourceLine[], convention: AnswerConvention): ParseResult {
  return parseMcqLines(lines, { convention });
}

/** Suggests the answer convention that explains the most questions in a file. */
export function suggestConvention(detected: ParseResult['detected']): AnswerConvention {
  const ranked = (
    Object.entries(detected) as Array<[Exclude<AnswerConvention, 'auto'>, number]>
  ).sort((a, b) => b[1] - a[1]);
  return ranked[0] && ranked[0][1] > 0 ? ranked[0][0] : 'auto';
}

export interface OutsideMatch {
  position: number;
  stemText: string;
  questionId: string | null;
  score: number;
  exact: boolean;
  bankStemText: string;
}

/** Matches questions of a test made outside the app to the bank by normalized wording. */
export function matchOutside(
  ws: Workspace,
  items: Array<{ stem: RichText; options: RichText[] }>,
  thresholdPct: number,
): OutsideMatch[] {
  const index = new DuplicateIndex();
  for (const q of allComparable(ws)) index.add(q.id, q);
  const stemIndex = new DuplicateIndex();
  for (const q of allComparable(ws)) stemIndex.add(q.id, { stem: q.stem, options: [] });
  return items.map((item, position) => {
    const full = index.findSimilar(item, thresholdPct / 100, 1)[0];
    // Outside papers often reorder or reword options; fall back to the stem alone.
    const stemOnly = full
      ? undefined
      : stemIndex.findSimilar({ stem: item.stem, options: [] }, thresholdPct / 100, 1)[0];
    const best = full ?? stemOnly;
    const bank: BankQuestion | null = best ? getQuestion(ws, best.id) : null;
    return {
      position,
      stemText: toPlainText(item.stem).slice(0, 300),
      questionId: best?.id ?? null,
      score: best ? Math.round(best.score * 1000) / 10 : 0,
      exact: !!full?.exact,
      bankStemText: bank ? toPlainText(bank.stem).slice(0, 300) : '',
    };
  });
}

export function safeFileName(value: string): string {
  // Control characters are invalid in file names on every OS, so stripping them is intended.
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Test'
  );
}

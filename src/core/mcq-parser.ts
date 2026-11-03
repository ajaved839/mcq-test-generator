import {
  isEmptyRich,
  isEntirely,
  joinRich,
  sliceRich,
  text,
  toOffsetText,
  toPlainText,
  trimRich,
  type RichText,
} from './richtext';
import { normalizeText } from './duplicates';
import { indexForLetter, letterFor, type OptionLetter } from './types';

/**
 * Splits a stream of lines (Word paragraphs or OCR lines) into MCQs.
 *
 * Recognizes typed or auto-numbered questions ("1.", "Q1)", "Question 1:"), options labeled
 * a) / (a) / A. on their own lines or several to a line, answer lines ("Ans: b", "Answer: (c)"),
 * inline answers ("(Ans: b)"), an answer key at the end ("1. b 2. d"), explanation lines and
 * options marked bold, highlighted or with an asterisk.
 *
 * Nothing is dropped: text the parser cannot place becomes an `unplaced` block for the review
 * queue, and every doubt becomes a warning on the MCQ.
 */

export interface SourceLine {
  content: RichText;
  /** Where the line came from, e.g. "paragraph 12" or "page 2". */
  ref?: string;
  /** Rendered label of a Word auto-numbered paragraph, e.g. "12." or "b)". */
  listLabel?: string;
  page?: number;
  /** Importer notes (e.g. "MathType equation could not be converted") passed to the MCQ. */
  notes?: string[];
}

export type AnswerConvention =
  'auto' | 'answer-line' | 'answer-key' | 'bold' | 'highlight' | 'asterisk';
export type AnswerSource = Exclude<AnswerConvention, 'auto'>;

export interface ParsedMcq {
  number: number | null;
  stem: RichText;
  options: RichText[];
  correct: number | null;
  answerFrom: AnswerSource | null;
  explanation: RichText;
  warnings: string[];
  refs: string[];
  pages: number[];
}

export interface UnplacedBlock {
  content: RichText;
  reason: string;
  refs: string[];
}

export interface ParseResult {
  mcqs: ParsedMcq[];
  unplaced: UnplacedBlock[];
  answerKey: Record<number, OptionLetter>;
  /** How often each answer convention appeared; drives the "how are answers marked?" default. */
  detected: Record<AnswerSource, number>;
}

const QUESTION_START =
  /^\s*(?:(?:q(?:uestion)?|q\.?\s*no)\s*[.#:-]?\s*(\d{1,4})\s*[.):\]-]?|(\d{1,4})\s*(?:[.):\]]|\s-))\s*(?!\d)/i;
const OPTION_START = /^\s*(?:\(([a-e])\)|\[([a-e])\]|([a-e])\s*[.):\]])(?![a-z]\.)\s*/i;
/** "Ans: b", "Answer: (c)", "Correct option - d", "Key: a" (separator required). */
const ANSWER_WITH_SEPARATOR =
  /^\s*(?:ans(?:wer)?s?|correct\s+(?:answer|option)|correct|key)\s*(?:is\s*)?[:.\-–=]\s*(?:is\s*)?(?:option\s*)?[([]?\s*([a-e])\s*[)\]]?(?![a-z])/i;
/** "Answer is b", "Ans (c)" with nothing else on the line. */
const ANSWER_BARE =
  /^\s*(?:ans(?:wer)?|correct\s+(?:answer|option))\s*(?:is\s+)?(?:option\s+)?(?:\(\s*([a-e])\s*\)|([a-e]))\s*\.?\s*$/i;

function matchAnswerLine(value: string): { letter: string; length: number } | null {
  const sep = ANSWER_WITH_SEPARATOR.exec(value);
  if (sep) return { letter: sep[1], length: sep[0].length };
  const bare = ANSWER_BARE.exec(value);
  if (bare) return { letter: bare[1] ?? bare[2], length: bare[0].length };
  return null;
}
const INLINE_ANSWER =
  /[([]\s*(?:ans(?:wer)?|correct)\s*[:.\-–=]?\s*[([]?\s*([a-e])\s*[)\]]?\s*[)\]]/i;
const TRAILING_ANSWER = /\s(?:ans(?:wer)?)\s*[:.\-–=]\s*[([]?\s*([a-e])\s*[)\]]?\s*$/i;
const EXPLANATION_LINE =
  /^\s*(?:explanation|explain|exp|solution|reason|rationale|hint)\s*[:.\-–]\s*/i;
const KEY_HEADER = /^\s*(?:answer\s*keys?|answers?|keys?|solutions?)\s*[:.\-–]?\s*$/i;
const KEY_PAIR = /(\d{1,4})\s*[.):\-–=]?\s*[([]?\s*([a-e])\s*[)\]]?(?![a-z])/gi;
const ASTERISK_MARK = /^\s*[*✓✔]\s*|\s*[*✓✔]\s*$/;

/** Parses "1. b 2. d" / "1-b, 2-c" / "1 (a)" into a map. */
export function parseAnswerKeyText(value: string): Record<number, OptionLetter> {
  const key: Record<number, OptionLetter> = {};
  for (const match of value.matchAll(KEY_PAIR)) {
    key[Number(match[1])] = match[2].toUpperCase() as OptionLetter;
  }
  return key;
}

/** True when the line is nothing but answer-key pairs (at least two). */
function isKeyOnlyLine(value: string): boolean {
  const pairs = [...value.matchAll(KEY_PAIR)];
  if (pairs.length < 2) return false;
  const rest = value.replace(KEY_PAIR, '').replace(/[\s,;|]+/g, '');
  return rest.length === 0;
}

interface Marker {
  letterIndex: number;
  start: number;
  contentStart: number;
}

/**
 * Finds option markers in sequence (a, then b, then c...) starting at `firstLetter`.
 * Requiring the sequence keeps ordinary words like "a" from splitting text.
 */
function findSequentialMarkers(value: string, firstLetter: number, from = 0): Marker[] {
  const markers: Marker[] = [];
  const re = /(^|[\s,;])(?:\(([a-e])\)|\[([a-e])\]|([a-e])[.)])\s*/gi;
  re.lastIndex = from;
  let expected = firstLetter;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const letter = (m[2] ?? m[3] ?? m[4]).toLowerCase();
    const index = letter.charCodeAt(0) - 97;
    if (index !== expected) continue;
    const start = m.index + m[1].length;
    // "a." directly followed by another letter-dot is an abbreviation (a.m., e.g.).
    if (/^[a-e]\.[a-z]\./i.test(value.slice(start, start + 4))) continue;
    markers.push({ letterIndex: index, start, contentStart: m.index + m[0].length });
    expected += 1;
  }
  return markers;
}

interface Draft {
  number: number | null;
  stemParts: RichText[];
  options: RichText[];
  optionLetters: number[];
  explanationParts: RichText[];
  answerLine: number | null;
  /** Last numbered statement seen inside the stem ("1. ... 2. ..."). */
  lastStatement: number | null;
  warnings: string[];
  refs: string[];
  pages: number[];
  state: 'stem' | 'options' | 'explanation';
}

function newDraft(number: number | null, line: SourceLine): Draft {
  return {
    number,
    stemParts: [],
    options: [],
    optionLetters: [],
    explanationParts: [],
    answerLine: null,
    lastStatement: null,
    warnings: [],
    refs: line.ref ? [line.ref] : [],
    pages: line.page !== undefined ? [line.page] : [],
    state: 'stem',
  };
}

function noteSource(draft: Draft, line: SourceLine): void {
  for (const note of line.notes ?? [])
    if (!draft.warnings.includes(note)) draft.warnings.push(note);
  if (line.ref && !draft.refs.includes(line.ref)) draft.refs.push(line.ref);
  if (line.page !== undefined && !draft.pages.includes(line.page)) draft.pages.push(line.page);
}

/** Removes an inline "(Ans: b)" and returns the letter index it named. */
function extractInlineAnswer(content: RichText): { content: RichText; answer: number | null } {
  const offsetText = toOffsetText(content);
  const match = INLINE_ANSWER.exec(offsetText) ?? TRAILING_ANSWER.exec(offsetText);
  if (!match) return { content, answer: null };
  const before = sliceRich(content, 0, match.index);
  const after = sliceRich(content, match.index + match[0].length);
  return { content: trimRich([...before, ...after]), answer: indexForLetter(match[1]) };
}

function stripAsterisk(option: RichText): { option: RichText; marked: boolean } {
  const value = toOffsetText(option);
  if (!ASTERISK_MARK.test(value)) return { option, marked: false };
  const lead = /^\s*[*✓✔]\s*/.exec(value);
  const trail = /\s*[*✓✔]\s*$/.exec(value);
  const start = lead ? lead[0].length : 0;
  const end = trail ? trail.index : value.length;
  return { option: trimRich(sliceRich(option, start, end)), marked: true };
}

export interface ParseOptions {
  convention?: AnswerConvention;
}

export function parseMcqLines(
  lines: readonly SourceLine[],
  options: ParseOptions = {},
): ParseResult {
  const convention = options.convention ?? 'auto';
  const drafts: Draft[] = [];
  const unplaced: UnplacedBlock[] = [];
  const answerKey: Record<number, OptionLetter> = {};
  let inKey = false;
  let current: Draft | null = null;

  const unplace = (line: SourceLine, reason: string, content: RichText = line.content): void => {
    if (isEmptyRich(content)) return;
    const notes = line.notes?.length ? ` (${line.notes.join(' ')})` : '';
    unplaced.push({
      content: trimRich(content),
      reason: reason + notes,
      refs: line.ref ? [line.ref] : [],
    });
  };

  const startQuestion = (number: number | null, line: SourceLine): Draft => {
    const draft = newDraft(number, line);
    noteSource(draft, line);
    drafts.push(draft);
    current = draft;
    return draft;
  };

  const addOptions = (
    draft: Draft,
    content: RichText,
    offsetText: string,
    firstMarker: Marker,
  ): void => {
    // Start one character early so the whitespace before the marker can anchor the match.
    const markers = findSequentialMarkers(
      offsetText,
      firstMarker.letterIndex,
      Math.max(0, firstMarker.start - 1),
    );
    const list = markers.length ? markers : [firstMarker];
    list.forEach((marker, i) => {
      const end = i + 1 < list.length ? list[i + 1].start : offsetText.length;
      const extracted = extractInlineAnswer(trimRich(sliceRich(content, marker.contentStart, end)));
      if (extracted.answer !== null) draft.answerLine = extracted.answer;
      const expected = draft.options.length;
      if (marker.letterIndex > expected) {
        draft.warnings.push(
          `Option ${letterFor(expected)} seems to be missing; the next option was labeled ${letterFor(marker.letterIndex)}.`,
        );
      }
      draft.options.push(extracted.content);
      draft.optionLetters.push(marker.letterIndex);
    });
    draft.state = 'options';
  };

  const appendContinuation = (draft: Draft, content: RichText, line: SourceLine): void => {
    noteSource(draft, line);
    if (draft.state === 'explanation') {
      draft.explanationParts.push(content);
    } else if (draft.state === 'options' && draft.options.length) {
      const last = draft.options.length - 1;
      draft.options[last] = joinRich([draft.options[last], content]);
      draft.warnings.push(
        `A line after option ${letterFor(last)} was joined to it; check it is not the start of another question.`,
      );
    } else {
      draft.stemParts.push(content);
    }
  };

  for (const line of lines) {
    const content: RichText = line.listLabel
      ? [text(`${line.listLabel} `), ...line.content]
      : line.content;
    if (isEmptyRich(content)) continue;
    const offsetText = toOffsetText(content);
    const plainValue = toPlainText(content);

    if (KEY_HEADER.test(offsetText)) {
      inKey = true;
      continue;
    }
    if (inKey || isKeyOnlyLine(plainValue)) {
      const pairs = parseAnswerKeyText(plainValue);
      if (Object.keys(pairs).length) {
        Object.assign(answerKey, pairs);
        if (!inKey && isKeyOnlyLine(plainValue)) inKey = true;
      } else {
        unplace({ ...line, content }, 'Text after the answer key');
      }
      continue;
    }

    const answerMatch = matchAnswerLine(offsetText);
    if (answerMatch && !OPTION_START.test(offsetText)) {
      const draft = current as Draft | null;
      if (!draft) {
        unplace({ ...line, content }, 'Answer line before any question');
        continue;
      }
      noteSource(draft, line);
      draft.answerLine = indexForLetter(answerMatch.letter);
      const rest = trimRich(sliceRich(content, answerMatch.length));
      const restText = toOffsetText(rest);
      const explanation = EXPLANATION_LINE.exec(restText);
      if (explanation) {
        draft.explanationParts.push(
          trimRich(sliceRich(rest, explanation.index + explanation[0].length)),
        );
        draft.state = 'explanation';
      } else if (!isEmptyRich(rest)) {
        // "Ans: b) Mitochondrion" restates the option; anything else is kept as explanation.
        const restated = draft.options[draft.answerLine];
        const cleaned = normalizeText(restText.replace(/^[\s).\]:-]+/, ''));
        if (!restated || cleaned !== normalizeText(toPlainText(restated))) {
          draft.explanationParts.push(rest);
          draft.warnings.push('Text after the answer line was kept as the explanation.');
        }
      }
      continue;
    }

    const explanationMatch = EXPLANATION_LINE.exec(offsetText);
    if (explanationMatch) {
      const draft = current as Draft | null;
      if (!draft) {
        unplace({ ...line, content }, 'Explanation before any question');
        continue;
      }
      noteSource(draft, line);
      draft.explanationParts.push(trimRich(sliceRich(content, explanationMatch[0].length)));
      draft.state = 'explanation';
      continue;
    }

    const questionMatch = QUESTION_START.exec(offsetText);
    const numbered = questionMatch ? Number(questionMatch[1] ?? questionMatch[2]) : null;
    const open = current as Draft | null;
    // Numbered statements inside a stem ("Consider: 1. ... 2. ...") arrive before any option and
    // do not continue the question numbering, so they stay part of the stem.
    const isStatement =
      numbered !== null &&
      open !== null &&
      open.options.length === 0 &&
      open.number !== null &&
      (numbered !== open.number + 1 || open.lastStatement === numbered - 1);
    if (isStatement && open) open.lastStatement = numbered;
    if (questionMatch && numbered !== null && !isStatement) {
      const number = numbered;
      const previous = open;
      const draft = startQuestion(number, line);
      if (previous?.number != null && number !== previous.number + 1 && number > previous.number) {
        draft.warnings.push(
          `Numbering jumps from ${previous.number} to ${number}; a question may be missing or misread.`,
        );
      }
      const restStart = questionMatch[0].length;
      const markers = findSequentialMarkers(offsetText, 0, restStart);
      if (markers.length >= 2) {
        const stem = extractInlineAnswer(trimRich(sliceRich(content, restStart, markers[0].start)));
        if (stem.answer !== null) draft.answerLine = stem.answer;
        draft.stemParts.push(stem.content);
        addOptions(draft, content, offsetText, markers[0]);
      } else {
        const stem = extractInlineAnswer(trimRich(sliceRich(content, restStart)));
        if (stem.answer !== null) draft.answerLine = stem.answer;
        draft.stemParts.push(stem.content);
      }
      continue;
    }

    const optionMatch = OPTION_START.exec(offsetText);
    if (optionMatch) {
      const letterIndex =
        (optionMatch[1] ?? optionMatch[2] ?? optionMatch[3]).toLowerCase().charCodeAt(0) - 97;
      let draft = current as Draft | null;
      const marker: Marker = { letterIndex, start: 0, contentStart: optionMatch[0].length };
      if (!draft) {
        draft = startQuestion(null, line);
        draft.warnings.push(
          'Options were found without a question above them; add the question text.',
        );
      } else if (letterIndex === 0 && draft.options.length >= 2) {
        draft = startQuestion(null, line);
        draft.warnings.push(
          'A new set of options started without a numbered question; add the question text.',
        );
      } else if (letterIndex < draft.options.length) {
        appendContinuation(draft, content, line);
        continue;
      }
      noteSource(draft, line);
      addOptions(draft, content, offsetText, marker);
      continue;
    }

    const draft = current as Draft | null;
    if (!draft) {
      unplace({ ...line, content }, 'Text before the first question');
      continue;
    }
    appendContinuation(draft, content, line);
  }

  const detected: Record<AnswerSource, number> = {
    'answer-line': 0,
    'answer-key': 0,
    bold: 0,
    highlight: 0,
    asterisk: 0,
  };
  const mcqs = drafts.map((draft) => finalizeDraft(draft, answerKey, convention, detected));
  return { mcqs, unplaced, answerKey, detected };
}

function finalizeDraft(
  draft: Draft,
  answerKey: Record<number, OptionLetter>,
  convention: AnswerConvention,
  detected: Record<AnswerSource, number>,
): ParsedMcq {
  const warnings = [...draft.warnings];
  const stripped = draft.options.map(stripAsterisk);
  const options = stripped.map((s) => s.option);

  const singleMarked = (flags: boolean[]): number | null => {
    const marked = flags.flatMap((flag, i) => (flag ? [i] : []));
    if (marked.length === 1 && marked.length < flags.length) return marked[0];
    return null;
  };

  const sources: Record<AnswerSource, number | null> = {
    'answer-line': draft.answerLine,
    'answer-key':
      draft.number !== null && answerKey[draft.number]
        ? indexForLetter(answerKey[draft.number])
        : null,
    asterisk: singleMarked(stripped.map((s) => s.marked)),
    highlight: singleMarked(options.map((o) => isEntirely(o, 'hl'))),
    bold: singleMarked(options.map((o) => isEntirely(o, 'b'))),
  };
  (Object.keys(sources) as AnswerSource[]).forEach((source) => {
    if (sources[source] !== null) detected[source] += 1;
  });

  let correct: number | null = null;
  let answerFrom: AnswerSource | null = null;
  if (convention === 'auto') {
    const priority: AnswerSource[] = ['answer-line', 'answer-key', 'asterisk', 'highlight', 'bold'];
    const found = priority.filter((s) => sources[s] !== null);
    if (found.length) {
      answerFrom = found[0];
      correct = sources[answerFrom];
      const disagree = found.filter((s) => sources[s] !== correct);
      if (disagree.length) {
        warnings.push(
          `Answer sources disagree: ${found.map((s) => `${s} says ${letterFor(sources[s]!)}`).join(', ')}. ${letterFor(correct!)} was used.`,
        );
      }
    }
  } else if (sources[convention] !== null) {
    answerFrom = convention;
    correct = sources[convention];
  }

  if (correct !== null && correct >= options.length) {
    warnings.push(
      `The answer is ${letterFor(correct)} but only ${options.length} options were found.`,
    );
    correct = null;
    answerFrom = null;
  }
  const stem = trimRich(joinRich(draft.stemParts));
  if (isEmptyRich(stem)) warnings.push('The question text is empty.');
  if (options.length < 2)
    warnings.push(`Only ${options.length} option(s) found; an MCQ needs 2 to 5.`);
  options.forEach((o, i) => {
    if (isEmptyRich(o)) warnings.push(`Option ${letterFor(i)} is empty.`);
  });
  if (correct === null) warnings.push('No answer found; mark the correct option.');

  return {
    number: draft.number,
    stem,
    options,
    correct,
    answerFrom,
    explanation: trimRich(joinRich(draft.explanationParts)),
    warnings,
    refs: draft.refs,
    pages: draft.pages,
  };
}

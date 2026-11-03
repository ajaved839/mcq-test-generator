import { describe, expect, it } from 'vitest';
import { parseAnswerKeyText, parseMcqLines, type SourceLine } from '../../src/core/mcq-parser';
import { text, toPlainText, type RichText } from '../../src/core/richtext';

const lines = (...values: Array<string | RichText>): SourceLine[] =>
  values.map((v, i) => ({
    content: typeof v === 'string' ? [text(v)] : v,
    ref: `paragraph ${i + 1}`,
  }));

const plainOptions = (options: RichText[]): string[] => options.map(toPlainText);

describe('MCQ parser', () => {
  it('parses typed questions with options on separate lines and an answer line', () => {
    const r = parseMcqLines(
      lines(
        '1. Which organelle is the main site of ATP synthesis?',
        'a) Ribosome',
        'b) Mitochondrion',
        'c) Golgi body',
        'd) Lysosome',
        'Ans: b',
        '2) What is the chemical formula of water?',
        '(a) H2O',
        '(b) CO2',
        'Answer: (a)',
      ),
    );
    expect(r.mcqs).toHaveLength(2);
    expect(toPlainText(r.mcqs[0].stem)).toBe('Which organelle is the main site of ATP synthesis?');
    expect(plainOptions(r.mcqs[0].options)).toEqual([
      'Ribosome',
      'Mitochondrion',
      'Golgi body',
      'Lysosome',
    ]);
    expect(r.mcqs[0].correct).toBe(1);
    expect(r.mcqs[0].answerFrom).toBe('answer-line');
    expect(r.mcqs[1].correct).toBe(0);
    expect(r.mcqs[0].warnings).toEqual([]);
    expect(r.unplaced).toEqual([]);
  });

  it('splits several options on one line, including uppercase labels', () => {
    const r = parseMcqLines(lines('Q3. 2 + 2 = ?', 'A. 3   B. 4   C. 5   D. 22', 'Answer is B'));
    expect(plainOptions(r.mcqs[0].options)).toEqual(['3', '4', '5', '22']);
    expect(r.mcqs[0].number).toBe(3);
    expect(r.mcqs[0].correct).toBe(1);
  });

  it('splits options that follow the stem on the same line', () => {
    const r = parseMcqLines(
      lines('4. The SI unit of force is (a) joule (b) newton (c) watt (d) pascal (Ans: b)'),
    );
    expect(toPlainText(r.mcqs[0].stem)).toBe('The SI unit of force is');
    expect(plainOptions(r.mcqs[0].options)).toEqual(['joule', 'newton', 'watt', 'pascal']);
    expect(r.mcqs[0].correct).toBe(1);
  });

  it('uses Word auto-numbering labels', () => {
    const r = parseMcqLines([
      { content: [text('Name the largest planet.')], listLabel: '1.' },
      { content: [text('Mars')], listLabel: 'a)' },
      { content: [text('Jupiter')], listLabel: 'b)' },
      { content: [text('Ans: b')] },
    ]);
    expect(r.mcqs[0].number).toBe(1);
    expect(r.mcqs[0].correct).toBe(1);
  });

  it('reads an answer key at the end of the file', () => {
    const r = parseMcqLines(
      lines(
        '1. First?',
        'a) x',
        'b) y',
        '2. Second?',
        'a) p',
        'b) q',
        'c) r',
        'Answer Key',
        '1. b 2. c',
      ),
    );
    expect(r.answerKey).toEqual({ 1: 'B', 2: 'C' });
    expect(r.mcqs.map((m) => m.correct)).toEqual([1, 2]);
    expect(r.mcqs[0].answerFrom).toBe('answer-key');
  });

  it('reads a key without a header when the line is only pairs', () => {
    const r = parseMcqLines(
      lines('1. First?', 'a) x', 'b) y', '2. Second?', 'a) p', 'b) q', '1-b, 2-a'),
    );
    expect(r.mcqs.map((m) => m.correct)).toEqual([1, 0]);
  });

  it('detects bold, highlighted and asterisk-marked options', () => {
    const bold = parseMcqLines(
      lines('1. Pick one', [text('a) wrong')], [text('b) right', { b: true })], [text('c) wrong')]),
      { convention: 'bold' },
    );
    expect(bold.mcqs[0].correct).toBe(1);
    expect(bold.detected.bold).toBe(1);

    const highlighted = parseMcqLines(
      lines('1. Pick one', 'a) no', [text('b) '), text('yes', { hl: true })]),
    );
    expect(highlighted.mcqs[0].correct).toBe(1);
    expect(highlighted.mcqs[0].answerFrom).toBe('highlight');

    const starred = parseMcqLines(lines('1. Pick one', 'a) no', 'b) yes *', 'c) no'));
    expect(starred.mcqs[0].correct).toBe(1);
    expect(toPlainText(starred.mcqs[0].options[1])).toBe('yes');
  });

  it('ignores bold when every option is bold', () => {
    const r = parseMcqLines(
      lines('1. Pick', [text('a) x', { b: true })], [text('b) y', { b: true })]),
      {
        convention: 'bold',
      },
    );
    expect(r.mcqs[0].correct).toBeNull();
    expect(r.mcqs[0].warnings).toContain('No answer found; mark the correct option.');
  });

  it('warns when answer sources disagree', () => {
    const r = parseMcqLines(lines('1. Pick', 'a) x', [text('b) y', { b: true })], 'Ans: a'));
    expect(r.mcqs[0].correct).toBe(0);
    expect(r.mcqs[0].warnings.join(' ')).toMatch(/disagree/);
  });

  it('keeps explanations, including multi-line ones', () => {
    const r = parseMcqLines(
      lines('1. Q?', 'a) x', 'b) y', 'Ans: a', 'Explanation: because', 'it is so.'),
    );
    expect(toPlainText(r.mcqs[0].explanation)).toBe('because\nit is so.');
  });

  it('keeps numbered statements inside the stem', () => {
    const r = parseMcqLines(
      lines(
        '5. Consider the statements:',
        '1. Water boils at 100 C at sea level.',
        '2. Ice is denser than water.',
        'Which is correct?',
        'a) 1 only',
        'b) 2 only',
        'c) Both',
        'Ans: a',
      ),
    );
    expect(r.mcqs).toHaveLength(1);
    expect(toPlainText(r.mcqs[0].stem)).toContain('Ice is denser');
    expect(r.mcqs[0].options).toHaveLength(3);
  });

  it('flags, never drops, text it cannot place', () => {
    const r = parseMcqLines(
      lines(
        'Biology Chapter 3',
        'Ans: c',
        '1. Q?',
        'a) x',
        'b) y',
        'Answer Key',
        '1. a',
        'Good luck!',
      ),
    );
    expect(r.unplaced.map((u) => u.reason)).toEqual([
      'Text before the first question',
      'Answer line before any question',
      'Text after the answer key',
    ]);
    expect(r.unplaced[0].refs).toEqual(['paragraph 1']);
  });

  it('warns about missing options, empty stems and numbering gaps', () => {
    const r = parseMcqLines(
      lines('1. Q?', 'a) x', '3. Next?', 'a) p', 'c) r', 'a) orphan', 'b) options'),
    );
    expect(r.mcqs[1].warnings.join(' ')).toMatch(/jumps from 1 to 3/);
    expect(r.mcqs[1].warnings.join(' ')).toMatch(/Option B seems to be missing/);
    expect(r.mcqs[0].warnings.join(' ')).toMatch(/Only 1 option/);
    expect(r.mcqs[2].warnings.join(' ')).toMatch(/without a numbered question/);
  });

  it('joins wrapped option text and warns', () => {
    const r = parseMcqLines(
      lines('1. Q?', 'a) a long option that', 'wraps here', 'b) y', 'Ans: b'),
    );
    expect(toPlainText(r.mcqs[0].options[0])).toBe('a long option that\nwraps here');
    expect(r.mcqs[0].warnings.join(' ')).toMatch(/joined/);
  });

  it('does not mistake abbreviations or decimals for structure', () => {
    const r = parseMcqLines(lines('1. Q?', 'a) 1.5 kg', 'b) e.g. two', 'c) 3.0 kg'));
    expect(plainOptions(r.mcqs[0].options)).toEqual(['1.5 kg', 'e.g. two', '3.0 kg']);
  });

  it('keeps formatting through slicing (subscripts)', () => {
    const r = parseMcqLines(
      lines(
        '1. Formula of sulfuric acid?',
        [text('a) H'), text('2', { sub: true }), text('SO'), text('4', { sub: true })],
        'b) HCl',
      ),
    );
    const option = r.mcqs[0].options[0];
    expect(option.some((i) => i.t === 'text' && i.sub && i.text === '2')).toBe(true);
  });

  it('parses answer key text variants', () => {
    expect(parseAnswerKeyText('1. b 2. d 3 (a) 4-c, 5:e')).toEqual({
      1: 'B',
      2: 'D',
      3: 'A',
      4: 'C',
      5: 'E',
    });
  });
});

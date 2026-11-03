import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_COLUMNS,
  detectMapping,
  missingRequired,
  parseCorrect,
  templateCsv,
  validateRows,
} from '../../src/core/tabular';
import { toPlainText } from '../../src/core/richtext';

const subjects = ['Biology', 'Chemistry', 'Physics'];
const mapping = detectMapping([...TEMPLATE_COLUMNS]);

const row = (overrides: Record<number, string> = {}): string[] => {
  const base = [
    'Q?',
    'A1',
    'B1',
    'C1',
    'D1',
    '',
    'B',
    'Biology',
    'Cells',
    'Easy',
    'Because.',
    'Book',
  ];
  Object.entries(overrides).forEach(([i, v]) => (base[Number(i)] = v));
  return base;
};

describe('tabular import', () => {
  it('maps the template headers and aliases', () => {
    expect(missingRequired(mapping)).toEqual([]);
    const custom = detectMapping([
      'Stem',
      'A',
      'B',
      'C',
      'D',
      'Answer',
      'Course',
      'Chapter',
      'Level',
    ]);
    expect(custom.question).toBe(0);
    expect(custom.correct).toBe(5);
    expect(custom.subject).toBe(6);
    expect(custom.topic).toBe(7);
    expect(custom.difficulty).toBe(8);
    expect(missingRequired(detectMapping(['Foo']))).toContain('question');
  });

  it('accepts a valid row', () => {
    const [r] = validateRows([row()], mapping, { subjects });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.correct).toBe(1);
      expect(r.value.options).toHaveLength(4);
      expect(r.value.difficulty).toBe('easy');
      expect(toPlainText(r.value.explanation)).toBe('Because.');
    }
  });

  it('explains each bad row with its fix', () => {
    const results = validateRows(
      [
        row({ 0: '' }),
        row({ 6: 'Z' }),
        row({ 6: 'E' }),
        row({ 3: '' }),
        row({ 7: 'Biolgy' }),
        row({ 9: 'Impossible' }),
        row({ 2: 'A1' }),
      ],
      mapping,
      { subjects },
    );
    const messages = results.map((r) => (r.ok ? '' : r.errors.map((e) => e.message).join(' ')));
    expect(messages[0]).toMatch(/Question is empty/);
    expect(messages[1]).toMatch(/Correct is "Z"/);
    expect(messages[2]).toMatch(/Option E is empty/);
    expect(messages[3]).toMatch(/Option C is empty but Option D is filled/);
    expect(messages[4]).toMatch(/Did you mean "Biology"/);
    expect(messages[5]).toMatch(/Use Easy, Medium or Hard/);
    expect(messages[6]).toMatch(/repeats Option A/);
    expect(results.map((r) => r.row)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('defaults a blank difficulty with a warning and skips blank rows', () => {
    const results = validateRows([row({ 9: '' }), ['', '', ''], row()], mapping, { subjects });
    expect(results).toHaveLength(2);
    expect(results[0].ok && results[0].value.difficulty).toBe('medium');
    expect(results[0].warnings[0].message).toMatch(/Medium/);
    expect(results[1].row).toBe(4);
  });

  it('parses the correct column in several styles', () => {
    const options = ['Paris', 'Rome'];
    expect(parseCorrect('b', options)).toBe(1);
    expect(parseCorrect('(A)', options)).toBe(0);
    expect(parseCorrect('Option B', options)).toBe(1);
    expect(parseCorrect('2', options)).toBe(1);
    expect(parseCorrect('rome', options)).toBe(1);
    expect(parseCorrect('London', options)).toBeNull();
  });

  it('validates 1,000 rows in well under 10 seconds', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row({ 0: `Question ${i}?` }));
    const started = performance.now();
    const results = validateRows(rows, mapping, { subjects });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('ships a template with a synthetic example', () => {
    const csv = templateCsv();
    expect(csv.split('\n')[0]).toBe(TEMPLATE_COLUMNS.join(','));
    expect(csv).toContain('Mitochondrion');
  });
});

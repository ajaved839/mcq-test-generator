import {
  AlignmentType,
  Document,
  ImageRun,
  LevelFormat,
  Math as DocxMath,
  MathFraction,
  MathRun,
  MathSuperScript,
  MathRadical,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import writeXlsxFile from 'write-excel-file/node';
import { describe, expect, it } from 'vitest';
import { parseMcqLines } from '../../src/core/mcq-parser';
import { toPlainText, type RichText } from '../../src/core/richtext';
import { detectMapping, validateRows } from '../../src/core/tabular';
import { readDocx } from '../../src/main/importers/docx';
import { checkImageFormat, wordsToRich } from '../../src/main/importers/ocr';
import { readTable } from '../../src/main/importers/tabular';

// 1x1 transparent PNG (synthetic).
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

async function buildDocx(): Promise<Uint8Array> {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'questions',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: '%2)',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('Synthetic Biology Practice')] }),
          new Paragraph({
            numbering: { reference: 'questions', level: 0 },
            children: [new TextRun('Which organelle makes ATP?')],
          }),
          new Paragraph({
            numbering: { reference: 'questions', level: 1 },
            children: [new TextRun('Ribosome')],
          }),
          new Paragraph({
            numbering: { reference: 'questions', level: 1 },
            children: [new TextRun({ text: 'Mitochondrion', bold: true })],
          }),
          new Paragraph({
            numbering: { reference: 'questions', level: 1 },
            children: [new TextRun('Lysosome')],
          }),
          new Paragraph({
            numbering: { reference: 'questions', level: 0 },
            children: [new TextRun('Formula of sulfuric acid?')],
          }),
          new Paragraph({
            numbering: { reference: 'questions', level: 1 },
            children: [
              new TextRun('H'),
              new TextRun({ text: '2', subScript: true }),
              new TextRun('SO'),
              new TextRun({ text: '4', subScript: true }),
            ],
          }),
          new Paragraph({
            numbering: { reference: 'questions', level: 1 },
            children: [new TextRun({ text: 'HCl', bold: true })],
          }),
          new Paragraph({ children: [new TextRun('3. Simplify the expression')] }),
          new Paragraph({
            children: [
              new DocxMath({
                children: [
                  new MathFraction({
                    numerator: [new MathRun('x')],
                    denominator: [new MathRun('2')],
                  }),
                  new MathRun('+'),
                  new MathSuperScript({
                    children: [new MathRun('y')],
                    superScript: [new MathRun('2')],
                  }),
                  new MathRadical({ children: [new MathRun('9')] }),
                ],
              }),
            ],
          }),
          new Paragraph({
            children: [
              new ImageRun({ type: 'png', data: PNG, transformation: { width: 40, height: 20 } }),
            ],
          }),
          new Paragraph({ children: [new TextRun('(a) 1 (b) 2 (c) 3 (d) 4')] }),
          new Paragraph({ children: [new TextRun('Answer Key')] }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('1')] }),
                  new TableCell({ children: [new Paragraph('b')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('2')] }),
                  new TableCell({ children: [new Paragraph('a')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('3')] }),
                  new TableCell({ children: [new Paragraph('c')] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

describe('Word importer', () => {
  it('captures numbering, formatting, equations, images and the answer key', async () => {
    const stored: Uint8Array[] = [];
    const { lines, stats } = await readDocx(await buildDocx(), (img) => {
      stored.push(img.bytes);
      return 'a'.repeat(64);
    });
    expect(stats.equations).toBe(1);
    expect(stats.images).toBe(1);
    expect(stored).toHaveLength(1);
    expect(lines.find((l) => l.listLabel === '1.')).toBeTruthy();
    expect(lines.filter((l) => l.listLabel?.endsWith(')')).map((l) => l.listLabel)).toEqual([
      'a)',
      'b)',
      'c)',
      'a)',
      'b)',
    ]);

    const result = parseMcqLines(lines);
    expect(result.unplaced.map((u) => toPlainText(u.content))).toEqual([
      'Synthetic Biology Practice',
    ]);
    expect(result.mcqs).toHaveLength(3);
    const [q1, q2, q3] = result.mcqs;
    expect(toPlainText(q1.stem)).toBe('Which organelle makes ATP?');
    expect(q1.correct).toBe(1);
    expect(q1.answerFrom).toBe('answer-key');
    expect(result.detected.bold).toBe(2);
    expect(q2.options[0].some((i) => i.t === 'text' && i.sub)).toBe(true);
    expect(q2.correct).toBe(0);
    const stem: RichText = q3.stem;
    const math = stem.find((i) => i.t === 'math');
    expect(math && math.t === 'math' && JSON.stringify(math.mathml)).toContain('"mfrac"');
    expect(math && math.t === 'math' && JSON.stringify(math.mathml)).toContain('"msqrt"');
    expect(stem.some((i) => i.t === 'img')).toBe(true);
    expect(q3.options.map(toPlainText)).toEqual(['1', '2', '3', '4']);
    expect(q3.correct).toBe(2);
  });

  it('can follow the bold convention instead of the key', async () => {
    const { lines } = await readDocx(await buildDocx(), () => 'b'.repeat(64));
    const result = parseMcqLines(lines, { convention: 'bold' });
    expect(result.mcqs.map((m) => m.correct)).toEqual([1, 1, null]);
  });

  it('rejects files that are not .docx', async () => {
    await expect(readDocx(new TextEncoder().encode('not a zip'), () => null)).rejects.toThrow(
      /not a valid .docx/,
    );
  });
});

describe('Excel and CSV reader', () => {
  it('reads CSV with BOM and quoted commas', async () => {
    const csv = '﻿Question,Option A,Option B,Correct,Subject\n"Pick, one",x,y,A,Biology\n';
    const [sheet] = await readTable('bank.csv', new TextEncoder().encode(csv));
    expect(sheet.rows[1]).toEqual(['Pick, one', 'x', 'y', 'A', 'Biology']);
    const mapping = detectMapping(sheet.rows[0] as string[]);
    const [row] = validateRows(sheet.rows.slice(1), mapping, { subjects: ['Biology'] });
    expect(row.ok).toBe(true);
  });

  it('reads .xlsx files', async () => {
    const data = [
      [
        { value: 'Question' },
        { value: 'Option A' },
        { value: 'Option B' },
        { value: 'Correct' },
        { value: 'Subject' },
      ],
      [
        { value: 'Synthetic?' },
        { value: 'Yes' },
        { value: 'No' },
        { value: 'B' },
        { value: 'Physics' },
      ],
    ];
    const buffer = await writeXlsxFile(data).toBuffer();
    const [sheet] = await readTable('bank.xlsx', new Uint8Array(buffer));
    expect(sheet.rows[1]).toEqual(['Synthetic?', 'Yes', 'No', 'B', 'Physics']);
  });

  it('explains unsupported formats', async () => {
    await expect(readTable('old.xls', new Uint8Array())).rejects.toThrow(/save it as .xlsx/);
    await expect(readTable('x.pdf', new Uint8Array())).rejects.toThrow(/xlsx or .csv/);
  });
});

describe('OCR helpers', () => {
  it('marks low-confidence words and restores subscripts', () => {
    const rich = wordsToRich([
      { text: 'Formula', confidence: 95 },
      {
        text: 'H2SO4',
        confidence: 50,
        symbols: [
          { text: 'H', is_subscript: false, is_superscript: false },
          { text: '2', is_subscript: true, is_superscript: false },
          { text: 'SO', is_subscript: false, is_superscript: false },
          { text: '4', is_subscript: true, is_superscript: false },
        ],
      },
    ]);
    expect(rich[0]).toEqual({ t: 'text', text: 'Formula ' });
    expect(rich.some((i) => i.t === 'text' && i.sub && i.low)).toBe(true);
  });

  it('rejects HEIC with the fix', () => {
    expect(() => checkImageFormat('IMG_0001.HEIC', new Uint8Array(20))).toThrow(/Most Compatible/);
    expect(() => checkImageFormat('page.png', PNG)).not.toThrow();
    expect(() => checkImageFormat('page.gif', new Uint8Array([0x47, 0x49]))).toThrow(
      /not a JPG or PNG/,
    );
  });
});

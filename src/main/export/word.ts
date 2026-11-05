import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  PageBreak,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import { toPlainText, type Inline, type RichText } from '../../core/richtext';
import type { PaperVersion } from '../../core/shuffle';
import type { BankQuestion } from '../../core/types';
import type { PaperHeader } from '../../shared/paper';

/**
 * Word export of a paper version. Layout is close to, not identical with, the PDF.
 * Equations are placed as images rendered from the same MathML the PDF uses.
 */

export interface ImageSource {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

export interface WordAssets {
  image: (ref: string) => ImageSource | null;
  /** Renders a math inline to a PNG; null falls back to the equation's text. */
  math: (inline: Extract<Inline, { t: 'math' }>) => Promise<ImageSource | null>;
}

const LETTERS = 'ABCDE';
const MAX_IMAGE_WIDTH = 520;

function imageType(mime: string): 'png' | 'jpg' | 'gif' {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

function scaled(
  width: number,
  height: number,
  maxWidth = MAX_IMAGE_WIDTH,
): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.round((height * maxWidth) / width) };
}

async function runs(rich: RichText, assets: WordAssets, size: number): Promise<ParagraphChild[]> {
  const out: ParagraphChild[] = [];
  for (const inline of rich) {
    switch (inline.t) {
      case 'text':
        out.push(
          new TextRun({
            text: inline.text,
            bold: inline.b,
            italics: inline.i,
            underline: inline.u ? {} : undefined,
            subScript: inline.sub,
            superScript: inline.sup,
            size,
          }),
        );
        break;
      case 'br':
        out.push(new TextRun({ break: 1 }));
        break;
      case 'img': {
        const img = assets.image(inline.ref);
        if (img) {
          const dims = scaled(inline.w ?? img.width, inline.h ?? img.height);
          out.push(
            new ImageRun({ type: imageType(img.mime), data: img.bytes, transformation: dims }),
          );
        } else {
          out.push(new TextRun({ text: '[image missing]', italics: true }));
        }
        break;
      }
      case 'math': {
        const png = await assets.math(inline);
        if (png) {
          out.push(
            new ImageRun({
              type: 'png',
              data: png.bytes,
              transformation: scaled(png.width, png.height),
            }),
          );
        } else {
          out.push(new TextRun({ text: toPlainText([inline]), italics: true, size }));
        }
        break;
      }
      case 'table':
        // Tables inside a sentence cannot nest in a Word run; flatten to text rows.
        out.push(new TextRun({ text: toPlainText([inline]), size }));
        break;
    }
  }
  return out;
}

export interface WordPaperInput {
  header: PaperHeader;
  version: PaperVersion;
  versionCount: number;
  questions: ReadonlyMap<string, BankQuestion>;
  groupBySubject: boolean;
  logo: ImageSource | null;
  /** Print this version's answer key on a new page after the questions. */
  answerKeyAtEnd?: boolean;
}

export async function buildPaperDocx(
  input: WordPaperInput,
  assets: WordAssets,
): Promise<Uint8Array> {
  const { header: h, version } = input;
  const size = Math.round(h.fontSizePt * 2);
  const letter = input.versionCount > 1 ? version.letter : null;
  const children: Array<Paragraph | Table> = [];

  const headerCells: ParagraphChild[] = [];
  if (input.logo) {
    headerCells.push(
      new ImageRun({
        type: imageType(input.logo.mime),
        data: input.logo.bytes,
        transformation: scaled(input.logo.width, input.logo.height, 90),
      }),
    );
  }
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: headerCells }));
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: h.instituteName, bold: true, size: size + 8 })],
    }),
  );
  if (h.instituteAddress)
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: h.instituteAddress, size: size - 2 })],
      }),
    );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: h.title, bold: true, size: size + 4 })],
    }),
  );
  const meta = [
    letter ? `Version ${letter}` : '',
    h.showTestCode && h.code ? `Test code: ${h.code}` : '',
    `Questions: ${version.questions.length}`,
    `Time: ${h.durationMinutes} minutes`,
    h.date,
  ].filter(Boolean);
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.join('    '), size })],
    }),
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Name: ______________________________    Roll number: ______________',
          size,
        }),
      ],
      spacing: { before: 200, after: 200 },
    }),
  );
  if (h.instructions.trim()) {
    children.push(
      new Paragraph({
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
          bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
          left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
          right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
        },
        children: [
          new TextRun({ text: 'Instructions. ', bold: true, size }),
          new TextRun({ text: h.instructions, size }),
        ],
        spacing: { after: 240 },
      }),
    );
  }

  let currentSubject: string | null = null;
  for (const [index, vq] of version.questions.entries()) {
    const q = input.questions.get(vq.questionId);
    if (!q) throw new Error('A question snapshot is missing from the test.');
    if (input.groupBySubject && q.subject !== currentSubject) {
      currentSubject = q.subject;
      children.push(
        new Paragraph({
          children: [new TextRun({ text: q.subject, bold: true, size: size + 2 })],
          spacing: { before: 240, after: 120 },
        }),
      );
    }
    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { before: 120 },
        children: [
          new TextRun({ text: `${index + 1}.  `, bold: true, size }),
          ...(await runs(q.stem, assets, size)),
        ],
      }),
    );
    for (const [pos, optionIndex] of vq.optionOrder.entries()) {
      children.push(
        new Paragraph({
          keepNext: pos < vq.optionOrder.length - 1,
          indent: { left: 440 },
          children: [
            new TextRun({ text: `${LETTERS[pos]}.  `, bold: true, size }),
            ...(await runs(q.options[optionIndex], assets, size)),
          ],
        }),
      );
    }
  }
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400 },
      children: [new TextRun({ text: 'END OF PAPER', bold: true, size })],
    }),
  );
  if (input.answerKeyAtEnd) {
    children.push(
      new Paragraph({
        children: [
          new PageBreak(),
          new TextRun({ text: 'Answer key', bold: true, size: size + 4 }),
        ],
        spacing: { after: 120 },
      }),
      keyGrid(version, size),
    );
  }

  const footerText = [h.showTestCode && h.code ? h.code : '', letter ? `Version ${letter}` : '']
    .filter(Boolean)
    .join(' · ');
  const doc = new Document({
    creator: h.instituteName,
    title: h.title,
    styles: { default: { document: { run: { font: 'Times New Roman' } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 900, bottom: 1000, left: 850, right: 850 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: footerText, size: 16 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
                    size: 16,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** One version's answers as a grid: question numbers over the letters, ten to a row. */
function keyGrid(version: PaperVersion, size: number): Table {
  const perRow = 10;
  const cell = (value: string, bold: boolean): TableCell =>
    new TableCell({
      width: { size: 10, type: WidthType.PERCENTAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: value, bold, size })],
        }),
      ],
    });
  const rows: TableRow[] = [];
  for (let start = 0; start < version.questions.length; start += perRow) {
    const slice = version.questions.slice(start, start + perRow);
    rows.push(new TableRow({ children: slice.map((_, i) => cell(String(start + i + 1), false)) }));
    rows.push(new TableRow({ children: slice.map((q) => cell(q.correctLetter, true)) }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

/** Simple Word answer key, used only when staff ask for an editable key. */
export async function buildKeyDocx(h: PaperHeader, versions: PaperVersion[]): Promise<Uint8Array> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'CONFIDENTIAL: ANSWER KEY', bold: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `${h.instituteName} · ${h.title}`, bold: true })],
    }),
  ];
  for (const v of versions) {
    children.push(
      new Paragraph({
        spacing: { before: 240 },
        children: [
          new TextRun({
            text: versions.length > 1 ? `Version ${v.letter}` : 'Answers',
            bold: true,
          }),
        ],
      }),
    );
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: v.questions.map(
          (q, i) =>
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph(String(i + 1))] }),
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [new TextRun({ text: q.correctLetter, bold: true })],
                    }),
                  ],
                }),
              ],
            }),
        ),
      }),
    );
  }
  return new Uint8Array(await Packer.toBuffer(new Document({ sections: [{ children }] })));
}

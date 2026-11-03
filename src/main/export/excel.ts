import writeXlsxFile from 'write-excel-file/node';
import { toPlainText } from '../../core/richtext';
import type { TestDetail } from '../db/tests';

/**
 * Test record workbook (FR-12): one sheet with the test's settings and seed, one per version
 * with question IDs and answers, and one with the overlap report it passed when saved.
 */

type Cell = { value: string | number; fontWeight?: 'bold' } | null;

const bold = (value: string): Cell => ({ value, fontWeight: 'bold' });
const v = (value: string | number): Cell => ({ value });

export async function buildTestRecordXlsx(test: TestDetail): Promise<Uint8Array> {
  const request = test.settings.request;
  const snapshots = new Map(
    test.questions.map((q) => [q.questionId ?? `pos-${q.position}`, q.snapshot]),
  );
  const info: Cell[][] = [
    [bold('Field'), bold('Value')],
    [v('Title'), v(test.title)],
    [v('Test code'), v(test.code)],
    [v('Test ID'), v(test.id)],
    [v('Created'), v(test.createdAt)],
    [v('Created by'), v(test.createdBy)],
    [v('Questions'), v(test.questionCount)],
    [v('Seed'), v(test.seed)],
    [
      v('Repeat rule'),
      v(
        request
          ? `${request.rule.mode === 'each' ? 'Each earlier test' : 'All earlier tests combined'}, ${request.rule.limitPct}%, measured against ${request.rule.denominator === 'smaller' ? 'the smaller test' : 'the new test'}`
          : 'n/a',
      ),
    ],
    [
      v('Picking'),
      v(request?.strategy === 'stretch' ? 'Stretch the bank' : 'Fresh questions first'),
    ],
    [v('Highest repeat'), v(test.report ? `${test.report.highestPct}%` : 'n/a')],
    [v('New questions'), v(test.report ? test.report.freshCount : 'n/a')],
  ];
  const sheets = [{ sheet: 'Test', data: info, columns: [{ width: 18 }, { width: 70 }] }];

  for (const version of test.settings.versions ?? []) {
    const rows: Cell[][] = [
      [
        bold('No.'),
        bold('Question ID'),
        bold('Subject'),
        bold('Topic'),
        bold('Difficulty'),
        bold('Answer'),
        bold('Question'),
      ],
    ];
    version.questions.forEach((vq, i) => {
      const q = snapshots.get(vq.questionId);
      rows.push([
        v(i + 1),
        v(vq.questionId),
        v(q?.subject ?? ''),
        v(q?.topic ?? ''),
        v(q?.difficulty ?? ''),
        v(vq.correctLetter),
        v(q ? toPlainText(q.stem).slice(0, 500) : ''),
      ]);
    });
    sheets.push({
      sheet: `Version ${version.letter}`,
      data: rows,
      columns: [
        { width: 6 },
        { width: 38 },
        { width: 16 },
        { width: 18 },
        { width: 10 },
        { width: 8 },
        { width: 80 },
      ],
    });
  }

  if (test.report) {
    const rows: Cell[][] = [
      [
        bold('Earlier test'),
        bold('Date'),
        bold('Shared'),
        bold('Overlap %'),
        bold('Limit (questions)'),
        bold('Result'),
      ],
    ];
    for (const t of test.report.perTest) {
      rows.push([
        v(t.title),
        v(t.createdAt.slice(0, 10)),
        v(t.shared),
        v(t.pct),
        v(t.cap),
        v(t.passes ? 'Within limit' : 'Over limit'),
      ]);
    }
    sheets.push({
      sheet: 'Overlap',
      data: rows,
      columns: [
        { width: 36 },
        { width: 12 },
        { width: 10 },
        { width: 12 },
        { width: 18 },
        { width: 14 },
      ],
    });
  }

  const buffer = await writeXlsxFile(sheets as never).toBuffer();
  return new Uint8Array(buffer);
}

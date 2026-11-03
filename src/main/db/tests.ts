import { expandBlueprint } from '../../core/blueprint';
import { generateTest, type GenerateResult } from '../../core/generator';
import { computeOverlap, compareTwo, type OverlapReport } from '../../core/overlap';
import { buildVersions, type PaperVersion } from '../../core/shuffle';
import type { BankQuestion, TestRef } from '../../core/types';
import type { PaperHeader } from '../../shared/paper';
import type { GenerateRequest } from '../../shared/schemas';
import { audit } from './audit';
import { generatorBank, getQuestions } from './questions';
import { newId, nowIso, type ActorContext, type Workspace } from './workspace';

/**
 * Tests and history (FR-7 to FR-9, FR-13, FR-14).
 *
 * A saved test keeps its request, seed, rule, the overlap report it passed, a snapshot of every
 * question exactly as printed and the shuffled versions, so it reprints identically even after
 * questions are edited or the app is upgraded.
 */

export interface TestSettings {
  request?: GenerateRequest;
  versions?: PaperVersion[];
  /** Paper header as printed (institute details at save time), for identical reprints. */
  header?: PaperHeader;
  /** Outside tests: how each line was matched to the bank. */
  matches?: Array<{
    position: number;
    questionId: string | null;
    score: number;
    confirmed: boolean;
  }>;
}

export interface TestSummary {
  id: string;
  title: string;
  code: string;
  kind: 'generated' | 'outside';
  createdAt: string;
  createdBy: string;
  questionCount: number;
  versions: number;
  includedInRule: boolean;
  highestPct: number | null;
  exports: number;
}

export interface TestDetail extends TestSummary {
  seed: string;
  settings: TestSettings;
  report: OverlapReport | null;
  questions: Array<{ position: number; questionId: string | null; snapshot: BankQuestion }>;
  sourceFile: string;
}

interface TestRow {
  id: string;
  title: string;
  code: string;
  kind: 'generated' | 'outside';
  seed: string;
  settings: string;
  overlap_report: string;
  included_in_rule: number;
  source_file: string;
  question_count: number;
  created_at: string;
  created_by: string;
  exports?: number;
}

function summary(row: TestRow): TestSummary {
  const settings = JSON.parse(row.settings) as TestSettings;
  const report = JSON.parse(row.overlap_report) as Partial<OverlapReport>;
  return {
    id: row.id,
    title: row.title,
    code: row.code,
    kind: row.kind,
    createdAt: row.created_at,
    createdBy: row.created_by,
    questionCount: row.question_count,
    versions: settings.versions?.length ?? 0,
    includedInRule: row.included_in_rule === 1,
    highestPct: typeof report.highestPct === 'number' ? report.highestPct : null,
    exports: row.exports ?? 0,
  };
}

export function listTests(ws: Workspace): TestSummary[] {
  return (
    ws.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM test_exports e WHERE e.test_id = t.id) AS exports
         FROM tests t ORDER BY t.created_at DESC`,
      )
      .all() as unknown as TestRow[]
  ).map(summary);
}

export function getTest(ws: Workspace, id: string): TestDetail | null {
  const row = ws.db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as TestRow | undefined;
  if (!row) return null;
  const questions = (
    ws.db
      .prepare(
        'SELECT position, question_id, snapshot FROM test_questions WHERE test_id = ? ORDER BY position',
      )
      .all(id) as Array<{
      position: number;
      question_id: string | null;
      snapshot: string;
    }>
  ).map((r) => ({
    position: r.position,
    questionId: r.question_id,
    snapshot: JSON.parse(r.snapshot) as BankQuestion,
  }));
  const report = JSON.parse(row.overlap_report) as OverlapReport;
  return {
    ...summary(row),
    seed: row.seed,
    settings: JSON.parse(row.settings) as TestSettings,
    report: report && 'perTest' in report ? report : null,
    questions,
    sourceFile: row.source_file,
  };
}

/** Test refs for the repeat rule, honoring unchecked tests and the optional date range. */
export function comparedTests(
  ws: Workspace,
  scope: { excludedTestIds: string[]; from: string | null; to: string | null },
): TestRef[] {
  const excluded = new Set(scope.excludedTestIds);
  const rows = ws.db
    .prepare(
      'SELECT id, title, created_at, kind FROM tests WHERE included_in_rule = 1 ORDER BY created_at',
    )
    .all() as Array<{
    id: string;
    title: string;
    created_at: string;
    kind: 'generated' | 'outside';
  }>;
  const idsStmt = ws.db.prepare(
    'SELECT question_id FROM test_questions WHERE test_id = ? AND question_id IS NOT NULL ORDER BY position',
  );
  return rows
    .filter((r) => !excluded.has(r.id))
    .filter((r) => !scope.from || r.created_at.slice(0, 10) >= scope.from)
    .filter((r) => !scope.to || r.created_at.slice(0, 10) <= scope.to)
    .map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      kind: r.kind,
      questionIds: (idsStmt.all(r.id) as Array<{ question_id: string }>).map((x) => x.question_id),
    }));
}

export interface PreviewResult {
  result: GenerateResult;
  compared: Array<{ id: string; title: string; createdAt: string; kind: string; size: number }>;
}

/** Runs the generator without saving. The same request + seed always gives the same test. */
export function previewTest(ws: Workspace, request: GenerateRequest): PreviewResult {
  const compared = comparedTests(ws, request.scope);
  const result = generateTest({
    bank: generatorBank(ws),
    buckets: expandBlueprint(request.blueprint),
    compared,
    rule: request.rule,
    seed: request.seed,
    strategy: request.strategy,
    allowReserved: request.allowReserved,
  });
  return {
    result,
    compared: compared.map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      kind: t.kind,
      size: t.questionIds.length,
    })),
  };
}

export class RuleViolationError extends Error {
  constructor(messages: string[]) {
    super(messages.join(' '));
    this.name = 'RuleViolationError';
  }
}

/**
 * Saves a test. Generation is re-run here from the request and seed, never trusted from the UI,
 * and the overlap is re-checked inside the same transaction that writes the test.
 */
export function saveGeneratedTest(
  ws: Workspace,
  ctx: ActorContext,
  request: GenerateRequest,
  header?: PaperHeader,
): TestDetail {
  return ws.transaction(() => {
    const { result } = previewTest(ws, request);
    if (!result.ok) throw new RuleViolationError(result.messages);
    const compared = comparedTests(ws, request.scope);
    const report = computeOverlap(result.questionIds, compared, request.rule);
    if (!report.passes) throw new RuleViolationError(report.violations);

    const snapshots = getQuestions(ws, result.questionIds);
    if (snapshots.length !== result.questionIds.length)
      throw new Error('A question changed while the test was saved.');
    const versions = buildVersions(
      snapshots.map((q) => ({
        id: q.id,
        subject: q.subject,
        options: q.options,
        correct: q.correct,
        lockOptions: q.lockOptions,
      })),
      { versions: request.versions, seed: request.seed, groupBySubject: request.groupBySubject },
    );

    const id = newId();
    const now = nowIso();
    const settings: TestSettings = { request, versions, ...(header ? { header } : {}) };
    ws.db
      .prepare(
        `INSERT INTO tests (id, title, kind, code, seed, settings, overlap_report, included_in_rule, question_count, created_at, created_by)
         VALUES (?, ?, 'generated', ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        request.title,
        request.code,
        String(request.seed),
        JSON.stringify(settings),
        JSON.stringify(report),
        snapshots.length,
        now,
        ctx.actor,
      );
    const insert = ws.db.prepare(
      'INSERT INTO test_questions (test_id, position, question_id, snapshot) VALUES (?, ?, ?, ?)',
    );
    snapshots.forEach((q, position) => insert.run(id, position, q.id, JSON.stringify(q)));
    audit(ws, ctx, 'test.generated', 'test', id, {
      title: request.title,
      questions: snapshots.length,
      versions: request.versions,
      seed: request.seed,
      highestPct: report.highestPct,
      rule: request.rule,
    });
    return getTest(ws, id)!;
  });
}

export function setIncludedInRule(
  ws: Workspace,
  ctx: ActorContext,
  id: string,
  included: boolean,
): void {
  ws.db.prepare('UPDATE tests SET included_in_rule = ? WHERE id = ?').run(included ? 1 : 0, id);
  audit(ws, ctx, 'test.comparison-changed', 'test', id, { included });
}

export interface OutsideTestInput {
  title: string;
  sourceFile: string;
  createdAt: string | null;
  items: Array<{
    snapshot: BankQuestion;
    questionId: string | null;
    score: number;
    confirmed: boolean;
  }>;
}

/** An outside test participates in the repeat rule through its matched bank questions. */
export function saveOutsideTest(
  ws: Workspace,
  ctx: ActorContext,
  input: OutsideTestInput,
): TestDetail {
  return ws.transaction(() => {
    const id = newId();
    const createdAt = input.createdAt ? new Date(input.createdAt).toISOString() : nowIso();
    const settings: TestSettings = {
      matches: input.items.map((item, position) => ({
        position,
        questionId: item.questionId,
        score: item.score,
        confirmed: item.confirmed,
      })),
    };
    ws.db
      .prepare(
        `INSERT INTO tests (id, title, kind, settings, included_in_rule, source_file, question_count, created_at, created_by)
         VALUES (?, ?, 'outside', ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        JSON.stringify(settings),
        input.sourceFile,
        input.items.length,
        createdAt,
        ctx.actor,
      );
    const insert = ws.db.prepare(
      'INSERT INTO test_questions (test_id, position, question_id, snapshot) VALUES (?, ?, ?, ?)',
    );
    input.items.forEach((item, position) =>
      insert.run(
        id,
        position,
        item.confirmed ? item.questionId : null,
        JSON.stringify(item.snapshot),
      ),
    );
    audit(ws, ctx, 'test.outside-imported', 'test', id, {
      title: input.title,
      questions: input.items.length,
      matched: input.items.filter((i) => i.confirmed && i.questionId).length,
    });
    return getTest(ws, id)!;
  });
}

export function compareTests(ws: Workspace, aId: string, bId: string) {
  const [a, b] = [getTest(ws, aId), getTest(ws, bId)];
  if (!a || !b) throw new Error('One of the tests was not found.');
  const ref = (t: TestDetail): TestRef => ({
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    kind: t.kind,
    questionIds: t.questions.flatMap((q) => (q.questionId ? [q.questionId] : [])),
  });
  const result = compareTwo(ref(a), ref(b));
  const byId = new Map(a.questions.map((q) => [q.questionId, q.snapshot]));
  return {
    a: { id: a.id, title: a.title, size: a.questionCount },
    b: { id: b.id, title: b.title, size: b.questionCount },
    pctOfA: result.pctOfA,
    pctOfB: result.pctOfB,
    shared: result.shared.map((qid) => ({ questionId: qid, snapshot: byId.get(qid)! })),
  };
}

export function recordExport(
  ws: Workspace,
  ctx: ActorContext,
  testId: string,
  file: {
    kind: string;
    versionLetter: string;
    fileName: string;
    sha256: string;
    bytes: Uint8Array;
  },
): void {
  ws.db
    .prepare(
      'INSERT INTO test_exports (test_id, kind, version_letter, file_name, sha256, bytes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      testId,
      file.kind,
      file.versionLetter,
      file.fileName,
      file.sha256,
      file.bytes,
      nowIso(),
      ctx.actor,
    );
  audit(ws, ctx, 'test.exported', 'test', testId, {
    kind: file.kind,
    version: file.versionLetter,
    sha256: file.sha256,
  });
}

export interface ExportRecord {
  id: number;
  kind: string;
  versionLetter: string;
  fileName: string;
  sha256: string;
  createdAt: string;
  createdBy: string;
}

export function listExports(ws: Workspace, testId: string): ExportRecord[] {
  return (
    ws.db
      .prepare(
        'SELECT id, kind, version_letter AS versionLetter, file_name AS fileName, sha256, created_at AS createdAt, created_by AS createdBy FROM test_exports WHERE test_id = ? ORDER BY id DESC',
      )
      .all(testId) as unknown as ExportRecord[]
  ).map((r) => ({ ...r }));
}

export function getExportBytes(
  ws: Workspace,
  exportId: number,
): { fileName: string; bytes: Uint8Array } | null {
  const row = ws.db
    .prepare('SELECT file_name, bytes FROM test_exports WHERE id = ?')
    .get(exportId) as { file_name: string; bytes: Uint8Array } | undefined;
  return row ? { fileName: row.file_name, bytes: row.bytes } : null;
}

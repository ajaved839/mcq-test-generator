import { fingerprint, normalizeText } from '../../core/duplicates';
import { stripReviewMarks, toPlainText, type RichText } from '../../core/richtext';
import type { BankQuestion, Difficulty, GeneratorQuestion } from '../../core/types';
import type { BankFilter, QuestionInput } from '../../shared/schemas';
import { audit } from './audit';
import { newId, nowIso, type ActorContext, type Workspace } from './workspace';

/**
 * Question bank (FR-6). Edits keep version history; questions used in tests can only be
 * archived, never deleted, and a corrected answer lists the issued tests that used it.
 */

interface QuestionRow {
  id: string;
  stem: string;
  options: string;
  correct: number;
  explanation: string;
  lock_options: number;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  tags: string;
  source: string;
  reserved: number;
  status: 'active' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

export function rowToQuestion(row: QuestionRow): BankQuestion {
  return {
    id: row.id,
    stem: JSON.parse(row.stem) as RichText,
    options: JSON.parse(row.options) as RichText[],
    correct: row.correct,
    explanation: JSON.parse(row.explanation) as RichText,
    lockOptions: row.lock_options === 1,
    subject: row.subject,
    topic: row.topic,
    difficulty: row.difficulty,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    reserved: row.reserved === 1,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function searchText(q: {
  stem: RichText;
  options: RichText[];
  explanation: RichText;
  tags: string[];
  topic: string;
  source: string;
}): string {
  return normalizeText(
    [
      toPlainText(q.stem),
      ...q.options.map(toPlainText),
      toPlainText(q.explanation),
      q.topic,
      q.source,
      ...q.tags,
    ].join(' '),
  );
}

function cleanInput(input: QuestionInput): QuestionInput {
  return {
    ...input,
    stem: stripReviewMarks(input.stem),
    options: input.options.map(stripReviewMarks),
    explanation: stripReviewMarks(input.explanation),
    tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))],
  };
}

function snapshotOf(q: BankQuestion): string {
  return JSON.stringify(q);
}

export function getQuestion(ws: Workspace, id: string): BankQuestion | null {
  const row = ws.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
    QuestionRow | undefined;
  return row ? rowToQuestion(row) : null;
}

export function getQuestions(ws: Workspace, ids: readonly string[]): BankQuestion[] {
  const out: BankQuestion[] = [];
  const stmt = ws.db.prepare('SELECT * FROM questions WHERE id = ?');
  for (const id of ids) {
    const row = stmt.get(id) as QuestionRow | undefined;
    if (row) out.push(rowToQuestion(row));
  }
  return out;
}

export function findByFingerprint(ws: Workspace, fp: string): string[] {
  return (
    ws.db.prepare('SELECT id FROM questions WHERE fingerprint = ?').all(fp) as Array<{ id: string }>
  ).map((r) => r.id);
}

export function createQuestion(
  ws: Workspace,
  ctx: ActorContext,
  raw: QuestionInput,
  note = 'Created',
): BankQuestion {
  const input = cleanInput(raw);
  const id = input.id ?? newId();
  const now = nowIso();
  return ws.transaction(() => {
    ws.db
      .prepare(
        `INSERT INTO questions (id, stem, options, correct, explanation, lock_options, subject, topic, difficulty,
          tags, source, reserved, status, version, fingerprint, search_text, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(input.stem),
        JSON.stringify(input.options),
        input.correct,
        JSON.stringify(input.explanation),
        input.lockOptions ? 1 : 0,
        input.subject,
        input.topic,
        input.difficulty,
        JSON.stringify(input.tags),
        input.source,
        input.reserved ? 1 : 0,
        fingerprint(input),
        searchText(input),
        now,
        now,
        ctx.actor,
        ctx.actor,
      );
    const created = getQuestion(ws, id)!;
    ws.db
      .prepare(
        'INSERT INTO question_versions (question_id, version, snapshot, changed_at, changed_by, note) VALUES (?, 1, ?, ?, ?, ?)',
      )
      .run(id, snapshotOf(created), now, ctx.actor, note);
    audit(ws, ctx, 'question.created', 'question', id, { subject: input.subject });
    return created;
  });
}

export interface IssuedTest {
  testId: string;
  title: string;
  createdAt: string;
  kind: string;
}

/** Tests (generated or outside) that contain the question. */
export function testsUsingQuestion(ws: Workspace, questionId: string): IssuedTest[] {
  return (
    ws.db
      .prepare(
        `SELECT DISTINCT t.id AS testId, t.title, t.created_at AS createdAt, t.kind
         FROM test_questions tq JOIN tests t ON t.id = tq.test_id
         WHERE tq.question_id = ? ORDER BY t.created_at DESC`,
      )
      .all(questionId) as unknown as IssuedTest[]
  ).map((r) => ({ ...r }));
}

export class VersionConflictError extends Error {
  constructor() {
    super('Someone saved this question since you opened it. Reload it and make your change again.');
    this.name = 'VersionConflictError';
  }
}

export interface UpdateResult {
  question: BankQuestion;
  /** Issued tests that printed the old answer, listed when the correct answer changed. */
  answerChangedIn: IssuedTest[];
}

export function updateQuestion(
  ws: Workspace,
  ctx: ActorContext,
  id: string,
  raw: QuestionInput,
): UpdateResult {
  const input = cleanInput(raw);
  return ws.transaction(() => {
    const before = getQuestion(ws, id);
    if (!before) throw new Error('That question no longer exists.');
    if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
      throw new VersionConflictError();
    }
    const version = before.version + 1;
    const now = nowIso();
    ws.db
      .prepare(
        `UPDATE questions SET stem = ?, options = ?, correct = ?, explanation = ?, lock_options = ?, subject = ?,
          topic = ?, difficulty = ?, tags = ?, source = ?, reserved = ?, version = ?, fingerprint = ?,
          search_text = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(input.stem),
        JSON.stringify(input.options),
        input.correct,
        JSON.stringify(input.explanation),
        input.lockOptions ? 1 : 0,
        input.subject,
        input.topic,
        input.difficulty,
        JSON.stringify(input.tags),
        input.source,
        input.reserved ? 1 : 0,
        version,
        fingerprint(input),
        searchText(input),
        now,
        ctx.actor,
        id,
      );
    const after = getQuestion(ws, id)!;
    ws.db
      .prepare(
        'INSERT INTO question_versions (question_id, version, snapshot, changed_at, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, version, snapshotOf(after), now, ctx.actor, input.note ?? 'Edited');
    const correctChanged =
      toPlainText(before.options[before.correct] ?? []) !==
        toPlainText(after.options[after.correct] ?? []) ||
      before.options.length !== after.options.length;
    const answerChangedIn = correctChanged ? testsUsingQuestion(ws, id) : [];
    audit(ws, ctx, 'question.edited', 'question', id, {
      version,
      answerChanged: correctChanged,
      issuedTestsAffected: answerChangedIn.map((t) => t.testId),
    });
    return { question: after, answerChangedIn };
  });
}

export interface VersionEntry {
  version: number;
  changedAt: string;
  changedBy: string;
  note: string;
  snapshot: BankQuestion;
}

export function questionHistory(ws: Workspace, id: string): VersionEntry[] {
  return (
    ws.db
      .prepare('SELECT * FROM question_versions WHERE question_id = ? ORDER BY version DESC')
      .all(id) as Array<{
      version: number;
      changed_at: string;
      changed_by: string;
      note: string;
      snapshot: string;
    }>
  ).map((r) => ({
    version: r.version,
    changedAt: r.changed_at,
    changedBy: r.changed_by,
    note: r.note,
    snapshot: JSON.parse(r.snapshot) as BankQuestion,
  }));
}

/** Undo for edits: saves an older version's content as a new version. */
export function revertQuestion(
  ws: Workspace,
  ctx: ActorContext,
  id: string,
  toVersion: number,
): UpdateResult {
  const entry = questionHistory(ws, id).find((v) => v.version === toVersion);
  if (!entry) throw new Error('That version was not found.');
  const s = entry.snapshot;
  const result = updateQuestion(ws, ctx, id, {
    stem: s.stem,
    options: s.options,
    correct: s.correct,
    explanation: s.explanation,
    lockOptions: s.lockOptions,
    subject: s.subject,
    topic: s.topic,
    difficulty: s.difficulty,
    tags: s.tags,
    source: s.source,
    reserved: s.reserved,
    note: `Reverted to version ${toVersion}`,
  });
  audit(ws, ctx, 'question.reverted', 'question', id, { toVersion });
  return result;
}

export function setStatus(
  ws: Workspace,
  ctx: ActorContext,
  ids: readonly string[],
  status: 'active' | 'archived',
): number {
  return ws.transaction(() => {
    const stmt = ws.db.prepare(
      'UPDATE questions SET status = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status != ?',
    );
    let changed = 0;
    const now = nowIso();
    for (const id of ids) changed += Number(stmt.run(status, now, ctx.actor, id, status).changes);
    audit(
      ws,
      ctx,
      status === 'archived' ? 'question.archived' : 'question.restored',
      'question',
      ids.join(',').slice(0, 2000),
      {
        count: changed,
      },
    );
    return changed;
  });
}

/**
 * Hard delete is allowed only for questions that never appeared in any test; the rest must be
 * archived so history and reprints stay intact. Returns the IDs that were refused.
 */
export function deleteUnused(
  ws: Workspace,
  ctx: ActorContext,
  ids: readonly string[],
): { deleted: number; refused: string[] } {
  return ws.transaction(() => {
    const refused: string[] = [];
    let deleted = 0;
    for (const id of ids) {
      if (testsUsingQuestion(ws, id).length) {
        refused.push(id);
        continue;
      }
      ws.db.prepare('UPDATE review_items SET question_id = NULL WHERE question_id = ?').run(id);
      ws.db.prepare('DELETE FROM question_versions WHERE question_id = ?').run(id);
      deleted += Number(ws.db.prepare('DELETE FROM questions WHERE id = ?').run(id).changes);
    }
    audit(ws, ctx, 'question.deleted', 'question', '', { deleted, refused: refused.length });
    return { deleted, refused };
  });
}

export function bulkTag(
  ws: Workspace,
  ctx: ActorContext,
  ids: readonly string[],
  add: string[],
  remove: string[],
): number {
  return ws.transaction(() => {
    let changed = 0;
    for (const q of getQuestions(ws, ids)) {
      const tags = new Set(q.tags);
      add.forEach((t) => tags.add(t));
      remove.forEach((t) => tags.delete(t));
      const next = [...tags];
      if (next.join('\u0000') === q.tags.join('\u0000')) continue;
      updateQuestion(ws, ctx, q.id, { ...q, tags: next, note: 'Tags changed' });
      changed += 1;
    }
    return changed;
  });
}

export interface BankListItem {
  id: string;
  stemText: string;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  tags: string[];
  status: 'active' | 'archived';
  reserved: boolean;
  usedIn: number;
  hasImage: boolean;
  hasMath: boolean;
  updatedAt: string;
  version: number;
}

export function listQuestions(
  ws: Workspace,
  filter: BankFilter,
): { total: number; items: BankListItem[] } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status !== 'all') {
    where.push('q.status = ?');
    params.push(filter.status);
  }
  if (filter.search.trim()) {
    for (const word of normalizeText(filter.search).split(' ').filter(Boolean)) {
      where.push("q.search_text LIKE ? ESCAPE '\\'");
      params.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
  }
  const inList = (column: string, values: string[]): void => {
    if (!values.length) return;
    where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  };
  inList('q.subject', filter.subjects);
  inList('q.topic', filter.topics);
  inList('q.difficulty', filter.difficulties);
  if (filter.reserved === 'only') where.push('q.reserved = 1');
  if (filter.reserved === 'exclude') where.push('q.reserved = 0');
  if (filter.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(q.tags) WHERE json_each.value = ?)');
    params.push(filter.tag);
  }
  const usedExpr =
    '(SELECT COUNT(DISTINCT tq.test_id) FROM test_questions tq WHERE tq.question_id = q.id)';
  if (filter.usage === 'never') where.push(`${usedExpr} = 0`);
  if (filter.usage === 'used') where.push(`${usedExpr} > 0`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    ws.db.prepare(`SELECT COUNT(*) AS n FROM questions q ${clause}`).get(...params) as { n: number }
  ).n;
  const rows = ws.db
    .prepare(
      `SELECT q.*, ${usedExpr} AS used_in FROM questions q ${clause}
       ORDER BY q.updated_at DESC, q.id LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as unknown as Array<
    QuestionRow & { used_in: number }
  >;
  return {
    total,
    items: rows.map((row) => {
      const q = rowToQuestion(row);
      const all = [q.stem, ...q.options];
      return {
        id: q.id,
        stemText: toPlainText(q.stem).slice(0, 300),
        subject: q.subject,
        topic: q.topic,
        difficulty: q.difficulty,
        tags: q.tags,
        status: q.status,
        reserved: q.reserved,
        usedIn: row.used_in,
        hasImage: all.some((r) => r.some((i) => i.t === 'img')),
        hasMath: all.some((r) => r.some((i) => i.t === 'math')),
        updatedAt: q.updatedAt,
        version: q.version,
      };
    }),
  };
}

export interface Facets {
  subjects: Array<{ subject: string; count: number }>;
  topics: Array<{ subject: string; topic: string; count: number }>;
  tags: string[];
}

export function bankFacets(ws: Workspace): Facets {
  const subjects = ws.db
    .prepare(
      "SELECT subject, COUNT(*) AS count FROM questions WHERE status = 'active' GROUP BY subject ORDER BY subject",
    )
    .all() as Array<{ subject: string; count: number }>;
  const topics = ws.db
    .prepare(
      "SELECT subject, topic, COUNT(*) AS count FROM questions WHERE status = 'active' AND topic != '' GROUP BY subject, topic ORDER BY subject, topic",
    )
    .all() as Array<{ subject: string; topic: string; count: number }>;
  const tags = (
    ws.db
      .prepare(
        'SELECT DISTINCT json_each.value AS tag FROM questions, json_each(questions.tags) ORDER BY tag',
      )
      .all() as Array<{
      tag: string;
    }>
  ).map((r) => r.tag);
  return { subjects: subjects.map((r) => ({ ...r })), topics: topics.map((r) => ({ ...r })), tags };
}

/** Minimal rows for the generator; fast enough for a 10,000-question bank. */
export function generatorBank(ws: Workspace): GeneratorQuestion[] {
  return (
    ws.db
      .prepare('SELECT id, subject, topic, difficulty, reserved, status FROM questions')
      .all() as Array<{
      id: string;
      subject: string;
      topic: string;
      difficulty: Difficulty;
      reserved: number;
      status: 'active' | 'archived';
    }>
  ).map((r) => ({ ...r, reserved: r.reserved === 1 }));
}

/** All questions for duplicate indexing, as stem + options only. */
export function allComparable(
  ws: Workspace,
): Array<{ id: string; stem: RichText; options: RichText[] }> {
  return (
    ws.db.prepare('SELECT id, stem, options FROM questions').all() as Array<{
      id: string;
      stem: string;
      options: string;
    }>
  ).map((r) => ({
    id: r.id,
    stem: JSON.parse(r.stem) as RichText,
    options: JSON.parse(r.options) as RichText[],
  }));
}

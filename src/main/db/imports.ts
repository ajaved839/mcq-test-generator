import { DuplicateIndex, fingerprint } from '../../core/duplicates';
import type { UnplacedBlock } from '../../core/mcq-parser';
import { isEmptyRich, type RichText } from '../../core/richtext';
import type { Difficulty } from '../../core/types';
import { audit } from './audit';
import {
  allComparable,
  createQuestion,
  deleteUnused,
  findByFingerprint,
  getQuestion,
  setStatus,
  updateQuestion,
} from './questions';
import { newId, nowIso, type ActorContext, type Workspace } from './workspace';

/**
 * Import batches and the review queue (FR-4, FR-5). Every import path stages candidates here;
 * nothing enters the bank until staff approve it with a correct answer marked.
 */

export type SourceType = 'excel' | 'csv' | 'docx' | 'ocr' | 'manual' | 'merge';

export interface ReviewCandidate {
  stem: RichText;
  options: RichText[];
  correct: number | null;
  explanation: RichText;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  tags: string[];
  source: string;
  lockOptions: boolean;
  reserved: boolean;
  /** Parser or validation notes shown beside the item. */
  warnings: string[];
  refs: string[];
  pages: number[];
  number: number | null;
}

export interface DuplicateHit {
  /** Bank question ID, or a review item ID for duplicates inside the same batch. */
  id: string;
  scope: 'bank' | 'batch';
  score: number;
  exact: boolean;
}

export type DuplicateDecision = 'keep' | null;

export interface ReviewItem {
  id: string;
  batchId: string;
  position: number;
  status: 'pending' | 'approved' | 'rejected' | 'merged' | 'skipped';
  kind: 'mcq' | 'unplaced';
  candidate: ReviewCandidate | null;
  unplaced: UnplacedBlock | null;
  duplicates: DuplicateHit[];
  duplicateDecision: DuplicateDecision;
  rejectReason: string;
  questionId: string | null;
  pageImage: string | null;
  issues: string[];
}

export interface BatchSummary {
  id: string;
  sourceType: SourceType;
  fileName: string;
  createdAt: string;
  createdBy: string;
  status: 'open' | 'closed';
  counts: Record<ReviewItem['status'], number>;
  total: number;
}

/** Problems that block approval. Warnings from the parser are advisory; these are not. */
export function blockingIssues(c: ReviewCandidate, subjects: readonly string[]): string[] {
  const issues: string[] = [];
  if (isEmptyRich(c.stem)) issues.push('Add the question text.');
  if (c.options.length < 2) issues.push('Add at least 2 options.');
  if (c.options.length > 5) issues.push('Use at most 5 options.');
  c.options.forEach((o, i) => {
    if (isEmptyRich(o)) issues.push(`Option ${'ABCDE'[i]} is empty.`);
  });
  if (c.correct === null || c.correct < 0 || c.correct >= c.options.length)
    issues.push('Mark the correct answer.');
  if (!c.subject.trim()) issues.push('Choose a subject.');
  else if (subjects.length && !subjects.some((s) => s.toLowerCase() === c.subject.toLowerCase())) {
    issues.push(`"${c.subject}" is not in the subject list in Settings.`);
  }
  return issues;
}

interface ItemRow {
  id: string;
  batch_id: string;
  position: number;
  status: ReviewItem['status'];
  kind: 'mcq' | 'unplaced';
  data: string;
  duplicates: string;
  reject_reason: string;
  question_id: string | null;
  page_image: string | null;
}

function rowToItem(row: ItemRow, subjects: readonly string[]): ReviewItem {
  const data = JSON.parse(row.data) as {
    candidate?: ReviewCandidate;
    unplaced?: UnplacedBlock;
    duplicateDecision?: DuplicateDecision;
  };
  const dup = JSON.parse(row.duplicates) as DuplicateHit[];
  const candidate = row.kind === 'mcq' ? (data.candidate ?? null) : null;
  return {
    id: row.id,
    batchId: row.batch_id,
    position: row.position,
    status: row.status,
    kind: row.kind,
    candidate,
    unplaced: row.kind === 'unplaced' ? (data.unplaced ?? null) : null,
    duplicates: dup,
    duplicateDecision: data.duplicateDecision ?? null,
    rejectReason: row.reject_reason,
    questionId: row.question_id,
    pageImage: row.page_image,
    issues: candidate
      ? blockingIssues(candidate, subjects)
      : ['Turn this text into a question or discard it.'],
  };
}

function bankIndex(ws: Workspace): DuplicateIndex {
  const index = new DuplicateIndex();
  for (const q of allComparable(ws)) index.add(q.id, q);
  return index;
}

export interface StageInput {
  sourceType: SourceType;
  fileName: string;
  settings: Record<string, unknown>;
  candidates: Array<{ candidate: ReviewCandidate; pageImage?: string | null }>;
  unplaced: Array<{ block: UnplacedBlock; pageImage?: string | null }>;
}

export function stageBatch(
  ws: Workspace,
  ctx: ActorContext,
  input: StageInput,
  thresholdPct: number,
): BatchSummary {
  const threshold = thresholdPct / 100;
  const index = bankIndex(ws);
  const batchIndex = new DuplicateIndex();
  return ws.transaction(() => {
    const batchId = newId();
    const now = nowIso();
    ws.db
      .prepare(
        'INSERT INTO import_batches (id, source_type, file_name, settings, total, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        batchId,
        input.sourceType,
        input.fileName,
        JSON.stringify(input.settings),
        input.candidates.length + input.unplaced.length,
        'open',
        now,
        ctx.actor,
      );
    const insert = ws.db.prepare(
      'INSERT INTO review_items (id, batch_id, position, status, kind, data, duplicates, page_image, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let position = 0;
    for (const { candidate, pageImage } of input.candidates) {
      const itemId = newId();
      const hits: DuplicateHit[] = [
        ...index
          .findSimilar(candidate, threshold)
          .map((m) => ({ id: m.id, scope: 'bank' as const, score: m.score, exact: m.exact })),
        ...batchIndex
          .findSimilar(candidate, threshold)
          .map((m) => ({ id: m.id, scope: 'batch' as const, score: m.score, exact: m.exact })),
      ];
      batchIndex.add(itemId, candidate);
      insert.run(
        itemId,
        batchId,
        position++,
        'pending',
        'mcq',
        JSON.stringify({ candidate }),
        JSON.stringify(hits),
        pageImage ?? null,
        now,
      );
    }
    for (const { block, pageImage } of input.unplaced) {
      insert.run(
        newId(),
        batchId,
        position++,
        'pending',
        'unplaced',
        JSON.stringify({ unplaced: block }),
        '[]',
        pageImage ?? null,
        now,
      );
    }
    audit(ws, ctx, 'import.staged', 'batch', batchId, {
      sourceType: input.sourceType,
      fileName: input.fileName,
      candidates: input.candidates.length,
      unplaced: input.unplaced.length,
    });
    return getBatch(ws, batchId)!;
  });
}

export function getBatch(ws: Workspace, id: string): BatchSummary | null {
  return listBatches(ws).find((b) => b.id === id) ?? null;
}

export function listBatches(ws: Workspace): BatchSummary[] {
  const rows = ws.db
    .prepare('SELECT * FROM import_batches ORDER BY created_at DESC')
    .all() as Array<{
    id: string;
    source_type: SourceType;
    file_name: string;
    created_at: string;
    created_by: string;
    status: 'open' | 'closed';
    total: number;
  }>;
  const countStmt = ws.db.prepare(
    'SELECT status, COUNT(*) AS n FROM review_items WHERE batch_id = ? GROUP BY status',
  );
  return rows.map((r) => {
    const counts = { pending: 0, approved: 0, rejected: 0, merged: 0, skipped: 0 };
    for (const c of countStmt.all(r.id) as Array<{ status: keyof typeof counts; n: number }>)
      counts[c.status] = c.n;
    return {
      id: r.id,
      sourceType: r.source_type,
      fileName: r.file_name,
      createdAt: r.created_at,
      createdBy: r.created_by,
      status: r.status,
      counts,
      total: r.total,
    };
  });
}

export function listItems(
  ws: Workspace,
  batchId: string,
  subjects: readonly string[],
  status?: ReviewItem['status'],
): ReviewItem[] {
  const rows = (status
    ? ws.db
        .prepare('SELECT * FROM review_items WHERE batch_id = ? AND status = ? ORDER BY position')
        .all(batchId, status)
    : ws.db
        .prepare('SELECT * FROM review_items WHERE batch_id = ? ORDER BY position')
        .all(batchId)) as unknown as ItemRow[];
  return rows.map((r) => rowToItem(r, subjects));
}

export function getItem(
  ws: Workspace,
  itemId: string,
  subjects: readonly string[],
): ReviewItem | null {
  const row = ws.db.prepare('SELECT * FROM review_items WHERE id = ?').get(itemId) as
    ItemRow | undefined;
  return row ? rowToItem(row, subjects) : null;
}

function writeItem(ws: Workspace, item: ReviewItem): void {
  const data =
    item.kind === 'mcq'
      ? { candidate: item.candidate, duplicateDecision: item.duplicateDecision }
      : { unplaced: item.unplaced };
  ws.db
    .prepare(
      'UPDATE review_items SET status = ?, kind = ?, data = ?, duplicates = ?, reject_reason = ?, question_id = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      item.status,
      item.kind,
      JSON.stringify(data),
      JSON.stringify(item.duplicates),
      item.rejectReason,
      item.questionId,
      nowIso(),
      item.id,
    );
}

function closeIfDone(ws: Workspace, batchId: string): void {
  const pending = ws.db
    .prepare("SELECT COUNT(*) AS n FROM review_items WHERE batch_id = ? AND status = 'pending'")
    .get(batchId) as { n: number };
  ws.db
    .prepare('UPDATE import_batches SET status = ? WHERE id = ?')
    .run(pending.n ? 'open' : 'closed', batchId);
}

/** Saves staff edits to a pending item and refreshes its bank duplicate check. */
export function updateItem(
  ws: Workspace,
  itemId: string,
  candidate: ReviewCandidate,
  subjects: readonly string[],
  thresholdPct: number,
  duplicateDecision: DuplicateDecision = null,
): ReviewItem {
  const item = getItem(ws, itemId, subjects);
  if (!item) throw new Error('That review item no longer exists.');
  if (item.status !== 'pending') throw new Error('Only items waiting for review can be edited.');
  const index = bankIndex(ws);
  const bankHits = index
    .findSimilar(candidate, thresholdPct / 100)
    .map((m) => ({ id: m.id, scope: 'bank' as const, score: m.score, exact: m.exact }));
  const next: ReviewItem = {
    ...item,
    kind: 'mcq',
    candidate,
    unplaced: null,
    duplicates: [...bankHits, ...item.duplicates.filter((d) => d.scope === 'batch')],
    duplicateDecision,
  };
  writeItem(ws, next);
  return getItem(ws, itemId, subjects)!;
}

export interface ApproveOutcome {
  approved: string[];
  refused: Array<{ itemId: string; reason: string }>;
}

/**
 * Approves items into the bank. Exact duplicates are always refused; near duplicates need an
 * explicit "keep both" decision. `onlyClean` is the bulk path for clean Excel imports.
 */
export function approveItems(
  ws: Workspace,
  ctx: ActorContext,
  itemIds: readonly string[],
  subjects: readonly string[],
  options: { onlyClean?: boolean } = {},
): ApproveOutcome {
  return ws.transaction(() => {
    const outcome: ApproveOutcome = { approved: [], refused: [] };
    for (const itemId of itemIds) {
      const item = getItem(ws, itemId, subjects);
      if (!item || item.status !== 'pending' || !item.candidate) {
        outcome.refused.push({ itemId, reason: 'Not waiting for review.' });
        continue;
      }
      const c = item.candidate;
      if (item.issues.length) {
        outcome.refused.push({ itemId, reason: item.issues.join(' ') });
        continue;
      }
      if (findByFingerprint(ws, fingerprint(c)).length) {
        outcome.refused.push({
          itemId,
          reason: 'An identical question is already in the bank. Skip it or merge it.',
        });
        continue;
      }
      const near = item.duplicates.filter((d) => !d.exact || d.scope === 'batch');
      if (near.length && item.duplicateDecision !== 'keep') {
        outcome.refused.push({
          itemId,
          reason: 'A similar question exists. Compare them, then keep both, merge or skip.',
        });
        continue;
      }
      if (options.onlyClean && c.warnings.length) {
        outcome.refused.push({ itemId, reason: 'Has warnings; review it individually.' });
        continue;
      }
      const subject =
        subjects.find((s) => s.toLowerCase() === c.subject.toLowerCase()) ?? c.subject;
      const question = createQuestion(
        ws,
        ctx,
        {
          stem: c.stem,
          options: c.options,
          correct: c.correct!,
          explanation: c.explanation,
          lockOptions: c.lockOptions,
          subject,
          topic: c.topic,
          difficulty: c.difficulty,
          tags: c.tags,
          source: c.source,
          reserved: c.reserved,
        },
        'Approved from import',
      );
      writeItem(ws, { ...item, status: 'approved', questionId: question.id });
      outcome.approved.push(itemId);
    }
    const batchIds = new Set(
      itemIds.map((id) => getItem(ws, id, subjects)?.batchId).filter(Boolean) as string[],
    );
    batchIds.forEach((b) => closeIfDone(ws, b));
    if (outcome.approved.length)
      audit(ws, ctx, 'review.approved', 'batch', [...batchIds].join(','), {
        count: outcome.approved.length,
      });
    return outcome;
  });
}

export function rejectItems(
  ws: Workspace,
  ctx: ActorContext,
  itemIds: readonly string[],
  reason: string,
  subjects: readonly string[],
  status: 'rejected' | 'skipped' = 'rejected',
): number {
  return ws.transaction(() => {
    let count = 0;
    const batches = new Set<string>();
    for (const itemId of itemIds) {
      const item = getItem(ws, itemId, subjects);
      if (!item || item.status !== 'pending') continue;
      writeItem(ws, { ...item, status, rejectReason: reason });
      batches.add(item.batchId);
      count += 1;
    }
    batches.forEach((b) => closeIfDone(ws, b));
    audit(
      ws,
      ctx,
      status === 'skipped' ? 'review.skipped' : 'review.rejected',
      'batch',
      [...batches].join(','),
      { count, reason },
    );
    return count;
  });
}

/** Merge: keep the existing bank question, adding the import's tags and source to it. */
export function mergeItem(
  ws: Workspace,
  ctx: ActorContext,
  itemId: string,
  questionId: string,
  subjects: readonly string[],
): void {
  ws.transaction(() => {
    const item = getItem(ws, itemId, subjects);
    const target = getQuestion(ws, questionId);
    if (!item?.candidate || item.status !== 'pending' || !target)
      throw new Error('Nothing to merge.');
    const tags = [...new Set([...target.tags, ...item.candidate.tags])];
    const sources = [...new Set([target.source, item.candidate.source].filter(Boolean))]
      .join('; ')
      .slice(0, 200);
    updateQuestion(ws, ctx, questionId, {
      ...target,
      tags,
      source: sources,
      note: 'Merged a duplicate import',
    });
    writeItem(ws, { ...item, status: 'merged', questionId });
    closeIfDone(ws, item.batchId);
    audit(ws, ctx, 'review.merged', 'question', questionId, { itemId });
  });
}

/** Turns a flagged text block into an MCQ draft so staff can complete it. */
export function convertUnplaced(
  ws: Workspace,
  itemId: string,
  subjects: readonly string[],
  defaults: Pick<ReviewCandidate, 'subject' | 'difficulty' | 'source'>,
): ReviewItem {
  const item = getItem(ws, itemId, subjects);
  if (!item?.unplaced || item.status !== 'pending')
    throw new Error('Only flagged text can be converted.');
  const candidate: ReviewCandidate = {
    stem: item.unplaced.content,
    options: [[], []],
    correct: null,
    explanation: [],
    subject: defaults.subject,
    topic: '',
    difficulty: defaults.difficulty,
    tags: [],
    source: defaults.source,
    lockOptions: false,
    reserved: false,
    warnings: [`Converted from flagged text: ${item.unplaced.reason}.`],
    refs: item.unplaced.refs,
    pages: [],
    number: null,
  };
  writeItem(ws, { ...item, kind: 'mcq', candidate, unplaced: null });
  return getItem(ws, itemId, subjects)!;
}

export interface DeleteBatchOutcome {
  /** Bank questions removed because they were approved from this import and never used. */
  deleted: number;
  /** Bank questions archived instead because an issued test used them. */
  archived: number;
}

/**
 * Deletes an import and its review queue. Questions it added to the bank stay unless
 * `removeQuestions` is set; then unused ones are deleted and ones used in a test are archived,
 * so test history and reprints stay intact. Merged items point at older bank questions and are
 * never touched.
 */
export function deleteBatch(
  ws: Workspace,
  ctx: ActorContext,
  batchId: string,
  options: { removeQuestions: boolean },
): DeleteBatchOutcome {
  return ws.transaction(() => {
    const batch = getBatch(ws, batchId);
    if (!batch) throw new Error('That import was not found.');
    const added = (
      ws.db
        .prepare(
          "SELECT question_id FROM review_items WHERE batch_id = ? AND status = 'approved' AND question_id IS NOT NULL",
        )
        .all(batchId) as Array<{ question_id: string }>
    ).map((r) => r.question_id);
    const outcome: DeleteBatchOutcome = { deleted: 0, archived: 0 };
    if (options.removeQuestions && added.length) {
      const { deleted, refused } = deleteUnused(ws, ctx, added);
      outcome.deleted = deleted;
      outcome.archived = refused.length ? setStatus(ws, ctx, refused, 'archived') : 0;
    }
    ws.db.prepare('DELETE FROM review_items WHERE batch_id = ?').run(batchId);
    ws.db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId);
    audit(ws, ctx, 'import.deleted', 'batch', batchId, {
      fileName: batch.fileName,
      removeQuestions: options.removeQuestions,
      ...outcome,
    });
    return outcome;
  });
}

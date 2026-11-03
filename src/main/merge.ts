import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { fingerprint } from '../core/duplicates';
import { toPlainText } from '../core/richtext';
import type { BankQuestion } from '../core/types';
import { audit } from './db/audit';
import { findByFingerprint, getQuestion, rowToQuestion, updateQuestion } from './db/questions';
import { nowIso, type ActorContext, type Workspace } from './db/workspace';
import { decryptContainer, encryptContainer } from './crypto';
import { richText } from '../shared/schemas';

/**
 * Multi-laptop history merge (FR-16). One laptop exports its questions, tests and images as a
 * passphrase-encrypted file; another merges it. Questions match by ID, then by wording;
 * conflicting edits are shown side by side; tests are added once by ID. Nothing is duplicated.
 */

const questionRow = z
  .object({
    id: z.string().min(1).max(100),
    stem: z.string(),
    options: z.string(),
    correct: z.number().int().min(0).max(4),
    explanation: z.string(),
    lock_options: z.number().int(),
    subject: z.string().max(100),
    topic: z.string().max(200),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    tags: z.string(),
    source: z.string().max(200),
    reserved: z.number().int(),
    status: z.enum(['active', 'archived']),
    version: z.number().int().min(1),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

const payloadSchema = z.object({
  format: z.literal(1),
  workspaceId: z.string(),
  exportedAt: z.string(),
  questions: z.array(questionRow),
  images: z.array(
    z.object({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      mime: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      bytes: z.string(),
    }),
  ),
  tests: z.array(
    z.object({
      test: z
        .object({
          id: z.string(),
          title: z.string().max(200),
          kind: z.enum(['generated', 'outside']),
          code: z.string(),
          seed: z.string(),
          settings: z.string(),
          overlap_report: z.string(),
          included_in_rule: z.number().int(),
          source_file: z.string(),
          question_count: z.number().int(),
          created_at: z.string(),
          created_by: z.string(),
        })
        .passthrough(),
      questions: z.array(
        z.object({
          position: z.number().int(),
          question_id: z.string().nullable(),
          snapshot: z.string(),
        }),
      ),
    }),
  ),
});
type MergePayload = z.infer<typeof payloadSchema>;

function parseQuestion(row: z.infer<typeof questionRow>): BankQuestion {
  const q = rowToQuestion(row as never);
  // Content arriving from another laptop is validated like any other input.
  richText.parse(q.stem);
  q.options.forEach((o) => richText.parse(o));
  richText.parse(q.explanation);
  return q;
}

export async function exportMergeFile(
  ws: Workspace,
  ctx: ActorContext,
  passphrase: string,
  appVersion: string,
): Promise<Buffer> {
  const questions = ws.db.prepare('SELECT * FROM questions').all();
  const images = (
    ws.db.prepare('SELECT hash, mime, width, height, bytes FROM images').all() as Array<{
      hash: string;
      mime: string;
      width: number | null;
      height: number | null;
      bytes: Uint8Array;
    }>
  ).map((i) => ({ ...i, bytes: Buffer.from(i.bytes).toString('base64') }));
  const tests = (ws.db.prepare('SELECT * FROM tests').all() as Array<{ id: string }>).map(
    (test) => ({
      test,
      questions: ws.db
        .prepare(
          'SELECT position, question_id, snapshot FROM test_questions WHERE test_id = ? ORDER BY position',
        )
        .all(test.id),
    }),
  );
  const payload = { format: 1, workspaceId: ws.id, exportedAt: nowIso(), questions, images, tests };
  const bytes = await encryptContainer(gzipSync(Buffer.from(JSON.stringify(payload))), passphrase, {
    kind: 'merge',
    createdAt: payload.exportedAt,
    appVersion,
    workspaceId: ws.id,
    counts: { questions: questions.length, tests: tests.length, images: images.length },
  });
  audit(ws, ctx, 'merge.exported', 'workspace', ws.id, {
    questions: questions.length,
    tests: tests.length,
  });
  return bytes;
}

export interface MergeConflict {
  id: string;
  mine: BankQuestion;
  theirs: BankQuestion;
}

export interface MergePlan {
  sourceWorkspaceId: string;
  exportedAt: string;
  sameWorkspace: boolean;
  newQuestions: number;
  unchangedQuestions: number;
  matchedByWording: Array<{ theirId: string; localId: string }>;
  conflicts: MergeConflict[];
  newTests: Array<{
    id: string;
    title: string;
    createdAt: string;
    questionCount: number;
    kind: string;
  }>;
  existingTests: number;
  newImages: number;
}

export async function readMergeFile(file: Uint8Array, passphrase: string): Promise<MergePayload> {
  const { header, payload } = await decryptContainer(file, passphrase);
  if (header.kind !== 'merge')
    throw new Error('This is a backup, not a merge file. Use Restore instead.');
  let json: unknown;
  try {
    json = JSON.parse(
      gunzipSync(payload, { maxOutputLength: 2 * 1024 * 1024 * 1024 }).toString('utf8'),
    );
  } catch {
    throw new Error('The merge file is damaged.');
  }
  return payloadSchema.parse(json);
}

const sameContent = (a: BankQuestion, b: BankQuestion): boolean =>
  fingerprint(a) === fingerprint(b) &&
  toPlainText(a.options[a.correct]) === toPlainText(b.options[b.correct]) &&
  a.subject === b.subject &&
  a.topic === b.topic &&
  a.difficulty === b.difficulty &&
  a.status === b.status &&
  JSON.stringify(a.tags) === JSON.stringify(b.tags);

export function planMerge(ws: Workspace, payload: MergePayload): MergePlan {
  const plan: MergePlan = {
    sourceWorkspaceId: payload.workspaceId,
    exportedAt: payload.exportedAt,
    sameWorkspace: payload.workspaceId === ws.id,
    newQuestions: 0,
    unchangedQuestions: 0,
    matchedByWording: [],
    conflicts: [],
    newTests: [],
    existingTests: 0,
    newImages: 0,
  };
  for (const row of payload.questions) {
    const theirs = parseQuestion(row);
    const mine = getQuestion(ws, theirs.id);
    if (mine) {
      if (sameContent(mine, theirs)) plan.unchangedQuestions += 1;
      else plan.conflicts.push({ id: theirs.id, mine, theirs });
      continue;
    }
    const byWording = findByFingerprint(ws, fingerprint(theirs));
    if (byWording.length) plan.matchedByWording.push({ theirId: theirs.id, localId: byWording[0] });
    else plan.newQuestions += 1;
  }
  const hasTest = ws.db.prepare('SELECT 1 FROM tests WHERE id = ?');
  for (const t of payload.tests) {
    if (hasTest.get(t.test.id)) plan.existingTests += 1;
    else
      plan.newTests.push({
        id: t.test.id,
        title: t.test.title,
        createdAt: t.test.created_at,
        questionCount: t.test.question_count,
        kind: t.test.kind,
      });
  }
  const hasImage = ws.db.prepare('SELECT 1 FROM images WHERE hash = ?');
  plan.newImages = payload.images.filter((i) => !hasImage.get(i.hash)).length;
  return plan;
}

export type ConflictChoice = 'mine' | 'theirs';

export function applyMerge(
  ws: Workspace,
  ctx: ActorContext,
  payload: MergePayload,
  choices: Record<string, ConflictChoice>,
): MergePlan {
  const plan = planMerge(ws, payload);
  return ws.transaction(() => {
    const insertImage = ws.db.prepare(
      'INSERT OR IGNORE INTO images (hash, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const img of payload.images)
      insertImage.run(
        img.hash,
        img.mime,
        img.width,
        img.height,
        Buffer.from(img.bytes, 'base64'),
        nowIso(),
      );

    const idMap = new Map(plan.matchedByWording.map((m) => [m.theirId, m.localId]));
    const conflictIds = new Set(plan.conflicts.map((c) => c.id));
    const insertQuestion = ws.db.prepare(
      `INSERT INTO questions (id, stem, options, correct, explanation, lock_options, subject, topic, difficulty, tags, source,
        reserved, status, version, fingerprint, search_text, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVersion = ws.db.prepare(
      'INSERT INTO question_versions (question_id, version, snapshot, changed_at, changed_by, note) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const row of payload.questions) {
      const theirs = parseQuestion(row);
      if (idMap.has(theirs.id)) continue;
      if (conflictIds.has(theirs.id)) {
        if (choices[theirs.id] === 'theirs') {
          updateQuestion(ws, ctx, theirs.id, { ...theirs, note: 'Merged from another laptop' });
        }
        continue;
      }
      if (getQuestion(ws, theirs.id)) continue;
      const r = row as Record<string, unknown>;
      insertQuestion.run(
        theirs.id,
        row.stem,
        row.options,
        row.correct,
        row.explanation,
        row.lock_options,
        row.subject,
        row.topic,
        row.difficulty,
        row.tags,
        row.source,
        row.reserved,
        row.status,
        row.version,
        fingerprint(theirs),
        String(r.search_text ?? ''),
        row.created_at,
        row.updated_at,
        String(r.created_by ?? ''),
        String(r.updated_by ?? ''),
      );
      insertVersion.run(
        theirs.id,
        row.version,
        JSON.stringify(theirs),
        nowIso(),
        ctx.actor,
        'Merged from another laptop',
      );
    }

    const hasTest = ws.db.prepare('SELECT 1 FROM tests WHERE id = ?');
    const insertTest = ws.db.prepare(
      `INSERT INTO tests (id, title, kind, code, seed, settings, overlap_report, included_in_rule, source_file, question_count, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTq = ws.db.prepare(
      'INSERT INTO test_questions (test_id, position, question_id, snapshot) VALUES (?, ?, ?, ?)',
    );
    for (const { test, questions } of payload.tests) {
      if (hasTest.get(test.id)) continue;
      insertTest.run(
        test.id,
        test.title,
        test.kind,
        test.code,
        test.seed,
        test.settings,
        test.overlap_report,
        test.included_in_rule,
        test.source_file,
        test.question_count,
        test.created_at,
        test.created_by,
      );
      for (const q of questions) {
        const mapped = q.question_id ? (idMap.get(q.question_id) ?? q.question_id) : null;
        insertTq.run(
          test.id,
          q.position,
          mapped && getQuestion(ws, mapped) ? mapped : null,
          q.snapshot,
        );
      }
    }
    audit(ws, ctx, 'merge.applied', 'workspace', payload.workspaceId, {
      newQuestions: plan.newQuestions,
      matchedByWording: plan.matchedByWording.length,
      conflicts: plan.conflicts.length,
      tookTheirs: Object.values(choices).filter((c) => c === 'theirs').length,
      newTests: plan.newTests.length,
    });
    return plan;
  });
}

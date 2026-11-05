import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plain } from '../../src/core/richtext';
import { listAudit } from '../../src/main/db/audit';
import {
  approveItems,
  deleteBatch,
  listBatches,
  listItems,
  mergeItem,
  rejectItems,
  stageBatch,
  updateItem,
  type ReviewCandidate,
} from '../../src/main/db/imports';
import { SCHEMA_VERSION, WorkspaceTooNewError } from '../../src/main/db/migrations';
import {
  bulkTag,
  createQuestion,
  deleteUnused,
  getQuestion,
  listQuestions,
  questionHistory,
  revertQuestion,
  setStatus,
  updateQuestion,
  VersionConflictError,
} from '../../src/main/db/questions';
import { getSettings, saveSettings } from '../../src/main/db/settings';
import {
  compareTests,
  comparedTests,
  getTest,
  previewTest,
  saveGeneratedTest,
  saveOutsideTest,
  setIncludedInRule,
} from '../../src/main/db/tests';
import { Workspace } from '../../src/main/db/workspace';
import { bankFilter } from '../../src/shared/schemas';
import { questionInput, request, seedBank } from '../helpers/fixtures';

const ctx = { actor: 'Test Staff', osUser: 'tester' };
const subjects = ['Biology', 'Chemistry', 'Physics', 'English', 'Logical Reasoning'];

const candidate = (i: number, overrides: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  ...questionInput(i),
  correct: i % 4,
  warnings: [],
  refs: [`row ${i + 2}`],
  pages: [],
  number: null,
  ...overrides,
});

describe('workspace', () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcq-ws-'));
    ws = Workspace.open(join(dir, 'workspace.sqlite'));
  });
  afterEach(() => {
    ws.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a new file and refuses a newer schema', () => {
    expect(Workspace.peekVersion(ws.path)).toBe(SCHEMA_VERSION);
    ws.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    ws.close();
    expect(() => Workspace.open(join(dir, 'workspace.sqlite'))).toThrow(WorkspaceTooNewError);
    ws = Workspace.open(':memory:');
  });

  it('stores settings over defaults and validates them', () => {
    expect(getSettings(ws).rule.limitPct).toBe(20);
    saveSettings(ws, { rule: { limitPct: 25 }, institute: { name: 'Synthetic Academy' } });
    expect(getSettings(ws).rule).toEqual({ mode: 'each', limitPct: 25, denominator: 'new' });
    expect(getSettings(ws).institute.name).toBe('Synthetic Academy');
    expect(() => saveSettings(ws, { rule: { limitPct: 300 } })).toThrow();
  });

  it('creates, edits with history, reverts and guards concurrent edits', () => {
    const q = createQuestion(ws, ctx, questionInput(1));
    const { question } = updateQuestion(ws, ctx, q.id, {
      ...questionInput(1),
      topic: 'Changed',
      expectedVersion: 1,
    });
    expect(question.version).toBe(2);
    expect(() =>
      updateQuestion(ws, ctx, q.id, { ...questionInput(1), expectedVersion: 1 }),
    ).toThrow(VersionConflictError);
    revertQuestion(ws, ctx, q.id, 1);
    expect(getQuestion(ws, q.id)!.topic).toBe('Topic 1');
    expect(questionHistory(ws, q.id).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('lists with search and filters using parameters only', () => {
    seedBank(ws, 30);
    const all = listQuestions(ws, bankFilter.parse({}));
    expect(all.total).toBe(30);
    const bio = listQuestions(ws, bankFilter.parse({ subjects: ['Biology'] }));
    expect(bio.items.every((i) => i.subject === 'Biology')).toBe(true);
    expect(listQuestions(ws, bankFilter.parse({ search: 'concept 13' })).total).toBeGreaterThan(0);
    // Injection attempt is just a search string.
    expect(listQuestions(ws, bankFilter.parse({ search: "x' OR 1=1 --" })).total).toBe(0);
    expect(listQuestions(ws, bankFilter.parse({ search: '100%' })).total).toBe(0);
  });

  it('archives used questions instead of deleting them, and lists affected tests on answer change', () => {
    seedBank(ws, 60);
    const saved = saveGeneratedTest(ws, ctx, request());
    const usedId = saved.questions[0].questionId!;
    const { deleted, refused } = deleteUnused(ws, ctx, [usedId]);
    expect(deleted).toBe(0);
    expect(refused).toEqual([usedId]);
    expect(setStatus(ws, ctx, [usedId], 'archived')).toBe(1);
    expect(getQuestion(ws, usedId)!.status).toBe('archived');
    const q = getQuestion(ws, usedId)!;
    const changed = updateQuestion(ws, ctx, usedId, { ...q, correct: (q.correct + 1) % 4 });
    expect(changed.answerChangedIn.map((t) => t.testId)).toEqual([saved.id]);
    expect(bulkTag(ws, ctx, [usedId], ['finals'], [])).toBe(1);
    expect(getQuestion(ws, usedId)!.tags).toEqual(['finals']);
  });

  it('saves a generated test with snapshot, versions and passing overlap, and re-checks on save', () => {
    seedBank(ws, 60);
    const preview = previewTest(ws, request());
    expect(preview.result.ok).toBe(true);
    const saved = saveGeneratedTest(ws, ctx, request());
    expect(saved.questions).toHaveLength(20);
    expect(saved.settings.versions).toHaveLength(2);
    expect(saved.report!.passes).toBe(true);
    if (preview.result.ok)
      expect(saved.questions.map((q) => q.questionId)).toEqual(preview.result.questionIds);

    // Snapshot survives later edits.
    const first = saved.questions[0];
    updateQuestion(ws, ctx, first.questionId!, {
      ...questionInput(0),
      stem: plain('Edited wording'),
    });
    expect(getTest(ws, saved.id)!.questions[0].snapshot.stem).toEqual(first.snapshot.stem);

    // Each test draws a fresh set until the bank runs short, then refuses.
    saveGeneratedTest(ws, ctx, request({ seed: 2 }));
    expect(() =>
      saveGeneratedTest(
        ws,
        ctx,
        request({
          seed: 3,
          blueprint: {
            sections: [{ subject: 'Biology', count: 20, topics: [] }],
            difficultyMix: null,
          },
        }),
      ),
    ).toThrow(/fit the 20% rule/);
  });

  it('honours unchecked tests and outside tests in comparisons', () => {
    const ids = seedBank(ws, 60);
    const outside = saveOutsideTest(ws, ctx, {
      title: 'Final 2025 (imported)',
      sourceFile: 'final-2025.xlsx',
      createdAt: '2025-06-01',
      items: ids.slice(0, 5).map((id) => ({
        snapshot: getQuestion(ws, id)!,
        questionId: id,
        score: 1,
        confirmed: true,
      })),
    });
    expect(comparedTests(ws, { excludedTestIds: [], from: null, to: null })).toHaveLength(1);
    expect(comparedTests(ws, { excludedTestIds: [outside.id], from: null, to: null })).toHaveLength(
      0,
    );
    expect(comparedTests(ws, { excludedTestIds: [], from: '2026-01-01', to: null })).toHaveLength(
      0,
    );
    setIncludedInRule(ws, ctx, outside.id, false);
    expect(comparedTests(ws, { excludedTestIds: [], from: null, to: null })).toHaveLength(0);

    const t = saveGeneratedTest(ws, ctx, request());
    const cmp = compareTests(ws, t.id, outside.id);
    expect(cmp.pctOfA).toBeGreaterThanOrEqual(0);
  });

  it('stages, flags duplicates, approves, merges and rejects', () => {
    const existing = createQuestion(ws, ctx, questionInput(100));
    const batch = stageBatch(
      ws,
      ctx,
      {
        sourceType: 'excel',
        fileName: 'synthetic.xlsx',
        settings: {},
        candidates: [
          { candidate: candidate(1) },
          { candidate: candidate(2) },
          { candidate: { ...candidate(100) } },
          { candidate: candidate(3, { correct: null }) },
          {
            candidate: {
              ...candidate(4),
              options: [plain('Alpha 4'), plain('Beta 4'), plain('Gamma 4'), plain('Deltaa 4')],
            },
          },
          { candidate: candidate(4) },
        ],
        unplaced: [
          {
            block: {
              content: plain('Chapter 3'),
              reason: 'Text before the first question',
              refs: [],
            },
          },
        ],
      },
      90,
    );
    expect(batch.total).toBe(7);
    const items = listItems(ws, batch.id, subjects);
    expect(items[2].duplicates[0]).toMatchObject({ id: existing.id, exact: true });
    expect(items[3].issues).toContain('Mark the correct answer.');
    expect(items[5].duplicates[0]).toMatchObject({ scope: 'batch' });

    const bulk = approveItems(
      ws,
      ctx,
      items.map((i) => i.id),
      subjects,
      { onlyClean: true },
    );
    expect(bulk.approved).toEqual([items[0].id, items[1].id, items[4].id]);
    expect(bulk.refused.find((r) => r.itemId === items[2].id)!.reason).toMatch(/identical/);

    updateItem(ws, items[3].id, { ...items[3].candidate!, correct: 2 }, subjects, 90);
    expect(approveItems(ws, ctx, [items[3].id], subjects).approved).toEqual([items[3].id]);

    mergeItem(ws, ctx, items[2].id, existing.id, subjects);
    expect(rejectItems(ws, ctx, [items[5].id, items[6].id], 'Not needed', subjects)).toBe(2);
    const after = listItems(ws, batch.id, subjects);
    expect(after.map((i) => i.status)).toEqual([
      'approved',
      'approved',
      'merged',
      'approved',
      'approved',
      'rejected',
      'rejected',
    ]);
    expect(listQuestions(ws, bankFilter.parse({})).total).toBe(5);
    expect(
      listAudit(ws, { limit: 100, offset: 0 }).entries.some((e) => e.action === 'review.approved'),
    ).toBe(true);
  });

  it('deletes an import, optionally removing the questions it added', () => {
    const stage = (fileName: string, n: number) =>
      stageBatch(
        ws,
        ctx,
        {
          sourceType: 'docx',
          fileName,
          settings: {},
          candidates: [{ candidate: candidate(n) }, { candidate: candidate(n + 1) }],
          unplaced: [],
        },
        90,
      );
    const kept = stage('keep.docx', 10);
    const keptItems = listItems(ws, kept.id, subjects);
    approveItems(ws, ctx, [keptItems[0].id], subjects);
    expect(deleteBatch(ws, ctx, kept.id, { removeQuestions: false })).toEqual({
      deleted: 0,
      archived: 0,
    });
    expect(listQuestions(ws, bankFilter.parse({})).total).toBe(1);

    const removed = stage('remove.docx', 20);
    const items = listItems(ws, removed.id, subjects);
    approveItems(
      ws,
      ctx,
      items.map((i) => i.id),
      subjects,
    );
    const [used, unused] = listItems(ws, removed.id, subjects).map((i) => i.questionId!);
    saveOutsideTest(ws, ctx, {
      title: 'Synthetic past paper',
      sourceFile: 'past.docx',
      createdAt: '2026-01-01',
      items: [{ snapshot: getQuestion(ws, used)!, questionId: used, score: 1, confirmed: true }],
    });
    expect(deleteBatch(ws, ctx, removed.id, { removeQuestions: true })).toEqual({
      deleted: 1,
      archived: 1,
    });
    expect(getQuestion(ws, unused)).toBeNull();
    expect(getQuestion(ws, used)!.status).toBe('archived');
    expect(listBatches(ws)).toEqual([]);
    expect(
      listAudit(ws, { limit: 100, offset: 0 }).entries.some((e) => e.action === 'import.deleted'),
    ).toBe(true);
  });
});

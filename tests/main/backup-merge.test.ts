import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plain } from '../../src/core/richtext';
import { BackupService, inspectWorkspaceFile } from '../../src/main/backup';
import {
  decryptContainer,
  encryptContainer,
  readHeader,
  WrongPassphraseError,
} from '../../src/main/crypto';
import { createQuestion, getQuestion, updateQuestion } from '../../src/main/db/questions';
import { getTest, saveGeneratedTest } from '../../src/main/db/tests';
import { Workspace } from '../../src/main/db/workspace';
import { applyMerge, exportMergeFile, planMerge, readMergeFile } from '../../src/main/merge';
import { questionInput, request, seedBank } from '../helpers/fixtures';

const ctx = { actor: 'Test Staff', osUser: 'tester' };
const PASS = 'correct horse battery';

describe('encrypted container', () => {
  it('round-trips and authenticates the header', async () => {
    const meta = {
      kind: 'backup' as const,
      createdAt: '2026-01-01',
      appVersion: '0.1.0',
      workspaceId: 'w',
      counts: { questions: 3 },
    };
    const sealed = await encryptContainer(Buffer.from('payload'), PASS, meta, {
      N: 2 ** 10,
      r: 8,
      p: 1,
    });
    expect(readHeader(sealed).header.counts.questions).toBe(3);
    expect((await decryptContainer(sealed, PASS)).payload.toString()).toBe('payload');
    await expect(decryptContainer(sealed, 'wrong passphrase')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );

    // Tampering with the visible header is detected.
    const tampered = Buffer.from(
      sealed.toString('latin1').replace('"questions":3', '"questions":9'),
      'latin1',
    );
    await expect(decryptContainer(tampered, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(encryptContainer(Buffer.from('x'), 'short', meta)).rejects.toThrow(/at least 8/);
    expect(() => readHeader(Buffer.from('not a backup file at all'))).toThrow(/not an MCQ/);
  });
});

describe('backup and restore', () => {
  let dir: string;
  let ws: Workspace;
  let service: BackupService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcq-bk-'));
    ws = Workspace.open(join(dir, 'workspace.sqlite'));
    service = new BackupService(join(dir, 'backups'), '0.1.0');
  });
  afterEach(() => {
    ws.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the newest automatic snapshots', () => {
    seedBank(ws, 3);
    for (let i = 0; i < 4; i++) service.snapshot(ws, 'close', 2);
    const list = service.list();
    expect(list).toHaveLength(2);
    expect(service.inspectSnapshot(list[0].file).questions).toBe(3);
  });

  it('writes an encrypted backup that restores with counts', async () => {
    seedBank(ws, 5);
    const { bytes, counts } = await service.createEncrypted(ws, PASS);
    expect(counts.questions).toBe(5);
    expect(bytes.includes(Buffer.from('Synthetic question'))).toBe(false);
    const inspected = await service.inspectEncrypted(bytes, PASS);
    expect(inspected.counts.questions).toBe(5);
    const restored = Workspace.open(inspected.tempPath);
    expect(restored.id).toBe(ws.id);
    restored.close();
  });

  it('refuses files that are not workspaces', () => {
    const bad = join(dir, 'bad.sqlite');
    writeFileSync(bad, 'nope');
    expect(() => inspectWorkspaceFile(bad)).toThrow(/not an MCQ/);
  });
});

describe('history merge between laptops', () => {
  let dir: string;
  let a: Workspace;
  let b: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcq-merge-'));
    a = Workspace.open(join(dir, 'a.sqlite'));
    b = Workspace.open(join(dir, 'b.sqlite'));
  });
  afterEach(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges questions and tests without duplicates and surfaces conflicts', async () => {
    seedBank(a, 60);
    const testA = saveGeneratedTest(a, ctx, request());
    // Laptop B typed one of the same questions itself (different ID, same wording).
    createQuestion(b, ctx, questionInput(0));

    const file = await exportMergeFile(a, ctx, PASS, '0.1.0');
    const payload = await readMergeFile(file, PASS);
    const plan = planMerge(b, payload);
    expect(plan.matchedByWording).toHaveLength(1);
    expect(plan.newQuestions).toBe(59);
    expect(plan.newTests.map((t) => t.id)).toEqual([testA.id]);

    applyMerge(b, ctx, payload, {});
    const merged = getTest(b, testA.id)!;
    expect(merged.questions).toHaveLength(20);
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n).toBe(60);

    // Merging again changes nothing.
    const again = planMerge(b, payload);
    expect(again.newQuestions).toBe(0);
    expect(again.newTests).toHaveLength(0);

    // A later edit on laptop A shows as a conflict on B, resolved by choice.
    const editedId = testA.questions[0].questionId!;
    const q = getQuestion(a, editedId)!;
    updateQuestion(a, ctx, editedId, { ...q, stem: plain('Edited on laptop A') });
    const second = await readMergeFile(await exportMergeFile(a, ctx, PASS, '0.1.0'), PASS);
    const plan2 = planMerge(b, second);
    expect(plan2.conflicts.map((c) => c.id)).toEqual([editedId]);
    applyMerge(b, ctx, second, { [editedId]: 'theirs' });
    expect(getQuestion(b, editedId)!.stem).toEqual(plain('Edited on laptop A'));
  });

  it('rejects a backup offered as a merge file', async () => {
    const service = new BackupService(join(dir, 'backups'), '0.1.0');
    const { bytes } = await service.createEncrypted(a, PASS);
    await expect(readMergeFile(bytes, PASS)).rejects.toThrow(/backup, not a merge/);
  });
});

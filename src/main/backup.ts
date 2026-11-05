import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptContainer, encryptContainer, type ContainerHeader } from './crypto';
import { SCHEMA_VERSION, schemaVersion } from './db/migrations';
import type { Workspace } from './db/workspace';

/**
 * Backups (FR-15).
 *
 * - Automatic: a plain snapshot in the app-data folder on every close and before upgrades and
 *   restores; the newest N are kept. Same-disk copies do not survive a lost laptop.
 * - Manual ("Back up now"): one passphrase-encrypted file written to any folder.
 */

export type SnapshotReason = 'close' | 'upgrade' | 'pre-restore' | 'pre-merge';

export interface WorkspaceCounts {
  questions: number;
  activeQuestions: number;
  tests: number;
  images: number;
  auditEntries: number;
}

export function countWorkspace(db: DatabaseSync): WorkspaceCounts {
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    questions: n('SELECT COUNT(*) AS n FROM questions'),
    activeQuestions: n("SELECT COUNT(*) AS n FROM questions WHERE status = 'active'"),
    tests: n('SELECT COUNT(*) AS n FROM tests'),
    images: n('SELECT COUNT(*) AS n FROM images'),
    auditEntries: n('SELECT COUNT(*) AS n FROM audit_log'),
  };
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

export interface AutoBackup {
  file: string;
  name: string;
  reason: string;
  createdAt: string;
  bytes: number;
}

export class BackupService {
  constructor(
    private readonly backupDir: string,
    private readonly appVersion: string,
  ) {
    mkdirSync(backupDir, { recursive: true });
  }

  snapshot(ws: Workspace, reason: SnapshotReason, keep: number): string {
    const file = join(this.backupDir, `auto-${stamp()}-${reason}.sqlite`);
    ws.snapshotTo(file);
    this.prune(keep);
    return file;
  }

  list(): AutoBackup[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter((name) => /^auto-.*\.sqlite$/.test(name))
      .map((name) => {
        const file = join(this.backupDir, name);
        const info = statSync(file);
        const reason =
          /-(close|upgrade|pre-restore|pre-merge)\.sqlite$/.exec(name)?.[1] ?? 'unknown';
        return { file, name, reason, createdAt: info.mtime.toISOString(), bytes: info.size };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Keeps the newest `keep` automatic snapshots. */
  prune(keep: number): void {
    for (const old of this.list().slice(keep)) rmSync(old.file, { force: true });
  }

  /** Encrypted single-file backup for "Back up now". */
  async createEncrypted(
    ws: Workspace,
    passphrase: string,
  ): Promise<{ bytes: Buffer; counts: WorkspaceCounts }> {
    const temp = join(this.backupDir, `manual-${stamp()}.tmp`);
    try {
      ws.snapshotTo(temp);
      const payload = await readFile(temp);
      const counts = countWorkspace(ws.db);
      const bytes = await encryptContainer(payload, passphrase, {
        kind: 'backup',
        createdAt: new Date().toISOString(),
        appVersion: this.appVersion,
        workspaceId: ws.id,
        counts: { ...counts },
      });
      return { bytes, counts };
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /**
   * Decrypts a backup to a temporary file and checks it is a workspace this app can open.
   * Returns the temp path for a confirmed restore.
   */
  async inspectEncrypted(
    file: Uint8Array,
    passphrase: string,
  ): Promise<{ header: ContainerHeader; counts: WorkspaceCounts; tempPath: string }> {
    const { header, payload } = await decryptContainer(file, passphrase);
    if (header.kind !== 'backup')
      throw new Error(
        'This is a merge file, not a backup. Use "Merge from another laptop" instead.',
      );
    const tempPath = join(this.backupDir, `restore-${stamp()}.sqlite`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(tempPath, payload);
    return { header, counts: inspectWorkspaceFile(tempPath), tempPath };
  }

  /** Validates an automatic snapshot before restoring it. */
  inspectSnapshot(file: string): WorkspaceCounts {
    return inspectWorkspaceFile(file);
  }
}

export function inspectWorkspaceFile(path: string): WorkspaceCounts {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const version = schemaVersion(db);
    if (version > SCHEMA_VERSION)
      throw new Error(
        'This backup was made by a newer version of the app. Install that version to restore it.',
      );
    if (version < 1) throw new Error('This file is not an MCQ Shuffler workspace.');
    const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (integrity.quick_check !== 'ok')
      throw new Error('The backup is damaged and cannot be restored.');
    return countWorkspace(db);
  } catch (error) {
    if (error instanceof Error && /newer version|damaged|not an MCQ/.test(error.message))
      throw error;
    throw new Error('This file is not an MCQ Shuffler workspace.', { cause: error });
  } finally {
    db?.close();
  }
}

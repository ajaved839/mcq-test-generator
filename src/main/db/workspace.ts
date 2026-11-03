import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { migrate, schemaVersion } from './migrations';

/**
 * One SQLite file per OS account holds questions, images, tests and the audit log.
 * Every query in the app is parameterized; string concatenation is limited to fixed SQL
 * fragments chosen by code, never by user input.
 */

export interface ActorContext {
  /** Staff name picked at startup, or the OS user when no staff list is configured. */
  actor: string;
  osUser: string;
}

export class Workspace {
  readonly previousVersion: number;

  private constructor(
    readonly db: DatabaseSync,
    readonly path: string,
  ) {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    this.previousVersion = migrate(db);
    const existing = db.prepare("SELECT value FROM meta WHERE key = 'workspace_id'").get() as
      { value: string } | undefined;
    if (!existing) {
      const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      insert.run('workspace_id', randomUUID());
      insert.run('created_at', new Date().toISOString());
    }
  }

  static open(path: string): Workspace {
    return new Workspace(new DatabaseSync(path), path);
  }

  /** Reads the schema version of a file without migrating it. */
  static peekVersion(path: string): number {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return schemaVersion(db);
    } finally {
      db.close();
    }
  }

  get id(): string {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = 'workspace_id'").get() as {
        value: string;
      }
    ).value;
  }

  /** Runs `fn` in a transaction; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Consistent single-file copy, safe while the workspace is open. */
  snapshotTo(targetPath: string): void {
    this.db.prepare('VACUUM INTO ?').run(targetPath);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => randomUUID();

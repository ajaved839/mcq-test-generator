import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order inside a transaction. PRAGMA user_version records the
 * schema version so an older app can refuse to open a newer workspace instead of damaging it.
 *
 * Never edit a migration that has shipped; add a new one.
 */

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    stem TEXT NOT NULL,
    options TEXT NOT NULL,
    correct INTEGER NOT NULL,
    explanation TEXT NOT NULL DEFAULT '[]',
    lock_options INTEGER NOT NULL DEFAULT 0,
    subject TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',
    reserved INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL DEFAULT 1,
    fingerprint TEXT NOT NULL,
    search_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX questions_subject ON questions (subject, status);
  CREATE INDEX questions_fingerprint ON questions (fingerprint);

  CREATE TABLE question_versions (
    question_id TEXT NOT NULL REFERENCES questions (id),
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    changed_by TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (question_id, version)
  );

  CREATE TABLE images (
    hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE tests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('generated', 'outside')),
    code TEXT NOT NULL DEFAULT '',
    seed TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    overlap_report TEXT NOT NULL DEFAULT '{}',
    included_in_rule INTEGER NOT NULL DEFAULT 1,
    source_file TEXT NOT NULL DEFAULT '',
    question_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE test_questions (
    test_id TEXT NOT NULL REFERENCES tests (id),
    position INTEGER NOT NULL,
    question_id TEXT,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (test_id, position)
  );
  CREATE INDEX test_questions_question ON test_questions (question_id);

  CREATE TABLE test_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id TEXT NOT NULL REFERENCES tests (id),
    kind TEXT NOT NULL,
    version_letter TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX test_exports_test ON test_exports (test_id);

  CREATE TABLE import_batches (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    total INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE review_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES import_batches (id),
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'skipped')),
    kind TEXT NOT NULL DEFAULT 'mcq' CHECK (kind IN ('mcq', 'unplaced')),
    data TEXT NOT NULL,
    duplicates TEXT NOT NULL DEFAULT '[]',
    reject_reason TEXT NOT NULL DEFAULT '',
    question_id TEXT,
    page_image TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX review_items_batch ON review_items (batch_id, status, position);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    os_user TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_log_at ON audit_log (at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class WorkspaceTooNewError extends Error {
  constructor(public readonly found: number) {
    super(
      `This workspace was created by a newer version of MCQ Shuffler (schema ${found}, this app supports ${SCHEMA_VERSION}). Install the newer version to open it.`,
    );
    this.name = 'WorkspaceTooNewError';
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Applies pending migrations. Returns the version before migrating. */
export function migrate(db: DatabaseSync): number {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) throw new WorkspaceTooNewError(current);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return current;
}

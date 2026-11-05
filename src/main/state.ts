import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { BackupService } from './backup';
import { withPrefix } from '../shared/names';
import { verifyAdmin } from './auth';
import { audit } from './db/audit';
import { SCHEMA_VERSION, schemaVersion, WorkspaceTooNewError } from './db/migrations';
import { getSettings } from './db/settings';
import { Workspace, type ActorContext } from './db/workspace';
import { OcrEngine } from './importers/ocr';
import { log } from './logger';

/**
 * Process-wide state for the main process: the open workspace, who is acting, backups, OCR and
 * short-lived tokens for multi-step flows (file parsed, then confirmed).
 */

export interface AppPaths {
  dataDir: string;
  workspaceFile: string;
  backupDir: string;
  logDir: string;
  fontBase: string;
}

interface Pending {
  kind: string;
  value: unknown;
  expires: number;
  cleanup?: () => void;
}

const TOKEN_TTL_MS = 30 * 60 * 1000;

export class AppState {
  ws!: Workspace;
  readonly backups: BackupService;
  readonly ocr: OcrEngine;
  readonly osUser: string;
  private actorName: string | null = null;
  private pending = new Map<string, Pending>();

  constructor(
    readonly paths: AppPaths,
    readonly appVersion: string,
    onOcrLog?: (status: string, progress: number) => void,
  ) {
    mkdirSync(paths.dataDir, { recursive: true });
    this.backups = new BackupService(paths.backupDir, appVersion);
    this.ocr = new OcrEngine(undefined, onOcrLog);
    let name = 'staff';
    try {
      name = userInfo().username || name;
    } catch {
      // Some managed accounts hide the user name; keep the fallback.
    }
    this.osUser = name;
  }

  /** Opens the workspace, snapshotting first when the schema or app version is about to change. */
  open(): void {
    const file = this.paths.workspaceFile;
    if (existsSync(file)) {
      const db = new DatabaseSync(file);
      try {
        const version = schemaVersion(db);
        if (version > SCHEMA_VERSION) throw new WorkspaceTooNewError(version);
        if (version < SCHEMA_VERSION) {
          const target = join(
            this.paths.backupDir,
            `auto-${new Date().toISOString().replace(/[:.]/g, '-')}-upgrade.sqlite`,
          );
          db.prepare('VACUUM INTO ?').run(target);
          log('info', 'backup.pre-upgrade', { from: version, to: SCHEMA_VERSION });
        }
      } finally {
        db.close();
      }
    }
    this.ws = Workspace.open(file);
    const last = this.ws.db
      .prepare("SELECT value FROM meta WHERE key = 'last_app_version'")
      .get() as { value: string } | undefined;
    if (last && last.value !== this.appVersion) {
      this.backups.snapshot(this.ws, 'upgrade', getSettings(this.ws).backup.keepAutomatic);
    }
    this.ws.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_app_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(this.appVersion);
  }

  get settings() {
    return getSettings(this.ws);
  }

  get ctx(): ActorContext {
    return { actor: this.actorName ?? this.osUser, osUser: this.osUser };
  }

  get actor(): string | null {
    return this.actorName;
  }

  get signedIn(): boolean {
    return this.actorName !== null;
  }

  /**
   * Checks the super admin credential, then records `name` as the actor for every action in this
   * session. Failed attempts are audited (without the password) and slowed down.
   */
  async signIn(username: string, password: string, name: string): Promise<void> {
    // Every name is recorded as "Dr. <name>"; staff list entries are compared the same way.
    const display = withPrefix(name);
    if (!display) throw new Error('Enter your name.');
    const staff = this.settings.staff.map(withPrefix);
    if (staff.length && !staff.includes(display))
      throw new Error('Pick a name from the staff list.');
    if (!(await verifyAdmin(this.ws, username, password))) {
      audit(this.ws, { actor: display, osUser: this.osUser }, 'session.login-failed', 'staff');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw new Error('The username or password is wrong.');
    }
    this.actorName = display;
    audit(this.ws, this.ctx, 'session.started', 'staff', display);
  }

  signOut(): void {
    if (!this.actorName) return;
    audit(this.ws, this.ctx, 'session.ended', 'staff', this.actorName);
    this.actorName = null;
  }

  /** Closing snapshot (last N kept), then close. */
  closeWithBackup(): void {
    if (!this.ws) return;
    try {
      this.backups.snapshot(this.ws, 'close', this.settings.backup.keepAutomatic);
    } catch (error) {
      log('error', 'backup.on-close-failed', error);
    }
    this.ws.close();
  }

  /** Replaces the workspace file with a validated copy, keeping a snapshot of the current one. */
  replaceWorkspace(sourceFile: string): void {
    this.backups.snapshot(this.ws, 'pre-restore', this.settings.backup.keepAutomatic + 1);
    this.ws.close();
    const target = this.paths.workspaceFile;
    for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
    copyFileSync(sourceFile, target);
    this.ws = Workspace.open(target);
  }

  putToken(kind: string, value: unknown, cleanup?: () => void): string {
    this.sweep();
    const token = randomUUID();
    this.pending.set(token, { kind, value, expires: Date.now() + TOKEN_TTL_MS, cleanup });
    return token;
  }

  takeToken<T>(kind: string, token: string, consume = false): T {
    this.sweep();
    const entry = this.pending.get(token);
    if (!entry || entry.kind !== kind) throw new Error('This step has expired. Start again.');
    if (consume) this.pending.delete(token);
    return entry.value as T;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) {
      if (entry.expires < now) {
        entry.cleanup?.();
        this.pending.delete(token);
      }
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) entry.cleanup?.();
    this.pending.clear();
    void this.ocr.dispose();
  }
}

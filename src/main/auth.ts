import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { Workspace } from './db/workspace';

/**
 * Super admin sign-in. The credential lives in the workspace `meta` table as a scrypt hash, never
 * as plain text. A fresh workspace is seeded with the temporary default admin / admin.
 * TODO: add a "change password" screen and force a change on first sign-in before release.
 */

const META_KEY = 'admin_credential';
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';
const KDF = { N: 2 ** 15, r: 8, p: 1, keyLength: 32 };

interface StoredCredential {
  username: string;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

function derive(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(
      password.normalize('NFC'),
      salt,
      KDF.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

async function storeCredential(ws: Workspace, username: string, password: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, KDF);
  const value: StoredCredential = {
    username,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
  };
  ws.db
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .run(META_KEY, JSON.stringify(value));
}

/** Seeds the default super admin when the workspace has none (new or restored from an old backup). */
export async function ensureAdmin(ws: Workspace): Promise<void> {
  const row = ws.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
  if (!row) await storeCredential(ws, DEFAULT_USERNAME, DEFAULT_PASSWORD);
}

/** True when the username and password match the stored super admin credential. */
export async function verifyAdmin(
  ws: Workspace,
  username: string,
  password: string,
): Promise<boolean> {
  await ensureAdmin(ws);
  const row = ws.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as
    { value: string } | undefined;
  if (!row) return false;
  const stored = JSON.parse(row.value) as StoredCredential;
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await derive(password, Buffer.from(stored.salt, 'base64'), stored);
  // Always run the hash, then compare both parts, so timing does not reveal which part was wrong.
  const passwordOk = actual.length === expected.length && timingSafeEqual(actual, expected);
  const userOk = username.trim().toLowerCase() === stored.username.toLowerCase();
  return passwordOk && userOk;
}

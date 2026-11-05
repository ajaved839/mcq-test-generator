import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureAdmin, verifyAdmin } from '../../src/main/auth';
import { Workspace } from '../../src/main/db/workspace';

describe('super admin sign-in', () => {
  let ws: Workspace;
  beforeEach(() => {
    ws = Workspace.open(':memory:');
  });
  afterEach(() => ws.close());

  it('accepts the seeded default credential and rejects others', async () => {
    expect(await verifyAdmin(ws, 'admin', 'admin')).toBe(true);
    expect(await verifyAdmin(ws, ' Admin ', 'admin')).toBe(true);
    expect(await verifyAdmin(ws, 'admin', 'wrong')).toBe(false);
    expect(await verifyAdmin(ws, 'someone', 'admin')).toBe(false);
  });

  it('stores only a salted hash, never the password', async () => {
    await ensureAdmin(ws);
    const row = ws.db.prepare("SELECT value FROM meta WHERE key = 'admin_credential'").get() as {
      value: string;
    };
    const stored = JSON.parse(row.value) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['N', 'hash', 'p', 'r', 'salt', 'username']);
    expect(stored.hash).not.toBe('admin');
  });
});

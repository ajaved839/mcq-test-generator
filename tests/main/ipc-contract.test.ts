import { describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../../src/shared/ipc';

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {}, nativeImage: {} }));

describe('IPC contract', () => {
  it('preload allowlist matches the main-process handlers exactly', async () => {
    const { api } = await import('../../src/main/api');
    expect([...CHANNELS].sort()).toEqual(Object.keys(api).sort());
  });

  it('every handler validates its input', async () => {
    const { api } = await import('../../src/main/api');
    for (const [name, def] of Object.entries(api)) {
      expect(typeof (def as { input: { safeParse: unknown } }).input.safeParse, name).toBe(
        'function',
      );
    }
    // Unknown keys are rejected rather than stored.
    expect(api['bank:get'].input.safeParse({ id: 'x', extra: 1 }).success).toBe(false);
    expect(
      api['bank:list'].input.safeParse({ search: "x'; DROP TABLE questions; --" }).success,
    ).toBe(true);
    expect(api['backup:restore'].input.safeParse({ token: 't' }).success).toBe(false);
  });
});

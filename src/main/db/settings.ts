import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../../shared/schemas';
import type { Workspace } from './workspace';

/** Settings live in one JSON row, merged over defaults so new keys appear after upgrades. */

function deepMerge<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return (patch === undefined ? base : patch) as T;
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key in out) out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

export function getSettings(ws: Workspace): Settings {
  const row = ws.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
    { value: string } | undefined;
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(row.value));
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(ws: Workspace, patch: unknown): Settings {
  const next = settingsSchema.parse(deepMerge(getSettings(ws), patch));
  ws.db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .run(JSON.stringify(next));
  return next;
}

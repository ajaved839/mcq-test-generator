import { createHash } from 'node:crypto';
import type { Workspace } from './workspace';
import { nowIso } from './workspace';

/** Images are stored once by SHA-256, so the same diagram imported twice costs nothing. */

export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export interface StoredImage {
  hash: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
}

/** Stores bytes after checking they really are an allowed image type. */
export function putImage(
  ws: Workspace,
  bytes: Uint8Array,
  size: { width?: number; height?: number } = {},
): string {
  const mime = sniffImageMime(bytes);
  if (!mime || !ALLOWED_IMAGE_MIME.has(mime)) {
    throw new Error('Only PNG, JPEG, GIF and WebP images can be stored.');
  }
  const hash = sha256(bytes);
  ws.db
    .prepare(
      'INSERT OR IGNORE INTO images (hash, mime, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(hash, mime, size.width ?? null, size.height ?? null, bytes, nowIso());
  return hash;
}

export function getImage(ws: Workspace, hash: string): StoredImage | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const row = ws.db.prepare('SELECT * FROM images WHERE hash = ?').get(hash) as
    | { hash: string; mime: string; width: number | null; height: number | null; bytes: Uint8Array }
    | undefined;
  return row ? { ...row } : null;
}

export function hasImage(ws: Workspace, hash: string): boolean {
  return !!ws.db.prepare('SELECT 1 FROM images WHERE hash = ?').get(hash);
}

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local diagnostics log. Exam content never goes here: messages are event names plus
 * redacted error text (quoted strings removed, length capped). "Save diagnostics" copies it.
 */

const MAX_BYTES = 1024 * 1024;
let logFile: string | null = null;

export function initLogger(dir: string): string {
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, 'app.log');
  return logFile;
}

export function redact(value: string): string {
  return value
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s]+/gi, '<home>')
    .slice(0, 2000);
}

function rotate(file: string): void {
  if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
}

export function log(level: 'info' | 'warn' | 'error', event: string, detail?: unknown): void {
  const line: Record<string, unknown> = { at: new Date().toISOString(), level, event };
  if (detail instanceof Error) {
    line.error = {
      name: detail.name,
      message: redact(detail.message),
      stack: redact(detail.stack ?? ''),
    };
  } else if (detail !== undefined) {
    line.detail = typeof detail === 'string' ? redact(detail) : detail;
  }
  const text = `${JSON.stringify(line)}\n`;
  if (level === 'error') console.error(text.trim());
  if (!logFile) return;
  try {
    rotate(logFile);
    appendFileSync(logFile, text);
  } catch {
    // Logging must never crash the app.
  }
}

export function logPath(): string | null {
  return logFile;
}

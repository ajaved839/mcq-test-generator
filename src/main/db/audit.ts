import type { Workspace, ActorContext } from './workspace';
import { nowIso } from './workspace';

/**
 * Audit trail (FR-14): who imported, edited, generated, exported, restored or merged what,
 * and when. Details hold IDs, titles and counts; never question wording or answers.
 */

export type AuditAction =
  | 'import.staged'
  | 'import.deleted'
  | 'review.approved'
  | 'review.rejected'
  | 'review.merged'
  | 'review.skipped'
  | 'question.created'
  | 'question.edited'
  | 'question.archived'
  | 'question.restored'
  | 'question.deleted'
  | 'question.reverted'
  | 'test.generated'
  | 'test.outside-imported'
  | 'test.exported'
  | 'test.comparison-changed'
  | 'settings.changed'
  | 'backup.created'
  | 'backup.restored'
  | 'merge.exported'
  | 'merge.applied'
  | 'session.started';

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  osUser: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export function audit(
  ws: Workspace,
  ctx: ActorContext,
  action: AuditAction,
  entityType = '',
  entityId = '',
  details: Record<string, unknown> = {},
): void {
  ws.db
    .prepare(
      'INSERT INTO audit_log (at, actor, os_user, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(nowIso(), ctx.actor, ctx.osUser, action, entityType, entityId, JSON.stringify(details));
}

export interface AuditQuery {
  action?: string;
  entityId?: string;
  limit: number;
  offset: number;
}

export function listAudit(
  ws: Workspace,
  query: AuditQuery,
): { total: number; entries: AuditEntry[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (query.action) {
    where.push('action LIKE ?');
    params.push(`${query.action}%`);
  }
  if (query.entityId) {
    where.push('entity_id = ?');
    params.push(query.entityId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    ws.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as { n: number }
  ).n;
  const rows = ws.db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.limit, query.offset) as Array<Record<string, string | number>>;
  return {
    total,
    entries: rows.map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      actor: String(r.actor),
      osUser: String(r.os_user),
      action: r.action as AuditAction,
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      details: JSON.parse(String(r.details)) as Record<string, unknown>,
    })),
  };
}

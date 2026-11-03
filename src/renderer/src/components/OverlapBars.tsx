import { Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import type { OverlapReport } from '../../../core/overlap';
import { formatDate } from '../lib';

/** Overlap with each earlier test, with the limit drawn on every bar. Status uses icon + words. */
export function OverlapBars({ report, max = 12 }: { report: OverlapReport; max?: number }) {
  const limit = report.rule.limitPct;
  const scale = Math.max(limit * 2, ...report.perTest.map((t) => t.pct), 10);
  const rows = report.perTest.slice(0, max);
  return (
    <Stack gap={8}>
      {rows.map((t) => {
        const over = report.rule.mode === 'each' && !t.passes;
        return (
          <Group key={t.testId} wrap="nowrap" gap="sm">
            <Text size="sm" w={220} truncate title={t.title}>
              {t.title}
              {t.kind === 'outside' ? ' (imported)' : ''}
              <Text span size="xs" c="dimmed">
                {' '}
                {formatDate(t.createdAt)}
              </Text>
            </Text>
            <div
              className="overlap-track"
              style={{ flex: 1 }}
              role="img"
              aria-label={`${t.pct}% shared with ${t.title}; limit ${limit}%`}
            >
              <div
                className="overlap-fill"
                style={{
                  width: `${Math.min(100, (t.pct / scale) * 100)}%`,
                  background: over
                    ? 'var(--mantine-color-red-7)'
                    : t.pct === report.highestPct && t.pct > 0
                      ? 'var(--mantine-color-calmBlue-6)'
                      : 'var(--mantine-color-gray-5)',
                }}
              />
              <div className="overlap-limit" style={{ left: `${(limit / scale) * 100}%` }} />
            </div>
            <Group gap={4} w={150} wrap="nowrap">
              {over ? (
                <IconAlertTriangle size={14} color="var(--mantine-color-red-7)" aria-hidden />
              ) : (
                <IconCircleCheck size={14} color="var(--mantine-color-clinical-7)" aria-hidden />
              )}
              <Text size="sm">
                {t.pct}% ({t.shared}){over ? ' over limit' : ''}
              </Text>
            </Group>
          </Group>
        );
      })}
      {report.perTest.length > max ? (
        <Text size="xs" c="dimmed">
          {report.perTest.length - max} more tests, all lower.
        </Text>
      ) : null}
      {!report.perTest.length ? (
        <Text size="sm" c="dimmed">
          No earlier tests to compare with yet.
        </Text>
      ) : null}
      <Text size="xs" c="dimmed">
        Dashed line: the {limit}% limit.
      </Text>
    </Stack>
  );
}

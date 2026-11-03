import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCircleCheck,
  IconClipboardList,
  IconFileImport,
  IconHelpCircle,
} from '@tabler/icons-react';
import { call } from '../api';
import { formatDate, useLoad, useNav } from '../lib';

/** Home: bank health at a glance, remaining capacity, recent tests and quick actions. */
export function Home() {
  const { go } = useNav();
  const { data, loading } = useLoad(() => call('home:summary'));
  if (loading && !data) return <Loader aria-label="Loading" />;
  if (!data) return null;
  const { totals, capacity, recentTests, openBatches } = data;

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>Home</Title>
        <Group>
          <Button
            leftSection={<IconFileImport size={18} aria-hidden />}
            variant="light"
            onClick={() => go({ screen: 'import' })}
          >
            Import questions
          </Button>
          <Button
            leftSection={<IconClipboardList size={18} aria-hidden />}
            onClick={() => go({ screen: 'generate' })}
          >
            Generate a test
          </Button>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Card>
          <Text size="sm" c="dimmed">
            Questions in the bank
          </Text>
          <Text fz={28} fw={700}>
            {totals.active}
          </Text>
          <Text size="xs" c="dimmed">
            {totals.archived} archived
          </Text>
        </Card>
        <Card>
          <Text size="sm" c="dimmed">
            Tests saved
          </Text>
          <Text fz={28} fw={700}>
            {totals.tests}
          </Text>
          <Text size="xs" c="dimmed">
            All count toward the repeat rule
          </Text>
        </Card>
        <Card>
          <Text size="sm" c="dimmed">
            Waiting for review
          </Text>
          <Text fz={28} fw={700}>
            {totals.pendingReview}
          </Text>
          <Text size="xs" c="dimmed">
            Imported, not yet in the bank
          </Text>
        </Card>
        <Card>
          <Text size="sm" c="dimmed">
            Fresh questions
          </Text>
          <Text fz={28} fw={700}>
            {capacity.reduce((s, c) => s + c.fresh, 0)}
          </Text>
          <Text size="xs" c="dimmed">
            Never used in any test
          </Text>
        </Card>
      </SimpleGrid>

      {openBatches.length ? (
        <Alert
          color="calmBlue"
          icon={<IconAlertCircle aria-hidden />}
          title="Imports waiting for review"
        >
          <Group gap="xs">
            {openBatches.map((b) => (
              <Button
                key={b.id}
                size="xs"
                variant="white"
                onClick={() => go({ screen: 'import', params: { batch: b.id } })}
              >
                {b.fileName || b.sourceType}: {b.counts.pending} to review
              </Button>
            ))}
          </Group>
        </Alert>
      ) : null}

      <Card>
        <Group justify="space-between" mb="xs">
          <Title order={3} size="h4">
            Bank health by subject
          </Title>
          <Group gap={4}>
            <IconHelpCircle size={16} aria-hidden />
            <Text size="xs" c="dimmed">
              Keep each subject's pool at least 7 times the questions it puts on a paper.
            </Text>
          </Group>
        </Group>
        {capacity.length ? (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Subject</Table.Th>
                <Table.Th>Questions</Table.Th>
                <Table.Th>Easy / Medium / Hard</Table.Th>
                <Table.Th>Fresh</Table.Th>
                <Table.Th>Used</Table.Th>
                <Table.Th>On the last paper</Table.Th>
                <Table.Th>Remaining capacity</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {capacity.map((c) => (
                <Table.Tr key={c.subject}>
                  <Table.Td fw={600}>{c.subject}</Table.Td>
                  <Table.Td>
                    {c.active}
                    {c.reserved ? ` (${c.reserved} reserved)` : ''}
                  </Table.Td>
                  <Table.Td>
                    {c.byDifficulty.easy} / {c.byDifficulty.medium} / {c.byDifficulty.hard}
                  </Table.Td>
                  <Table.Td>{c.fresh}</Table.Td>
                  <Table.Td>{c.used}</Table.Td>
                  <Table.Td>{c.recentShare ?? 'n/a'}</Table.Td>
                  <Table.Td>
                    {c.status === 'unknown' ? (
                      <Text size="sm" c="dimmed">
                        Generate a test to estimate
                      </Text>
                    ) : (
                      <Group gap={6} wrap="nowrap">
                        {c.status === 'healthy' ? (
                          <Badge
                            color="clinical"
                            variant="light"
                            leftSection={<IconCircleCheck size={12} aria-hidden />}
                          >
                            Healthy
                          </Badge>
                        ) : (
                          <Badge
                            color="orange"
                            variant="light"
                            leftSection={<IconAlertCircle size={12} aria-hidden />}
                          >
                            Low
                          </Badge>
                        )}
                        <Text size="sm">
                          {c.freshPapersLeft} more papers with all-new questions; pool target{' '}
                          {c.recommendedPool}
                        </Text>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed">
            The bank is empty. Import questions from Excel, Word or photos to get started.
          </Text>
        )}
      </Card>

      <Card>
        <Title order={3} size="h4" mb="xs">
          Recent tests
        </Title>
        {recentTests.length ? (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Date</Table.Th>
                <Table.Th>Questions</Table.Th>
                <Table.Th>Highest repeat</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {recentTests.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>
                    {t.title}
                    {t.kind === 'outside' ? ' (imported)' : ''}
                  </Table.Td>
                  <Table.Td>{formatDate(t.createdAt)}</Table.Td>
                  <Table.Td>{t.questionCount}</Table.Td>
                  <Table.Td>{t.highestPct === null ? 'n/a' : `${t.highestPct}%`}</Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => go({ screen: 'tests', params: { test: t.id } })}
                    >
                      Open
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text c="dimmed">No tests yet.</Text>
        )}
      </Card>
    </Stack>
  );
}

import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Grid,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconDownload, IconUpload } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { call, fileToUpload, type Out } from '../api';
import { ExportDialog } from '../components/ExportDialog';
import { OverlapBars } from '../components/OverlapBars';
import { PaperPreview } from '../components/PaperPreview';
import { formatDate, formatDateTime, notifyOk, RichView, useAction, useLoad, useNav } from '../lib';

const EXPORT_LABEL: Record<string, string> = {
  'paper-pdf': 'Paper PDF',
  'paper-docx': 'Paper Word',
  'key-pdf': 'Answer key PDF',
  'key-docx': 'Answer key Word',
  'record-xlsx': 'Test record Excel',
};

function TestDetailView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useLoad(() => call('tests:get', { id }), [id]);
  const [version, setVersion] = useState<'A' | 'B' | 'C' | 'D'>('A');
  const [paper, setPaper] = useState<Out<'tests:preview'> | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, run] = useAction();

  useEffect(() => setPaper(null), [id, version]);
  if (detail.loading && !detail.data) return <Loader aria-label="Loading test" />;
  if (!detail.data) return null;
  const { test, exports } = detail.data;
  const versions = (test.settings.versions ?? []).map((v) => v.letter);
  const request = test.settings.request;

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={3} size="h4">
            {test.title}
          </Title>
          <Text size="sm" c="dimmed">
            {test.kind === 'outside'
              ? `Imported from ${test.sourceFile}`
              : `Generated ${formatDateTime(test.createdAt)} by ${test.createdBy}`}{' '}
            · {test.questionCount} questions{test.code ? ` · ${test.code}` : ''}
          </Text>
        </div>
        {test.kind === 'generated' ? (
          <Button
            leftSection={<IconDownload size={16} aria-hidden />}
            onClick={() => setExportOpen(true)}
          >
            Export or reprint
          </Button>
        ) : null}
      </Group>
      <Switch
        label="Count this test in the repeat rule"
        checked={test.includedInRule}
        onChange={async (e) => {
          const included = e.currentTarget.checked;
          await run(() => call('tests:setIncluded', { id, included }));
          void detail.reload();
          onChanged();
        }}
      />
      {request ? (
        <Card>
          <Text size="sm">
            Rule:{' '}
            {request.rule.mode === 'each'
              ? 'each earlier test separately'
              : 'all earlier tests combined'}
            , {request.rule.limitPct}%
            {request.rule.denominator === 'smaller' ? ', measured against the smaller test' : ''}.
            Seed {test.seed}.{' '}
            {test.report
              ? `Highest repeat when saved: ${test.report.highestPct}%; ${test.report.freshCount} new questions.`
              : ''}
          </Text>
        </Card>
      ) : null}
      <Tabs defaultValue={test.kind === 'generated' ? 'paper' : 'questions'}>
        <Tabs.List>
          {test.kind === 'generated' ? <Tabs.Tab value="paper">Paper</Tabs.Tab> : null}
          {test.report ? <Tabs.Tab value="overlap">Overlap when saved</Tabs.Tab> : null}
          <Tabs.Tab value="questions">Questions</Tabs.Tab>
          <Tabs.Tab value="exports">Exports ({exports.length})</Tabs.Tab>
        </Tabs.List>
        {test.kind === 'generated' ? (
          <Tabs.Panel value="paper" pt="md">
            <Group mb="sm">
              {versions.length > 1 ? (
                <Select
                  aria-label="Version"
                  data={versions.map((v) => ({ value: v, label: `Version ${v}` }))}
                  value={version}
                  onChange={(v) => setVersion((v ?? 'A') as typeof version)}
                  allowDeselect={false}
                />
              ) : null}
              <Button
                variant="light"
                loading={busy}
                onClick={async () =>
                  setPaper((await run(() => call('tests:preview', { id, version }))) ?? null)
                }
              >
                Show paper
              </Button>
            </Group>
            {paper ? (
              <PaperPreview css={paper.css} body={paper.body} label={`Paper, version ${version}`} />
            ) : null}
          </Tabs.Panel>
        ) : null}
        {test.report ? (
          <Tabs.Panel value="overlap" pt="md">
            <OverlapBars report={test.report} max={30} />
          </Tabs.Panel>
        ) : null}
        <Tabs.Panel value="questions" pt="md">
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={50}>No.</Table.Th>
                <Table.Th>Question (as printed)</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th>In bank</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {test.questions.map((q) => (
                <Table.Tr key={q.position}>
                  <Table.Td>{q.position + 1}</Table.Td>
                  <Table.Td>
                    <RichView value={q.snapshot.stem} />
                  </Table.Td>
                  <Table.Td>{q.snapshot.subject}</Table.Td>
                  <Table.Td>
                    {q.questionId ? (
                      'Yes'
                    ) : (
                      <Badge color="gray" variant="light">
                        Not matched
                      </Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
        <Tabs.Panel value="exports" pt="md">
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Exported</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {exports.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{e.fileName}</Table.Td>
                  <Table.Td>
                    {EXPORT_LABEL[e.kind] ?? e.kind}
                    {e.versionLetter ? ` (${e.versionLetter})` : ''}
                  </Table.Td>
                  <Table.Td>
                    {formatDateTime(e.createdAt)} by {e.createdBy}
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={async () => {
                        const r = await run(() => call('export:reprint', { exportId: e.id }));
                        if (r?.saved) notifyOk('Identical copy saved.');
                      }}
                    >
                      Save identical copy
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
              {!exports.length ? (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text c="dimmed" size="sm">
                      Not exported yet.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : null}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
      </Tabs>
      {exportOpen ? (
        <ExportDialog
          testId={id}
          versions={versions}
          opened={exportOpen}
          onClose={() => {
            setExportOpen(false);
            void detail.reload();
          }}
        />
      ) : null}
    </Stack>
  );
}

function OverlapChecker({ tests }: { tests: Out<'tests:list'> }) {
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [result, setResult] = useState<Out<'tests:compare'> | null>(null);
  const [busy, run] = useAction();
  const data = tests.map((t) => ({
    value: t.id,
    label: `${t.title} (${formatDate(t.createdAt)})`,
  }));
  return (
    <Stack>
      <Group align="flex-end">
        <Select label="Test A" data={data} value={a} onChange={setA} searchable w={320} />
        <Select label="Test B" data={data} value={b} onChange={setB} searchable w={320} />
        <Button
          disabled={!a || !b || a === b}
          loading={busy}
          onClick={async () =>
            setResult((await run(() => call('tests:compare', { a: a!, b: b! }))) ?? null)
          }
        >
          Compare
        </Button>
      </Group>
      {result ? (
        <Card>
          <Text fw={600}>
            {result.shared.length} shared questions: {result.pctOfA}% of "{result.a.title}" and{' '}
            {result.pctOfB}% of "{result.b.title}".
          </Text>
          <Table mt="sm" striped>
            <Table.Tbody>
              {result.shared.map((s, i) => (
                <Table.Tr key={s.questionId}>
                  <Table.Td w={40}>{i + 1}</Table.Td>
                  <Table.Td>
                    <RichView value={s.snapshot.stem} />
                  </Table.Td>
                  <Table.Td>{s.snapshot.subject}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      ) : null}
    </Stack>
  );
}

function OutsideImport({ onSaved }: { onSaved: (id: string) => void }) {
  const [analysis, setAnalysis] = useState<Out<'tests:outsideAnalyze'> | null>(null);
  const [confirmed, setConfirmed] = useState<Record<number, boolean>>({});
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [busy, run] = useAction();

  return (
    <Stack>
      <Text size="sm">
        Add a test made outside the app (Word, Excel or CSV) so the repeat rule and the overlap
        checker see it. Questions are matched to the bank by wording; confirm doubtful matches.
      </Text>
      <Dropzone
        onDrop={async ([f]) => {
          const r = await run(async () => call('tests:outsideAnalyze', await fileToUpload(f)));
          if (r) {
            setAnalysis(r);
            setTitle(f.name.replace(/\.[^.]+$/, ''));
            setConfirmed(Object.fromEntries(r.matches.map((m) => [m.position, m.exact])));
          }
        }}
        accept={['.docx', '.xlsx', '.csv']}
        maxFiles={1}
        loading={busy}
      >
        <Group justify="center" mih={80}>
          <IconUpload size={24} aria-hidden />
          <Text>Drop the outside test file here</Text>
        </Group>
      </Dropzone>
      {analysis ? (
        <Card>
          <Stack>
            <Group>
              <TextInput
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                w={320}
              />
              <TextInput
                type="date"
                label="Date given"
                value={date}
                onChange={(e) => setDate(e.currentTarget.value)}
              />
            </Group>
            <Text size="sm">
              {analysis.matches.filter((m) => m.questionId).length} of {analysis.matches.length}{' '}
              questions look like bank questions.
            </Text>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Outside question</Table.Th>
                  <Table.Th>Closest bank question</Table.Th>
                  <Table.Th>Match</Table.Th>
                  <Table.Th>Same question?</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {analysis.matches.map((m) => (
                  <Table.Tr key={m.position}>
                    <Table.Td>{m.stemText}</Table.Td>
                    <Table.Td>
                      {m.bankStemText || (
                        <Text c="dimmed" size="sm">
                          No match
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {m.questionId ? `${m.score}%${m.exact ? ' (exact)' : ''}` : ''}
                    </Table.Td>
                    <Table.Td>
                      {m.questionId ? (
                        <Checkbox
                          aria-label="Same question"
                          checked={!!confirmed[m.position]}
                          onChange={(e) =>
                            setConfirmed({ ...confirmed, [m.position]: e.currentTarget.checked })
                          }
                        />
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Group>
              <Button
                loading={busy}
                disabled={!title.trim()}
                onClick={async () => {
                  const t = await run(() =>
                    call('tests:outsideSave', {
                      token: analysis.token,
                      title: title.trim(),
                      date: date || null,
                      confirmations: analysis.matches.map((m) => ({
                        position: m.position,
                        questionId: confirmed[m.position] ? m.questionId : null,
                      })),
                    }),
                  );
                  if (t) {
                    notifyOk(`"${t.title}" added. It now counts toward the repeat rule.`);
                    setAnalysis(null);
                    onSaved(t.id);
                  }
                }}
              >
                Save outside test
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

/** Tests and history: filterable list, detail with reprint, overlap checker, outside tests. */
export function Tests() {
  const { params } = useNav();
  const tests = useLoad(() => call('tests:list'));
  const [selected, setSelected] = useState<string | null>(params.test ?? null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<string | null>('history');
  const list = (tests.data ?? []).filter(
    (t) =>
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      t.code.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Stack gap="md">
      <Title order={2}>Tests and history</Title>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="history">History</Tabs.Tab>
          <Tabs.Tab value="compare">Overlap checker</Tabs.Tab>
          <Tabs.Tab value="outside">Add an outside test</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="history" pt="md">
          <Grid>
            <Grid.Col span={4}>
              <TextInput
                placeholder="Search by title or code"
                aria-label="Search tests"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                mb="sm"
              />
              <Stack gap={4}>
                {list.map((t) => (
                  <Button
                    key={t.id}
                    variant={t.id === selected ? 'light' : 'subtle'}
                    color={t.id === selected ? 'clinical' : 'dark'}
                    justify="space-between"
                    onClick={() => setSelected(t.id)}
                    rightSection={
                      !t.includedInRule ? (
                        <Badge size="xs" color="gray">
                          Not compared
                        </Badge>
                      ) : t.kind === 'outside' ? (
                        <Badge size="xs" color="calmBlue">
                          Imported
                        </Badge>
                      ) : null
                    }
                    styles={{ inner: { justifyContent: 'space-between' } }}
                  >
                    <span>
                      {t.title} · {formatDate(t.createdAt)}
                    </span>
                  </Button>
                ))}
                {!list.length ? (
                  <Text c="dimmed" size="sm">
                    No tests yet.
                  </Text>
                ) : null}
              </Stack>
            </Grid.Col>
            <Grid.Col span={8}>
              {selected ? (
                <TestDetailView id={selected} onChanged={() => void tests.reload()} />
              ) : (
                <Alert color="gray">Select a test to see its paper, overlap and exports.</Alert>
              )}
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
        <Tabs.Panel value="compare" pt="md">
          <OverlapChecker tests={tests.data ?? []} />
        </Tabs.Panel>
        <Tabs.Panel value="outside" pt="md">
          <OutsideImport
            onSaved={(id) => {
              void tests.reload();
              setSelected(id);
              setTab('history');
            }}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

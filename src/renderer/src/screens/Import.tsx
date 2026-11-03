import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Image,
  List,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconCamera, IconFileSpreadsheet, IconFileText, IconUpload } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { FIELD_LABELS, FIELDS, type ColumnMapping, type Field } from '../../../core/tabular';
import type { Difficulty } from '../../../core/types';
import { call, fileToUpload, onProgress, type Out } from '../api';
import { useAppData } from '../App';
import { ReviewQueue } from '../components/ReviewQueue';
import { formatDateTime, notifyError, notifyOk, useAction, useLoad, useNav } from '../lib';
import { pdfToImages, type RenderedPage } from '../pdf';

type Source = 'excel' | 'word' | 'photo';

interface Defaults {
  subject: string;
  topic: string;
  difficulty: Difficulty;
  source: string;
}

const CONVENTIONS = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'answer-line', label: 'Answer lines ("Ans: b")' },
  { value: 'answer-key', label: 'Answer key at the end' },
  { value: 'bold', label: 'Bold option' },
  { value: 'highlight', label: 'Highlighted option' },
  { value: 'asterisk', label: 'Asterisk (*) after the option' },
] as const;
type Convention = (typeof CONVENTIONS)[number]['value'];

function DefaultsFields({
  value,
  onChange,
  subjects,
}: {
  value: Defaults;
  onChange: (v: Defaults) => void;
  subjects: string[];
}) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 4 }}>
      <Select
        label="Subject for these questions"
        data={subjects}
        value={value.subject || null}
        onChange={(v) => onChange({ ...value, subject: v ?? '' })}
        required
      />
      <TextInput
        label="Topic (optional)"
        value={value.topic}
        onChange={(e) => onChange({ ...value, topic: e.currentTarget.value })}
      />
      <Select
        label="Difficulty"
        data={[
          { value: 'easy', label: 'Easy' },
          { value: 'medium', label: 'Medium' },
          { value: 'hard', label: 'Hard' },
        ]}
        value={value.difficulty}
        onChange={(v) => onChange({ ...value, difficulty: (v ?? 'medium') as Difficulty })}
        allowDeselect={false}
      />
      <TextInput
        label="Source"
        placeholder="Book or file name"
        value={value.source}
        onChange={(e) => onChange({ ...value, source: e.currentTarget.value })}
      />
    </SimpleGrid>
  );
}

function ExcelFlow({ onStaged }: { onStaged: (batchId: string) => void }) {
  const { settings } = useAppData();
  const [file, setFile] = useState<Out<'import:tableRead'> | null>(null);
  const [sheet, setSheet] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [check, setCheck] = useState<Out<'import:tableValidate'> | null>(null);
  const [includeInvalid, setIncludeInvalid] = useState(true);
  const [busy, run] = useAction();

  const headers = file?.sheets[sheet]?.headers ?? [];
  const columnOptions = [
    { value: '-1', label: '(not in this file)' },
    ...headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
  ];

  return (
    <Stack>
      <Group>
        <Button
          variant="light"
          onClick={() => void run(() => call('import:template', { format: 'xlsx' }))}
        >
          Download Excel template
        </Button>
        <Button
          variant="subtle"
          onClick={() => void run(() => call('import:template', { format: 'csv' }))}
        >
          Download CSV template
        </Button>
      </Group>
      <Dropzone
        onDrop={async ([f]) => {
          const r = await run(async () => call('import:tableRead', await fileToUpload(f)));
          if (r) {
            setFile(r);
            setSheet(0);
            setMapping(r.mapping);
            setCheck(null);
          }
        }}
        accept={[
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.csv',
          '.xlsx',
        ]}
        maxFiles={1}
        loading={busy}
      >
        <Group justify="center" mih={90}>
          <IconUpload size={28} aria-hidden />
          <Text>Drop an .xlsx or .csv file here, or click to choose one</Text>
        </Group>
      </Dropzone>
      {file && mapping ? (
        <Card>
          <Stack>
            <Group justify="space-between">
              <Title order={3} size="h5">
                {file.fileName}: match the columns
              </Title>
              {file.sheets.length > 1 ? (
                <Select
                  aria-label="Sheet"
                  data={file.sheets.map((s, i) => ({
                    value: String(i),
                    label: `${s.name} (${s.rowCount} rows)`,
                  }))}
                  value={String(sheet)}
                  onChange={(v) => setSheet(Number(v))}
                />
              ) : (
                <Text size="sm" c="dimmed">
                  {file.sheets[0]?.rowCount ?? 0} rows
                </Text>
              )}
            </Group>
            <SimpleGrid cols={{ base: 2, md: 4 }}>
              {FIELDS.map((field: Field) => (
                <Select
                  key={field}
                  label={FIELD_LABELS[field]}
                  data={columnOptions}
                  value={String(mapping[field])}
                  onChange={(v) => {
                    setMapping({ ...mapping, [field]: Number(v ?? -1) });
                    setCheck(null);
                  }}
                  allowDeselect={false}
                />
              ))}
            </SimpleGrid>
            <Group>
              <Button
                onClick={async () =>
                  setCheck(
                    (await run(() =>
                      call('import:tableValidate', { token: file.token, sheet, mapping }),
                    )) ?? null,
                  )
                }
                loading={busy}
              >
                Check rows
              </Button>
            </Group>
            {check ? (
              <Stack>
                <Group>
                  <Badge color="clinical" variant="light">
                    {check.valid} ready
                  </Badge>
                  <Badge color={check.invalidCount ? 'red' : 'gray'} variant="light">
                    {check.invalidCount} with problems
                  </Badge>
                  <Badge color="yellow" variant="light">
                    {check.warnings} with notes
                  </Badge>
                </Group>
                {check.invalid.length ? (
                  <Table striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={80}>Row</Table.Th>
                        <Table.Th>What to fix</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {check.invalid.slice(0, 100).map((r) => (
                        <Table.Tr key={r.row}>
                          <Table.Td>{r.row}</Table.Td>
                          <Table.Td>
                            <List size="sm">
                              {r.errors.map((e) => (
                                <List.Item key={e}>{e}</List.Item>
                              ))}
                            </List>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                ) : null}
                <Checkbox
                  label="Also send rows with problems to the review queue so they can be fixed there"
                  checked={includeInvalid}
                  onChange={(e) => setIncludeInvalid(e.currentTarget.checked)}
                />
                <Group>
                  <Button
                    loading={busy}
                    onClick={async () => {
                      const batch = await run(() =>
                        call('import:tableStage', {
                          token: file.token,
                          sheet,
                          mapping,
                          includeInvalid,
                          defaults: {
                            subject: settings.subjects[0] ?? '',
                            topic: '',
                            difficulty: 'medium',
                            source: file.fileName,
                          },
                        }),
                      );
                      if (batch) {
                        notifyOk(
                          `${batch.total} rows sent to the review queue. Nothing is in the bank until approved.`,
                        );
                        onStaged(batch.id);
                      }
                    }}
                  >
                    Send to review
                  </Button>
                </Group>
              </Stack>
            ) : null}
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

function WordFlow({ onStaged }: { onStaged: (batchId: string) => void }) {
  const { settings } = useAppData();
  const [analysis, setAnalysis] = useState<
    (Out<'import:docxAnalyze'> & { fileName: string }) | null
  >(null);
  const [convention, setConvention] = useState<Convention>('auto');
  const [defaults, setDefaults] = useState<Defaults>({
    subject: settings.subjects[0] ?? '',
    topic: '',
    difficulty: 'medium',
    source: '',
  });
  const [busy, run] = useAction();

  return (
    <Stack>
      <Dropzone
        onDrop={async ([f]) => {
          const r = await run(async () => call('import:docxAnalyze', await fileToUpload(f)));
          if (r) {
            setAnalysis({ ...r, fileName: f.name });
            setConvention(r.suggested);
            setDefaults((d) => ({ ...d, source: f.name }));
          }
        }}
        accept={[
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.docx',
        ]}
        maxFiles={1}
        loading={busy}
      >
        <Group justify="center" mih={90}>
          <IconUpload size={28} aria-hidden />
          <Text>Drop a Word (.docx) file here. Old .doc files must be saved as .docx first.</Text>
        </Group>
      </Dropzone>
      {analysis ? (
        <Card>
          <Stack>
            <Title order={3} size="h5">
              {analysis.fileName}
            </Title>
            <Text size="sm">
              Found {analysis.mcqs} questions, {analysis.stats.images} images,{' '}
              {analysis.stats.equations} equations and {analysis.stats.tables} tables.
              {analysis.unplaced
                ? ` ${analysis.unplaced} blocks of text could not be placed and will be flagged in review.`
                : ''}
              {analysis.stats.notes
                ? ` ${analysis.stats.notes} items need attention (for example old MathType equations).`
                : ''}
            </Text>
            <Select
              label="How are answers marked in this file?"
              description={`Seen in this file: answer lines ${analysis.detected['answer-line']}, answer key ${analysis.detected['answer-key']}, bold ${analysis.detected.bold}, highlighted ${analysis.detected.highlight}, asterisk ${analysis.detected.asterisk}`}
              data={CONVENTIONS.map((c) => ({ ...c }))}
              value={convention}
              onChange={(v) => setConvention((v ?? 'auto') as Convention)}
              allowDeselect={false}
            />
            <DefaultsFields value={defaults} onChange={setDefaults} subjects={settings.subjects} />
            <Group>
              <Button
                loading={busy}
                disabled={!defaults.subject}
                onClick={async () => {
                  const r = await run(() =>
                    call('import:docxStage', { token: analysis.token, convention, defaults }),
                  );
                  if (r) {
                    notifyOk(
                      `${r.mcqs} questions sent to review${r.unplaced ? `, ${r.unplaced} flagged blocks` : ''}.`,
                    );
                    onStaged(r.batch.id);
                  }
                }}
              >
                Send to review
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

function PhotoFlow({ onStaged }: { onStaged: (batchId: string) => void }) {
  const { settings } = useAppData();
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [convention, setConvention] = useState<Convention>('auto');
  const [defaults, setDefaults] = useState<Defaults>({
    subject: settings.subjects[0] ?? '',
    topic: '',
    difficulty: 'medium',
    source: '',
  });
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [busy, run] = useAction();

  useEffect(
    () =>
      onProgress((p) => {
        if (p.task === 'ocr')
          setProgress({
            label: p.label,
            pct: p.total ? Math.round((p.current / p.total) * 100) : 0,
          });
      }),
    [],
  );

  const addFiles = async (files: File[]): Promise<void> => {
    const added: RenderedPage[] = [];
    for (const f of files) {
      if (/\.(heic|heif)$/i.test(f.name)) {
        notifyError(
          new Error(
            'iPhone HEIC photos are not supported. Export them as JPEG, or set the camera to "Most Compatible".',
          ),
        );
        continue;
      }
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        setProgress({ label: `Preparing ${f.name}`, pct: 0 });
        added.push(
          ...(await pdfToImages(f, (done, total) =>
            setProgress({
              label: `Preparing ${f.name}: page ${done} of ${total}`,
              pct: Math.round((done / total) * 100),
            }),
          )),
        );
      } else {
        added.push({
          fileName: f.name,
          bytes: new Uint8Array(await f.arrayBuffer()),
          previewUrl: URL.createObjectURL(f),
        });
      }
    }
    setProgress(null);
    setPages((p) => [...p, ...added]);
    if (!defaults.source && files[0]) setDefaults((d) => ({ ...d, source: files[0].name }));
  };

  return (
    <Stack>
      <Alert color="calmBlue" title="For the best results">
        Photograph pages flat and well lit, filling the frame, or scan at 300 dpi. Curved pages,
        small print, chemical structures and handwriting need more correction. Every question is
        checked in review before it enters the bank.
      </Alert>
      <Dropzone
        onDrop={(files) => void run(() => addFiles(files))}
        accept={['image/jpeg', 'image/png', 'application/pdf']}
        loading={busy && !progress}
      >
        <Group justify="center" mih={90}>
          <IconCamera size={28} aria-hidden />
          <Text>
            Drop JPG or PNG photos, or a scanned PDF. Pages are read on this laptop; nothing is
            uploaded.
          </Text>
        </Group>
      </Dropzone>
      {progress ? (
        <Stack gap={4}>
          <Text size="sm">{progress.label}</Text>
          <Progress value={progress.pct} animated aria-label={progress.label} />
        </Stack>
      ) : null}
      {pages.length ? (
        <Card>
          <Stack>
            <Group justify="space-between">
              <Title order={3} size="h5">
                {pages.length} page(s) in order
              </Title>
              <Button variant="subtle" color="gray" onClick={() => setPages([])}>
                Clear pages
              </Button>
            </Group>
            <SimpleGrid cols={{ base: 3, md: 6 }}>
              {pages.map((p, i) => (
                <Stack key={p.previewUrl} gap={2} align="center">
                  <Image
                    src={p.previewUrl}
                    alt={`Page ${i + 1}`}
                    h={120}
                    fit="contain"
                    radius="sm"
                  />
                  <Text size="xs">Page {i + 1}</Text>
                </Stack>
              ))}
            </SimpleGrid>
            <Select
              label="How are answers marked?"
              data={CONVENTIONS.filter((c) => !['bold', 'highlight'].includes(c.value)).map(
                (c) => ({ ...c }),
              )}
              value={convention}
              onChange={(v) => setConvention((v ?? 'auto') as Convention)}
              allowDeselect={false}
            />
            <DefaultsFields value={defaults} onChange={setDefaults} subjects={settings.subjects} />
            <Group>
              <Button
                loading={busy}
                disabled={!defaults.subject}
                onClick={async () => {
                  setProgress({ label: 'Starting the text reader', pct: 0 });
                  const r = await run(() =>
                    call('import:ocrStage', {
                      fileName: defaults.source || 'Photos',
                      pages: pages.map((p) => ({ fileName: p.fileName, bytes: p.bytes })),
                      convention,
                      defaults,
                    }),
                  );
                  setProgress(null);
                  if (r) {
                    const low = r.pages.reduce((s, p) => s + p.lowConfidenceWords, 0);
                    notifyOk(
                      `${r.mcqs} questions found on ${r.pages.length} page(s); ${low} uncertain words are highlighted for checking.`,
                    );
                    onStaged(r.batch.id);
                  }
                }}
              >
                Read pages and send to review
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

/** Import: drop zone, a source-specific step, then the review queue beside the source. */
export function ImportScreen() {
  const { params, go } = useNav();
  const [source, setSource] = useState<Source | null>(null);
  const batches = useLoad(() => call('import:batches'));

  if (params.batch)
    return <ReviewQueue batchId={params.batch} onBack={() => go({ screen: 'import' })} />;
  const openBatch = (id: string): void => go({ screen: 'import', params: { batch: id } });

  const sources: Array<{ key: Source; title: string; text: string; icon: ReactNode }> = [
    {
      key: 'excel',
      title: 'Excel or CSV',
      text: 'Fastest and most reliable. Use the template or match your own columns once.',
      icon: <IconFileSpreadsheet size={28} aria-hidden />,
    },
    {
      key: 'word',
      title: 'Word (.docx)',
      text: 'Numbered questions, options a) to e), answer lines or marked options, images and equations.',
      icon: <IconFileText size={28} aria-hidden />,
    },
    {
      key: 'photo',
      title: 'Photos and scans',
      text: 'JPG, PNG or PDF pages read on this laptop. Every question is checked before it enters the bank.',
      icon: <IconCamera size={28} aria-hidden />,
    },
  ];

  return (
    <Stack gap="md">
      <Title order={2}>Import</Title>
      <Tabs defaultValue="new">
        <Tabs.List>
          <Tabs.Tab value="new">New import</Tabs.Tab>
          <Tabs.Tab value="batches">
            Imports and review ({(batches.data ?? []).reduce((s, b) => s + b.counts.pending, 0)}{' '}
            waiting)
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="new" pt="md">
          <Stack>
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              {sources.map((s) => (
                <Card
                  key={s.key}
                  component="button"
                  onClick={() => setSource(s.key)}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderColor: source === s.key ? 'var(--mantine-color-clinical-6)' : undefined,
                    borderWidth: source === s.key ? 2 : 1,
                  }}
                  aria-pressed={source === s.key}
                >
                  <Group mb="xs">
                    {s.icon}
                    <Text fw={600}>{s.title}</Text>
                  </Group>
                  <Text size="sm" c="dimmed">
                    {s.text}
                  </Text>
                </Card>
              ))}
            </SimpleGrid>
            {source === 'excel' ? <ExcelFlow onStaged={openBatch} /> : null}
            {source === 'word' ? <WordFlow onStaged={openBatch} /> : null}
            {source === 'photo' ? <PhotoFlow onStaged={openBatch} /> : null}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="batches" pt="md">
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Imported</Table.Th>
                <Table.Th>Waiting</Table.Th>
                <Table.Th>Approved</Table.Th>
                <Table.Th>Rejected or skipped</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(batches.data ?? []).map((b) => (
                <Table.Tr key={b.id}>
                  <Table.Td>{b.fileName || '(no name)'}</Table.Td>
                  <Table.Td>{b.sourceType.toUpperCase()}</Table.Td>
                  <Table.Td>
                    {formatDateTime(b.createdAt)} by {b.createdBy}
                  </Table.Td>
                  <Table.Td>{b.counts.pending}</Table.Td>
                  <Table.Td>{b.counts.approved + b.counts.merged}</Table.Td>
                  <Table.Td>{b.counts.rejected + b.counts.skipped}</Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant={b.counts.pending ? 'filled' : 'subtle'}
                      onClick={() => openBatch(b.id)}
                    >
                      {b.counts.pending ? 'Review' : 'View'}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
              {!(batches.data ?? []).length ? (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text c="dimmed" ta="center">
                      No imports yet.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : null}
            </Table.Tbody>
          </Table>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

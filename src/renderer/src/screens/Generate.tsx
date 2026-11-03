import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Radio,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { validateBlueprint } from '../../../core/blueprint';
import type { GenerateRequest } from '../../../shared/schemas';
import { call, type Out } from '../api';
import { useAppData } from '../App';
import { ExportDialog } from '../components/ExportDialog';
import { OverlapBars } from '../components/OverlapBars';
import { PaperPreview } from '../components/PaperPreview';
import { formatDate, notifyError, notifyOk, randomSeed, useAction, useLoad, useNav } from '../lib';

type Section = GenerateRequest['blueprint']['sections'][number];

/** Generate test: details, blueprint, repeat rule, then a preview with the overlap report. */
export function Generate() {
  const { settings } = useAppData();
  const { go } = useNav();
  const facets = useLoad(() => call('bank:facets'));
  const tests = useLoad(() => call('tests:list'));
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [versions, setVersions] = useState(settings.paper.versions);
  const [duration, setDuration] = useState(settings.paper.durationMinutes);
  const [instructions, setInstructions] = useState(settings.paper.instructions);
  const [allowReserved, setAllowReserved] = useState(false);
  const [sections, setSections] = useState<Section[]>([
    { subject: settings.subjects[0] ?? '', count: 20, topics: [] },
  ]);
  const [useMix, setUseMix] = useState(false);
  const [mix, setMix] = useState({ easy: 30, medium: 50, hard: 20 });
  const [rule, setRule] = useState(settings.rule);
  const [strategy, setStrategy] = useState(settings.strategy);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [seed, setSeed] = useState(randomSeed());
  const [preview, setPreview] = useState<Out<'generate:preview'> | null>(null);
  const [paper, setPaper] = useState<Out<'paper:previewDraft'> | null>(null);
  const [saved, setSaved] = useState<{ id: string; versions: string[] } | null>(null);
  const [busy, run] = useAction();

  const total = sections.reduce((s, x) => s + (x.count || 0), 0);
  const available = new Map((facets.data?.subjects ?? []).map((s) => [s.subject, s.count]));
  const topicsBySubject = (subject: string): string[] =>
    (facets.data?.topics ?? []).filter((t) => t.subject === subject).map((t) => t.topic);

  const request = useMemo<GenerateRequest>(
    () => ({
      title: title.trim() || 'Untitled test',
      code: code.trim(),
      blueprint: { sections, difficultyMix: useMix ? mix : null },
      rule,
      strategy,
      versions,
      allowReserved,
      groupBySubject: settings.paper.groupBySubject,
      scope: { excludedTestIds: excluded, from: from || null, to: to || null },
      instructions,
      durationMinutes: duration,
      seed,
    }),
    [
      title,
      code,
      sections,
      useMix,
      mix,
      rule,
      strategy,
      versions,
      allowReserved,
      settings.paper.groupBySubject,
      excluded,
      from,
      to,
      instructions,
      duration,
      seed,
    ],
  );

  const blueprintErrors = validateBlueprint(request.blueprint);

  const runPreview = async (nextSeed = seed): Promise<void> => {
    setSeed(nextSeed);
    setPaper(null);
    const r = await run(() => call('generate:preview', { ...request, seed: nextSeed }));
    if (r) setPreview(r);
  };

  const goTo = (target: number): void => {
    if (target >= 1 && !title.trim())
      return notifyError(new Error('Give the test a title.'), 'Details needed');
    if (target >= 2 && blueprintErrors.length)
      return notifyError(new Error(blueprintErrors.join(' ')), 'Blueprint needs attention');
    setStep(target);
    if (target === 3) void runPreview();
  };

  const save = async (): Promise<void> => {
    const t = await run(() => call('generate:save', request));
    if (!t) return;
    notifyOk(`"${t.title}" saved. It now counts toward the repeat rule.`);
    setSaved({ id: t.id, versions: (t.settings.versions ?? []).map((v) => v.letter) });
    void tests.reload();
  };

  const result = preview?.result;

  return (
    <Stack gap="md">
      <Title order={2}>Generate test</Title>
      <Stepper active={step} onStepClick={goTo} allowNextStepsSelect={false}>
        <Stepper.Step label="Details" description="Title and paper" />
        <Stepper.Step label="Blueprint" description="Subjects and counts" />
        <Stepper.Step label="Repeat rule" description="Compare with earlier tests" />
        <Stepper.Step label="Preview" description="Check, then save" />
      </Stepper>

      {step === 0 ? (
        <Card>
          <Stack>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <TextInput
                label="Title"
                placeholder="For example: Mock Test 7"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                required
                data-autofocus
              />
              <TextInput
                label="Test code (printed on every page)"
                placeholder="For example: MT-07"
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
              <Select
                label="Versions"
                description="Each version has its own question and option order and its own key"
                data={['1', '2', '3', '4'].map((v) => ({
                  value: v,
                  label: v === '1' ? '1 version' : `${v} versions (A to ${'ABCD'[Number(v) - 1]})`,
                }))}
                value={String(versions)}
                onChange={(v) => setVersions(Number(v ?? 1))}
                allowDeselect={false}
              />
              <NumberInput
                label="Time allowed (minutes)"
                value={duration}
                onChange={(v) => setDuration(Number(v) || 0)}
                min={0}
                max={1000}
              />
            </SimpleGrid>
            <Textarea
              label="Instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.currentTarget.value)}
              autosize
              minRows={2}
            />
            <Checkbox
              label="This is a final: questions reserved for finals may be used"
              checked={allowReserved}
              onChange={(e) => setAllowReserved(e.currentTarget.checked)}
            />
            <Group justify="flex-end">
              <Button onClick={() => goTo(1)}>Next: blueprint</Button>
            </Group>
          </Stack>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <Stack>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Subject</Table.Th>
                  <Table.Th>Questions</Table.Th>
                  <Table.Th>Topics (optional)</Table.Th>
                  <Table.Th>In bank</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sections.map((s, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>
                      <Select
                        aria-label={`Subject ${i + 1}`}
                        data={settings.subjects}
                        value={s.subject || null}
                        onChange={(v) =>
                          setSections(
                            sections.map((x, j) =>
                              j === i ? { ...x, subject: v ?? '', topics: [] } : x,
                            ),
                          )
                        }
                      />
                    </Table.Td>
                    <Table.Td>
                      <NumberInput
                        aria-label={`Questions for subject ${i + 1}`}
                        value={s.count}
                        min={1}
                        max={1000}
                        onChange={(v) =>
                          setSections(
                            sections.map((x, j) => (j === i ? { ...x, count: Number(v) || 0 } : x)),
                          )
                        }
                        w={110}
                      />
                    </Table.Td>
                    <Table.Td>
                      <MultiSelect
                        aria-label={`Topics for subject ${i + 1}`}
                        data={topicsBySubject(s.subject)}
                        value={s.topics}
                        onChange={(v) =>
                          setSections(sections.map((x, j) => (j === i ? { ...x, topics: v } : x)))
                        }
                        placeholder="Any topic"
                        clearable
                      />
                    </Table.Td>
                    <Table.Td>{available.get(s.subject) ?? 0}</Table.Td>
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Remove subject ${i + 1}`}
                        disabled={sections.length === 1}
                        onClick={() => setSections(sections.filter((_, j) => j !== i))}
                      >
                        <IconTrash size={16} aria-hidden />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Group justify="space-between">
              <Button
                variant="light"
                leftSection={<IconPlus size={16} aria-hidden />}
                onClick={() =>
                  setSections([
                    ...sections,
                    {
                      subject:
                        settings.subjects.find((s) => !sections.some((x) => x.subject === s)) ?? '',
                      count: 10,
                      topics: [],
                    },
                  ])
                }
              >
                Add subject
              </Button>
              <Text fw={600}>Total: {total} questions</Text>
            </Group>
            <Switch
              label="Set a difficulty mix"
              checked={useMix}
              onChange={(e) => setUseMix(e.currentTarget.checked)}
            />
            {useMix ? (
              <Group>
                {(['easy', 'medium', 'hard'] as const).map((d) => (
                  <NumberInput
                    key={d}
                    label={`${d[0].toUpperCase()}${d.slice(1)} %`}
                    value={mix[d]}
                    min={0}
                    max={100}
                    onChange={(v) => setMix({ ...mix, [d]: Number(v) || 0 })}
                    w={120}
                  />
                ))}
                <Text size="sm" c={mix.easy + mix.medium + mix.hard === 100 ? 'dimmed' : 'red.8'}>
                  Adds up to {mix.easy + mix.medium + mix.hard}%
                </Text>
              </Group>
            ) : null}
            {blueprintErrors.length ? (
              <Alert color="orange">{blueprintErrors.join(' ')}</Alert>
            ) : null}
            <Group justify="space-between">
              <Button variant="default" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button onClick={() => goTo(2)}>Next: repeat rule</Button>
            </Group>
          </Stack>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <Stack>
            <Radio.Group
              label="How should repeats be limited?"
              value={rule.mode}
              onChange={(v) => setRule({ ...rule, mode: v as typeof rule.mode })}
            >
              <Stack gap={6} mt={6}>
                <Radio
                  value="each"
                  label={`Each earlier test separately: at most ${rule.limitPct}% shared with any one test (regular tests)`}
                />
                <Radio
                  value="combined"
                  label={`All earlier tests combined: at most ${rule.limitPct}% of this test appeared before (high-stakes finals)`}
                />
              </Stack>
            </Radio.Group>
            <Group align="flex-end">
              <NumberInput
                label="Limit (%)"
                value={rule.limitPct}
                min={0}
                max={100}
                onChange={(v) => setRule({ ...rule, limitPct: Math.round(Number(v) || 0) })}
                w={120}
              />
              {rule.mode === 'each' ? (
                <Checkbox
                  label="Stricter: measure against the smaller test, so a long paper cannot absorb a short quiz"
                  checked={rule.denominator === 'smaller'}
                  onChange={(e) =>
                    setRule({ ...rule, denominator: e.currentTarget.checked ? 'smaller' : 'new' })
                  }
                />
              ) : null}
            </Group>
            <Radio.Group
              label="Picking"
              value={strategy}
              onChange={(v) => setStrategy(v as typeof strategy)}
            >
              <Stack gap={6} mt={6}>
                <Radio value="fresh-first" label="Fresh questions first (reuse only when needed)" />
                <Radio
                  value="stretch"
                  label="Stretch the bank (spend the allowed repeats on least-used questions, saving fresh ones for later)"
                />
              </Stack>
            </Radio.Group>
            <Title order={4} size="h5">
              Earlier tests to compare with
            </Title>
            <Group>
              <TextInput
                type="date"
                label="From"
                value={from}
                onChange={(e) => setFrom(e.currentTarget.value)}
              />
              <TextInput
                type="date"
                label="To"
                value={to}
                onChange={(e) => setTo(e.currentTarget.value)}
              />
            </Group>
            <ScrollArea.Autosize mah={260}>
              <Stack gap={4}>
                {(tests.data ?? [])
                  .filter((t) => t.includedInRule)
                  .map((t) => (
                    <Checkbox
                      key={t.id}
                      label={`${t.title} (${formatDate(t.createdAt)}, ${t.questionCount} questions${t.kind === 'outside' ? ', imported' : ''})`}
                      checked={!excluded.includes(t.id)}
                      onChange={(e) =>
                        setExcluded(
                          e.currentTarget.checked
                            ? excluded.filter((x) => x !== t.id)
                            : [...excluded, t.id],
                        )
                      }
                    />
                  ))}
                {!(tests.data ?? []).length ? (
                  <Text size="sm" c="dimmed">
                    No earlier tests yet.
                  </Text>
                ) : null}
              </Stack>
            </ScrollArea.Autosize>
            <Group justify="space-between">
              <Button variant="default" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button onClick={() => goTo(3)}>Generate preview</Button>
            </Group>
          </Stack>
        </Card>
      ) : null}

      {step === 3 ? (
        <Stack>
          <Title order={3} size="h4">
            {request.title}: {total} questions
            {versions > 1 ? `, versions A to ${'ABCD'[versions - 1]}` : ''}
          </Title>
          {busy && !result ? <Loader aria-label="Generating" /> : null}
          {result && !result.ok ? (
            <Alert
              color="red"
              icon={<IconAlertTriangle aria-hidden />}
              title="This test cannot be built under the rule"
            >
              <Stack gap={4}>
                {result.messages.map((m) => (
                  <Text key={m} size="sm">
                    {m}
                  </Text>
                ))}
              </Stack>
            </Alert>
          ) : null}
          {result && result.ok ? (
            <>
              <SimpleGrid cols={{ base: 1, md: 3 }}>
                <Card>
                  <Text size="sm" c="dimmed">
                    Highest repeat
                  </Text>
                  <Text fz={26} fw={700}>
                    {rule.mode === 'each' ? result.report.highestPct : result.report.combinedPct}%
                  </Text>
                  <Group gap={4}>
                    <IconCircleCheck
                      size={14}
                      color="var(--mantine-color-clinical-7)"
                      aria-hidden
                    />
                    <Text size="sm">Limit {rule.limitPct}%, passes</Text>
                  </Group>
                </Card>
                <Card>
                  <Text size="sm" c="dimmed">
                    New questions
                  </Text>
                  <Text fz={26} fw={700}>
                    {result.freshCount} of {total}
                  </Text>
                  <Text size="sm">{result.reusedCount} reused</Text>
                </Card>
                <Card>
                  <Text size="sm" c="dimmed">
                    Blueprint
                  </Text>
                  <Text fz={26} fw={700}>
                    Matches
                  </Text>
                  <Text size="sm">All counts exact</Text>
                </Card>
              </SimpleGrid>
              <Tabs defaultValue="overlap">
                <Tabs.List>
                  <Tabs.Tab value="overlap">Overlap with each earlier test</Tabs.Tab>
                  <Tabs.Tab
                    value="paper"
                    onClick={async () => {
                      if (!paper)
                        setPaper((await run(() => call('paper:previewDraft', request))) ?? null);
                    }}
                  >
                    Paper preview
                  </Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="overlap" pt="md">
                  <Card>
                    <OverlapBars report={result.report} />
                  </Card>
                </Tabs.Panel>
                <Tabs.Panel value="paper" pt="md">
                  {paper && paper.ok ? (
                    <Tabs defaultValue={paper.versions[0].letter} variant="pills">
                      <Tabs.List>
                        {paper.versions.map((v) => (
                          <Tabs.Tab key={v.letter} value={v.letter}>
                            Version {v.letter}
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                      {paper.versions.map((v) => (
                        <Tabs.Panel key={v.letter} value={v.letter} pt="sm">
                          <PaperPreview
                            css={paper.css}
                            body={v.body}
                            label={`Paper preview, version ${v.letter}`}
                          />
                        </Tabs.Panel>
                      ))}
                    </Tabs>
                  ) : busy ? (
                    <Loader aria-label="Building preview" />
                  ) : null}
                </Tabs.Panel>
              </Tabs>
            </>
          ) : null}
          <Group justify="space-between">
            <Button variant="default" onClick={() => setStep(2)}>
              Back
            </Button>
            <Group>
              <Text size="xs" c="dimmed">
                New random seed each time
              </Text>
              <Button
                variant="light"
                leftSection={<IconRefresh size={16} aria-hidden />}
                onClick={() => void runPreview(randomSeed())}
                loading={busy}
              >
                Regenerate
              </Button>
              <Button disabled={!result?.ok || !!saved} loading={busy} onClick={() => void save()}>
                Save and export
              </Button>
            </Group>
          </Group>
          {saved ? (
            <Alert color="clinical" title="Saved">
              <Group>
                <Badge color="clinical" leftSection={<IconCircleCheck size={12} aria-hidden />}>
                  Counts toward the repeat rule
                </Badge>
                <Button
                  size="xs"
                  variant="white"
                  onClick={() => go({ screen: 'tests', params: { test: saved.id } })}
                >
                  Open in history
                </Button>
              </Group>
            </Alert>
          ) : null}
        </Stack>
      ) : null}
      {saved ? (
        <ExportDialog
          testId={saved.id}
          versions={saved.versions}
          opened={!!saved}
          onClose={() => go({ screen: 'tests', params: { test: saved.id } })}
        />
      ) : null}
    </Stack>
  );
}

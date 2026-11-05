import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  List,
  Loader,
  Modal,
  MultiSelect,
  Pagination,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  TagsInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useLocalStorage } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconMathFunction,
  IconPhoto,
  IconPlus,
  IconSearch,
  IconTag,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { call, type Out } from '../api';
import { useAppData } from '../App';
import { QuestionForm, type QuestionDraft } from '../components/QuestionForm';
import {
  DIFFICULTY_LABEL,
  formatDateTime,
  notifyError,
  notifyOk,
  RichView,
  useAction,
  useLoad,
  useNav,
} from '../lib';

const PAGE = 50;
const LETTERS = 'ABCDE';

interface Filters {
  search: string;
  subjects: string[];
  difficulties: Array<'easy' | 'medium' | 'hard'>;
  status: 'active' | 'archived' | 'all';
  usage: 'any' | 'never' | 'used';
  tag: string;
}

const emptyDraft = (subject: string): QuestionDraft => ({
  stem: [],
  options: [[], [], [], []],
  correct: null,
  explanation: [],
  subject,
  topic: '',
  difficulty: 'medium',
  tags: [],
  source: '',
  lockOptions: false,
  reserved: false,
});

function draftIssues(d: QuestionDraft): string[] {
  const issues: string[] = [];
  if (!d.stem.length) issues.push('Add the question text.');
  if (d.options.some((o) => !o.length))
    issues.push('Fill in every option or remove the empty ones.');
  if (d.correct === null) issues.push('Mark the correct answer.');
  if (!d.subject) issues.push('Choose a subject.');
  return issues;
}

/** Question bank: search, filters, preview with images and equations, edit with history, bulk tag or archive. */
export function Bank() {
  const { settings } = useAppData();
  const { params } = useNav();
  const [filters, setFilters] = useLocalStorage<Filters>({
    key: 'bank-filters',
    defaultValue: {
      search: '',
      subjects: [],
      difficulties: [],
      status: 'active',
      usage: 'any',
      tag: '',
    },
  });
  const [debouncedSearch] = useDebouncedValue(filters.search, 250);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{
    id: string | null;
    draft: QuestionDraft;
    version?: number;
  } | null>(null);
  const [detail, setDetail] = useState<Out<'bank:get'> | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagAdd, setTagAdd] = useState<string[]>([]);
  const [answerWarning, setAnswerWarning] = useState<Out<'bank:update'>['answerChangedIn'] | null>(
    null,
  );
  const [busy, run] = useAction();
  const facets = useLoad(() => call('bank:facets'));
  const list = useLoad(
    () =>
      call('bank:list', {
        search: debouncedSearch,
        subjects: filters.subjects,
        difficulties: filters.difficulties,
        status: filters.status,
        usage: filters.usage,
        tag: filters.tag,
        offset: (page - 1) * PAGE,
        limit: PAGE,
      }),
    [
      debouncedSearch,
      filters.subjects,
      filters.difficulties,
      filters.status,
      filters.usage,
      filters.tag,
      page,
    ],
  );

  useEffect(
    () => setPage(1),
    [
      debouncedSearch,
      filters.subjects,
      filters.difficulties,
      filters.status,
      filters.usage,
      filters.tag,
    ],
  );
  useEffect(() => {
    if (params.question) void openEdit(params.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.question]);

  const subjects = settings.subjects;
  const topics = (facets.data?.topics ?? [])
    .filter((t) => !editing || t.subject === editing.draft.subject)
    .map((t) => t.topic);

  async function openEdit(id: string): Promise<void> {
    try {
      const data = await call('bank:get', { id });
      setDetail(data);
      const q = data.question;
      setEditing({ id, version: q.version, draft: { ...q } });
    } catch (error) {
      notifyError(error);
    }
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const d = editing.draft;
    const issues = draftIssues(d);
    if (issues.length) return notifyError(new Error(issues.join(' ')), 'Not saved yet');
    const payload = {
      ...d,
      correct: d.correct!,
      ...(editing.version ? { expectedVersion: editing.version } : {}),
    };
    const result = await run(async () => {
      if (editing.id) return call('bank:update', { id: editing.id, question: payload });
      const similar = await call('bank:similar', { stem: d.stem, options: d.options });
      if (similar.some((s) => s.exact))
        throw new Error('An identical question is already in the bank.');
      if (
        similar.length &&
        !window.confirm(
          `A similar question already exists (${Math.round(similar[0].score * 100)}% match). Save anyway as a separate question?`,
        )
      )
        return null;
      return call('bank:create', payload);
    });
    if (!result) return;
    if ('answerChangedIn' in result && result.answerChangedIn.length)
      setAnswerWarning(result.answerChangedIn);
    notifyOk(
      editing.id
        ? 'Question saved. The previous version is kept in its history.'
        : 'Question added to the bank.',
    );
    setEditing(null);
    setDetail(null);
    void list.reload();
    void facets.reload();
  }

  async function bulk(kind: 'archive' | 'restore' | 'delete'): Promise<void> {
    const ids = [...selected];
    if (!ids.length) return;
    if (kind === 'delete') {
      if (
        !window.confirm(
          `Delete ${ids.length} question(s) permanently? Questions used in any test cannot be deleted and will be skipped; archive them instead.`,
        )
      )
        return;
      const r = await run(() => call('bank:delete', { ids }));
      if (r)
        notifyOk(
          `${r.deleted} deleted.${r.refused.length ? ` ${r.refused.length} were used in tests and were kept; archive them instead.` : ''}`,
        );
    } else {
      const r = await run(() => call('bank:archive', { ids, archived: kind === 'archive' }));
      if (r)
        notifyOk(
          `${r.changed} question(s) ${kind === 'archive' ? 'archived. Use the Archived filter to restore them.' : 'restored.'}`,
        );
    }
    setSelected(new Set());
    void list.reload();
  }

  const items = list.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((i) => selected.has(i.id));

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Question bank</Title>
        <Button
          leftSection={<IconPlus size={18} aria-hidden />}
          onClick={() => setEditing({ id: null, draft: emptyDraft(subjects[0] ?? '') })}
        >
          Add question
        </Button>
      </Group>

      <Group align="flex-end" wrap="wrap">
        <TextInput
          label="Search"
          leftSection={<IconSearch size={16} aria-hidden />}
          placeholder="Words in the question, options or tags"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.currentTarget.value })}
          w={300}
        />
        <MultiSelect
          label="Subjects"
          data={subjects}
          value={filters.subjects}
          onChange={(v) => setFilters({ ...filters, subjects: v })}
          clearable
          w={240}
          placeholder="All"
        />
        <MultiSelect
          label="Difficulty"
          data={[
            { value: 'easy', label: 'Easy' },
            { value: 'medium', label: 'Medium' },
            { value: 'hard', label: 'Hard' },
          ]}
          value={filters.difficulties}
          onChange={(v) => setFilters({ ...filters, difficulties: v as Filters['difficulties'] })}
          clearable
          w={200}
          placeholder="All"
        />
        <Select
          label="Usage"
          data={[
            { value: 'any', label: 'Any' },
            { value: 'never', label: 'Never used' },
            { value: 'used', label: 'Used in tests' },
          ]}
          value={filters.usage}
          onChange={(v) => setFilters({ ...filters, usage: (v ?? 'any') as Filters['usage'] })}
          w={150}
          allowDeselect={false}
        />
        <Select
          label="Tag"
          data={facets.data?.tags ?? []}
          value={filters.tag || null}
          onChange={(v) => setFilters({ ...filters, tag: v ?? '' })}
          clearable
          w={150}
          placeholder="Any"
        />
        <SegmentedControl
          aria-label="Status"
          data={[
            { value: 'active', label: 'Active' },
            { value: 'archived', label: 'Archived' },
            { value: 'all', label: 'All' },
          ]}
          value={filters.status}
          onChange={(v) => setFilters({ ...filters, status: v as Filters['status'] })}
        />
      </Group>

      {selected.size ? (
        <Group>
          <Text size="sm">{selected.size} selected</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconTag size={14} aria-hidden />}
            onClick={() => setTagOpen(true)}
          >
            Add tags
          </Button>
          {filters.status === 'archived' ? (
            <Button
              size="xs"
              variant="light"
              leftSection={<IconArrowBackUp size={14} aria-hidden />}
              onClick={() => void bulk('restore')}
              loading={busy}
            >
              Restore
            </Button>
          ) : (
            <Button
              size="xs"
              variant="light"
              color="orange"
              leftSection={<IconArchive size={14} aria-hidden />}
              onClick={() => void bulk('archive')}
              loading={busy}
            >
              Archive
            </Button>
          )}
          <Button size="xs" variant="subtle" color="red" onClick={() => void bulk('delete')}>
            Delete unused
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </Group>
      ) : null}

      {list.loading && !list.data ? (
        <Loader aria-label="Loading questions" />
      ) : (
        <Table striped highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40}>
                <Checkbox
                  aria-label="Select all on this page"
                  checked={allOnPage}
                  onChange={() =>
                    setSelected(
                      allOnPage ? new Set() : new Set([...selected, ...items.map((i) => i.id)]),
                    )
                  }
                />
              </Table.Th>
              <Table.Th>Question</Table.Th>
              <Table.Th>Subject</Table.Th>
              <Table.Th>Topic</Table.Th>
              <Table.Th>Difficulty</Table.Th>
              <Table.Th>Used in</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((q) => (
              <Table.Tr key={q.id} onDoubleClick={() => void openEdit(q.id)}>
                <Table.Td>
                  <Checkbox
                    aria-label="Select question"
                    checked={selected.has(q.id)}
                    onChange={() => {
                      const next = new Set(selected);
                      if (next.has(q.id)) next.delete(q.id);
                      else next.add(q.id);
                      setSelected(next);
                    }}
                  />
                </Table.Td>
                <Table.Td>
                  <Button
                    variant="subtle"
                    color="dark"
                    size="compact-sm"
                    onClick={() => void openEdit(q.id)}
                    style={{
                      height: 'auto',
                      whiteSpace: 'normal',
                      textAlign: 'left',
                      fontWeight: 400,
                    }}
                  >
                    <span className="line-clamp-2">{q.stemText || '(no text)'}</span>
                  </Button>
                  <Group gap={4}>
                    {q.hasImage ? (
                      <Tooltip label="Has an image">
                        <IconPhoto size={14} aria-label="Has an image" />
                      </Tooltip>
                    ) : null}
                    {q.hasMath ? (
                      <Tooltip label="Has an equation">
                        <IconMathFunction size={14} aria-label="Has an equation" />
                      </Tooltip>
                    ) : null}
                    {q.tags.map((t) => (
                      <Badge key={t} size="xs" variant="outline">
                        {t}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{q.subject}</Table.Td>
                <Table.Td>{q.topic}</Table.Td>
                <Table.Td>{DIFFICULTY_LABEL[q.difficulty]}</Table.Td>
                <Table.Td>{q.usedIn ? `${q.usedIn} test(s)` : 'Never'}</Table.Td>
                <Table.Td>
                  {q.status === 'archived' ? (
                    <Badge color="gray" variant="light">
                      Archived
                    </Badge>
                  ) : q.reserved ? (
                    <Badge color="calmBlue" variant="light">
                      Reserved for finals
                    </Badge>
                  ) : (
                    <Badge color="clinical" variant="light">
                      Active
                    </Badge>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
            {!items.length ? (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text c="dimmed" ta="center" py="lg">
                    No questions match these filters.
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      )}
      {list.data && list.data.total > PAGE ? (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {list.data.total} questions
          </Text>
          <Pagination
            total={Math.ceil(list.data.total / PAGE)}
            value={page}
            onChange={setPage}
            aria-label="Pages"
          />
        </Group>
      ) : list.data ? (
        <Text size="sm" c="dimmed">
          {list.data.total} questions
        </Text>
      ) : null}

      <Drawer
        opened={!!editing}
        onClose={() => {
          setEditing(null);
          setDetail(null);
        }}
        position="right"
        size="xl"
        title={editing?.id ? 'Edit question' : 'Add question'}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {editing ? (
          <Tabs defaultValue="edit">
            <Tabs.List>
              <Tabs.Tab value="edit">Question</Tabs.Tab>
              {detail ? (
                <Tabs.Tab value="history">History ({detail.history.length})</Tabs.Tab>
              ) : null}
              {detail ? <Tabs.Tab value="usage">Used in ({detail.usedIn.length})</Tabs.Tab> : null}
            </Tabs.List>
            <Tabs.Panel value="edit" pt="md">
              <Stack>
                {detail?.usedIn.length ? (
                  <Alert color="calmBlue" title="Used in issued tests">
                    Printed papers keep the version they used. If you change the correct answer, the
                    app lists the issued tests that used this question.
                  </Alert>
                ) : null}
                <QuestionForm
                  value={editing.draft}
                  onChange={(draft) => setEditing({ ...editing, draft })}
                  topics={topics}
                />
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button onClick={() => void save()} loading={busy}>
                    Save
                  </Button>
                </Group>
              </Stack>
            </Tabs.Panel>
            {detail ? (
              <Tabs.Panel value="history" pt="md">
                <Stack>
                  {detail.history.map((v) => (
                    <Stack
                      key={v.version}
                      gap={4}
                      p="sm"
                      style={{
                        border: '1px solid var(--mantine-color-default-border)',
                        borderRadius: 8,
                      }}
                    >
                      <Group justify="space-between">
                        <Text fw={600}>Version {v.version}</Text>
                        <Text size="sm" c="dimmed">
                          {formatDateTime(v.changedAt)} by {v.changedBy || 'unknown'} · {v.note}
                        </Text>
                      </Group>
                      <RichView value={v.snapshot.stem} />
                      <Text size="sm">Answer: {LETTERS[v.snapshot.correct]}</Text>
                      {v.version !== detail.question.version ? (
                        <Button
                          size="xs"
                          variant="light"
                          w="fit-content"
                          leftSection={<IconArrowBackUp size={14} aria-hidden />}
                          onClick={async () => {
                            const r = await run(() =>
                              call('bank:revert', { id: detail.question.id, version: v.version }),
                            );
                            if (r) {
                              notifyOk(`Restored version ${v.version} as a new version.`);
                              if (r.answerChangedIn.length) setAnswerWarning(r.answerChangedIn);
                              void openEdit(detail.question.id);
                              void list.reload();
                            }
                          }}
                        >
                          Undo to this version
                        </Button>
                      ) : (
                        <Badge w="fit-content">Current</Badge>
                      )}
                    </Stack>
                  ))}
                </Stack>
              </Tabs.Panel>
            ) : null}
            {detail ? (
              <Tabs.Panel value="usage" pt="md">
                {detail.usedIn.length ? (
                  <List>
                    {detail.usedIn.map((t) => (
                      <List.Item key={t.testId}>
                        {t.title} ({formatDateTime(t.createdAt)})
                      </List.Item>
                    ))}
                  </List>
                ) : (
                  <Text c="dimmed">Not used in any test yet.</Text>
                )}
              </Tabs.Panel>
            ) : null}
          </Tabs>
        ) : null}
      </Drawer>

      <Modal
        opened={tagOpen}
        onClose={() => setTagOpen(false)}
        title={`Add tags to ${selected.size} question(s)`}
      >
        <Stack>
          <TagsInput
            label="Tags"
            value={tagAdd}
            onChange={setTagAdd}
            data={facets.data?.tags ?? []}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button
              disabled={!tagAdd.length}
              loading={busy}
              onClick={async () => {
                const r = await run(() =>
                  call('bank:tag', { ids: [...selected], add: tagAdd, remove: [] }),
                );
                if (r) notifyOk(`Tags added to ${r.changed} question(s).`);
                setTagOpen(false);
                setTagAdd([]);
                void list.reload();
                void facets.reload();
              }}
            >
              Add tags
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={!!answerWarning}
        onClose={() => setAnswerWarning(null)}
        title="The answer changed for issued tests"
        size="lg"
      >
        <Stack>
          <Alert color="orange" icon={<IconAlertTriangle aria-hidden />}>
            These tests were printed with the previous answer. Their saved papers and keys are
            unchanged; check whether results need re-marking.
          </Alert>
          <List>
            {(answerWarning ?? []).map((t) => (
              <List.Item key={t.testId}>
                {t.title} ({formatDateTime(t.createdAt)})
              </List.Item>
            ))}
          </List>
          <Group justify="flex-end">
            <Button onClick={() => setAnswerWarning(null)}>I understand</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

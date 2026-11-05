import {
  Alert,
  Badge,
  Button,
  Divider,
  FileButton,
  Grid,
  Group,
  Kbd,
  List,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconKey,
  IconPlayerSkipForward,
  IconQuestionMark,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RichText } from '../../../core/richtext';
import type { ReviewCandidate, ReviewItem } from '../../../main/db/imports';
import { call, fileToUpload, type Out } from '../api';
import { useAppData } from '../App';
import { notifyOk, RichView, useAction, useLoad } from '../lib';
import { CropTool } from './CropTool';
import { QuestionForm, type QuestionDraft } from './QuestionForm';

const LETTERS = 'ABCDE';

const STATUS: Record<ReviewItem['status'], { label: string; color: string; icon: ReactNode }> = {
  pending: { label: 'Waiting', color: 'yellow', icon: <IconQuestionMark size={12} aria-hidden /> },
  approved: {
    label: 'Approved',
    color: 'clinical',
    icon: <IconCircleCheck size={12} aria-hidden />,
  },
  rejected: { label: 'Rejected', color: 'red', icon: <IconCircleX size={12} aria-hidden /> },
  merged: { label: 'Merged', color: 'calmBlue', icon: <IconCopy size={12} aria-hidden /> },
  skipped: {
    label: 'Skipped',
    color: 'gray',
    icon: <IconPlayerSkipForward size={12} aria-hidden />,
  },
};

function toDraft(c: ReviewCandidate): QuestionDraft {
  return { ...c };
}

/** Review queue (FR-4): nothing reaches the bank without staff approval and a marked answer. */
export function ReviewQueue({ batchId, onBack }: { batchId: string; onBack: () => void }) {
  const { settings } = useAppData();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const items = useLoad(() => call('import:items', { batchId }), [batchId]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuestionDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [compare, setCompare] = useState<Out<'review:compare'> | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyText, setKeyText] = useState('');
  const [busy, run] = useAction();

  const visible = useMemo(
    () => (items.data ?? []).filter((i) => filter === 'all' || i.status === 'pending'),
    [items.data, filter],
  );
  const current = (items.data ?? []).find((i) => i.id === currentId) ?? null;
  const pendingCount = (items.data ?? []).filter((i) => i.status === 'pending').length;

  useEffect(() => {
    if (!currentId && visible.length) setCurrentId(visible[0].id);
  }, [visible, currentId]);
  useEffect(() => {
    setDraft(current?.candidate ? toDraft(current.candidate) : null);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status]);

  const move = (delta: number): void => {
    const index = visible.findIndex((i) => i.id === currentId);
    const next = visible[index + delta];
    if (next) setCurrentId(next.id);
  };

  const saveDraft = async (
    decision: 'keep' | null = current?.duplicateDecision ?? null,
  ): Promise<ReviewItem | undefined> => {
    if (!current?.candidate || !draft) return undefined;
    const candidate: ReviewCandidate = { ...current.candidate, ...draft };
    return run(() =>
      call('review:update', { itemId: current.id, candidate, duplicateDecision: decision }),
    );
  };

  const approve = async (): Promise<void> => {
    if (!current || current.status !== 'pending') return;
    if (dirty || current.duplicateDecision === null) {
      const saved = await saveDraft();
      if (!saved) return;
    }
    const result = await run(() =>
      call('review:approve', { itemIds: [current.id], onlyClean: false }),
    );
    if (!result) return;
    if (result.refused.length) {
      notifyOk(result.refused[0].reason, 'Not approved yet');
    } else {
      notifyOk('Added to the question bank.');
      const index = visible.findIndex((i) => i.id === current.id);
      setCurrentId(visible[index + 1]?.id ?? visible[index - 1]?.id ?? null);
    }
    await items.reload();
  };

  const markAnswer = (index: number): void => {
    if (!draft || index >= draft.options.length) return;
    setDraft({ ...draft, correct: index });
    setDirty(true);
  };

  useHotkeys(
    [
      ['mod+Enter', () => void approve()],
      ['mod+ArrowRight', () => move(1)],
      ['mod+ArrowLeft', () => move(-1)],
      ['mod+1', () => markAnswer(0)],
      ['mod+2', () => markAnswer(1)],
      ['mod+3', () => markAnswer(2)],
      ['mod+4', () => markAnswer(3)],
      ['mod+5', () => markAnswer(4)],
    ],
    [],
  );

  const bulkApprove = async (): Promise<void> => {
    const ids = (items.data ?? [])
      .filter((i) => i.status === 'pending' && i.kind === 'mcq')
      .map((i) => i.id);
    if (!ids.length) return;
    const r = await run(() => call('review:approve', { itemIds: ids, onlyClean: true }));
    if (r)
      notifyOk(
        `${r.approved.length} clean question(s) approved. ${r.refused.length} need a closer look.`,
      );
    await items.reload();
  };

  const attachCrop = (
    target: number,
    ref: string,
    size: { width: number; height: number },
  ): void => {
    if (!draft) return;
    const img = {
      t: 'img' as const,
      ref,
      w: Math.min(size.width, 480),
      h: Math.round((size.height * Math.min(size.width, 480)) / size.width),
    };
    if (target === 0) setDraft({ ...draft, stem: [...draft.stem, { t: 'br' }, img] });
    else {
      const options = draft.options.slice();
      options[target - 1] = [...options[target - 1], img] as RichText;
      setDraft({ ...draft, options });
    }
    setDirty(true);
  };

  if (items.loading && !items.data) return <Loader aria-label="Loading review queue" />;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group>
          <Button variant="subtle" onClick={onBack}>
            Back to imports
          </Button>
          <Title order={2}>Review queue</Title>
          <Badge variant="light" color={pendingCount ? 'yellow' : 'clinical'}>
            {pendingCount} waiting
          </Badge>
        </Group>
        <Group>
          <Button
            variant="light"
            leftSection={<IconKey size={16} aria-hidden />}
            onClick={() => setKeyOpen(true)}
          >
            Apply answer key
          </Button>
          <Button
            variant="light"
            leftSection={<IconCheck size={16} aria-hidden />}
            onClick={() => void bulkApprove()}
            loading={busy}
          >
            Approve all clean items
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        Shortcuts: <Kbd>Ctrl/⌘</Kbd>+<Kbd>Enter</Kbd> approve, <Kbd>Ctrl/⌘</Kbd>+<Kbd>→</Kbd> next,{' '}
        <Kbd>Ctrl/⌘</Kbd>+<Kbd>1</Kbd>–<Kbd>5</Kbd> mark answer A to E.
      </Text>

      <Grid gap="md">
        <Grid.Col span={3}>
          <SegmentedControl
            fullWidth
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as 'pending' | 'all')}
            data={[
              { value: 'pending', label: 'Waiting' },
              { value: 'all', label: 'All' },
            ]}
            mb="xs"
          />
          <ScrollArea h="calc(100vh - 290px)" type="auto">
            <Stack gap={4}>
              {visible.map((item, i) => {
                const s = STATUS[item.status];
                const text = item.candidate ? item.candidate.stem : (item.unplaced?.content ?? []);
                return (
                  <UnstyledButton
                    key={item.id}
                    onClick={() => setCurrentId(item.id)}
                    aria-current={item.id === currentId ? 'true' : undefined}
                    p="xs"
                    style={{
                      borderRadius: 8,
                      border: '1px solid var(--mantine-color-default-border)',
                      background:
                        item.id === currentId ? 'var(--mantine-color-clinical-light)' : undefined,
                    }}
                  >
                    <Group gap={6} wrap="nowrap" mb={2}>
                      <Text size="xs" fw={600}>
                        {item.candidate?.number ? `Q${item.candidate.number}` : `#${i + 1}`}
                      </Text>
                      <Badge size="xs" color={s.color} variant="light" leftSection={s.icon}>
                        {s.label}
                      </Badge>
                      {item.kind === 'unplaced' ? (
                        <Badge size="xs" color="orange" variant="light">
                          Flagged text
                        </Badge>
                      ) : null}
                      {item.duplicates.length ? (
                        <Badge size="xs" color="grape" variant="light">
                          Similar exists
                        </Badge>
                      ) : null}
                      {item.issues.length && item.status === 'pending' ? (
                        <IconAlertTriangle
                          size={12}
                          color="var(--mantine-color-orange-7)"
                          aria-label="Needs attention"
                        />
                      ) : null}
                    </Group>
                    <Text size="xs" className="line-clamp-2">
                      <RichView value={text} />
                    </Text>
                  </UnstyledButton>
                );
              })}
              {!visible.length ? (
                <Text c="dimmed" size="sm">
                  Nothing waiting. All items are reviewed.
                </Text>
              ) : null}
            </Stack>
          </ScrollArea>
        </Grid.Col>

        <Grid.Col span={current?.pageImage ? 5 : 9}>
          {current ? (
            <Stack>
              {current.status !== 'pending' ? (
                <Alert color="gray">
                  This item is {STATUS[current.status].label.toLowerCase()}
                  {current.rejectReason ? `: ${current.rejectReason}` : ''}.
                </Alert>
              ) : null}
              {current.kind === 'unplaced' && current.unplaced ? (
                <Stack>
                  <Alert color="orange" title="Text the importer could not place">
                    {current.unplaced.reason}. {current.unplaced.refs.join(', ')}
                  </Alert>
                  <div
                    style={{
                      padding: 12,
                      border: '1px solid var(--mantine-color-default-border)',
                      borderRadius: 8,
                    }}
                  >
                    <RichView value={current.unplaced.content} review />
                  </div>
                  {current.status === 'pending' ? (
                    <Group>
                      <Button
                        onClick={async () => {
                          await run(() =>
                            call('review:convert', {
                              itemId: current.id,
                              defaults: {
                                subject: settings.subjects[0] ?? '',
                                topic: '',
                                difficulty: 'medium',
                                source: '',
                              },
                            }),
                          );
                          await items.reload();
                        }}
                      >
                        Turn into a question
                      </Button>
                      <Button
                        variant="light"
                        color="red"
                        onClick={async () => {
                          await run(() =>
                            call('review:reject', {
                              itemIds: [current.id],
                              reason: 'Not a question',
                              skip: false,
                            }),
                          );
                          await items.reload();
                        }}
                      >
                        Discard (not a question)
                      </Button>
                    </Group>
                  ) : null}
                </Stack>
              ) : draft ? (
                <Stack>
                  {current.candidate?.warnings.length ? (
                    <Alert
                      color="yellow"
                      icon={<IconAlertTriangle aria-hidden />}
                      title="Check these"
                    >
                      <List size="sm">
                        {current.candidate.warnings.map((w) => (
                          <List.Item key={w}>{w}</List.Item>
                        ))}
                      </List>
                    </Alert>
                  ) : null}
                  {current.duplicates.length ? (
                    <Alert
                      color="grape"
                      title={
                        current.duplicates.some((d) => d.exact && d.scope === 'bank')
                          ? 'This exact question is already in the bank'
                          : 'A similar question exists'
                      }
                    >
                      <Group>
                        <Text size="sm">
                          Best match {Math.round(current.duplicates[0].score * 100)}% (
                          {current.duplicates[0].scope === 'bank'
                            ? 'in the bank'
                            : 'in this import'}
                          ).
                        </Text>
                        <Button
                          size="xs"
                          variant="white"
                          onClick={async () =>
                            setCompare(
                              (await run(() => call('review:compare', { itemId: current.id }))) ??
                                null,
                            )
                          }
                        >
                          Compare side by side
                        </Button>
                      </Group>
                    </Alert>
                  ) : null}
                  {current.candidate?.pages.length || current.candidate?.refs.length ? (
                    <Text size="xs" c="dimmed">
                      From: {current.candidate.refs.join(', ')}
                    </Text>
                  ) : null}
                  {current.candidate?.stem.some((i) => i.t === 'text' && i.low) ||
                  current.candidate?.options.some((o) => o.some((i) => i.t === 'text' && i.low)) ? (
                    <div
                      style={{
                        padding: 8,
                        border: '1px dashed var(--mantine-color-yellow-6)',
                        borderRadius: 8,
                      }}
                    >
                      <Text size="xs" fw={600}>
                        Words the OCR was unsure of are highlighted:
                      </Text>
                      <RichView value={current.candidate!.stem} review />
                      {current.candidate!.options.map((o, i) => (
                        <div key={i}>
                          {LETTERS[i]}. <RichView value={o} review />
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <QuestionForm
                    value={draft}
                    onChange={(d) => {
                      setDraft(d);
                      setDirty(true);
                    }}
                    disabled={current.status !== 'pending'}
                  />
                  {current.status === 'pending' ? (
                    <>
                      {current.issues.length && !dirty ? (
                        <Text size="sm" c="orange.8" role="status">
                          Before approving: {current.issues.join(' ')}
                        </Text>
                      ) : null}
                      <Divider />
                      <Group justify="space-between">
                        <Group>
                          <Button
                            onClick={() => void approve()}
                            loading={busy}
                            leftSection={<IconCheck size={16} aria-hidden />}
                          >
                            Approve into bank
                          </Button>
                          {dirty ? (
                            <Button
                              variant="default"
                              onClick={async () => {
                                await saveDraft();
                                await items.reload();
                                setDirty(false);
                              }}
                            >
                              Save changes
                            </Button>
                          ) : null}
                        </Group>
                        <Group>
                          <Button variant="subtle" onClick={() => move(1)}>
                            Next
                          </Button>
                          <Button variant="light" color="red" onClick={() => setRejectOpen(true)}>
                            Reject
                          </Button>
                        </Group>
                      </Group>
                    </>
                  ) : null}
                </Stack>
              ) : null}
            </Stack>
          ) : (
            <Text c="dimmed">Select an item on the left.</Text>
          )}
        </Grid.Col>

        {current?.pageImage ? (
          <Grid.Col span={4}>
            <ScrollArea h="calc(100vh - 250px)" type="auto">
              <CropTool
                pageRef={current.pageImage}
                targets={[
                  'question',
                  ...(draft?.options.map((_, i) => `option ${LETTERS[i]}`) ?? []),
                ]}
                onAttach={attachCrop}
              />
            </ScrollArea>
          </Grid.Col>
        ) : null}
      </Grid>

      <Modal opened={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject this item">
        <Stack>
          <Textarea
            label="Reason"
            placeholder="For example: unreadable, duplicate, out of syllabus"
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button
              color="red"
              disabled={!reason.trim()}
              onClick={async () => {
                if (!current) return;
                await run(() =>
                  call('review:reject', {
                    itemIds: [current.id],
                    reason: reason.trim(),
                    skip: false,
                  }),
                );
                setRejectOpen(false);
                setReason('');
                move(1);
                await items.reload();
              }}
            >
              Reject
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={!!compare}
        onClose={() => setCompare(null)}
        title="Compare with the existing question"
        size="xl"
      >
        {compare && draft ? (
          <Stack>
            <Grid>
              <Grid.Col span={6}>
                <Title order={4} size="h5">
                  Imported
                </Title>
                <RichView value={draft.stem} />
                <List type="ordered" mt="xs">
                  {draft.options.map((o, i) => (
                    <List.Item key={i} fw={draft.correct === i ? 700 : 400}>
                      <RichView value={o} />
                    </List.Item>
                  ))}
                </List>
              </Grid.Col>
              <Grid.Col span={6}>
                {compare.bank.map(({ hit, question }) =>
                  question ? (
                    <Stack key={hit.id} gap={4}>
                      <Title order={4} size="h5">
                        In the bank ({Math.round(hit.score * 100)}% match)
                      </Title>
                      <RichView value={question.stem} />
                      <List type="ordered">
                        {question.options.map((o, i) => (
                          <List.Item key={i} fw={question.correct === i ? 700 : 400}>
                            <RichView value={o} />
                          </List.Item>
                        ))}
                      </List>
                      <Group mt="xs">
                        <Button
                          size="xs"
                          onClick={async () => {
                            await run(() =>
                              call('review:merge', {
                                itemId: compare.item.id,
                                questionId: question.id,
                              }),
                            );
                            setCompare(null);
                            await items.reload();
                          }}
                        >
                          Merge (keep the bank copy)
                        </Button>
                      </Group>
                    </Stack>
                  ) : null,
                )}
                {compare.batch.map(({ hit, item }) =>
                  item?.candidate ? (
                    <Stack key={hit.id} gap={4}>
                      <Title order={4} size="h5">
                        Also in this import ({Math.round(hit.score * 100)}% match)
                      </Title>
                      <RichView value={item.candidate.stem} />
                    </Stack>
                  ) : null,
                )}
              </Grid.Col>
            </Grid>
            <Group justify="flex-end">
              {!compare.item.duplicates.some((d) => d.exact && d.scope === 'bank') ? (
                <Button
                  variant="light"
                  onClick={async () => {
                    await saveDraft('keep');
                    setCompare(null);
                    await items.reload();
                  }}
                >
                  Keep both
                </Button>
              ) : null}
              <Button
                variant="light"
                color="gray"
                onClick={async () => {
                  await run(() =>
                    call('review:reject', {
                      itemIds: [compare.item.id],
                      reason: 'Duplicate',
                      skip: true,
                    }),
                  );
                  setCompare(null);
                  await items.reload();
                }}
              >
                Skip the import
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>

      <Modal
        opened={keyOpen}
        onClose={() => setKeyOpen(false)}
        title="Apply an answer key to this import"
        size="lg"
      >
        <Stack>
          <Text size="sm">
            Type or paste the key (for example "1. b 2. d 3. a"), or read it from a photo of the
            answer-key page. Answers are matched by question number.
          </Text>
          <Textarea
            value={keyText}
            onChange={(e) => setKeyText(e.currentTarget.value)}
            minRows={3}
            autosize
            label="Answer key"
          />
          <Group justify="space-between">
            <FileButton
              accept="image/png,image/jpeg"
              onChange={async (file) => {
                if (!file) return;
                const r = await run(async () =>
                  call('review:applyKey', {
                    batchId,
                    page: await fileToUpload(file),
                    overwrite: false,
                  }),
                );
                if (r) notifyOk(`${r.entries} answers read; ${r.applied} questions updated.`);
                setKeyOpen(false);
                await items.reload();
              }}
            >
              {(props) => (
                <Button variant="light" {...props} loading={busy}>
                  Read from a photo
                </Button>
              )}
            </FileButton>
            <Button
              disabled={!keyText.trim()}
              loading={busy}
              onClick={async () => {
                const r = await run(() =>
                  call('review:applyKey', { batchId, keyText, overwrite: false }),
                );
                if (r) notifyOk(`${r.entries} answers read; ${r.applied} questions updated.`);
                setKeyOpen(false);
                await items.reload();
              }}
            >
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

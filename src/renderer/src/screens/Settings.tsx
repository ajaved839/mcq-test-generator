import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  FileButton,
  Group,
  Image,
  Modal,
  NumberInput,
  Pagination,
  PasswordInput,
  Radio,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconDeviceFloppy } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/schemas';
import { call, fileToUpload, type Out } from '../api';
import { useAppData } from '../App';
import { formatDateTime, imageUrl, notifyOk, RichView, useAction, useLoad, useNav } from '../lib';

function GeneralTab() {
  const { settings, refresh } = useAppData();
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, run] = useAction();
  useEffect(() => setDraft(settings), [settings]);
  const save = async (): Promise<void> => {
    const r = await run(() =>
      call('settings:update', {
        institute: { name: draft.institute.name, address: draft.institute.address },
        paper: draft.paper,
        rule: draft.rule,
        strategy: draft.strategy,
        subjects: draft.subjects,
        duplicateThresholdPct: draft.duplicateThresholdPct,
        theme: draft.theme,
        textScalePct: draft.textScalePct,
        staff: draft.staff,
        backup: { keepAutomatic: draft.backup.keepAutomatic, remindDays: draft.backup.remindDays },
      }),
    );
    if (r) {
      notifyOk('Settings saved.');
      await refresh();
    }
  };
  const set = (patch: Partial<Settings>): void => setDraft({ ...draft, ...patch });

  return (
    <Stack>
      <Card>
        <Title order={3} size="h5" mb="sm">
          Institute and paper header
        </Title>
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <TextInput
            label="Institute name"
            value={draft.institute.name}
            onChange={(e) =>
              set({ institute: { ...draft.institute, name: e.currentTarget.value } })
            }
          />
          <TextInput
            label="Address or tagline"
            value={draft.institute.address}
            onChange={(e) =>
              set({ institute: { ...draft.institute, address: e.currentTarget.value } })
            }
          />
        </SimpleGrid>
        <Group mt="sm" align="center">
          {settings.institute.logoRef ? (
            <Image
              src={imageUrl(settings.institute.logoRef)}
              alt="Institute logo"
              h={56}
              w="auto"
              fit="contain"
            />
          ) : (
            <Text size="sm" c="dimmed">
              No logo
            </Text>
          )}
          <FileButton
            accept="image/png,image/jpeg"
            onChange={async (f) => {
              if (f && (await run(async () => call('settings:setLogo', await fileToUpload(f)))))
                await refresh();
            }}
          >
            {(props) => (
              <Button variant="light" {...props}>
                Choose logo
              </Button>
            )}
          </FileButton>
          {settings.institute.logoRef ? (
            <Button
              variant="subtle"
              color="gray"
              onClick={async () => {
                await run(() => call('settings:clearLogo'));
                await refresh();
              }}
            >
              Remove logo
            </Button>
          ) : null}
        </Group>
        <Textarea
          mt="sm"
          label="Default instructions"
          value={draft.paper.instructions}
          onChange={(e) => set({ paper: { ...draft.paper, instructions: e.currentTarget.value } })}
          autosize
          minRows={2}
        />
        <SimpleGrid cols={{ base: 2, md: 4 }} mt="sm">
          <NumberInput
            label="Default time (minutes)"
            value={draft.paper.durationMinutes}
            min={0}
            max={1000}
            onChange={(v) => set({ paper: { ...draft.paper, durationMinutes: Number(v) || 0 } })}
          />
          <Select
            label="Default versions"
            data={['1', '2', '3', '4']}
            value={String(draft.paper.versions)}
            onChange={(v) => set({ paper: { ...draft.paper, versions: Number(v ?? 1) } })}
            allowDeselect={false}
          />
          <NumberInput
            label="Paper font size (pt)"
            value={draft.paper.fontSizePt}
            min={8}
            max={16}
            step={0.5}
            onChange={(v) => set({ paper: { ...draft.paper, fontSizePt: Number(v) || 11 } })}
          />
          <Stack gap={6} mt={24}>
            <Checkbox
              label="Print the test code"
              checked={draft.paper.showTestCode}
              onChange={(e) =>
                set({ paper: { ...draft.paper, showTestCode: e.currentTarget.checked } })
              }
            />
            <Checkbox
              label="Group questions by subject"
              checked={draft.paper.groupBySubject}
              onChange={(e) =>
                set({ paper: { ...draft.paper, groupBySubject: e.currentTarget.checked } })
              }
            />
          </Stack>
        </SimpleGrid>
      </Card>
      <Card>
        <Title order={3} size="h5" mb="sm">
          Repeat rule defaults
        </Title>
        <Radio.Group
          value={draft.rule.mode}
          onChange={(v) => set({ rule: { ...draft.rule, mode: v as Settings['rule']['mode'] } })}
        >
          <Stack gap={6}>
            <Radio
              value="each"
              label="Each earlier test separately (recommended for regular tests)"
            />
            <Radio value="combined" label="All earlier tests combined (stricter, for finals)" />
          </Stack>
        </Radio.Group>
        <Group mt="sm" align="flex-end">
          <NumberInput
            label="Limit (%)"
            value={draft.rule.limitPct}
            min={0}
            max={100}
            onChange={(v) => set({ rule: { ...draft.rule, limitPct: Math.round(Number(v) || 0) } })}
            w={120}
          />
          <Checkbox
            label="Measure against the smaller test"
            checked={draft.rule.denominator === 'smaller'}
            onChange={(e) =>
              set({
                rule: { ...draft.rule, denominator: e.currentTarget.checked ? 'smaller' : 'new' },
              })
            }
          />
          <NumberInput
            label="Duplicate match threshold (%)"
            description="Close matches above this are shown side by side"
            value={draft.duplicateThresholdPct}
            min={50}
            max={100}
            onChange={(v) => set({ duplicateThresholdPct: Math.round(Number(v) || 90) })}
            w={260}
          />
        </Group>
      </Card>
      <Card>
        <Title order={3} size="h5" mb="sm">
          Subjects and staff
        </Title>
        <TagsInput
          label="Subjects"
          description="Imports and blueprints use this list"
          value={draft.subjects}
          onChange={(v) => set({ subjects: v })}
        />
        <TagsInput
          mt="sm"
          label="Staff names"
          description="If set, only these names can be entered at sign-in. Leave empty to allow any name."
          value={draft.staff}
          onChange={(v) => set({ staff: v })}
        />
      </Card>
      <Card>
        <Title order={3} size="h5" mb="sm">
          Appearance
        </Title>
        <Group>
          <SegmentedControl
            aria-label="Theme"
            value={draft.theme}
            onChange={(v) => set({ theme: v as Settings['theme'] })}
            data={[
              { value: 'auto', label: 'Match computer' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
          <Select
            aria-label="Text size"
            data={[
              { value: '90', label: 'Smaller text' },
              { value: '100', label: 'Normal text' },
              { value: '115', label: 'Larger text' },
              { value: '130', label: 'Largest text' },
            ]}
            value={String(draft.textScalePct)}
            onChange={(v) => set({ textScalePct: Number(v ?? 100) })}
            allowDeselect={false}
          />
        </Group>
      </Card>
      <Group justify="flex-end">
        <Button
          leftSection={<IconDeviceFloppy size={16} aria-hidden />}
          onClick={() => void save()}
          loading={busy}
        >
          Save settings
        </Button>
      </Group>
    </Stack>
  );
}

function BackupTab() {
  const { refresh } = useAppData();
  const autos = useLoad(() => call('backup:list'));
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [restorePass, setRestorePass] = useState('');
  const [pending, setPending] = useState<NonNullable<Out<'backup:inspectFile'>> | null>(null);
  const [mergePass, setMergePass] = useState('');
  const [mergePlan, setMergePlan] = useState<NonNullable<Out<'merge:inspect'>> | null>(null);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [busy, run] = useAction();

  return (
    <Stack>
      <Card>
        <Title order={3} size="h5">
          Back up now
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          Saves one encrypted file to any folder (a USB drive or shared drive). Keep the passphrase
          safe: without it the backup cannot be opened.
        </Text>
        <Group align="flex-end">
          <PasswordInput
            label="Passphrase (8+ characters)"
            value={pass}
            onChange={(e) => setPass(e.currentTarget.value)}
            w={260}
          />
          <PasswordInput
            label="Repeat passphrase"
            value={pass2}
            onChange={(e) => setPass2(e.currentTarget.value)}
            w={260}
            error={pass2 && pass !== pass2 ? 'Does not match' : undefined}
          />
          <Button
            disabled={pass.length < 8 || pass !== pass2}
            loading={busy}
            onClick={async () => {
              const r = await run(() => call('backup:now', { passphrase: pass }));
              if (r?.saved) {
                notifyOk(
                  `Backup saved: ${r.counts?.questions} questions, ${r.counts?.tests} tests.`,
                );
                setPass('');
                setPass2('');
                await refresh();
              }
            }}
          >
            Choose folder and back up
          </Button>
        </Group>
      </Card>
      <Card>
        <Title order={3} size="h5">
          Restore
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          Restoring replaces everything in this workspace. The current workspace is backed up
          automatically first.
        </Text>
        <Group align="flex-end">
          <PasswordInput
            label="Backup passphrase"
            value={restorePass}
            onChange={(e) => setRestorePass(e.currentTarget.value)}
            w={260}
          />
          <Button
            variant="light"
            disabled={restorePass.length < 8}
            loading={busy}
            onClick={async () =>
              setPending(
                (await run(() => call('backup:inspectFile', { passphrase: restorePass }))) ?? null,
              )
            }
          >
            Choose backup file
          </Button>
        </Group>
        <Title order={4} size="h6" mt="md">
          Automatic backups on this laptop (taken on close and before upgrades)
        </Title>
        <Table>
          <Table.Tbody>
            {(autos.data ?? []).map((b) => (
              <Table.Tr key={b.name}>
                <Table.Td>{formatDateTime(b.createdAt)}</Table.Td>
                <Table.Td>{b.reason}</Table.Td>
                <Table.Td>{Math.round(b.bytes / 1024)} KB</Table.Td>
                <Table.Td>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={async () =>
                      setPending(
                        (await run(() => call('backup:inspectAuto', { name: b.name }))) ?? null,
                      )
                    }
                  >
                    Restore…
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
            {!(autos.data ?? []).length ? (
              <Table.Tr>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    None yet. One is taken each time the app closes.
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      </Card>
      <Card>
        <Title order={3} size="h5">
          Merge history between laptops
        </Title>
        <Text size="sm" c="dimmed" mb="sm">
          The repeat rule only sees tests this laptop knows about. Export history here and merge it
          on the generating laptop before making new tests.
        </Text>
        <Group align="flex-end">
          <PasswordInput
            label="Passphrase"
            value={mergePass}
            onChange={(e) => setMergePass(e.currentTarget.value)}
            w={260}
          />
          <Button
            variant="light"
            disabled={mergePass.length < 8}
            loading={busy}
            onClick={async () => {
              const r = await run(() => call('merge:export', { passphrase: mergePass }));
              if (r?.saved)
                notifyOk('Merge file saved. Open it on the other laptop with the same passphrase.');
            }}
          >
            Export this laptop's history
          </Button>
          <Button
            disabled={mergePass.length < 8}
            loading={busy}
            onClick={async () => {
              const r = await run(() => call('merge:inspect', { passphrase: mergePass }));
              if (r) {
                setMergePlan(r);
                setChoices(Object.fromEntries(r.plan.conflicts.map((c) => [c.id, 'mine'])));
              }
            }}
          >
            Merge a file from another laptop
          </Button>
        </Group>
      </Card>

      <Modal opened={!!pending} onClose={() => setPending(null)} title="Restore this backup?">
        {pending ? (
          <Stack>
            <Alert color="orange" icon={<IconAlertTriangle aria-hidden />}>
              Everything in the current workspace will be replaced. A copy of the current workspace
              is saved first.
            </Alert>
            <Text size="sm">
              Made {formatDateTime(pending.createdAt)}
              {pending.appVersion ? ` by version ${pending.appVersion}` : ''}. Contains{' '}
              {pending.counts.questions} questions ({pending.counts.activeQuestions} active),{' '}
              {pending.counts.tests} tests and {pending.counts.images} images.
            </Text>
            {!pending.sameWorkspace ? (
              <Text size="sm" c="orange.8">
                This backup came from a different laptop or workspace.
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                color="orange"
                loading={busy}
                onClick={async () => {
                  const r = await run(() =>
                    call('backup:restore', { token: pending.token, confirm: true }),
                  );
                  if (r) {
                    notifyOk('Backup restored.');
                    setPending(null);
                    await refresh();
                    window.location.reload();
                  }
                }}
              >
                Replace and restore
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>

      <Modal
        opened={!!mergePlan}
        onClose={() => setMergePlan(null)}
        title="Merge history"
        size="xl"
      >
        {mergePlan ? (
          <Stack>
            {mergePlan.plan.sameWorkspace ? (
              <Alert color="yellow">
                This file came from this same workspace; merging changes little.
              </Alert>
            ) : null}
            <Text size="sm">
              {mergePlan.plan.newQuestions} new questions, {mergePlan.plan.matchedByWording.length}{' '}
              already here under another ID (kept once), {mergePlan.plan.unchangedQuestions}{' '}
              unchanged, {mergePlan.plan.newTests.length} new tests, {mergePlan.plan.newImages} new
              images.
            </Text>
            {mergePlan.plan.conflicts.length ? (
              <Stack>
                <Title order={4} size="h6">
                  {mergePlan.plan.conflicts.length} question(s) were edited differently. Choose
                  which version to keep.
                </Title>
                {mergePlan.plan.conflicts.map((c) => (
                  <Card key={c.id}>
                    <SimpleGrid cols={2}>
                      <div>
                        <Text size="xs" c="dimmed">
                          This laptop (v{c.mine.version})
                        </Text>
                        <RichView value={c.mine.stem} />
                        <Text size="xs">Answer {'ABCDE'[c.mine.correct]}</Text>
                      </div>
                      <div>
                        <Text size="xs" c="dimmed">
                          Other laptop (v{c.theirs.version})
                        </Text>
                        <RichView value={c.theirs.stem} />
                        <Text size="xs">Answer {'ABCDE'[c.theirs.correct]}</Text>
                      </div>
                    </SimpleGrid>
                    <SegmentedControl
                      mt="xs"
                      value={choices[c.id]}
                      onChange={(v) => setChoices({ ...choices, [c.id]: v as 'mine' | 'theirs' })}
                      data={[
                        { value: 'mine', label: 'Keep this laptop' },
                        { value: 'theirs', label: 'Take the other' },
                      ]}
                    />
                  </Card>
                ))}
              </Stack>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setMergePlan(null)}>
                Cancel
              </Button>
              <Button
                loading={busy}
                onClick={async () => {
                  const r = await run(() =>
                    call('merge:apply', { token: mergePlan.token, choices, confirm: true }),
                  );
                  if (r) {
                    notifyOk('History merged.');
                    setMergePlan(null);
                  }
                }}
              >
                Merge
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'import.staged': 'Imported for review',
  'import.deleted': 'Import deleted',
  'review.approved': 'Approved into bank',
  'review.rejected': 'Rejected in review',
  'review.merged': 'Merged duplicate',
  'review.skipped': 'Skipped duplicate',
  'question.created': 'Question added',
  'question.edited': 'Question edited',
  'question.archived': 'Questions archived',
  'question.restored': 'Questions restored',
  'question.deleted': 'Questions deleted',
  'question.reverted': 'Question undone to earlier version',
  'test.generated': 'Test generated',
  'test.outside-imported': 'Outside test added',
  'test.exported': 'Test exported',
  'test.comparison-changed': 'Test comparison changed',
  'settings.changed': 'Settings changed',
  'backup.created': 'Backup saved',
  'backup.restored': 'Backup restored',
  'merge.exported': 'History exported',
  'merge.applied': 'History merged',
  'session.started': 'Signed in',
  'session.ended': 'Signed out',
  'session.login-failed': 'Failed sign-in',
};

function AuditTab() {
  const [page, setPage] = useState(1);
  const log = useLoad(() => call('audit:list', { limit: 50, offset: (page - 1) * 50 }), [page]);
  return (
    <Stack>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th>
            <Table.Th>Who</Table.Th>
            <Table.Th>What</Table.Th>
            <Table.Th>Details</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(log.data?.entries ?? []).map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{formatDateTime(e.at)}</Table.Td>
              <Table.Td>
                {e.actor}
                {e.actor !== e.osUser ? ` (${e.osUser})` : ''}
              </Table.Td>
              <Table.Td>{ACTION_LABEL[e.action] ?? e.action}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" lineClamp={2}>
                  {Object.entries(e.details)
                    .map(
                      ([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
                    )
                    .join(', ')}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {log.data && log.data.total > 50 ? (
        <Pagination total={Math.ceil(log.data.total / 50)} value={page} onChange={setPage} />
      ) : null}
    </Stack>
  );
}

function SupportTab() {
  const { info } = useAppData();
  const [busy, run] = useAction();
  return (
    <Card>
      <Stack>
        <Text size="sm">
          Version {info.version} on {info.platform} {info.osRelease}. Data folder:{' '}
          {info.workspaceFolder}
        </Text>
        <Alert color="calmBlue" title="Data at rest">
          The workspace file is not encrypted by the app in v1. Turn on BitLocker (Windows) or
          FileVault (Mac) on admin laptops.
        </Alert>
        <Group>
          <Button
            variant="light"
            loading={busy}
            onClick={async () => {
              const r = await run(() => call('app:saveDiagnostics'));
              if (r?.saved) notifyOk('Diagnostics saved. It contains no exam content.');
            }}
          >
            Save diagnostics
          </Button>
          <Badge variant="light" color="gray">
            No internet connection is used
          </Badge>
        </Group>
      </Stack>
    </Card>
  );
}

/** Settings: institute setup, defaults, backups, merge, audit log and diagnostics. */
export function SettingsScreen() {
  const { params } = useNav();
  return (
    <Stack gap="md">
      <Title order={2}>Settings</Title>
      <Tabs defaultValue={params.tab ?? 'general'}>
        <Tabs.List>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="backup">Backup, restore and merge</Tabs.Tab>
          <Tabs.Tab value="audit">Activity log</Tabs.Tab>
          <Tabs.Tab value="support">Support</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="general" pt="md">
          <GeneralTab />
        </Tabs.Panel>
        <Tabs.Panel value="backup" pt="md">
          <BackupTab />
        </Tabs.Panel>
        <Tabs.Panel value="audit" pt="md">
          <AuditTab />
        </Tabs.Panel>
        <Tabs.Panel value="support" pt="md">
          <SupportTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

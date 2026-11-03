import { Button, Checkbox, Group, Modal, Progress, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { call, onProgress } from '../api';
import { notifyOk, useAction } from '../lib';

const KINDS = [
  { value: 'paper-pdf', label: 'Question paper (PDF)' },
  { value: 'paper-docx', label: 'Question paper (Word)' },
  { value: 'key-pdf', label: 'Answer key (PDF, marked confidential)' },
  { value: 'record-xlsx', label: 'Test record (Excel)' },
] as const;

/** Export a saved test. Every export is stored with the test so it can be reprinted identically. */
export function ExportDialog({
  testId,
  versions,
  opened,
  onClose,
}: {
  testId: string;
  versions: string[];
  opened: boolean;
  onClose: () => void;
}) {
  const [kinds, setKinds] = useState<string[]>(['paper-pdf', 'key-pdf', 'record-xlsx']);
  const [chosen, setChosen] = useState<string[]>(versions);
  const [explanations, setExplanations] = useState(false);
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [busy, run] = useAction();

  useEffect(() => setChosen(versions), [versions]);
  useEffect(
    () =>
      onProgress((p) => {
        if (p.task === 'export')
          setProgress({
            label: p.label,
            pct: p.total ? Math.round((p.current / p.total) * 100) : 0,
          });
      }),
    [],
  );

  return (
    <Modal opened={opened} onClose={onClose} title="Export papers" size="md">
      <Stack>
        <Checkbox.Group label="Files" value={kinds} onChange={setKinds}>
          <Stack gap={6} mt={6}>
            {KINDS.map((k) => (
              <Checkbox key={k.value} value={k.value} label={k.label} />
            ))}
          </Stack>
        </Checkbox.Group>
        {versions.length > 1 ? (
          <Checkbox.Group label="Versions" value={chosen} onChange={setChosen}>
            <Group mt={6}>
              {versions.map((v) => (
                <Checkbox key={v} value={v} label={`Version ${v}`} />
              ))}
            </Group>
          </Checkbox.Group>
        ) : null}
        <Checkbox
          label="Print explanations on the answer key"
          checked={explanations}
          onChange={(e) => setExplanations(e.currentTarget.checked)}
        />
        {progress && busy ? (
          <Stack gap={4}>
            <Text size="sm">{progress.label}</Text>
            <Progress value={progress.pct} aria-label={progress.label} />
          </Stack>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button
            loading={busy}
            disabled={!kinds.length || !chosen.length}
            onClick={async () => {
              const r = await run(() =>
                call('export:test', {
                  id: testId,
                  kinds: kinds as never,
                  versions: chosen as never,
                  includeExplanations: explanations,
                }),
              );
              setProgress(null);
              if (r && r.saved.length) {
                notifyOk(`${r.saved.length} file(s) saved.`, 'Exported');
                onClose();
              }
            }}
          >
            Choose folder and export
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

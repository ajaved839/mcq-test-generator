import {
  ActionIcon,
  Autocomplete,
  Button,
  Checkbox,
  Group,
  Radio,
  Select,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { RichText } from '../../../core/richtext';
import { optionLockReason } from '../../../core/shuffle';
import type { Difficulty } from '../../../core/types';
import { RichEditor } from './RichEditor';
import { SubjectSelect } from './SubjectSelect';

/** The fields every question has, shared by the bank editor and the review queue. */
export interface QuestionDraft {
  stem: RichText;
  options: RichText[];
  correct: number | null;
  explanation: RichText;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  tags: string[];
  source: string;
  lockOptions: boolean;
  reserved: boolean;
}

const LETTERS = 'ABCDE';

const LOCK_TEXT = {
  manual: 'Options stay in this order (locked by staff).',
  'letter-reference': 'Options stay in this order because one refers to others by letter.',
  'pinned-not-last': 'Options stay in this order because "All/None of the above" is not last.',
} as const;

export function QuestionForm({
  value,
  onChange,
  topics = [],
  disabled = false,
}: {
  value: QuestionDraft;
  onChange: (next: QuestionDraft) => void;
  topics?: string[];
  disabled?: boolean;
}) {
  const set = <K extends keyof QuestionDraft>(key: K, v: QuestionDraft[K]): void =>
    onChange({ ...value, [key]: v });
  const lock = optionLockReason({ options: value.options, lockOptions: value.lockOptions });

  const setOption = (index: number, rich: RichText): void => {
    const options = value.options.slice();
    options[index] = rich;
    set('options', options);
  };
  const removeOption = (index: number): void => {
    const options = value.options.filter((_, i) => i !== index);
    let correct = value.correct;
    if (correct === index) correct = null;
    else if (correct !== null && correct > index) correct -= 1;
    onChange({ ...value, options, correct });
  };

  return (
    <Stack gap="md">
      <RichEditor
        label="Question"
        value={value.stem}
        onChange={(v) => set('stem', v)}
        minHeight={90}
      />
      <Radio.Group
        label="Options (select the correct answer)"
        value={value.correct === null ? '' : String(value.correct)}
        onChange={(v) => set('correct', v === '' ? null : Number(v))}
        error={value.correct === null ? 'Mark the correct answer.' : undefined}
      >
        <Stack gap="xs" mt={6}>
          {value.options.map((option, i) => (
            <Group key={i} align="flex-start" wrap="nowrap" gap="sm">
              <Radio
                value={String(i)}
                aria-label={`Option ${LETTERS[i]} is correct`}
                mt={34}
                disabled={disabled}
              />
              <div style={{ flex: 1 }}>
                <RichEditor
                  label={`Option ${LETTERS[i]}`}
                  value={option}
                  onChange={(v) => setOption(i, v)}
                  minHeight={34}
                  compact
                />
              </div>
              <Tooltip label={`Remove option ${LETTERS[i]}`}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  mt={30}
                  aria-label={`Remove option ${LETTERS[i]}`}
                  disabled={value.options.length <= 2 || disabled}
                  onClick={() => removeOption(i)}
                >
                  <IconTrash size={16} aria-hidden />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
        </Stack>
      </Radio.Group>
      <Group>
        <Button
          variant="light"
          leftSection={<IconPlus size={16} aria-hidden />}
          disabled={value.options.length >= 5 || disabled}
          onClick={() => set('options', [...value.options, []])}
        >
          Add option
        </Button>
        {lock ? (
          <Text size="sm" c="dimmed">
            {LOCK_TEXT[lock]}
          </Text>
        ) : null}
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <SubjectSelect
          label="Subject"
          value={value.subject}
          onChange={(v) => set('subject', v)}
          required
          error={!value.subject ? 'Choose a subject.' : undefined}
        />
        <Autocomplete
          label="Topic"
          data={[...new Set(topics.filter(Boolean))]}
          value={value.topic}
          onChange={(v) => set('topic', v)}
          placeholder="Type or pick a topic"
        />
        <Select
          label="Difficulty"
          data={[
            { value: 'easy', label: 'Easy' },
            { value: 'medium', label: 'Medium' },
            { value: 'hard', label: 'Hard' },
          ]}
          value={value.difficulty}
          onChange={(v) => set('difficulty', (v ?? 'medium') as Difficulty)}
          allowDeselect={false}
        />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TagsInput
          label="Tags"
          value={value.tags}
          onChange={(v) => set('tags', v)}
          placeholder="Type and press Enter"
          clearable
        />
        <TextInput
          label="Source"
          value={value.source}
          onChange={(e) => set('source', e.currentTarget.value)}
          placeholder="Book, chapter or file"
        />
      </SimpleGrid>
      <RichEditor
        label="Explanation (optional, printed only on the answer key)"
        value={value.explanation}
        onChange={(v) => set('explanation', v)}
        minHeight={50}
      />
      <Group>
        <Checkbox
          label="Keep options in this order"
          checked={value.lockOptions}
          onChange={(e) => set('lockOptions', e.currentTarget.checked)}
        />
        <Checkbox
          label="Reserve for finals (regular tests never use it)"
          checked={value.reserved}
          onChange={(e) => set('reserved', e.currentTarget.checked)}
        />
      </Group>
    </Stack>
  );
}

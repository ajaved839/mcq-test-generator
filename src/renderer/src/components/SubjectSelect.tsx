import { Select } from '@mantine/core';
import { useState } from 'react';
import { call } from '../api';
import { useAppData } from '../App';
import { notifyError, notifyOk } from '../lib';

const NEW_PREFIX = '\u0000new:';

/**
 * Subject picker that can also create a subject: typing a name that is not in the list offers
 * "+ Add subject", which saves it to Settings so every screen sees it.
 */
export function SubjectSelect({
  label,
  value,
  onChange,
  required,
  error,
}: {
  label: string;
  value: string;
  onChange: (subject: string) => void;
  required?: boolean;
  error?: string;
}) {
  const { settings, refresh } = useAppData();
  const [search, setSearch] = useState('');
  const subjects = [...new Set([...settings.subjects, value].filter(Boolean))];
  const typed = search.trim();
  const exists = subjects.some((s) => s.toLowerCase() === typed.toLowerCase());
  const data = [
    ...subjects,
    ...(typed && !exists && typed.length <= 100
      ? [{ value: NEW_PREFIX + typed, label: `+ Add subject "${typed}"` }]
      : []),
  ];

  const add = async (name: string): Promise<void> => {
    try {
      await call('settings:update', { subjects: [...settings.subjects, name] });
      await refresh();
      notifyOk(`Subject "${name}" added.`);
      onChange(name);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <Select
      label={label}
      description={settings.subjects.length ? undefined : 'Type a subject name to add it'}
      placeholder="Choose or type a new subject"
      data={data}
      value={value || null}
      onChange={(v) => {
        if (v?.startsWith(NEW_PREFIX)) void add(v.slice(NEW_PREFIX.length));
        else onChange(v ?? '');
      }}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      nothingFoundMessage="Type a name to add a subject"
      required={required}
      error={error}
    />
  );
}

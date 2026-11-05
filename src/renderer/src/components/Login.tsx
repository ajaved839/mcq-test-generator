import { Alert, Button, PasswordInput, Select, Text, TextInput } from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowsShuffle,
  IconLock,
  IconRepeatOff,
  IconShieldCheck,
  IconShieldLock,
  IconUser,
  IconWifiOff,
} from '@tabler/icons-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { NAME_PREFIX, stripPrefix, withPrefix } from '../../../shared/names';
import { call } from '../api';
import classes from './Login.module.css';

const FEATURES = [
  { icon: <IconWifiOff size={16} aria-hidden />, text: 'Works fully offline on this laptop' },
  { icon: <IconArrowsShuffle size={16} aria-hidden />, text: 'Shuffled papers with answer keys' },
  { icon: <IconRepeatOff size={16} aria-hidden />, text: 'Repeat rule checked on every test' },
];

const inputClasses = { input: classes.input, label: classes.label };

// Fixed "Dr." shown inside the name field; it cannot be deleted.
const prefixSection = <span className={classes.prefix}>{NAME_PREFIX}</span>;

function initials(name: string): string {
  // Skip titles so "Dr Sara Khan" shows SK.
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p && !/^(dr|prof|mr|mrs|ms|miss)\.?$/i.test(p));
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?')[0])
    .toUpperCase()
    .slice(0, 2);
}

/** Super admin sign-in. The name entered here is recorded against every action this session. */
export function Login({ staff, onSignedIn }: { staff: string[]; onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsLock, setCapsLock] = useState(false);
  // Bumped on each failure so the shake animation restarts.
  const [attempt, setAttempt] = useState(0);
  const display = withPrefix(name ?? '');
  const ready = username.trim() && password && display;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call('app:login', { username, password, name: display });
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPassword('');
      setAttempt((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const trackCaps = (e: KeyboardEvent<HTMLInputElement>) =>
    setCapsLock(e.getModifierState('CapsLock'));

  return (
    <div className={classes.page}>
      <div className={classes.frame}>
        <section className={classes.brand} aria-hidden="false">
          <span className={`${classes.blob} ${classes.blobA}`} />
          <span className={`${classes.blob} ${classes.blobB}`} />
          <span className={`${classes.blob} ${classes.blobC}`} />
          <div className={classes.brandTop}>
            <div className={classes.logo}>
              <IconShieldCheck size={28} aria-hidden />
            </div>
            <h1 className={classes.brandTitle}>
              MCQ Shuffler
              <span className={classes.brandSub}>Medical Institutes</span>
            </h1>
            <p className={classes.brandLead}>
              Build fair, shuffled test papers from your question bank in minutes.
            </p>
          </div>
          <ul className={classes.brandBottom} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {FEATURES.map((f, i) => (
              <li
                key={f.text}
                className={classes.feature}
                style={{ animationDelay: `${0.2 + i * 0.1}s` }}
              >
                <span className={classes.featureIcon}>{f.icon}</span>
                {f.text}
              </li>
            ))}
          </ul>
        </section>

        <form
          key={attempt}
          className={`${classes.form} ${attempt ? classes.shake : ''}`}
          onSubmit={submit}
          aria-labelledby="login-heading"
        >
          <span className={classes.eyebrow}>
            <IconShieldLock size={14} aria-hidden />
            Super admin
          </span>
          <h2 id="login-heading" className={classes.heading}>
            Welcome back
          </h2>
          <p className={classes.sub}>Sign in to continue to your question bank.</p>

          {error ? (
            <Alert
              color="red"
              variant="light"
              role="alert"
              icon={<IconAlertCircle size={18} aria-hidden />}
            >
              {error}
            </Alert>
          ) : null}

          <TextInput
            label="Username"
            placeholder="Enter username"
            leftSection={<IconUser size={16} aria-hidden />}
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            autoComplete="username"
            size="md"
            classNames={inputClasses}
            required
            autoFocus
          />
          <PasswordInput
            label="Password"
            placeholder="Enter password"
            leftSection={<IconLock size={16} aria-hidden />}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onKeyUp={trackCaps}
            onKeyDown={trackCaps}
            onBlur={() => setCapsLock(false)}
            autoComplete="current-password"
            size="md"
            classNames={inputClasses}
            error={capsLock ? 'Caps Lock is on' : undefined}
            required
          />
          {staff.length ? (
            <Select
              label="Your name"
              placeholder="Pick your name"
              leftSection={prefixSection}
              leftSectionWidth={48}
              data={staff.map(stripPrefix)}
              value={name}
              onChange={setName}
              searchable
              size="md"
              classNames={inputClasses}
              required
            />
          ) : (
            <TextInput
              label="Your name"
              placeholder="First and last name"
              leftSection={prefixSection}
              leftSectionWidth={48}
              value={name ?? ''}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={95}
              size="md"
              classNames={inputClasses}
              required
            />
          )}

          {display ? (
            <div className={classes.preview} aria-live="polite">
              <span className={classes.avatar} aria-hidden>
                {initials(display)}
              </span>
              <div>
                <Text size="xs" c="#4b5563">
                  You will appear as
                </Text>
                <Text size="sm" fw={600} c="#111827">
                  {display}
                </Text>
              </div>
            </div>
          ) : null}

          <Button type="submit" className={classes.submit} loading={busy} disabled={!ready}>
            Sign in
          </Button>
          <Text className={classes.foot}>
            Your name is recorded on every import, edit and test.
          </Text>
        </form>
      </div>
    </div>
  );
}

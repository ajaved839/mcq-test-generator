import {
  Alert,
  AppShell,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  MantineProvider,
  NavLink,
  Text,
  Title,
} from '@mantine/core';
import { useColorScheme } from '@mantine/hooks';
import { Notifications } from '@mantine/notifications';
import {
  IconClipboardList,
  IconDatabase,
  IconFileImport,
  IconHistory,
  IconHome,
  IconLogout,
  IconSettings,
  IconShieldCheck,
  IconUser,
} from '@tabler/icons-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Settings } from '../../shared/schemas';
import { call, type Out } from './api';
import { Login } from './components/Login';
import { NavContext, notifyError, type NavTarget, type Screen } from './lib';
import { Bank } from './screens/Bank';
import { Generate } from './screens/Generate';
import { Home } from './screens/Home';
import { ImportScreen } from './screens/Import';
import { SettingsScreen } from './screens/Settings';
import { Tests } from './screens/Tests';
import { theme } from './theme';

interface AppData {
  info: Out<'app:info'>;
  settings: Settings;
  refresh: () => Promise<void>;
}

const AppDataContext = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const value = useContext(AppDataContext);
  if (!value) throw new Error('App data is not loaded.');
  return value;
}

const NAV: Array<{ screen: Screen; label: string; icon: ReactNode }> = [
  { screen: 'home', label: 'Home', icon: <IconHome size={18} aria-hidden /> },
  { screen: 'bank', label: 'Question bank', icon: <IconDatabase size={18} aria-hidden /> },
  { screen: 'import', label: 'Import', icon: <IconFileImport size={18} aria-hidden /> },
  { screen: 'generate', label: 'Generate test', icon: <IconClipboardList size={18} aria-hidden /> },
  { screen: 'tests', label: 'Tests and history', icon: <IconHistory size={18} aria-hidden /> },
  { screen: 'settings', label: 'Settings', icon: <IconSettings size={18} aria-hidden /> },
];

function Shell() {
  const { info, refresh } = useAppData();
  const [target, setTarget] = useState<NavTarget>({ screen: 'home' });
  const go = useCallback((next: NavTarget) => setTarget(next), []);
  const nav = useMemo(() => ({ go, params: target.params ?? {} }), [go, target.params]);

  let content: ReactNode;
  switch (target.screen) {
    case 'bank':
      content = <Bank key={JSON.stringify(target.params ?? {})} />;
      break;
    case 'import':
      content = <ImportScreen key={JSON.stringify(target.params ?? {})} />;
      break;
    case 'generate':
      content = <Generate />;
      break;
    case 'tests':
      content = <Tests key={JSON.stringify(target.params ?? {})} />;
      break;
    case 'settings':
      content = <SettingsScreen />;
      break;
    default:
      content = <Home />;
  }

  return (
    <NavContext.Provider value={nav}>
      <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: 0 }} padding="lg">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Group gap="xs">
              <IconShieldCheck size={22} color="var(--mantine-color-clinical-7)" aria-hidden />
              <Title order={1} size="h4">
                MCQ Shuffler - Medical Institutes
              </Title>
              <Badge
                variant="light"
                color="gray"
                title="Works fully offline; no data leaves this laptop"
              >
                Offline
              </Badge>
            </Group>
            <Group gap="xs">
              <IconUser size={16} aria-hidden />
              <Text size="sm">{info.actor ?? info.osUser}</Text>
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                leftSection={<IconLogout size={14} aria-hidden />}
                onClick={async () => {
                  try {
                    await call('app:logout');
                    await refresh();
                  } catch (error) {
                    notifyError(error);
                  }
                }}
              >
                Sign out
              </Button>
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar p="xs" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.screen}
              component="button"
              label={item.label}
              leftSection={item.icon}
              active={target.screen === item.screen}
              aria-current={target.screen === item.screen ? 'page' : undefined}
              onClick={() => go({ screen: item.screen })}
              variant="light"
              style={{ borderRadius: 8 }}
            />
          ))}
          <Text size="xs" c="dimmed" mt="auto" p="xs">
            Version {info.version}
          </Text>
        </AppShell.Navbar>
        <AppShell.Main>
          {info.backupReminderDue && target.screen !== 'settings' ? (
            <Alert color="yellow" mb="md" title="Keep a copy off this laptop">
              <Group justify="space-between">
                <Text size="sm">
                  {info.lastManualBackup
                    ? 'It has been more than a week since the last backup file was saved.'
                    : 'No backup file has been saved yet.'}{' '}
                  Automatic backups stay on this disk and do not survive a lost laptop.
                </Text>
                <Button
                  size="xs"
                  variant="white"
                  color="dark"
                  onClick={() => go({ screen: 'settings', params: { tab: 'backup' } })}
                >
                  Back up now
                </Button>
              </Group>
            </Alert>
          ) : null}
          <main aria-live="polite">{content}</main>
        </AppShell.Main>
      </AppShell>
    </NavContext.Provider>
  );
}

export function Root() {
  const [info, setInfo] = useState<Out<'app:info'> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const system = useColorScheme('light');

  const refresh = useCallback(async () => {
    try {
      // Settings are only readable after sign-in; the login screen uses the theme from app:info.
      const i = await call('app:info');
      setSettings(i.signedIn ? await call('settings:get') : null);
      setInfo(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const pct = settings?.textScalePct ?? info?.textScalePct;
    if (pct) document.documentElement.style.fontSize = `${pct}%`;
  }, [settings, info]);

  const themePref = settings?.theme ?? info?.theme;
  const scheme = themePref === 'dark' ? 'dark' : themePref === 'light' ? 'light' : system;
  const data = useMemo(
    () => (info && settings ? { info, settings, refresh } : null),
    [info, settings, refresh],
  );

  return (
    <MantineProvider theme={theme} forceColorScheme={scheme}>
      <Notifications position="bottom-right" limit={4} />
      {data ? (
        <AppDataContext.Provider value={data}>
          <Shell />
        </AppDataContext.Provider>
      ) : info && !info.signedIn ? (
        <Login staff={info.staff} onSignedIn={() => void refresh()} />
      ) : (
        <Center h="100vh">
          {error ? (
            <Alert color="red" title="The app could not start">
              {error}
            </Alert>
          ) : (
            <Loader aria-label="Loading" />
          )}
        </Center>
      )}
    </MantineProvider>
  );
}

import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import katex from 'katex';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { toHtml, type RichText } from '../../core/richtext';

/** Small shared helpers for screens: navigation, async state, notifications, rich text. */

export type Screen = 'home' | 'bank' | 'import' | 'generate' | 'tests' | 'settings';

export interface NavTarget {
  screen: Screen;
  params?: Record<string, string>;
}

export const NavContext = createContext<{
  go: (target: NavTarget) => void;
  params: Record<string, string>;
}>({
  go: () => undefined,
  params: {},
});

export const useNav = () => useContext(NavContext);

export const imageUrl = (ref: string): string => `app://image/${ref}`;

export function renderLatex(latex: string, display: boolean): string {
  return katex.renderToString(latex, {
    output: 'mathml',
    throwOnError: false,
    displayMode: display,
    trust: false,
    strict: 'ignore',
  });
}

/** HTML from the escaping serializer in core; never raw imported markup. */
export function richHtml(rich: RichText, showReviewMarks = false): string {
  return toHtml(rich, { imageUrl, renderLatex, showReviewMarks });
}

export function RichView({
  value,
  review = false,
  className,
}: {
  value: RichText;
  review?: boolean;
  className?: string;
}) {
  return (
    <span
      className={className ? `rich ${className}` : 'rich'}
      dangerouslySetInnerHTML={{ __html: richHtml(value, review) }}
    />
  );
}

export function notifyError(error: unknown, title = 'Something went wrong'): void {
  const message = error instanceof Error ? error.message : String(error);
  notifications.show({
    color: 'red',
    title,
    message,
    icon: <IconAlertTriangle size={18} aria-hidden />,
    autoClose: 9000,
  });
}

export function notifyOk(message: string, title = 'Done'): void {
  notifications.show({
    color: 'clinical',
    title,
    message,
    icon: <IconCircleCheck size={18} aria-hidden />,
    autoClose: 4000,
  });
}

/** Loads data with a refresh function; errors surface as notifications. */
export function useLoad<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loaderRef.current());
    } catch (error) {
      notifyError(error);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading, reload };
}

/** Wraps an async action with a busy flag and error notification. */
export function useAction(): [boolean, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (error) {
      notifyError(error);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

export const DIFFICULTY_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' } as const;

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

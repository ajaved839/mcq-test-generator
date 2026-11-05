import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { existsSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, PUBLIC_CHANNELS, type Channel, type HandlerEnv, type ProgressEvent } from './api';
import { getImage } from './db/images';
import { WorkspaceTooNewError } from './db/migrations';
import { initLogger, log } from './logger';
import { printPages } from './render';
import { AppState } from './state';

/**
 * Main process. Hardening follows Electron's security checklist:
 * context isolation, sandboxed renderer without Node, a custom app:// protocol instead of
 * file://, a strict CSP, blocked navigation, pop-ups, permissions and network, and IPC sender
 * checks with schema validation on every call.
 */

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL;
const DEV_URL = process.env.ELECTRON_RENDERER_URL ?? '';
const APP_ORIGIN = 'app://bundle';

// Windows: keep the workspace in %LOCALAPPDATA% so it never roams to a network share.
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  app.setPath('userData', join(process.env.LOCALAPPDATA, 'MCQ Test Generator'));
}
// Test runs use an isolated data folder.
if (process.env.MCQ_DATA_DIR) app.setPath('userData', process.env.MCQ_DATA_DIR);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' app: data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
].join('; ');

const rendererRoot = resolve(join(import.meta.dirname, '../renderer'));
// In development the renderer is served by Vite; static assets (fonts) come from the source tree.
const devPublicRoot = resolve(join(import.meta.dirname, '../../src/renderer/public'));
let mainWindow: BrowserWindow | null = null;
let state: AppState;

function resolveStatic(root: string, relative: string): string | null {
  const target = normalize(join(root, relative));
  // Path traversal guard: only files inside the given root are served.
  return target.startsWith(root + sep) && existsSync(target) ? target : null;
}

function serveBundle(pathname: string): Promise<Response> | Response {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const target =
    resolveStatic(rendererRoot, relative) ??
    (isDev ? resolveStatic(devPublicRoot, relative) : null);
  if (!target) return new Response('Not found', { status: 404 });
  return net.fetch(pathToFileURL(target).toString()).then((res) => {
    const headers = new Headers(res.headers);
    if (target.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}

function registerProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.host === 'bundle') return serveBundle(url.pathname);
    if (url.host === 'image') {
      const image = state?.ws ? getImage(state.ws, url.pathname.slice(1)) : null;
      if (!image) return new Response('Not found', { status: 404 });
      return new Response(Buffer.from(image.bytes), {
        headers: {
          'Content-Type': image.mime,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          // Lets the crop tool read pixels into a canvas; app:// is not reachable from the web.
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    if (url.host === 'print') {
      const html = printPages.get(url.pathname.slice(1));
      if (!html) return new Response('Not found', { status: 404 });
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('Not found', { status: 404 });
  });
}

function hardenSessions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // No network: every http(s)/ws request is cancelled except the local dev server in development.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const allowed =
      isDev &&
      DEV_URL &&
      details.url.startsWith(
        new URL(DEV_URL).origin.replace(/^http/, details.url.startsWith('ws') ? 'ws' : 'http'),
      );
    if (!allowed) log('warn', 'network.blocked', { scheme: details.url.split(':')[0] });
    callback({ cancel: !allowed });
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!(url.startsWith(APP_ORIGIN) || (isDev && url.startsWith(DEV_URL)))) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!(
      url.startsWith(APP_ORIGIN) ||
      url.startsWith('app://print') ||
      (isDev && url.startsWith(DEV_URL))
    ))
      event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    // The user guide link opens a local file in the system viewer; nothing opens inside the app.
    if (url.startsWith('app://bundle/docs/')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const url = event.senderFrame?.url ?? '';
  return url.startsWith(APP_ORIGIN) || (isDev && url.startsWith(DEV_URL));
}

function sendProgress(progress: ProgressEvent): void {
  mainWindow?.webContents.send('progress', progress);
}

function registerIpc(): void {
  const env: HandlerEnv = { state, window: () => mainWindow, progress: sendProgress };
  for (const channel of Object.keys(api) as Channel[]) {
    const def = api[channel] as {
      input: {
        safeParse: (v: unknown) => {
          success: boolean;
          data?: unknown;
          error?: { issues: Array<{ message: string; path: PropertyKey[] }> };
        };
      };
      run: (env: HandlerEnv, input: unknown) => unknown;
    };
    ipcMain.handle(channel, async (event, raw) => {
      if (!isTrustedSender(event)) {
        log('warn', 'ipc.untrusted-sender', { channel });
        return { ok: false, error: { message: 'Request refused.' } };
      }
      if (!PUBLIC_CHANNELS.has(channel) && !state.signedIn) {
        log('warn', 'ipc.not-signed-in', { channel });
        return { ok: false, error: { message: 'Sign in first.' } };
      }
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error?.issues[0];
        log('warn', 'ipc.invalid-input', { channel, path: issue?.path.join('.') });
        return {
          ok: false,
          error: { message: issue ? `Invalid input: ${issue.message}` : 'Invalid input.' },
        };
      }
      try {
        return { ok: true, data: await def.run(env, parsed.data) };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log('error', `ipc.${channel}`, err);
        return { ok: false, error: { message: err.message, name: err.name } };
      }
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'MCQ Shuffler - Medical Institutes',
    backgroundColor: '#f7f9fa',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(isDev ? DEV_URL : `${APP_ORIGIN}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = app.getPath('userData');
    initLogger(join(dataDir, 'logs'));
    log('info', 'app.start', { version: app.getVersion(), platform: process.platform });
    state = new AppState(
      {
        dataDir,
        workspaceFile: join(dataDir, 'workspace.sqlite'),
        backupDir: join(dataDir, 'backups'),
        logDir: join(dataDir, 'logs'),
        fontBase: `${APP_ORIGIN}/fonts`,
      },
      app.getVersion(),
      (status, progress) =>
        sendProgress({
          task: 'ocr',
          label: status,
          current: Math.round(progress * 100),
          total: 100,
        }),
    );
    try {
      state.open();
    } catch (error) {
      log('error', 'workspace.open-failed', error);
      await dialog.showMessageBox({
        type: 'error',
        title: 'MCQ Shuffler - Medical Institutes',
        message:
          error instanceof WorkspaceTooNewError
            ? error.message
            : 'The workspace could not be opened. Restore a backup or contact support with the diagnostics file.',
      });
      app.exit(1);
      return;
    }
    registerProtocol();
    hardenSessions();
    registerIpc();
    createWindow();
  });

  let closing = false;
  app.on('before-quit', () => {
    if (closing || !state) return;
    closing = true;
    state.dispose();
    state.closeWithBackup();
    log('info', 'app.quit');
  });

  app.on('window-all-closed', () => app.quit());

  process.on('uncaughtException', (error) => log('error', 'uncaught', error));
  process.on('unhandledRejection', (reason) =>
    log('error', 'unhandled-rejection', reason instanceof Error ? reason : String(reason)),
  );
}

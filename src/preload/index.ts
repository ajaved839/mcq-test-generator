import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type BridgeApi, type ChannelName, type ProgressMessage } from '../shared/ipc';

/**
 * Sandboxed preload: exposes a minimal, allowlisted bridge. No Node APIs, no raw ipcRenderer.
 */

const allowed = new Set<string>(CHANNELS);

const bridge: BridgeApi = {
  invoke(channel: ChannelName, input?: unknown) {
    if (!allowed.has(channel))
      return Promise.reject(new Error(`Unknown action: ${String(channel)}`));
    return ipcRenderer.invoke(channel, input);
  },
  onProgress(listener: (progress: ProgressMessage) => void) {
    const wrapped = (_event: unknown, progress: ProgressMessage): void => listener(progress);
    ipcRenderer.on('progress', wrapped);
    return () => ipcRenderer.removeListener('progress', wrapped);
  },
};

contextBridge.exposeInMainWorld('mcq', bridge);

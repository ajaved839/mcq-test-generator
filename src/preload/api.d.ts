import type { BridgeApi } from '../shared/ipc';

declare global {
  interface Window {
    mcq: BridgeApi;
  }
}

export {};

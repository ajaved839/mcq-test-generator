import type { z } from 'zod';
import type { AppApi } from '../../main/api';
import type { ChannelName, ProgressMessage } from '../../shared/ipc';

/**
 * Typed client for the preload bridge. Inputs and outputs are inferred from the main-process
 * handlers, so a renamed field fails type checks instead of failing at runtime.
 */

type Def<K extends keyof AppApi> = AppApi[K];
export type In<K extends keyof AppApi> =
  Def<K> extends { input: infer S extends z.ZodType } ? z.input<S> : never;
export type Out<K extends keyof AppApi> =
  Def<K> extends { run: (...args: never[]) => infer R } ? Awaited<R> : never;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = code ?? 'ApiError';
  }
}

export async function call<K extends keyof AppApi & ChannelName>(
  channel: K,
  ...input: undefined extends In<K> ? [In<K>?] : [In<K>]
): Promise<Out<K>> {
  const result = await window.mcq.invoke(channel, input[0]);
  if (!result.ok) throw new ApiError(result.error.message, result.error.name);
  return result.data as Out<K>;
}

export function onProgress(listener: (p: ProgressMessage) => void): () => void {
  return window.mcq.onProgress(listener);
}

export async function fileToUpload(
  file: File,
): Promise<{ fileName: string; bytes: Uint8Array<ArrayBuffer> }> {
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

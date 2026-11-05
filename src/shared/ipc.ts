/**
 * Bridge contract shared by preload and renderer. The preload exposes only `invoke` for the
 * allowlisted channels below and a progress listener; the renderer never sees ipcRenderer.
 */

export const CHANNELS = [
  'app:info',
  'app:login',
  'app:logout',
  'app:saveDiagnostics',
  'settings:get',
  'settings:update',
  'settings:setLogo',
  'settings:clearLogo',
  'home:summary',
  'bank:list',
  'bank:facets',
  'bank:get',
  'bank:create',
  'bank:update',
  'bank:archive',
  'bank:delete',
  'bank:tag',
  'bank:revert',
  'bank:similar',
  'images:put',
  'import:template',
  'import:tableRead',
  'import:tableValidate',
  'import:tableStage',
  'import:docxAnalyze',
  'import:docxStage',
  'import:ocrStage',
  'import:batches',
  'import:deleteBatch',
  'import:items',
  'review:update',
  'review:approve',
  'review:reject',
  'review:merge',
  'review:convert',
  'review:compare',
  'review:applyKey',
  'generate:preview',
  'generate:save',
  'paper:previewDraft',
  'tests:list',
  'tests:get',
  'tests:setIncluded',
  'tests:compare',
  'tests:preview',
  'tests:outsideAnalyze',
  'tests:outsideSave',
  'export:test',
  'export:reprint',
  'questions:affectedTests',
  'questions:imageRefs',
  'backup:list',
  'backup:now',
  'backup:inspectFile',
  'backup:inspectAuto',
  'backup:restore',
  'merge:export',
  'merge:inspect',
  'merge:apply',
  'audit:list',
] as const;

export type ChannelName = (typeof CHANNELS)[number];

export type IpcResult<T> =
  { ok: true; data: T } | { ok: false; error: { message: string; name?: string } };

export interface ProgressMessage {
  task: string;
  label: string;
  current: number;
  total: number;
}

export interface BridgeApi {
  invoke(channel: ChannelName, input?: unknown): Promise<IpcResult<unknown>>;
  onProgress(listener: (progress: ProgressMessage) => void): () => void;
}

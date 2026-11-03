import { BrowserWindow, dialog, nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, release } from 'node:os';
import { z } from 'zod';
import { subjectCapacity } from '../core/capacity';
import { parseAnswerKeyText, type AnswerConvention, type SourceLine } from '../core/mcq-parser';
import { imageRefs, plain, toPlainText, type Inline } from '../core/richtext';
import { DuplicateIndex } from '../core/duplicates';
import { buildVersions } from '../core/shuffle';
import { indexForLetter, type BankQuestion } from '../core/types';
import { TEMPLATE_COLUMNS, templateCsv, type ColumnMapping, FIELDS } from '../core/tabular';
import {
  buildKeyHtml,
  buildPaperHtml,
  buildPaperBody,
  paperCss,
  type PaperHeader,
} from '../shared/paper';
import {
  bankFilter,
  fileUpload,
  generateRequest,
  id,
  questionInput,
  richText,
  type GenerateRequest,
} from '../shared/schemas';
import { audit, listAudit } from './db/audit';
import { getImage, putImage } from './db/images';
import {
  approveItems,
  convertUnplaced,
  getItem,
  listBatches,
  listItems,
  mergeItem,
  rejectItems,
  stageBatch,
  updateItem,
  type ReviewCandidate,
} from './db/imports';
import {
  allComparable,
  bankFacets,
  bulkTag,
  createQuestion,
  deleteUnused,
  generatorBank,
  getQuestion,
  getQuestions,
  listQuestions,
  questionHistory,
  revertQuestion,
  setStatus,
  testsUsingQuestion,
  updateQuestion,
} from './db/questions';
import { saveSettings } from './db/settings';
import {
  compareTests,
  comparedTests,
  getExportBytes,
  getTest,
  listExports,
  listTests,
  previewTest,
  recordExport,
  saveGeneratedTest,
  saveOutsideTest,
  setIncludedInRule,
  type TestDetail,
} from './db/tests';
import { buildTestRecordXlsx } from './export/excel';
import { buildKeyDocx, buildPaperDocx, type ImageSource } from './export/word';
import { readDocx } from './importers/docx';
import { checkImageFormat, type OcrPageResult } from './importers/ocr';
import { readTable } from './importers/tabular';
import { log, logPath } from './logger';
import { applyMerge, exportMergeFile, planMerge, readMergeFile } from './merge';
import { htmlToPdf, mathToImages, renderLatex } from './render';
import {
  matchOutside,
  mcqToCandidate,
  parseLines,
  previewTable,
  rowToCandidate,
  safeFileName,
  suggestConvention,
  validateTable,
  type ImportDefaults,
} from './services';
import type { AppState } from './state';
import { inspectWorkspaceFile } from './backup';

/**
 * The allowlisted functions the UI may call (FR coverage noted per group). Every input is
 * validated with zod before it reaches the database; file paths never come from the UI.
 */

export interface HandlerEnv {
  state: AppState;
  window: () => BrowserWindow | null;
  progress: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  task: string;
  label: string;
  current: number;
  total: number;
}

interface Handler<S extends z.ZodType, R> {
  input: S;
  run: (env: HandlerEnv, input: z.output<S>) => R | Promise<R>;
}

const handler = <S extends z.ZodType, R>(
  input: S,
  run: (env: HandlerEnv, input: z.output<S>) => R | Promise<R>,
): Handler<S, R> => ({ input, run });
const none = z.undefined().or(z.object({}).strict()).optional();

const defaultsSchema = z
  .object({
    subject: z.string().max(100),
    topic: z.string().max(200),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    source: z.string().max(200),
  })
  .strict();

const convention = z.enum(['auto', 'answer-line', 'answer-key', 'bold', 'highlight', 'asterisk']);
const mappingSchema = z
  .object(
    Object.fromEntries(FIELDS.map((f) => [f, z.number().int().min(-1).max(500)])) as Record<
      (typeof FIELDS)[number],
      z.ZodNumber
    >,
  )
  .strict();

const candidateSchema = z
  .object({
    stem: richText,
    options: z.array(richText).min(0).max(5),
    correct: z.number().int().min(0).max(4).nullable(),
    explanation: richText,
    subject: z.string().max(100),
    topic: z.string().max(200),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    tags: z.array(z.string().max(60)).max(30),
    source: z.string().max(200),
    lockOptions: z.boolean(),
    reserved: z.boolean(),
    warnings: z.array(z.string().max(1000)).max(100),
    refs: z.array(z.string().max(100)).max(100),
    pages: z.array(z.number().int()).max(100),
    number: z.number().int().nullable(),
  })
  .strict();

const passphrase = z.string().min(8, 'Use a passphrase of at least 8 characters.').max(200);
const exportKinds = z.enum(['paper-pdf', 'paper-docx', 'key-pdf', 'key-docx', 'record-xlsx']);

const imageUrl = (ref: string): string => `app://image/${ref}`;

function htmlOptions() {
  return { imageUrl, renderLatex };
}

function paperHeaderFor(env: HandlerEnv, request: GenerateRequest, date: string): PaperHeader {
  const s = env.state.settings;
  return {
    instituteName: s.institute.name,
    instituteAddress: s.institute.address,
    logoUrl: s.institute.logoRef ? imageUrl(s.institute.logoRef) : null,
    title: request.title,
    code: request.code,
    date,
    durationMinutes: request.durationMinutes,
    instructions: request.instructions,
    showTestCode: s.paper.showTestCode,
    fontSizePt: s.paper.fontSizePt,
    confidentialFooter: s.paper.confidentialFooter,
  };
}

function headerOf(env: HandlerEnv, test: TestDetail): PaperHeader {
  if (test.settings.header) return test.settings.header;
  if (!test.settings.request) throw new Error('Only tests generated in this app can be printed.');
  return paperHeaderFor(
    env,
    test.settings.request,
    new Date(test.createdAt).toLocaleDateString('en-GB'),
  );
}

function snapshotMap(test: TestDetail): Map<string, BankQuestion> {
  return new Map(test.questions.map((q) => [q.snapshot.id, q.snapshot]));
}

function imageSource(env: HandlerEnv, ref: string): ImageSource | null {
  const img = getImage(env.state.ws, ref);
  if (!img) return null;
  let width = img.width ?? 0;
  let height = img.height ?? 0;
  if (!width || !height) {
    const size = nativeImage.createFromBuffer(Buffer.from(img.bytes)).getSize();
    width = size.width || 200;
    height = size.height || 100;
  }
  return { bytes: img.bytes, mime: img.mime, width, height };
}

/** Compresses large photos and keeps diagrams as PNG; returns the stored hash. */
export function storeImageBytes(
  env: HandlerEnv,
  bytes: Uint8Array,
  display?: { width?: number; height?: number },
): string | null {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return null;
  let size = image.getSize();
  let out: Buffer = Buffer.from(bytes);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (size.width > 1600) {
    const resized = image.resize({ width: 1600, quality: 'best' });
    size = resized.getSize();
    out = isJpeg ? resized.toJPEG(85) : resized.toPNG();
  } else if (!isJpeg && !(bytes[0] === 0x89 && bytes[1] === 0x50)) {
    out = image.toPNG(); // GIF/WebP/BMP to PNG
  }
  return putImage(env.state.ws, new Uint8Array(out), {
    width: display?.width ?? size.width,
    height: display?.height ?? size.height,
  });
}

async function chooseFolder(env: HandlerEnv, title: string): Promise<string | null> {
  const win = env.window();
  const options = {
    title,
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function chooseSavePath(
  env: HandlerEnv,
  title: string,
  defaultName: string,
  filters: Electron.FileFilter[],
): Promise<string | null> {
  const win = env.window();
  const options = { title, defaultPath: defaultName, filters };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}

async function chooseOpenFile(
  env: HandlerEnv,
  title: string,
  filters: Electron.FileFilter[],
): Promise<string | null> {
  const win = env.window();
  const options = { title, filters, properties: ['openFile'] as Array<'openFile'> };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

function stageParsed(
  env: HandlerEnv,
  sourceType: 'docx' | 'ocr',
  fileName: string,
  lines: SourceLine[],
  conv: AnswerConvention,
  defaults: ImportDefaults,
  pageImages: Record<number, string> = {},
) {
  const parsed = parseLines(lines, conv);
  const s = env.state.settings;
  const batch = stageBatch(
    env.state.ws,
    env.state.ctx,
    {
      sourceType,
      fileName,
      settings: { convention: conv, defaults },
      candidates: parsed.mcqs.map((mcq) => ({
        candidate: mcqToCandidate(mcq, defaults),
        pageImage: pageImages[mcq.pages[0]] ?? null,
      })),
      unplaced: parsed.unplaced.map((block) => {
        const page = Number(/page (\d+)/.exec(block.refs[0] ?? '')?.[1]);
        return { block, pageImage: Number.isFinite(page) ? (pageImages[page] ?? null) : null };
      }),
    },
    s.duplicateThresholdPct,
  );
  return {
    batch,
    mcqs: parsed.mcqs.length,
    unplaced: parsed.unplaced.length,
    detected: parsed.detected,
    answerKeyEntries: Object.keys(parsed.answerKey).length,
  };
}

export const api = {
  // ---- App and session -------------------------------------------------------------------
  'app:info': handler(none, (env) => {
    const s = env.state.settings;
    const lastManual = s.backup.lastManualAt ? new Date(s.backup.lastManualAt).getTime() : 0;
    return {
      version: env.state.appVersion,
      platform: platform(),
      osRelease: release(),
      osUser: env.state.osUser,
      actor: env.state.actor,
      staff: s.staff,
      needsStaffPick: s.staff.length > 0 && !env.state.actor,
      workspaceFolder: env.state.paths.dataDir,
      theme: s.theme,
      textScalePct: s.textScalePct,
      backupReminderDue: Date.now() - lastManual > s.backup.remindDays * 86_400_000,
      lastManualBackup: s.backup.lastManualAt,
    };
  }),
  'app:setActor': handler(z.object({ name: z.string().min(1).max(100) }).strict(), (env, input) => {
    env.state.setActor(input.name);
    return { actor: input.name };
  }),
  'app:saveDiagnostics': handler(none, async (env) => {
    const target = await chooseSavePath(
      env,
      'Save diagnostics',
      `mcq-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      [{ name: 'Text', extensions: ['txt'] }],
    );
    if (!target) return { saved: false };
    const file = logPath();
    const body = file ? await readFile(file, 'utf8').catch(() => '') : '';
    const header = JSON.stringify({
      app: env.state.appVersion,
      platform: platform(),
      release: release(),
      at: new Date().toISOString(),
    });
    writeFileSync(target, `${header}\n\n${body}`);
    return { saved: true };
  }),

  // ---- Settings (FR-17) ------------------------------------------------------------------
  'settings:get': handler(none, (env) => env.state.settings),
  'settings:update': handler(z.record(z.string(), z.unknown()), (env, patch) => {
    const before = env.state.settings;
    const next = saveSettings(env.state.ws, patch);
    const changed = Object.keys(patch).filter(
      (k) =>
        JSON.stringify((before as Record<string, unknown>)[k]) !==
        JSON.stringify((next as Record<string, unknown>)[k]),
    );
    if (changed.length) {
      // Audit which areas changed, not their values (instructions text may be long).
      audit(env.state.ws, env.state.ctx, 'settings.changed', 'settings', '', { areas: changed });
    }
    return next;
  }),
  'settings:setLogo': handler(fileUpload, (env, file) => {
    const hash = storeImageBytes(env, file.bytes);
    if (!hash) throw new Error('Choose a PNG or JPEG image for the logo.');
    return saveSettings(env.state.ws, { institute: { logoRef: hash } });
  }),
  'settings:clearLogo': handler(none, (env) =>
    saveSettings(env.state.ws, { institute: { logoRef: null } }),
  ),

  // ---- Home --------------------------------------------------------------------------------
  'home:summary': handler(none, (env) => {
    const ws = env.state.ws;
    const tests = comparedTests(ws, { excludedTestIds: [], from: null, to: null });
    const bank = generatorBank(ws);
    const batches = listBatches(ws);
    return {
      capacity: subjectCapacity(bank, tests),
      totals: {
        active: bank.filter((q) => q.status === 'active').length,
        archived: bank.filter((q) => q.status === 'archived').length,
        tests: listTests(ws).length,
        pendingReview: batches.reduce((sum, b) => sum + b.counts.pending, 0),
      },
      recentTests: listTests(ws).slice(0, 5),
      openBatches: batches.filter((b) => b.status === 'open').slice(0, 5),
    };
  }),

  // ---- Question bank (FR-6) ----------------------------------------------------------------
  'bank:list': handler(bankFilter, (env, filter) => listQuestions(env.state.ws, filter)),
  'bank:facets': handler(none, (env) => bankFacets(env.state.ws)),
  'bank:get': handler(z.object({ id }).strict(), (env, { id: qid }) => {
    const question = getQuestion(env.state.ws, qid);
    if (!question) throw new Error('That question no longer exists.');
    return {
      question,
      history: questionHistory(env.state.ws, qid),
      usedIn: testsUsingQuestion(env.state.ws, qid),
    };
  }),
  'bank:create': handler(questionInput, (env, input) =>
    createQuestion(env.state.ws, env.state.ctx, input),
  ),
  'bank:update': handler(z.object({ id, question: questionInput }).strict(), (env, input) =>
    updateQuestion(env.state.ws, env.state.ctx, input.id, input.question),
  ),
  'bank:archive': handler(
    z.object({ ids: z.array(id).min(1).max(10_000), archived: z.boolean() }).strict(),
    (env, input) => ({
      changed: setStatus(
        env.state.ws,
        env.state.ctx,
        input.ids,
        input.archived ? 'archived' : 'active',
      ),
    }),
  ),
  'bank:delete': handler(z.object({ ids: z.array(id).min(1).max(10_000) }).strict(), (env, input) =>
    deleteUnused(env.state.ws, env.state.ctx, input.ids),
  ),
  'bank:tag': handler(
    z
      .object({
        ids: z.array(id).min(1).max(10_000),
        add: z.array(z.string().trim().min(1).max(60)).max(20),
        remove: z.array(z.string().max(60)).max(20),
      })
      .strict(),
    (env, input) => ({
      changed: bulkTag(env.state.ws, env.state.ctx, input.ids, input.add, input.remove),
    }),
  ),
  'bank:revert': handler(
    z.object({ id, version: z.number().int().positive() }).strict(),
    (env, input) => revertQuestion(env.state.ws, env.state.ctx, input.id, input.version),
  ),
  'bank:similar': handler(
    z
      .object({ stem: richText, options: z.array(richText).max(5), excludeId: id.optional() })
      .strict(),
    (env, input) => {
      const index = new DuplicateIndex();
      for (const q of allComparable(env.state.ws)) if (q.id !== input.excludeId) index.add(q.id, q);
      return index
        .findSimilar(input, env.state.settings.duplicateThresholdPct / 100)
        .map((m) => ({ ...m, question: getQuestion(env.state.ws, m.id)! }));
    },
  ),
  'images:put': handler(
    z
      .object({
        bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength < 30 * 1024 * 1024),
        width: z.number().positive().max(5000).optional(),
        height: z.number().positive().max(5000).optional(),
      })
      .strict(),
    (env, input) => {
      const hash = storeImageBytes(env, input.bytes, { width: input.width, height: input.height });
      if (!hash) throw new Error('That image could not be read.');
      return { ref: hash };
    },
  ),

  // ---- Import (FR-1 to FR-5) -----------------------------------------------------------------
  'import:template': handler(
    z.object({ format: z.enum(['csv', 'xlsx']) }).strict(),
    async (env, { format }) => {
      const target = await chooseSavePath(
        env,
        'Save the import template',
        `MCQ import template.${format}`,
        [{ name: format.toUpperCase(), extensions: [format] }],
      );
      if (!target) return { saved: false };
      if (format === 'csv') writeFileSync(target, templateCsv());
      else {
        const writeXlsxFile = (await import('write-excel-file/node')).default;
        const rows = templateCsv()
          .trim()
          .split('\n')
          .map((line) =>
            line
              .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
              .map((v) => ({ value: v.replace(/^"|"$/g, '') })),
          );
        const buffer = await writeXlsxFile(
          rows as never,
          { columns: TEMPLATE_COLUMNS.map(() => ({ width: 22 })) } as never,
        ).toBuffer();
        writeFileSync(target, buffer);
      }
      return { saved: true };
    },
  ),
  'import:tableRead': handler(fileUpload, async (env, file) => {
    const sheets = await readTable(file.fileName, file.bytes);
    const token = env.state.putToken('table', { fileName: file.fileName, sheets });
    return { token, fileName: file.fileName, ...previewTable(sheets) };
  }),
  'import:tableValidate': handler(
    z
      .object({ token: z.string(), sheet: z.number().int().min(0), mapping: mappingSchema })
      .strict(),
    (env, input) => {
      const data = env.state.takeToken<{ sheets: Array<{ name: string; rows: unknown[][] }> }>(
        'table',
        input.token,
      );
      const sheet = data.sheets[input.sheet];
      if (!sheet) throw new Error('That sheet was not found.');
      const result = validateTable(
        sheet.rows,
        input.mapping as ColumnMapping,
        env.state.settings.subjects,
      );
      return {
        valid: result.valid,
        invalid: result.invalid.slice(0, 500),
        invalidCount: result.invalid.length,
        warnings: result.warnings,
        total: result.results.length,
      };
    },
  ),
  'import:tableStage': handler(
    z
      .object({
        token: z.string(),
        sheet: z.number().int().min(0),
        mapping: mappingSchema,
        includeInvalid: z.boolean(),
        defaults: defaultsSchema,
      })
      .strict(),
    (env, input) => {
      const data = env.state.takeToken<{
        fileName: string;
        sheets: Array<{ name: string; rows: unknown[][] }>;
      }>('table', input.token, true);
      const sheet = data.sheets[input.sheet];
      if (!sheet) throw new Error('That sheet was not found.');
      const mapping = input.mapping as ColumnMapping;
      const { results } = validateTable(sheet.rows, mapping, env.state.settings.subjects);
      const rowsByNumber = new Map(sheet.rows.slice(1).map((r, i) => [i + 2, r]));
      const chosen = results.filter((r) => r.ok || input.includeInvalid);
      const sourceType = data.fileName.toLowerCase().endsWith('.csv') ? 'csv' : 'excel';
      return stageBatch(
        env.state.ws,
        env.state.ctx,
        {
          sourceType,
          fileName: data.fileName,
          settings: { sheet: sheet.name, mapping },
          candidates: chosen.map((r) => ({
            candidate: rowToCandidate(r, rowsByNumber.get(r.row) ?? [], mapping, input.defaults),
          })),
          unplaced: [],
        },
        env.state.settings.duplicateThresholdPct,
      );
    },
  ),
  'import:docxAnalyze': handler(fileUpload, async (env, file) => {
    if (!file.fileName.toLowerCase().endsWith('.docx')) {
      throw new Error(
        file.fileName.toLowerCase().endsWith('.doc')
          ? 'Old .doc files are not supported. Open the file in Word and save it as .docx.'
          : 'Choose a .docx file.',
      );
    }
    const { lines, stats } = await readDocx(file.bytes, (img) =>
      storeImageBytes(env, img.bytes, { width: img.width, height: img.height }),
    );
    const parsed = parseLines(lines, 'auto');
    const token = env.state.putToken('docx', { fileName: file.fileName, lines });
    return {
      token,
      stats,
      mcqs: parsed.mcqs.length,
      unplaced: parsed.unplaced.length,
      detected: parsed.detected,
      suggested: suggestConvention(parsed.detected),
      answerKeyEntries: Object.keys(parsed.answerKey).length,
    };
  }),
  'import:docxStage': handler(
    z.object({ token: z.string(), convention, defaults: defaultsSchema }).strict(),
    (env, input) => {
      const data = env.state.takeToken<{ fileName: string; lines: SourceLine[] }>(
        'docx',
        input.token,
        true,
      );
      return stageParsed(env, 'docx', data.fileName, data.lines, input.convention, input.defaults);
    },
  ),
  'import:ocrStage': handler(
    z
      .object({
        fileName: z.string().max(260),
        pages: z
          .array(
            z.object({ fileName: z.string().max(260), bytes: z.instanceof(Uint8Array) }).strict(),
          )
          .min(1)
          .max(100),
        convention,
        defaults: defaultsSchema,
      })
      .strict(),
    async (env, input) => {
      input.pages.forEach((p) => checkImageFormat(p.fileName, p.bytes));
      const lines: SourceLine[] = [];
      const pageImages: Record<number, string> = {};
      const pageStats: Array<Omit<OcrPageResult, 'lines'>> = [];
      for (const [i, p] of input.pages.entries()) {
        const page = i + 1;
        env.progress({
          task: 'ocr',
          label: `Reading page ${page} of ${input.pages.length}`,
          current: i,
          total: input.pages.length,
        });
        const ref = storeImageBytes(env, p.bytes);
        if (ref) pageImages[page] = ref;
        const started = Date.now();
        const result = await env.state.ocr.recognizePage({ page, bytes: p.bytes });
        log('info', 'ocr.page', {
          page,
          ms: Date.now() - started,
          words: result.words,
          low: result.lowConfidenceWords,
        });
        lines.push(...result.lines);
        const { lines: _lines, ...stats } = result;
        pageStats.push(stats);
      }
      env.progress({
        task: 'ocr',
        label: 'Splitting into questions',
        current: input.pages.length,
        total: input.pages.length,
      });
      return {
        ...stageParsed(
          env,
          'ocr',
          input.fileName,
          lines,
          input.convention,
          input.defaults,
          pageImages,
        ),
        pages: pageStats,
      };
    },
  ),
  'import:batches': handler(none, (env) => listBatches(env.state.ws)),
  'import:items': handler(
    z
      .object({
        batchId: id,
        status: z.enum(['pending', 'approved', 'rejected', 'merged', 'skipped']).optional(),
      })
      .strict(),
    (env, input) =>
      listItems(env.state.ws, input.batchId, env.state.settings.subjects, input.status),
  ),
  'review:update': handler(
    z
      .object({
        itemId: id,
        candidate: candidateSchema,
        duplicateDecision: z.enum(['keep']).nullable(),
      })
      .strict(),
    (env, input) =>
      updateItem(
        env.state.ws,
        input.itemId,
        input.candidate as ReviewCandidate,
        env.state.settings.subjects,
        env.state.settings.duplicateThresholdPct,
        input.duplicateDecision,
      ),
  ),
  'review:approve': handler(
    z.object({ itemIds: z.array(id).min(1).max(10_000), onlyClean: z.boolean() }).strict(),
    (env, input) =>
      approveItems(env.state.ws, env.state.ctx, input.itemIds, env.state.settings.subjects, {
        onlyClean: input.onlyClean,
      }),
  ),
  'review:reject': handler(
    z
      .object({
        itemIds: z.array(id).min(1).max(10_000),
        reason: z.string().trim().min(1).max(500),
        skip: z.boolean(),
      })
      .strict(),
    (env, input) => ({
      count: rejectItems(
        env.state.ws,
        env.state.ctx,
        input.itemIds,
        input.reason,
        env.state.settings.subjects,
        input.skip ? 'skipped' : 'rejected',
      ),
    }),
  ),
  'review:merge': handler(z.object({ itemId: id, questionId: id }).strict(), (env, input) => {
    mergeItem(
      env.state.ws,
      env.state.ctx,
      input.itemId,
      input.questionId,
      env.state.settings.subjects,
    );
    return { merged: true };
  }),
  'review:convert': handler(
    z.object({ itemId: id, defaults: defaultsSchema }).strict(),
    (env, input) =>
      convertUnplaced(env.state.ws, input.itemId, env.state.settings.subjects, input.defaults),
  ),
  'review:compare': handler(z.object({ itemId: id }).strict(), (env, input) => {
    const item = getItem(env.state.ws, input.itemId, env.state.settings.subjects);
    if (!item) throw new Error('That review item no longer exists.');
    return {
      item,
      bank: item.duplicates
        .filter((d) => d.scope === 'bank')
        .map((d) => ({ hit: d, question: getQuestion(env.state.ws, d.id) })),
      batch: item.duplicates
        .filter((d) => d.scope === 'batch')
        .map((d) => ({ hit: d, item: getItem(env.state.ws, d.id, env.state.settings.subjects) })),
    };
  }),
  'review:applyKey': handler(
    z
      .object({
        batchId: id,
        keyText: z.string().max(20_000).optional(),
        page: z
          .object({ fileName: z.string().max(260), bytes: z.instanceof(Uint8Array) })
          .strict()
          .optional(),
        overwrite: z.boolean(),
      })
      .strict(),
    async (env, input) => {
      let text = input.keyText ?? '';
      if (input.page) {
        checkImageFormat(input.page.fileName, input.page.bytes);
        env.progress({ task: 'ocr', label: 'Reading the answer key page', current: 0, total: 1 });
        const result = await env.state.ocr.recognizePage({ page: 1, bytes: input.page.bytes });
        text = result.lines.map((l) => toPlainText(l.content)).join(' ');
      }
      const key = parseAnswerKeyText(text);
      const subjects = env.state.settings.subjects;
      let applied = 0;
      env.state.ws.transaction(() => {
        for (const item of listItems(env.state.ws, input.batchId, subjects, 'pending')) {
          const c = item.candidate;
          if (!c || c.number === null || !key[c.number]) continue;
          if (c.correct !== null && !input.overwrite) continue;
          const correct = indexForLetter(key[c.number]);
          if (correct >= c.options.length) continue;
          updateItem(
            env.state.ws,
            item.id,
            {
              ...c,
              correct,
              warnings: [
                ...c.warnings.filter((w) => !w.startsWith('No answer found')),
                `Answer ${key[c.number]} taken from the answer key.`,
              ],
            },
            subjects,
            env.state.settings.duplicateThresholdPct,
            item.duplicateDecision,
          );
          applied += 1;
        }
      });
      return { entries: Object.keys(key).length, applied };
    },
  ),

  // ---- Generate (FR-7 to FR-11) --------------------------------------------------------------
  'generate:preview': handler(generateRequest, (env, request) =>
    previewTest(env.state.ws, request),
  ),
  'generate:save': handler(generateRequest, (env, request) =>
    saveGeneratedTest(
      env.state.ws,
      env.state.ctx,
      request,
      paperHeaderFor(env, request, new Date().toLocaleDateString('en-GB')),
    ),
  ),
  'paper:previewDraft': handler(generateRequest, (env, request) => {
    const { result } = previewTest(env.state.ws, request);
    if (!result.ok) return { ok: false as const, messages: result.messages };
    const snapshots = getQuestions(env.state.ws, result.questionIds);
    const versions = buildVersions(snapshots, {
      versions: request.versions,
      seed: request.seed,
      groupBySubject: request.groupBySubject,
    });
    const header = paperHeaderFor(env, request, new Date().toLocaleDateString('en-GB'));
    const map = new Map(snapshots.map((q) => [q.id, q]));
    return {
      ok: true as const,
      css: paperCss(env.state.paths.fontBase, header.fontSizePt),
      versions: versions.map((v) => ({
        letter: v.letter,
        body: buildPaperBody({
          header,
          version: v,
          versionCount: versions.length,
          questions: map,
          groupBySubject: request.groupBySubject,
          fontBase: env.state.paths.fontBase,
          html: htmlOptions(),
        }),
      })),
    };
  }),

  // ---- Tests and history (FR-13, FR-14) ------------------------------------------------------
  'tests:list': handler(none, (env) => listTests(env.state.ws)),
  'tests:get': handler(z.object({ id }).strict(), (env, input) => {
    const test = getTest(env.state.ws, input.id);
    if (!test) throw new Error('That test was not found.');
    return { test, exports: listExports(env.state.ws, input.id) };
  }),
  'tests:setIncluded': handler(z.object({ id, included: z.boolean() }).strict(), (env, input) => {
    setIncludedInRule(env.state.ws, env.state.ctx, input.id, input.included);
    return { ok: true };
  }),
  'tests:compare': handler(z.object({ a: id, b: id }).strict(), (env, input) =>
    compareTests(env.state.ws, input.a, input.b),
  ),
  'tests:preview': handler(
    z.object({ id, version: z.enum(['A', 'B', 'C', 'D']) }).strict(),
    (env, input) => {
      const test = getTest(env.state.ws, input.id);
      if (!test?.settings.versions)
        throw new Error('Only tests generated in this app have a paper preview.');
      const version =
        test.settings.versions.find((v) => v.letter === input.version) ?? test.settings.versions[0];
      const header = headerOf(env, test);
      return {
        css: paperCss(env.state.paths.fontBase, header.fontSizePt),
        body: buildPaperBody({
          header,
          version,
          versionCount: test.settings.versions.length,
          questions: snapshotMap(test),
          groupBySubject: test.settings.request?.groupBySubject ?? true,
          fontBase: env.state.paths.fontBase,
          html: htmlOptions(),
        }),
      };
    },
  ),
  'tests:outsideAnalyze': handler(fileUpload, async (env, file) => {
    const lower = file.fileName.toLowerCase();
    let items: Array<{ stem: ReviewCandidate['stem']; options: ReviewCandidate['options'] }>;
    if (lower.endsWith('.docx')) {
      const { lines } = await readDocx(file.bytes, (img) =>
        storeImageBytes(env, img.bytes, { width: img.width, height: img.height }),
      );
      items = parseLines(lines, 'auto').mcqs.map((m) => ({ stem: m.stem, options: m.options }));
    } else {
      const sheets = await readTable(file.fileName, file.bytes);
      const preview = previewTable(sheets);
      const rows = sheets[0]?.rows.slice(1) ?? [];
      const m = preview.mapping;
      if (m.question < 0) throw new Error('The sheet needs a Question column.');
      const cell = (r: unknown[], i: number): string =>
        i >= 0 && r[i] != null ? String(r[i]).trim() : '';
      items = rows
        .filter((r) => cell(r, m.question))
        .map((r) => ({
          stem: plain(cell(r, m.question)),
          options: [m.optionA, m.optionB, m.optionC, m.optionD, m.optionE]
            .map((i) => cell(r, i))
            .filter(Boolean)
            .map(plain),
        }));
    }
    if (!items.length) throw new Error('No questions were found in that file.');
    const matches = matchOutside(env.state.ws, items, env.state.settings.duplicateThresholdPct);
    const token = env.state.putToken('outside', { fileName: file.fileName, items });
    return { token, fileName: file.fileName, matches };
  }),
  'tests:outsideSave': handler(
    z
      .object({
        token: z.string(),
        title: z.string().trim().min(1).max(200),
        date: z.string().max(40).nullable(),
        confirmations: z
          .array(
            z.object({ position: z.number().int().min(0), questionId: id.nullable() }).strict(),
          )
          .max(5000),
      })
      .strict(),
    (env, input) => {
      const data = env.state.takeToken<{
        fileName: string;
        items: Array<{ stem: ReviewCandidate['stem']; options: ReviewCandidate['options'] }>;
      }>('outside', input.token, true);
      const confirmed = new Map(input.confirmations.map((c) => [c.position, c.questionId]));
      const now = new Date().toISOString();
      return saveOutsideTest(env.state.ws, env.state.ctx, {
        title: input.title,
        sourceFile: data.fileName,
        createdAt: input.date,
        items: data.items.map((item, position) => {
          const questionId = confirmed.get(position) ?? null;
          const bank = questionId ? getQuestion(env.state.ws, questionId) : null;
          const snapshot: BankQuestion = bank ?? {
            id: `outside-${position}`,
            stem: item.stem,
            options: item.options,
            correct: 0,
            explanation: [],
            lockOptions: false,
            subject: '',
            topic: '',
            difficulty: 'medium',
            tags: [],
            source: data.fileName,
            reserved: false,
            status: 'archived',
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          return {
            snapshot,
            questionId: bank ? bank.id : null,
            score: bank ? 1 : 0,
            confirmed: !!bank,
          };
        }),
      });
    },
  ),

  // ---- Export (FR-12) ------------------------------------------------------------------------
  'export:test': handler(
    z
      .object({
        id,
        kinds: z.array(exportKinds).min(1),
        versions: z.array(z.enum(['A', 'B', 'C', 'D'])).min(1),
        includeExplanations: z.boolean(),
      })
      .strict(),
    async (env, input) => {
      const test = getTest(env.state.ws, input.id);
      if (!test?.settings.versions)
        throw new Error('Only tests generated in this app can be exported.');
      const folder = await chooseFolder(env, 'Choose where to save the papers');
      if (!folder) return { saved: [] as string[] };
      const header = headerOf(env, test);
      const map = snapshotMap(test);
      const versions = test.settings.versions.filter((v) => input.versions.includes(v.letter));
      const base = safeFileName(`${test.title}${test.code ? ` (${test.code})` : ''}`);
      const groupBySubject = test.settings.request?.groupBySubject ?? true;
      const fontBase = env.state.paths.fontBase;
      const saved: string[] = [];
      const total = input.kinds.length * versions.length;
      let step = 0;
      const write = (kind: string, letter: string, fileName: string, bytes: Uint8Array): void => {
        writeFileSync(join(folder, fileName), bytes);
        recordExport(env.state.ws, env.state.ctx, test.id, {
          kind,
          versionLetter: letter,
          fileName,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        });
        saved.push(fileName);
      };
      const multi = test.settings.versions.length > 1;
      for (const kind of input.kinds) {
        if (kind === 'paper-pdf' || kind === 'paper-docx') {
          for (const v of versions) {
            env.progress({
              task: 'export',
              label: `Exporting version ${v.letter}`,
              current: step++,
              total,
            });
            const suffix = multi ? ` - Version ${v.letter}` : '';
            if (kind === 'paper-pdf') {
              const html = buildPaperHtml({
                header,
                version: v,
                versionCount: test.settings.versions.length,
                questions: map,
                groupBySubject,
                fontBase,
                html: htmlOptions(),
              });
              const pdf = await htmlToPdf(html, {
                left: header.showTestCode ? header.code : '',
                right: multi ? `Version ${v.letter}` : '',
                confidential: false,
              });
              write(kind, v.letter, `${base}${suffix}.pdf`, pdf);
            } else {
              const maths: Array<Extract<Inline, { t: 'math' }>> = [];
              for (const q of map.values())
                for (const part of [q.stem, ...q.options])
                  for (const i of part) if (i.t === 'math') maths.push(i);
              const rendered = await mathToImages(maths, fontBase);
              const mathCache = new Map(maths.map((m, i) => [m, rendered[i]]));
              const logo = header.logoUrl
                ? imageSource(env, header.logoUrl.replace('app://image/', ''))
                : null;
              const docx = await buildPaperDocx(
                {
                  header,
                  version: v,
                  versionCount: test.settings.versions.length,
                  questions: map,
                  groupBySubject,
                  logo,
                },
                {
                  image: (ref) => imageSource(env, ref),
                  math: async (m) => mathCache.get(m) ?? null,
                },
              );
              write(kind, v.letter, `${base}${suffix}.docx`, docx);
            }
          }
        } else if (kind === 'key-pdf') {
          env.progress({
            task: 'export',
            label: 'Exporting the answer key',
            current: step++,
            total,
          });
          const html = buildKeyHtml({
            header,
            versions,
            questions: map,
            fontBase,
            html: htmlOptions(),
            includeExplanations: input.includeExplanations,
          });
          write(
            kind,
            '',
            `${base} - Answer key (CONFIDENTIAL).pdf`,
            await htmlToPdf(html, { left: header.code, right: '', confidential: true }),
          );
        } else if (kind === 'key-docx') {
          write(
            kind,
            '',
            `${base} - Answer key (CONFIDENTIAL).docx`,
            await buildKeyDocx(header, versions),
          );
        } else if (kind === 'record-xlsx') {
          write(kind, '', `${base} - Test record.xlsx`, await buildTestRecordXlsx(test));
        }
      }
      env.progress({ task: 'export', label: 'Done', current: total, total });
      return { saved, folder };
    },
  ),
  'export:reprint': handler(
    z.object({ exportId: z.number().int().positive() }).strict(),
    async (env, input) => {
      const file = getExportBytes(env.state.ws, input.exportId);
      if (!file) throw new Error('That export was not found.');
      const target = await chooseSavePath(env, 'Save the reprint', file.fileName, []);
      if (!target) return { saved: false };
      writeFileSync(target, file.bytes);
      return { saved: true };
    },
  ),
  'questions:affectedTests': handler(z.object({ id }).strict(), (env, input) =>
    testsUsingQuestion(env.state.ws, input.id),
  ),
  'questions:imageRefs': handler(z.object({ id }).strict(), (env, input) => {
    const q = getQuestion(env.state.ws, input.id);
    return q ? [q.stem, ...q.options, q.explanation].flatMap(imageRefs) : [];
  }),

  // ---- Backups, restore and merge (FR-15, FR-16) ---------------------------------------------
  'backup:list': handler(none, (env) =>
    env.state.backups.list().map(({ file: _file, ...rest }) => rest),
  ),
  'backup:now': handler(z.object({ passphrase }).strict(), async (env, input) => {
    const target = await chooseSavePath(
      env,
      'Save the backup',
      `MCQ backup ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.mcqbackup`,
      [{ name: 'MCQ backup', extensions: ['mcqbackup'] }],
    );
    if (!target) return { saved: false };
    const { bytes, counts } = await env.state.backups.createEncrypted(
      env.state.ws,
      input.passphrase,
    );
    writeFileSync(target, bytes);
    saveSettings(env.state.ws, { backup: { lastManualAt: new Date().toISOString() } });
    audit(env.state.ws, env.state.ctx, 'backup.created', 'workspace', env.state.ws.id, {
      ...counts,
    });
    return { saved: true, counts };
  }),
  'backup:inspectFile': handler(z.object({ passphrase }).strict(), async (env, input) => {
    const file = await chooseOpenFile(env, 'Choose a backup to restore', [
      { name: 'MCQ backup', extensions: ['mcqbackup'] },
    ]);
    if (!file) return null;
    const { header, counts, tempPath } = await env.state.backups.inspectEncrypted(
      await readFile(file),
      input.passphrase,
    );
    const token = env.state.putToken('restore', tempPath, () => rmSync(tempPath, { force: true }));
    return {
      token,
      createdAt: header.createdAt,
      appVersion: header.appVersion,
      counts,
      sameWorkspace: header.workspaceId === env.state.ws.id,
    };
  }),
  'backup:inspectAuto': handler(
    z.object({ name: z.string().regex(/^auto-[\w.-]+\.sqlite$/) }).strict(),
    (env, input) => {
      const entry = env.state.backups.list().find((b) => b.name === input.name);
      if (!entry) throw new Error('That automatic backup no longer exists.');
      const temp = join(env.state.paths.backupDir, `restore-${Date.now()}.sqlite`);
      copyFileSync(entry.file, temp);
      const counts = inspectWorkspaceFile(temp);
      const token = env.state.putToken('restore', temp, () => rmSync(temp, { force: true }));
      return { token, createdAt: entry.createdAt, appVersion: '', counts, sameWorkspace: true };
    },
  ),
  'backup:restore': handler(
    z.object({ token: z.string(), confirm: z.literal(true) }).strict(),
    async (env, input) => {
      const tempPath = env.state.takeToken<string>('restore', input.token, true);
      env.state.replaceWorkspace(tempPath);
      rmSync(tempPath, { force: true });
      audit(env.state.ws, env.state.ctx, 'backup.restored', 'workspace', env.state.ws.id, {});
      log('info', 'backup.restored');
      return { restored: true };
    },
  ),
  'merge:export': handler(z.object({ passphrase }).strict(), async (env, input) => {
    const target = await chooseSavePath(
      env,
      'Save the merge file',
      `MCQ history ${env.state.osUser} ${new Date().toISOString().slice(0, 10)}.mcqmerge`,
      [{ name: 'MCQ merge file', extensions: ['mcqmerge'] }],
    );
    if (!target) return { saved: false };
    writeFileSync(
      target,
      await exportMergeFile(env.state.ws, env.state.ctx, input.passphrase, env.state.appVersion),
    );
    return { saved: true };
  }),
  'merge:inspect': handler(z.object({ passphrase }).strict(), async (env, input) => {
    const file = await chooseOpenFile(env, 'Choose a merge file from another laptop', [
      { name: 'MCQ merge file', extensions: ['mcqmerge'] },
    ]);
    if (!file) return null;
    const payload = await readMergeFile(await readFile(file), input.passphrase);
    const plan = planMerge(env.state.ws, payload);
    const token = env.state.putToken('merge', payload);
    return { token, plan };
  }),
  'merge:apply': handler(
    z
      .object({
        token: z.string(),
        choices: z.record(z.string(), z.enum(['mine', 'theirs'])),
        confirm: z.literal(true),
      })
      .strict(),
    (env, input) => {
      const payload = env.state.takeToken<Awaited<ReturnType<typeof readMergeFile>>>(
        'merge',
        input.token,
        true,
      );
      env.state.backups.snapshot(
        env.state.ws,
        'pre-merge',
        env.state.settings.backup.keepAutomatic + 1,
      );
      return applyMerge(env.state.ws, env.state.ctx, payload, input.choices);
    },
  ),

  // ---- Audit (FR-14) ---------------------------------------------------------------------------
  'audit:list': handler(
    z
      .object({
        action: z.string().max(60).optional(),
        entityId: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(500),
        offset: z.number().int().min(0),
      })
      .strict(),
    (env, input) => listAudit(env.state.ws, input),
  ),
};

export type AppApi = typeof api;
export type Channel = keyof AppApi;

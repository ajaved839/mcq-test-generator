import { z } from 'zod';
import type { Inline, MathNode, RichText } from '../core/richtext';
import { MATHML_ATTRS, MATHML_TAGS } from '../core/richtext';

/**
 * Validation schemas for everything that crosses the IPC bridge or is read back from a
 * backup or merge file. Objects are strict, so unexpected keys are rejected rather than stored.
 */

const MAX_TEXT = 20_000;

const mathNode: z.ZodType<MathNode> = z.lazy(() =>
  z
    .object({
      tag: z.string().refine((t) => MATHML_TAGS.has(t), 'Unsupported MathML element'),
      attrs: z
        .record(z.string(), z.string().max(200))
        .refine(
          (a) => Object.keys(a).every((k) => MATHML_ATTRS.has(k)),
          'Unsupported MathML attribute',
        )
        .optional(),
      children: z.array(z.union([mathNode, z.string().max(MAX_TEXT)])).max(2000),
    })
    .strict(),
);

const textInline = z
  .object({
    t: z.literal('text'),
    text: z.string().max(MAX_TEXT),
    b: z.boolean().optional(),
    i: z.boolean().optional(),
    u: z.boolean().optional(),
    sub: z.boolean().optional(),
    sup: z.boolean().optional(),
    hl: z.boolean().optional(),
    low: z.boolean().optional(),
  })
  .strict();

const inline: z.ZodType<Inline> = z.lazy(() =>
  z.union([
    textInline,
    z.object({ t: z.literal('br') }).strict(),
    z
      .object({
        t: z.literal('img'),
        ref: z.string().regex(/^[a-f0-9]{64}$/),
        w: z.number().positive().max(5000).optional(),
        h: z.number().positive().max(5000).optional(),
        alt: z.string().max(500).optional(),
      })
      .strict(),
    z
      .object({
        t: z.literal('math'),
        latex: z.string().max(MAX_TEXT).optional(),
        mathml: mathNode.optional(),
        display: z.boolean().optional(),
      })
      .strict(),
    z.object({ t: z.literal('table'), rows: z.array(z.array(richText).max(20)).max(100) }).strict(),
  ]),
);

export const richText: z.ZodType<RichText> = z.array(inline).max(5000);

export const difficulty = z.enum(['easy', 'medium', 'hard']);
export const id = z.string().min(1).max(100);
const shortText = z.string().max(200);

export const questionInput = z
  .object({
    id: id.optional(),
    stem: richText,
    options: z.array(richText).min(2).max(5),
    correct: z.number().int().min(0).max(4),
    explanation: richText,
    lockOptions: z.boolean(),
    subject: z.string().trim().min(1).max(100),
    topic: shortText,
    difficulty,
    tags: z.array(z.string().trim().min(1).max(60)).max(30),
    source: shortText,
    reserved: z.boolean(),
    /** Optimistic concurrency: the version being edited. */
    expectedVersion: z.number().int().positive().optional(),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((q) => q.correct < q.options.length, 'The correct answer must be one of the options.');
export type QuestionInput = z.infer<typeof questionInput>;

export const repeatRule = z
  .object({
    mode: z.enum(['each', 'combined']),
    limitPct: z.number().int().min(0).max(100),
    denominator: z.enum(['new', 'smaller']),
  })
  .strict();

const difficultyMix = z
  .object({
    easy: z.number().int().min(0).max(100),
    medium: z.number().int().min(0).max(100),
    hard: z.number().int().min(0).max(100),
  })
  .strict()
  .refine((m) => m.easy + m.medium + m.hard === 100, 'The difficulty mix must add up to 100%.');

export const blueprint = z
  .object({
    sections: z
      .array(
        z
          .object({
            subject: z.string().trim().min(1).max(100),
            count: z.number().int().min(1).max(1000),
            topics: z.array(shortText).max(100),
            difficultyMix: difficultyMix.nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    difficultyMix: difficultyMix.nullable(),
  })
  .strict();

export const comparisonScope = z
  .object({
    /** Tests the admin unchecked for this generation. */
    excludedTestIds: z.array(id).max(10_000),
    from: z.string().max(40).nullable(),
    to: z.string().max(40).nullable(),
  })
  .strict();

export const generateRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    code: z.string().trim().max(40),
    blueprint,
    rule: repeatRule,
    strategy: z.enum(['fresh-first', 'stretch']),
    versions: z.number().int().min(1).max(4),
    allowReserved: z.boolean(),
    groupBySubject: z.boolean(),
    scope: comparisonScope,
    instructions: z.string().max(5000),
    durationMinutes: z.number().int().min(0).max(1000),
    seed: z.number().int().min(0).max(0xffffffff),
  })
  .strict();
export type GenerateRequest = z.infer<typeof generateRequest>;

export const settingsSchema = z
  .object({
    institute: z
      .object({
        name: z.string().max(200),
        address: z.string().max(500),
        logoRef: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict(),
    paper: z
      .object({
        instructions: z.string().max(5000),
        durationMinutes: z.number().int().min(0).max(1000),
        versions: z.number().int().min(1).max(4),
        showTestCode: z.boolean(),
        groupBySubject: z.boolean(),
        fontSizePt: z.number().min(8).max(16),
        confidentialFooter: z.boolean(),
      })
      .strict(),
    rule: repeatRule,
    strategy: z.enum(['fresh-first', 'stretch']),
    subjects: z.array(z.string().trim().min(1).max(100)).max(100),
    duplicateThresholdPct: z.number().int().min(50).max(100),
    theme: z.enum(['light', 'dark', 'auto']),
    textScalePct: z.number().int().min(80).max(150),
    staff: z.array(z.string().trim().min(1).max(100)).max(100),
    backup: z
      .object({
        keepAutomatic: z.number().int().min(1).max(50),
        remindDays: z.number().int().min(1).max(90),
        lastManualAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  institute: { name: 'Your Institute', address: '', logoRef: null },
  paper: {
    instructions:
      'Answer all questions. Each question has one best answer. Mark your answer clearly on the answer sheet.',
    durationMinutes: 60,
    versions: 1,
    showTestCode: true,
    groupBySubject: true,
    fontSizePt: 11,
    confidentialFooter: true,
  },
  rule: { mode: 'each', limitPct: 20, denominator: 'new' },
  strategy: 'fresh-first',
  subjects: ['Biology', 'Chemistry', 'Physics', 'English', 'Logical Reasoning'],
  duplicateThresholdPct: 90,
  theme: 'auto',
  textScalePct: 100,
  staff: [],
  backup: { keepAutomatic: 10, remindDays: 7, lastManualAt: null },
};

export const bankFilter = z
  .object({
    search: z.string().max(200).default(''),
    subjects: z.array(z.string().max(100)).max(100).default([]),
    topics: z.array(z.string().max(200)).max(200).default([]),
    difficulties: z.array(difficulty).max(3).default([]),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    usage: z.enum(['any', 'never', 'used']).default('any'),
    reserved: z.enum(['any', 'only', 'exclude']).default('any'),
    tag: z.string().max(60).default(''),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();
export type BankFilter = z.infer<typeof bankFilter>;

/** Uploaded file bytes from the renderer (drop zone or file picker). */
export const fileUpload = z
  .object({
    fileName: z.string().min(1).max(260),
    bytes: z
      .instanceof(Uint8Array)
      .refine((b) => b.byteLength <= 200 * 1024 * 1024, 'Files must be under 200 MB.'),
  })
  .strict();
export type FileUpload = z.infer<typeof fileUpload>;

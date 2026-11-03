import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SourceLine } from '../../core/mcq-parser';
import { mergeText, text, type RichText } from '../../core/richtext';

/**
 * Offline OCR for photos and scans (FR-3) using Tesseract.js with the bundled English model.
 * Nothing is uploaded or downloaded: `langPath` points at the model inside the app, and
 * Tesseract runs in its own worker thread so the window stays responsive.
 */

export const LOW_CONFIDENCE = 70;

export interface OcrPage {
  /** 1-based page number within the import. */
  page: number;
  bytes: Uint8Array;
}

export interface OcrProgress {
  page: number;
  pages: number;
  status: string;
  progress: number;
}

export interface OcrPageResult {
  page: number;
  lines: SourceLine[];
  confidence: number;
  lowConfidenceWords: number;
  words: number;
}

interface TesseractWord {
  text: string;
  confidence: number;
  symbols?: Array<{ text: string; is_subscript: boolean; is_superscript: boolean }>;
}
interface TesseractLine {
  words: TesseractWord[];
}
interface TesseractBlock {
  paragraphs: Array<{ lines: TesseractLine[] }>;
}
interface TesseractWorker {
  recognize(
    image: Buffer,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: { blocks: TesseractBlock[] | null; confidence: number } }>;
  terminate(): Promise<unknown>;
}

const require = createRequire(import.meta.url);

/** Folder holding eng.traineddata.gz; inside the unpacked app resources when packaged. */
export function defaultLangPath(): string {
  const pkg = require.resolve('@tesseract.js-data/eng/package.json');
  return join(dirname(pkg), '4.0.0_best_int').replace('app.asar', 'app.asar.unpacked');
}

/** Rejects formats Tesseract cannot read, with the fix staff need. */
export function checkImageFormat(fileName: string, bytes: Uint8Array): void {
  const lower = fileName.toLowerCase();
  const isHeic =
    lower.endsWith('.heic') ||
    lower.endsWith('.heif') ||
    (bytes.length > 12 && new TextDecoder().decode(bytes.slice(4, 12)).startsWith('ftyphei'));
  if (isHeic) {
    throw new Error(
      'iPhone HEIC photos are not supported. Export the photo as JPEG, or set the camera to "Most Compatible" and take it again.',
    );
  }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) throw new Error(`${fileName} is not a JPG or PNG image.`);
}

/** Turns Tesseract words into a rich line, marking low-confidence words and sub/superscripts. */
export function wordsToRich(words: readonly TesseractWord[]): RichText {
  const out: RichText = [];
  words.forEach((word, i) => {
    if (i > 0) out.push(text(' '));
    const low = word.confidence < LOW_CONFIDENCE;
    const symbols = word.symbols ?? [];
    if (symbols.some((s) => s.is_subscript || s.is_superscript)) {
      for (const s of symbols) {
        out.push(
          text(s.text, {
            ...(low ? { low: true } : {}),
            ...(s.is_subscript ? { sub: true } : {}),
            ...(s.is_superscript ? { sup: true } : {}),
          }),
        );
      }
    } else {
      out.push(text(word.text, low ? { low: true } : {}));
    }
  });
  return mergeText(out);
}

export class OcrEngine {
  private worker: TesseractWorker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly langPath: string = defaultLangPath(),
    private readonly onLog?: (status: string, progress: number) => void,
  ) {}

  private async getWorker(): Promise<TesseractWorker> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.worker) {
      const { createWorker, OEM } =
        (await import('tesseract.js')).default ?? (await import('tesseract.js'));
      this.worker = (await createWorker('eng', OEM.LSTM_ONLY, {
        langPath: this.langPath,
        cacheMethod: 'none',
        gzip: true,
        logger: (m: { status: string; progress: number }) => this.onLog?.(m.status, m.progress),
      })) as unknown as TesseractWorker;
    }
    return this.worker;
  }

  async recognizePage(page: OcrPage): Promise<OcrPageResult> {
    const worker = await this.getWorker();
    const { data } = await worker.recognize(
      Buffer.from(page.bytes),
      {},
      { blocks: true, text: false },
    );
    const lines: SourceLine[] = [];
    let words = 0;
    let low = 0;
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          const content = wordsToRich(line.words);
          words += line.words.length;
          low += line.words.filter((w) => w.confidence < LOW_CONFIDENCE).length;
          if (content.length) lines.push({ content, page: page.page, ref: `page ${page.page}` });
        }
      }
    }
    this.scheduleIdleShutdown();
    return { page: page.page, lines, confidence: data.confidence, lowConfidenceWords: low, words };
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.dispose(), 120_000);
    this.idleTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }
}

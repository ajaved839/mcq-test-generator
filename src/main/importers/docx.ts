import type { Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { SourceLine } from '../../core/mcq-parser';
import {
  mergeText,
  text,
  toPlainText,
  type Inline,
  type RichText,
  type TextInline,
} from '../../core/richtext';
import { convertOmml } from './omml';
import { attr, child, children, isEl, isOn, NS, parseXml, textContent } from './xml';

/**
 * Word (.docx) reader (FR-2). Produces SourceLines for the shared MCQ parser, keeping:
 * - auto-numbering labels (so "1." from Word's list numbering is not lost),
 * - bold, italic, underline, sub/superscript and highlight (for "marked" answers),
 * - images (stored via `storeImage`) and tables,
 * - equations (OMML converted to MathML).
 * MathType objects and unsupported images are reported as notes so review flags them.
 */

export interface DocxImage {
  bytes: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
}

/** Stores an image and returns its hash, or null when the format is not supported. */
export type StoreImage = (image: DocxImage) => string | null;

export interface DocxReadResult {
  lines: SourceLine[];
  stats: { paragraphs: number; images: number; equations: number; tables: number; notes: number };
}

const EMU_PER_PX = 9525;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

interface StyleInfo {
  b?: boolean;
  i?: boolean;
  basedOn?: string;
  numId?: string;
  ilvl?: number;
}

interface LevelDef {
  format: string;
  text: string;
  start: number;
}

class Numbering {
  private numToAbstract = new Map<string, string>();
  private startOverride = new Map<string, Map<number, number>>();
  private levels = new Map<string, Map<number, LevelDef>>();
  private counters = new Map<string, number[]>();

  constructor(root: Element | null) {
    if (!root) return;
    for (const el of children(root)) {
      if (isEl(el, NS.w, 'abstractNum')) {
        const id = attr(el, NS.w, 'abstractNumId') ?? '';
        const levels = new Map<number, LevelDef>();
        for (const lvl of children(el).filter((c) => isEl(c, NS.w, 'lvl'))) {
          levels.set(Number(attr(lvl, NS.w, 'ilvl') ?? 0), {
            format: attr(child(lvl, NS.w, 'numFmt'), NS.w, 'val') ?? 'decimal',
            text: attr(child(lvl, NS.w, 'lvlText'), NS.w, 'val') ?? '%1.',
            start: Number(attr(child(lvl, NS.w, 'start'), NS.w, 'val') ?? 1),
          });
        }
        this.levels.set(id, levels);
      }
    }
    for (const el of children(root)) {
      if (isEl(el, NS.w, 'num')) {
        const numId = attr(el, NS.w, 'numId') ?? '';
        this.numToAbstract.set(numId, attr(child(el, NS.w, 'abstractNumId'), NS.w, 'val') ?? '');
        const overrides = new Map<number, number>();
        for (const o of children(el).filter((c) => isEl(c, NS.w, 'lvlOverride'))) {
          const start = attr(child(o, NS.w, 'startOverride'), NS.w, 'val');
          if (start !== null) overrides.set(Number(attr(o, NS.w, 'ilvl') ?? 0), Number(start));
        }
        this.startOverride.set(numId, overrides);
      }
    }
  }

  /** Advances the counter for (numId, ilvl) and renders the label, e.g. "12." or "(b)". */
  next(numId: string, ilvl: number): string | null {
    const abstract = this.numToAbstract.get(numId);
    const levels = abstract !== undefined ? this.levels.get(abstract) : undefined;
    const def = levels?.get(ilvl);
    if (!levels || !def || def.format === 'bullet' || def.format === 'none') return null;
    const key = abstract!;
    const counters = this.counters.get(key) ?? [];
    for (let l = 0; l <= ilvl; l++) {
      if (counters[l] === undefined) {
        counters[l] = (this.startOverride.get(numId)?.get(l) ?? levels.get(l)?.start ?? 1) - 1;
      }
    }
    counters[ilvl] += 1;
    counters.length = ilvl + 1; // deeper levels restart
    this.counters.set(key, counters);
    return def.text.replace(/%(\d)/g, (_, n: string) => {
      const level = Number(n) - 1;
      return formatNumber(counters[level] ?? 1, levels.get(level)?.format ?? 'decimal');
    });
  }
}

function toRoman(n: number): string {
  const map: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [value, numeral] of map) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

function toLetters(n: number): string {
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function formatNumber(n: number, format: string): string {
  switch (format) {
    case 'lowerLetter':
      return toLetters(n);
    case 'upperLetter':
      return toLetters(n).toUpperCase();
    case 'lowerRoman':
      return toRoman(n);
    case 'upperRoman':
      return toRoman(n).toUpperCase();
    default:
      return String(n);
  }
}

function readStyles(root: Element | null): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!root) return styles;
  for (const s of children(root).filter((c) => isEl(c, NS.w, 'style'))) {
    const id = attr(s, NS.w, 'styleId') ?? '';
    const rPr = child(s, NS.w, 'rPr');
    const numPr = child(child(s, NS.w, 'pPr') ?? s, NS.w, 'numPr');
    styles.set(id, {
      b: rPr ? isOn(child(rPr, NS.w, 'b')) : undefined,
      i: rPr ? isOn(child(rPr, NS.w, 'i')) : undefined,
      basedOn: attr(child(s, NS.w, 'basedOn'), NS.w, 'val') ?? undefined,
      numId: numPr ? (attr(child(numPr, NS.w, 'numId'), NS.w, 'val') ?? undefined) : undefined,
      ilvl: numPr ? Number(attr(child(numPr, NS.w, 'ilvl'), NS.w, 'val') ?? 0) : undefined,
    });
  }
  return styles;
}

function styleChain(styles: Map<string, StyleInfo>, id: string | null): StyleInfo {
  const out: StyleInfo = {};
  const seen = new Set<string>();
  let current = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const s = styles.get(current);
    if (!s) break;
    out.b ??= s.b;
    out.i ??= s.i;
    out.numId ??= s.numId;
    out.ilvl ??= s.ilvl;
    current = s.basedOn ?? null;
  }
  return out;
}

const HIGHLIGHT_OFF = new Set(['none', 'auto', 'ffffff', 'white']);

export async function readDocx(bytes: Uint8Array, storeImage: StoreImage): Promise<DocxReadResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(
      'This file is not a valid .docx document. Old .doc files must be saved as .docx in Word first.',
    );
  }
  const read = async (path: string): Promise<string | null> => {
    const entry = zip.file(path);
    if (!entry) return null;
    const content = await entry.async('uint8array');
    if (content.byteLength > MAX_ENTRY_BYTES)
      throw new Error('The document is too large to import.');
    return new TextDecoder().decode(content);
  };
  const documentXml = await read('word/document.xml');
  if (!documentXml)
    throw new Error('This file is not a Word document (word/document.xml is missing).');

  const relsXml = await read('word/_rels/document.xml.rels');
  const rels = new Map<string, string>();
  if (relsXml) {
    for (const r of children(parseXml(relsXml))) {
      const idAttr = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      if (idAttr && target && r.getAttribute('TargetMode') !== 'External') rels.set(idAttr, target);
    }
  }
  const numberingXml = await read('word/numbering.xml');
  const numbering = new Numbering(numberingXml ? parseXml(numberingXml) : null);
  const stylesXml = await read('word/styles.xml');
  const styles = readStyles(stylesXml ? parseXml(stylesXml) : null);

  const stats = { paragraphs: 0, images: 0, equations: 0, tables: 0, notes: 0 };
  const imageCache = new Map<string, string | null>();

  const loadImage = async (
    rId: string | null,
    size: { width?: number; height?: number },
  ): Promise<Inline | string> => {
    if (!rId) return 'An image could not be found in the file.';
    const target = rels.get(rId);
    if (!target) return 'An image link points outside the file and was not imported.';
    const path = target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`;
    let hash = imageCache.get(path);
    if (hash === undefined) {
      const entry = zip.file(path);
      const data = entry ? await entry.async('uint8array') : null;
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const contentType =
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
        }[ext] ?? `image/${ext}`;
      hash = data ? storeImage({ bytes: data, contentType, ...size }) : null;
      imageCache.set(path, hash);
    }
    if (!hash)
      return 'An image in an unsupported format (for example EMF or WMF) was skipped; crop it from the page instead.';
    stats.images += 1;
    return {
      t: 'img',
      ref: hash,
      ...(size.width ? { w: size.width } : {}),
      ...(size.height ? { h: size.height } : {}),
    };
  };

  interface RunContext {
    paragraphStyle: StyleInfo;
    notes: string[];
  }

  const runMarks = (rPr: Element | null, ctx: RunContext): Omit<TextInline, 't' | 'text'> => {
    const charStyle = styleChain(
      styles,
      rPr ? attr(child(rPr, NS.w, 'rStyle'), NS.w, 'val') : null,
    );
    const marks: Omit<TextInline, 't' | 'text'> = {};
    const bEl = rPr ? child(rPr, NS.w, 'b') : null;
    const iEl = rPr ? child(rPr, NS.w, 'i') : null;
    const bold = bEl ? isOn(bEl) : (charStyle.b ?? ctx.paragraphStyle.b ?? false);
    const italic = iEl ? isOn(iEl) : (charStyle.i ?? ctx.paragraphStyle.i ?? false);
    if (bold) marks.b = true;
    if (italic) marks.i = true;
    if (rPr) {
      const u = child(rPr, NS.w, 'u');
      if (u && attr(u, NS.w, 'val') !== 'none') marks.u = true;
      const va = attr(child(rPr, NS.w, 'vertAlign'), NS.w, 'val');
      if (va === 'subscript') marks.sub = true;
      if (va === 'superscript') marks.sup = true;
      const hl = attr(child(rPr, NS.w, 'highlight'), NS.w, 'val');
      const shd = attr(child(rPr, NS.w, 'shd'), NS.w, 'fill');
      if (
        (hl && !HIGHLIGHT_OFF.has(hl.toLowerCase())) ||
        (shd && !HIGHLIGHT_OFF.has(shd.toLowerCase()))
      )
        marks.hl = true;
    }
    return marks;
  };

  const readInlineContainer = async (container: Element, ctx: RunContext): Promise<RichText> => {
    const out: RichText = [];
    for (const node of children(container)) {
      if (isEl(node, NS.w, 'r')) {
        const rPr = child(node, NS.w, 'rPr');
        const marks = runMarks(rPr, ctx);
        for (const part of children(node)) {
          if (isEl(part, NS.w, 't')) out.push(text(textContent(part), marks));
          else if (isEl(part, NS.w, 'tab')) out.push(text(' ', marks));
          else if (isEl(part, NS.w, 'br') || isEl(part, NS.w, 'cr')) {
            if (attr(part, NS.w, 'type') !== 'page') out.push({ t: 'br' });
          } else if (isEl(part, NS.w, 'sym')) {
            const code = attr(part, NS.w, 'char');
            if (code) out.push(text(String.fromCharCode(parseInt(code, 16) & 0xffff), marks));
          } else if (isEl(part, NS.w, 'drawing')) {
            const extent = findDeep(part, NS.wp, 'extent');
            const size = extent
              ? {
                  width: Math.round(Number(extent.getAttribute('cx')) / EMU_PER_PX),
                  height: Math.round(Number(extent.getAttribute('cy')) / EMU_PER_PX),
                }
              : {};
            const blip = findDeep(part, NS.a, 'blip');
            const result = await loadImage(attr(blip, NS.r, 'embed'), size);
            if (typeof result === 'string') ctx.notes.push(result);
            else out.push(result);
          } else if (isEl(part, NS.w, 'pict')) {
            const imagedata = findDeep(part, NS.v, 'imagedata');
            const result = await loadImage(attr(imagedata, NS.r, 'id'), {});
            if (typeof result === 'string') ctx.notes.push(result);
            else out.push(result);
          } else if (isEl(part, NS.w, 'object')) {
            const ole = findDeep(part, NS.o, 'OLEObject');
            const progId = ole?.getAttribute('ProgID') ?? '';
            ctx.notes.push(
              /equation|mathtype|dsmt/i.test(progId)
                ? 'A MathType or legacy equation could not be converted; retype it as LaTeX or crop it as an image.'
                : 'An embedded object could not be imported; crop it as an image if needed.',
            );
            out.push(text(' [equation] '));
          }
        }
      } else if (isEl(node, NS.m, 'oMath') || isEl(node, NS.m, 'oMathPara')) {
        const conversion = convertOmml(node);
        stats.equations += 1;
        if (conversion.unsupported.length) {
          ctx.notes.push(
            `Part of an equation (${[...new Set(conversion.unsupported)].join(', ')}) may not display correctly.`,
          );
        }
        out.push({
          t: 'math',
          mathml: conversion.node,
          ...(isEl(node, NS.m, 'oMathPara') ? { display: true } : {}),
        });
      } else if (
        isEl(node, NS.w, 'hyperlink') ||
        isEl(node, NS.w, 'ins') ||
        isEl(node, NS.w, 'smartTag') ||
        isEl(node, NS.w, 'fldSimple') ||
        isEl(node, NS.w, 'customXml')
      ) {
        out.push(...(await readInlineContainer(node, ctx)));
      } else if (isEl(node, NS.w, 'sdt')) {
        const sdtContent = child(node, NS.w, 'sdtContent');
        if (sdtContent) out.push(...(await readInlineContainer(sdtContent, ctx)));
      }
      // w:del (tracked deletions), w:pPr, bookmarks and comments carry no visible text.
    }
    return mergeText(out);
  };

  const lines: SourceLine[] = [];

  const readParagraph = async (p: Element): Promise<SourceLine> => {
    const pPr = child(p, NS.w, 'pPr');
    const styleId = attr(child(pPr ?? p, NS.w, 'pStyle'), NS.w, 'val');
    const paragraphStyle = styleChain(styles, styleId);
    const ctx: RunContext = { paragraphStyle, notes: [] };
    const content = await readInlineContainer(p, ctx);
    const numPr = pPr ? child(pPr, NS.w, 'numPr') : null;
    const numId = numPr ? attr(child(numPr, NS.w, 'numId'), NS.w, 'val') : paragraphStyle.numId;
    const ilvl = numPr
      ? Number(attr(child(numPr, NS.w, 'ilvl'), NS.w, 'val') ?? 0)
      : (paragraphStyle.ilvl ?? 0);
    const listLabel = numId && numId !== '0' ? numbering.next(numId, ilvl) : null;
    stats.paragraphs += 1;
    stats.notes += ctx.notes.length;
    return {
      content,
      ref: `paragraph ${stats.paragraphs}`,
      ...(listLabel ? { listLabel } : {}),
      ...(ctx.notes.length ? { notes: ctx.notes } : {}),
    };
  };

  const readTable = async (tbl: Element): Promise<SourceLine> => {
    stats.tables += 1;
    const rows: RichText[][] = [];
    const notes: string[] = [];
    for (const tr of children(tbl).filter((c) => isEl(c, NS.w, 'tr'))) {
      const cells: RichText[] = [];
      for (const tc of children(tr).filter((c) => isEl(c, NS.w, 'tc'))) {
        const parts: RichText = [];
        for (const p of children(tc).filter((c) => isEl(c, NS.w, 'p'))) {
          const line = await readParagraph(p);
          if (line.notes) notes.push(...line.notes);
          if (parts.length && line.content.length) parts.push({ t: 'br' });
          parts.push(...(line.listLabel ? [text(`${line.listLabel} `)] : []), ...line.content);
        }
        cells.push(parts);
      }
      rows.push(cells);
    }
    // A two-column table of numbers and letters is an answer key; pass it as key text.
    const flat = rows.map((r) => r.map((c) => toPlainText(c).trim()));
    const keyLike =
      flat.length > 0 &&
      flat.every(
        (r) =>
          r.length >= 2 &&
          r.length % 2 === 0 &&
          r.every((v, i) => (i % 2 === 0 ? /^\d{1,4}\.?$/.test(v) : /^\(?[a-e]\)?$/i.test(v))),
      );
    if (keyLike) {
      return {
        content: [
          text(
            flat
              .map((r) => r.map((v, i) => (i % 2 === 0 ? `${v.replace('.', '')}.` : v)).join(' '))
              .join(' '),
          ),
        ],
        ref: `table ${stats.tables}`,
      };
    }
    return {
      content: [{ t: 'table', rows }],
      ref: `table ${stats.tables}`,
      ...(notes.length ? { notes } : {}),
    };
  };

  const body = descendantBody(parseXml(documentXml));
  for (const node of children(body)) {
    if (isEl(node, NS.w, 'p')) lines.push(await readParagraph(node));
    else if (isEl(node, NS.w, 'tbl')) lines.push(await readTable(node));
    else if (isEl(node, NS.w, 'sdt')) {
      const sdtContent = child(node, NS.w, 'sdtContent');
      for (const inner of sdtContent ? children(sdtContent) : []) {
        if (isEl(inner, NS.w, 'p')) lines.push(await readParagraph(inner));
        else if (isEl(inner, NS.w, 'tbl')) lines.push(await readTable(inner));
      }
    }
  }
  return { lines, stats };
}

function descendantBody(root: Element): Element {
  const body = child(root, NS.w, 'body');
  if (!body) throw new Error('The Word document has no body.');
  return body;
}

function findDeep(node: Element, ns: string, local: string): Element | null {
  for (const c of children(node)) {
    if (isEl(c, ns, local)) return c;
    const found = findDeep(c, ns, local);
    if (found) return found;
  }
  return null;
}

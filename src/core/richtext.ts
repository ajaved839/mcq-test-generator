/**
 * Rich text model shared by every layer.
 *
 * Question content is stored as a small, allowlisted token tree instead of raw HTML.
 * Imported text (Word, Excel, OCR) is converted into these tokens, and HTML is only ever
 * produced by `toHtml`, which escapes every string. That makes "imported content is data,
 * never code" true by construction: there is no path for a <script> or event handler to
 * survive from a source file into the UI or a printed paper.
 */

export interface TextInline {
  t: 'text';
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  sub?: boolean;
  sup?: boolean;
  /** Highlighted in the source file; used only to detect marked answers, never printed. */
  hl?: boolean;
  /** Low OCR confidence; highlighted in the review queue, stripped on approval. */
  low?: boolean;
}

export interface BreakInline {
  t: 'br';
}

export interface ImageInline {
  t: 'img';
  /** SHA-256 of the stored image bytes (see the images table). */
  ref: string;
  w?: number;
  h?: number;
  alt?: string;
}

/** Allowlisted MathML element tree (MathML Core subset Chromium renders). */
export interface MathNode {
  tag: string;
  attrs?: Record<string, string>;
  children: Array<MathNode | string>;
}

export interface MathInline {
  t: 'math';
  /** LaTeX source typed by staff; rendered with KaTeX to MathML. */
  latex?: string;
  /** MathML converted from a Word equation. */
  mathml?: MathNode;
  display?: boolean;
}

export interface TableInline {
  t: 'table';
  rows: RichText[][];
}

export type Inline = TextInline | BreakInline | ImageInline | MathInline | TableInline;
export type RichText = Inline[];

/** Placeholder used for non-text inlines when slicing by character offset. */
export const OBJECT_CHAR = '￼';

export const MATHML_TAGS = new Set([
  'math',
  'mrow',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'mspace',
  'msub',
  'msup',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'munder',
  'mover',
  'munderover',
  'mtable',
  'mtr',
  'mtd',
  'mstyle',
  'mpadded',
  'mphantom',
  'semantics',
  'annotation',
]);

export const MATHML_ATTRS = new Set([
  'display',
  'mathvariant',
  'stretchy',
  'fence',
  'separator',
  'accent',
  'accentunder',
  'linethickness',
  'columnalign',
  'rowalign',
  'width',
  'height',
  'depth',
  'lspace',
  'rspace',
  'form',
  'largeop',
  'movablelimits',
  'symmetric',
  'encoding',
]);

export function text(value: string, marks: Omit<TextInline, 't' | 'text'> = {}): TextInline {
  return { t: 'text', text: value, ...marks };
}

export function plain(value: string): RichText {
  return value ? [text(value)] : [];
}

/** Length of one inline in the character space used by `sliceRich`. */
function inlineLength(inline: Inline): number {
  return inline.t === 'text' ? inline.text.length : inline.t === 'br' ? 1 : 1;
}

/**
 * Plain text view with one placeholder character per non-text inline, so character offsets
 * found by regexes map 1:1 back into the token list.
 */
export function toOffsetText(rich: RichText): string {
  return rich
    .map((inline) => (inline.t === 'text' ? inline.text : inline.t === 'br' ? '\n' : OBJECT_CHAR))
    .join('');
}

/** Returns the tokens covering characters [start, end) of `toOffsetText(rich)`. */
export function sliceRich(rich: RichText, start: number, end = Number.POSITIVE_INFINITY): RichText {
  const out: RichText = [];
  let pos = 0;
  for (const inline of rich) {
    const len = inlineLength(inline);
    const from = Math.max(start, pos);
    const to = Math.min(end, pos + len);
    if (from < to) {
      if (inline.t === 'text') {
        out.push({ ...inline, text: inline.text.slice(from - pos, to - pos) });
      } else {
        out.push(inline);
      }
    }
    pos += len;
    if (pos >= end) break;
  }
  return out;
}

/** Trims leading and trailing whitespace and breaks; merges adjacent equal-format text. */
export function trimRich(rich: RichText): RichText {
  const tokens = mergeText(rich);
  while (tokens.length && isBlankInline(tokens[0])) tokens.shift();
  while (tokens.length && isBlankInline(tokens[tokens.length - 1])) tokens.pop();
  if (tokens.length) {
    const first = tokens[0];
    if (first.t === 'text') tokens[0] = { ...first, text: first.text.replace(/^\s+/, '') };
    const last = tokens[tokens.length - 1];
    if (last.t === 'text')
      tokens[tokens.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') };
  }
  return tokens.filter((inline) => inline.t !== 'text' || inline.text.length > 0);
}

function isBlankInline(inline: Inline): boolean {
  return inline.t === 'br' || (inline.t === 'text' && inline.text.trim() === '');
}

function sameMarks(a: TextInline, b: TextInline): boolean {
  return (
    !!a.b === !!b.b &&
    !!a.i === !!b.i &&
    !!a.u === !!b.u &&
    !!a.sub === !!b.sub &&
    !!a.sup === !!b.sup &&
    !!a.hl === !!b.hl &&
    !!a.low === !!b.low
  );
}

export function mergeText(rich: RichText): RichText {
  const out: RichText = [];
  for (const inline of rich) {
    const prev = out[out.length - 1];
    if (inline.t === 'text' && prev && prev.t === 'text' && sameMarks(prev, inline)) {
      out[out.length - 1] = { ...prev, text: prev.text + inline.text };
    } else if (inline.t !== 'text' || inline.text.length > 0) {
      out.push(inline);
    }
  }
  return out;
}

export function joinRich(parts: RichText[], separator: Inline = { t: 'br' }): RichText {
  const out: RichText = [];
  parts.forEach((part, index) => {
    if (index > 0 && part.length) out.push(separator);
    out.push(...part);
  });
  return mergeText(out);
}

export function isEmptyRich(rich: RichText): boolean {
  return rich.every(
    (inline) => inline.t === 'br' || (inline.t === 'text' && inline.text.trim() === ''),
  );
}

/** True when every visible character is bold (used for "bold option marks the answer"). */
export function isEntirely(rich: RichText, mark: 'b' | 'hl'): boolean {
  const visible = rich.filter(
    (inline): inline is TextInline => inline.t === 'text' && inline.text.trim() !== '',
  );
  return visible.length > 0 && visible.every((inline) => inline[mark] === true);
}

/** Removes review-only marks (highlight, low confidence) before a question enters the bank. */
export function stripReviewMarks(rich: RichText): RichText {
  return mergeText(
    rich.map((inline) => {
      if (inline.t === 'text') {
        const { hl: _hl, low: _low, ...rest } = inline;
        return rest;
      }
      if (inline.t === 'table') {
        return { ...inline, rows: inline.rows.map((row) => row.map(stripReviewMarks)) };
      }
      return inline;
    }),
  );
}

function mathText(node: MathNode | string): string {
  return typeof node === 'string' ? node : node.children.map(mathText).join('');
}

/** Human-readable plain text, used for search, duplicate checks and logs-free summaries. */
export function toPlainText(rich: RichText): string {
  return rich
    .map((inline) => {
      switch (inline.t) {
        case 'text':
          return inline.text;
        case 'br':
          return '\n';
        case 'img':
          return `[image:${inline.ref.slice(0, 12)}]`;
        case 'math':
          return inline.latex ?? (inline.mathml ? mathText(inline.mathml) : '');
        case 'table':
          return inline.rows.map((row) => row.map(toPlainText).join(' | ')).join('\n');
      }
    })
    .join('');
}

export function imageRefs(rich: RichText): string[] {
  const refs: string[] = [];
  for (const inline of rich) {
    if (inline.t === 'img') refs.push(inline.ref);
    if (inline.t === 'table')
      inline.rows.forEach((row) => row.forEach((cell) => refs.push(...imageRefs(cell))));
  }
  return refs;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Serializes an allowlisted MathML tree; unknown tags and attributes are dropped. */
export function mathNodeToHtml(node: MathNode | string): string {
  if (typeof node === 'string') return escapeHtml(node);
  const children = node.children.map(mathNodeToHtml).join('');
  if (!MATHML_TAGS.has(node.tag)) return children;
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([name]) => MATHML_ATTRS.has(name))
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  return `<${node.tag}${attrs}>${children}</${node.tag}>`;
}

export interface HtmlOptions {
  /** Maps an image ref to a URL the page can load (app:// in the UI, data: URIs in PDFs). */
  imageUrl: (ref: string) => string;
  /** Renders LaTeX to MathML; injected so core stays free of a KaTeX dependency. */
  renderLatex?: (latex: string, display: boolean) => string;
  /** Show low-confidence OCR words (review queue only). */
  showReviewMarks?: boolean;
}

export function toHtml(rich: RichText, options: HtmlOptions): string {
  return rich
    .map((inline) => {
      switch (inline.t) {
        case 'text': {
          let html = escapeHtml(inline.text);
          if (inline.sub) html = `<sub>${html}</sub>`;
          if (inline.sup) html = `<sup>${html}</sup>`;
          if (inline.u) html = `<u>${html}</u>`;
          if (inline.i) html = `<em>${html}</em>`;
          if (inline.b) html = `<strong>${html}</strong>`;
          if (options.showReviewMarks && inline.low) html = `<mark class="ocr-low">${html}</mark>`;
          return html;
        }
        case 'br':
          return '<br>';
        case 'img': {
          const size = [
            inline.w ? ` width="${Math.round(inline.w)}"` : '',
            inline.h ? ` height="${Math.round(inline.h)}"` : '',
          ].join('');
          return `<img class="q-img" src="${escapeHtml(options.imageUrl(inline.ref))}" alt="${escapeHtml(inline.alt ?? 'Diagram')}"${size}>`;
        }
        case 'math': {
          if (inline.mathml) return mathNodeToHtml(inline.mathml);
          if (inline.latex && options.renderLatex)
            return options.renderLatex(inline.latex, !!inline.display);
          return `<code>${escapeHtml(inline.latex ?? '')}</code>`;
        }
        case 'table':
          return `<table class="q-table">${inline.rows
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${toHtml(cell, options)}</td>`).join('')}</tr>`,
            )
            .join('')}</table>`;
      }
    })
    .join('');
}

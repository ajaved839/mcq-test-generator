import { escapeHtml, toHtml, toPlainText, type HtmlOptions, type RichText } from '../core/richtext';
import type { PaperVersion } from '../core/shuffle';
import type { BankQuestion } from '../core/types';

/**
 * One HTML template drives both the on-screen preview and the PDF (FR-12), so what staff see
 * is what prints. All question content goes through `toHtml`, which escapes every string.
 */

export interface PaperHeader {
  instituteName: string;
  instituteAddress: string;
  logoUrl: string | null;
  title: string;
  code: string;
  date: string;
  durationMinutes: number;
  instructions: string;
  showTestCode: boolean;
  fontSizePt: number;
  confidentialFooter: boolean;
}

export interface PaperBuildInput {
  header: PaperHeader;
  version: PaperVersion;
  /** Number of versions in the set; the version letter is printed when more than one. */
  versionCount: number;
  questions: ReadonlyMap<string, BankQuestion>;
  groupBySubject: boolean;
  /** Base URL for fonts (app://bundle/fonts in the app). */
  fontBase: string;
  html: HtmlOptions;
}

const LETTERS = 'ABCDE';

export function paperCss(fontBase: string, fontSizePt: number): string {
  return `
@font-face { font-family: 'STIX Two Text'; src: url('${fontBase}/stix-two-text-400-normal.woff2') format('woff2'); font-weight: 400; font-style: normal; }
@font-face { font-family: 'STIX Two Text'; src: url('${fontBase}/stix-two-text-400-italic.woff2') format('woff2'); font-weight: 400; font-style: italic; }
@font-face { font-family: 'STIX Two Text'; src: url('${fontBase}/stix-two-text-700-normal.woff2') format('woff2'); font-weight: 700; font-style: normal; }
@font-face { font-family: 'STIX Two Text'; src: url('${fontBase}/stix-two-text-700-italic.woff2') format('woff2'); font-weight: 700; font-style: italic; }
@font-face { font-family: 'STIX Two Math'; src: url('${fontBase}/stix-two-math.woff') format('woff'); }
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: 'STIX Two Text', 'STIX Two Math', 'Times New Roman', serif; font-size: ${fontSizePt}pt; line-height: 1.35; color: #000; background: #fff; }
math { font-family: 'STIX Two Math', math; font-size: 1.05em; }
.paper { max-width: 180mm; margin: 0 auto; }
.head { display: grid; grid-template-columns: auto 1fr auto; gap: 4mm; align-items: center; border-bottom: 1.2pt solid #000; padding-bottom: 3mm; }
.head img.logo { max-height: 20mm; max-width: 30mm; object-fit: contain; }
.head .inst { text-align: center; }
.head .inst h1 { font-size: 1.45em; margin: 0; letter-spacing: 0.02em; }
.head .inst .addr { font-size: 0.85em; }
.head .inst h2 { font-size: 1.15em; margin: 1.5mm 0 0; font-weight: 700; }
.head .meta { text-align: right; font-size: 0.9em; white-space: nowrap; }
.version-badge { display: inline-block; border: 1.2pt solid #000; padding: 0.5mm 2.5mm; font-weight: 700; font-size: 1.2em; margin-bottom: 1mm; }
.facts { display: flex; justify-content: space-between; margin: 2.5mm 0; font-size: 0.95em; }
.candidate { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; margin: 2mm 0 3mm; font-size: 0.95em; }
.candidate span { display: block; border-bottom: 0.6pt solid #000; height: 6mm; }
.instructions { border: 0.6pt solid #000; padding: 2mm 3mm; margin-bottom: 4mm; font-size: 0.92em; white-space: pre-line; }
.section { font-weight: 700; font-size: 1.05em; margin: 4mm 0 2mm; border-bottom: 0.6pt solid #000; padding-bottom: 0.5mm; break-after: avoid; }
ol.questions { margin: 0; padding: 0; list-style: none; }
li.q { display: grid; grid-template-columns: 9mm 1fr; margin-bottom: 3.2mm; break-inside: avoid; }
li.q .num { font-weight: 700; }
.stem { margin-bottom: 1.2mm; }
.options { display: grid; grid-template-columns: 1fr; gap: 0.8mm 6mm; }
.options.two { grid-template-columns: 1fr 1fr; }
.options.four { grid-template-columns: repeat(4, 1fr); }
.opt { display: grid; grid-template-columns: 6mm 1fr; }
.opt .l { font-weight: 700; }
img.q-img { max-width: 100%; max-height: 70mm; vertical-align: middle; }
table.q-table { border-collapse: collapse; margin: 1mm 0; }
table.q-table td { border: 0.5pt solid #000; padding: 0.6mm 2mm; vertical-align: top; }
.end { text-align: center; margin-top: 6mm; font-weight: 700; letter-spacing: 0.1em; }
.key h2 { margin: 0 0 2mm; }
.key table { border-collapse: collapse; width: 100%; margin-bottom: 6mm; }
.key td, .key th { border: 0.6pt solid #000; padding: 1mm 2mm; text-align: center; font-size: 0.95em; }
.confidential { text-align: center; font-weight: 700; letter-spacing: 0.15em; border: 1.2pt solid #000; padding: 1.5mm; margin-bottom: 3mm; }
@media screen { body { background: #e9ecef; padding: 12px 0; } .paper { background: #fff; padding: 16mm 15mm; box-shadow: 0 1px 4px rgba(0,0,0,.2); } }
`;
}

function optionLayout(options: RichText[]): '' | 'two' | 'four' {
  const plainLengths = options.map((o) => toPlainText(o).length);
  const hasBlock = options.some((o) =>
    o.some((i) => i.t === 'img' || i.t === 'table' || i.t === 'br'),
  );
  if (hasBlock) return '';
  const longest = Math.max(...plainLengths);
  if (longest <= 14 && options.length === 4) return 'four';
  if (longest <= 38) return 'two';
  return '';
}

export function headerHtml(h: PaperHeader, versionLetter: string | null): string {
  const logo = h.logoUrl
    ? `<img class="logo" src="${escapeHtml(h.logoUrl)}" alt="Institute logo">`
    : '<span></span>';
  const badge = versionLetter
    ? `<div class="version-badge">Version ${escapeHtml(versionLetter)}</div>`
    : '';
  const code =
    h.showTestCode && h.code ? `<div>Test code: <strong>${escapeHtml(h.code)}</strong></div>` : '';
  return `<header class="head">
  ${logo}
  <div class="inst">
    <h1>${escapeHtml(h.instituteName)}</h1>
    ${h.instituteAddress ? `<div class="addr">${escapeHtml(h.instituteAddress)}</div>` : ''}
    <h2>${escapeHtml(h.title)}</h2>
  </div>
  <div class="meta">${badge}${code}<div>${escapeHtml(h.date)}</div></div>
</header>`;
}

export function buildPaperBody(input: PaperBuildInput): string {
  const { header: h, version, questions } = input;
  const letter = input.versionCount > 1 ? version.letter : null;
  const parts: string[] = [];
  parts.push(headerHtml(h, letter));
  parts.push(
    `<div class="facts"><span>Questions: <strong>${version.questions.length}</strong></span><span>Time: <strong>${h.durationMinutes} minutes</strong></span><span>Marks: <strong>${version.questions.length}</strong></span></div>`,
  );
  parts.push(
    '<div class="candidate"><label>Name<span></span></label><label>Roll number<span></span></label></div>',
  );
  if (h.instructions.trim())
    parts.push(
      `<div class="instructions"><strong>Instructions.</strong> ${escapeHtml(h.instructions)}</div>`,
    );

  let currentSubject: string | null = null;
  let open = false;
  version.questions.forEach((vq, index) => {
    const q = questions.get(vq.questionId);
    if (!q) throw new Error('A question snapshot is missing from the test.');
    if (input.groupBySubject && q.subject !== currentSubject) {
      if (open) parts.push('</ol>');
      parts.push(`<div class="section">${escapeHtml(q.subject)}</div><ol class="questions">`);
      currentSubject = q.subject;
      open = true;
    } else if (!open) {
      parts.push('<ol class="questions">');
      open = true;
    }
    const shown = vq.optionOrder.map((i) => q.options[i]);
    const layout = optionLayout(shown);
    const options = shown
      .map(
        (o, pos) =>
          `<div class="opt"><span class="l">${LETTERS[pos]}.</span><span>${toHtml(o, input.html)}</span></div>`,
      )
      .join('');
    parts.push(
      `<li class="q"><span class="num">${index + 1}.</span><div><div class="stem">${toHtml(q.stem, input.html)}</div><div class="options ${layout}">${options}</div></div></li>`,
    );
  });
  if (open) parts.push('</ol>');
  parts.push('<div class="end">END OF PAPER</div>');
  return `<main class="paper">${parts.join('\n')}</main>`;
}

export function wrapDocument(title: string, css: string, body: string, csp: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<title>${escapeHtml(title)}</title><style>${css}</style></head>
<body>${body}</body></html>`;
}

export const PRINT_CSP =
  "default-src 'none'; img-src app: data:; font-src app: data:; style-src 'unsafe-inline'";

export function buildPaperHtml(input: PaperBuildInput): string {
  return wrapDocument(
    `${input.header.title}${input.versionCount > 1 ? ` - Version ${input.version.letter}` : ''}`,
    paperCss(input.fontBase, input.header.fontSizePt),
    buildPaperBody(input),
    PRINT_CSP,
  );
}

export interface KeyBuildInput {
  header: PaperHeader;
  versions: PaperVersion[];
  questions: ReadonlyMap<string, BankQuestion>;
  fontBase: string;
  html: HtmlOptions;
  includeExplanations: boolean;
}

/** Answer key for every version, marked confidential, in a separate file from the paper. */
export function buildKeyHtml(input: KeyBuildInput): string {
  const { header: h } = input;
  const sections = input.versions.map((v) => {
    const rows: string[] = [];
    const perRow = 10;
    for (let start = 0; start < v.questions.length; start += perRow) {
      const slice = v.questions.slice(start, start + perRow);
      rows.push(`<tr>${slice.map((_, i) => `<th>${start + i + 1}</th>`).join('')}</tr>`);
      rows.push(
        `<tr>${slice.map((q) => `<td><strong>${q.correctLetter}</strong></td>`).join('')}</tr>`,
      );
    }
    const explanations = input.includeExplanations
      ? v.questions
          .map((vq, i) => {
            const q = input.questions.get(vq.questionId);
            return q && q.explanation.length
              ? `<p><strong>${i + 1}.</strong> ${toHtml(q.explanation, input.html)}</p>`
              : '';
          })
          .join('')
      : '';
    return `<section class="key"><h2>${input.versions.length > 1 ? `Version ${v.letter}` : 'Answers'}</h2><table>${rows.join('')}</table>${explanations}</section>`;
  });
  const body = `<main class="paper"><div class="confidential">CONFIDENTIAL: ANSWER KEY</div>${headerHtml(h, null)}<div class="facts"><span>Questions: <strong>${input.versions[0]?.questions.length ?? 0}</strong></span><span>Versions: <strong>${input.versions.map((v) => v.letter).join(', ')}</strong></span></div>${sections.join('')}</main>`;
  return wrapDocument(
    `${h.title} - Answer key`,
    paperCss(input.fontBase, h.fontSizePt),
    body,
    PRINT_CSP,
  );
}

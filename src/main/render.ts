import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import katex from 'katex';
import { mathNodeToHtml, type Inline } from '../core/richtext';
import type { ImageSource } from './export/word';

/**
 * Off-screen rendering in Chromium: PDFs via printToPDF (accurate A4 output on both Windows and
 * Mac) and equation images for Word exports. Pages are served from memory through
 * app://print/<token>; the windows have no preload, no Node and a CSP that blocks scripts.
 */

export const printPages = new Map<string, string>();

export function renderLatex(latex: string, display: boolean): string {
  return katex.renderToString(latex, {
    output: 'mathml',
    throwOnError: false,
    displayMode: display,
    trust: false,
    strict: 'ignore',
  });
}

function hiddenWindow(offscreen = false): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen,
      // Needed only so the main process can wait for fonts; page scripts are still blocked by CSP.
      javascript: true,
      spellcheck: false,
    },
  });
}

export interface PdfFooter {
  left: string;
  right: string;
  confidential: boolean;
}

const escape = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function htmlToPdf(html: string, footer: PdfFooter): Promise<Buffer> {
  const token = randomUUID();
  printPages.set(token, html);
  const win = hiddenWindow();
  try {
    await win.loadURL(`app://print/${token}`);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true);
    const footerHtml = `<div style="font-family: serif; font-size: 8pt; width: 100%; padding: 0 12mm; display: flex; justify-content: space-between;">
      <span>${escape(footer.left)}</span>
      <span>${footer.confidential ? 'CONFIDENTIAL · ' : ''}Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      <span>${escape(footer.right)}</span></div>`;
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footerHtml,
      preferCSSPageSize: true,
    });
  } finally {
    printPages.delete(token);
    win.destroy();
  }
}

/** Renders each equation to a PNG at 2x for crisp Word output. */
export async function mathToImages(
  inlines: Array<Extract<Inline, { t: 'math' }>>,
  fontBase: string,
): Promise<Array<ImageSource | null>> {
  if (!inlines.length) return [];
  const token = randomUUID();
  printPages.set(
    token,
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src app:; style-src 'unsafe-inline'">
    <style>@font-face{font-family:'STIX Two Math';src:url('${fontBase}/stix-two-math.woff') format('woff')}
    body{margin:0;background:#fff} #m{display:inline-block;padding:4px 6px;font-size:36px;font-family:'STIX Two Math',math;color:#000}</style>
    </head><body><span id="m"></span></body></html>`,
  );
  const win = hiddenWindow(true);
  const out: Array<ImageSource | null> = [];
  try {
    await win.loadURL(`app://print/${token}`);
    for (const inline of inlines) {
      const markup = inline.mathml
        ? mathNodeToHtml(inline.mathml)
        : inline.latex
          ? renderLatex(inline.latex, !!inline.display)
          : '';
      if (!markup) {
        out.push(null);
        continue;
      }
      const rect = (await win.webContents.executeJavaScript(
        `(() => { const m = document.getElementById('m'); m.innerHTML = ${JSON.stringify(markup)};
          return document.fonts.ready.then(() => { const r = m.getBoundingClientRect();
          return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; }); })()`,
        true,
      )) as { x: number; y: number; width: number; height: number };
      if (!rect.width || !rect.height) {
        out.push(null);
        continue;
      }
      const image = await win.webContents.capturePage(rect);
      const size = image.getSize();
      // Rendered at 36px; Word shows it at roughly body size.
      out.push({
        bytes: image.toPNG(),
        mime: 'image/png',
        width: Math.round(size.width / 2.6),
        height: Math.round(size.height / 2.6),
      });
    }
    return out;
  } finally {
    printPages.delete(token);
    win.destroy();
  }
}

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * PDF pages to PNG images for OCR, rendered locally with pdf.js. The worker is bundled with
 * the app, so nothing is downloaded.
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const TARGET_DPI = 300;
const MAX_WIDTH = 3000;

export interface RenderedPage {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
  previewUrl: string;
}

export async function pdfToImages(
  file: File,
  onPage?: (done: number, total: number) => void,
): Promise<RenderedPage[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const pages: RenderedPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(TARGET_DPI / 72, MAX_WIDTH / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This computer could not render the PDF page.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Rendering failed.'))),
          'image/png',
        ),
      );
      pages.push({
        fileName: `${file.name} page ${n}.png`,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        previewUrl: URL.createObjectURL(blob),
      });
      page.cleanup();
      onPage?.(n, doc.numPages);
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

/** Crops a region of a stored page image into PNG bytes for attaching as a diagram. */
export async function cropImage(
  src: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<{ bytes: Uint8Array<ArrayBuffer>; width: number; height: number }> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Crop failed.'))), 'image/png'),
  );
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
}

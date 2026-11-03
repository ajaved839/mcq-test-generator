import { Box } from '@mantine/core';
import { useEffect, useRef } from 'react';

/**
 * Shows the exact HTML used for the PDF inside a shadow root, so paper styles never leak into
 * the app and app styles never change the paper. The body comes from the shared paper template,
 * whose content is escaped by the core serializer.
 */
export function PaperPreview({ css, body, label }: { css: string; body: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    // @font-face and @page do not apply inside a shadow root; fonts are declared globally.
    const scoped = css
      .replace(/@font-face\s*{[^}]*}/g, '')
      .replace(/@page\s*{[^}]*}/g, '')
      .replace(/\bbody\b/g, ':host');
    root.innerHTML = `<style>:host{display:block;background:#e9ecef;padding:12px;border-radius:8px;color:#000} ${scoped} .paper{background:#fff;padding:16mm 15mm;box-shadow:0 1px 4px rgba(0,0,0,.2);margin:0 auto 16px}</style>${body}`;
  }, [css, body]);
  return <Box ref={host} role="document" aria-label={label} className="paper-preview" />;
}

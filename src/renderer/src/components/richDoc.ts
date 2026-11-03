import type { JSONContent } from '@tiptap/react';
import {
  mergeText,
  trimRich,
  type Inline,
  type RichText,
  type TextInline,
} from '../../../core/richtext';

/**
 * Converts between the editor's ProseMirror JSON and the app's RichText tokens. Images,
 * equations and tables travel as one "richAtom" node holding the original token, so editing
 * text around them never changes them.
 */

const MARKS: Array<[keyof TextInline, string]> = [
  ['b', 'bold'],
  ['i', 'italic'],
  ['u', 'underline'],
  ['sub', 'subscript'],
  ['sup', 'superscript'],
];

export function richToDoc(rich: RichText): JSONContent {
  const paragraphs: JSONContent[][] = [[]];
  for (const inline of rich) {
    const current = paragraphs[paragraphs.length - 1];
    if (inline.t === 'br') {
      paragraphs.push([]);
    } else if (inline.t === 'text') {
      if (!inline.text) continue;
      const marks = MARKS.filter(([key]) => inline[key]).map(([, type]) => ({ type }));
      current.push({ type: 'text', text: inline.text, ...(marks.length ? { marks } : {}) });
    } else {
      current.push({ type: 'richAtom', attrs: { data: JSON.stringify(inline) } });
    }
  }
  return {
    type: 'doc',
    content: paragraphs.map((content) => ({
      type: 'paragraph',
      ...(content.length ? { content } : {}),
    })),
  };
}

function inlineFromNode(node: JSONContent): Inline[] {
  if (node.type === 'text') {
    const marks = new Set((node.marks ?? []).map((m) => m.type));
    const t: TextInline = { t: 'text', text: node.text ?? '' };
    for (const [key, type] of MARKS)
      if (marks.has(type)) (t as unknown as Record<string, boolean>)[key] = true;
    return [t];
  }
  if (node.type === 'hardBreak') return [{ t: 'br' }];
  if (node.type === 'richAtom') {
    try {
      return [JSON.parse(String(node.attrs?.data)) as Inline];
    } catch {
      return [];
    }
  }
  return (node.content ?? []).flatMap(inlineFromNode);
}

export function docToRich(doc: JSONContent): RichText {
  const out: RichText = [];
  (doc.content ?? []).forEach((block, index) => {
    if (index > 0) out.push({ t: 'br' });
    out.push(...(block.content ?? []).flatMap(inlineFromNode));
  });
  return trimRich(mergeText(out));
}

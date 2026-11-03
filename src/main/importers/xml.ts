import { DOMParser, type Element, type Node } from '@xmldom/xmldom';

/** Small helpers over @xmldom/xmldom for walking Office Open XML by local name. */

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const;

export function parseXml(xml: string): Element {
  // Office XML never needs DTDs; xmldom does not fetch external entities.
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, 'application/xml');
  if (!doc.documentElement) throw new Error('The file contains invalid XML.');
  return doc.documentElement;
}

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

export function children(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === ELEMENT_NODE) out.push(c as Element);
  }
  return out;
}

export function isEl(node: Element, ns: string, local: string): boolean {
  return node.namespaceURI === ns && node.localName === local;
}

export function child(node: Element, ns: string, local: string): Element | null {
  return children(node).find((c) => isEl(c, ns, local)) ?? null;
}

export function childrenNamed(node: Element, ns: string, local: string): Element[] {
  return children(node).filter((c) => isEl(c, ns, local));
}

/** First descendant in document order. */
export function descendant(node: Element, ns: string, local: string): Element | null {
  for (const c of children(node)) {
    if (isEl(c, ns, local)) return c;
    const found = descendant(c, ns, local);
    if (found) return found;
  }
  return null;
}

export function attr(node: Element | null, ns: string, local: string): string | null {
  if (!node) return null;
  const value = node.getAttributeNS(ns, local);
  return value === '' && !node.hasAttributeNS(ns, local) ? null : value;
}

export function textContent(node: Node): string {
  return node.textContent ?? '';
}

/** OOXML on/off properties: <w:b/> is on, <w:b w:val="0"/> or "false" is off. */
export function isOn(prop: Element | null, ns: string = NS.w): boolean {
  if (!prop) return false;
  const val = attr(prop, ns, 'val');
  return val === null || !['0', 'false', 'off', 'none'].includes(val.toLowerCase());
}

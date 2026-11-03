import type { RichText } from './richtext';
import { toPlainText } from './richtext';

/**
 * Duplicate detection (FR-5).
 *
 * Wording is normalized (case, spacing, punctuation, option order) before comparison. Exact
 * duplicates share a fingerprint and are blocked; close matches are scored with the Dice
 * coefficient over character bigrams and shown to staff above a tunable threshold (default 90%).
 * This protects the repeat rule: a retyped copy would otherwise count as a new question.
 */

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[^\p{L}\p{N}⁰-₟+\-=<>×÷√π∞°%^]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Comparable {
  stem: RichText;
  options: RichText[];
}

export function normalizedParts(q: Comparable): { stem: string; options: string[] } {
  return {
    stem: normalizeText(toPlainText(q.stem)),
    options: q.options.map((o) => normalizeText(toPlainText(o))).sort(),
  };
}

/** Same fingerprint = exact duplicate (option order ignored). */
export function fingerprint(q: Comparable): string {
  const parts = normalizedParts(q);
  return [parts.stem, ...parts.options].join(' || ');
}

/** Text used for similarity scoring: stem plus sorted options. */
export function comparableText(q: Comparable): string {
  const parts = normalizedParts(q);
  return [parts.stem, ...parts.options].join(' | ');
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  const padded = ` ${value} `;
  for (let i = 0; i < padded.length - 1; i++) {
    const gram = padded.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen-Dice similarity over character bigram multisets, 0 to 1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const count of ga.values()) sizeA += count;
  for (const count of gb.values()) sizeB += count;
  for (const [gram, count] of ga) overlap += Math.min(count, gb.get(gram) ?? 0);
  return (2 * overlap) / (sizeA + sizeB);
}

export interface SimilarMatch {
  id: string;
  score: number;
  exact: boolean;
}

interface Entry {
  id: string;
  text: string;
  fingerprint: string;
  tokens: Set<string>;
}

/**
 * In-memory index over the bank. An inverted index on words narrows candidates so a 1,000-row
 * import checks against a 10,000-question bank in well under a second.
 */
export class DuplicateIndex {
  private entries = new Map<string, Entry>();
  private byFingerprint = new Map<string, Set<string>>();
  private byToken = new Map<string, Set<string>>();

  get size(): number {
    return this.entries.size;
  }

  add(id: string, q: Comparable): void {
    this.remove(id);
    const text = comparableText(q);
    const entry: Entry = {
      id,
      text,
      fingerprint: fingerprint(q),
      tokens: new Set(text.split(/[ |]+/).filter(Boolean)),
    };
    this.entries.set(id, entry);
    if (!this.byFingerprint.has(entry.fingerprint))
      this.byFingerprint.set(entry.fingerprint, new Set());
    this.byFingerprint.get(entry.fingerprint)!.add(id);
    for (const token of entry.tokens) {
      if (!this.byToken.has(token)) this.byToken.set(token, new Set());
      this.byToken.get(token)!.add(id);
    }
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.byFingerprint.get(entry.fingerprint)?.delete(id);
    for (const token of entry.tokens) this.byToken.get(token)?.delete(id);
  }

  exactMatches(q: Comparable): string[] {
    return [...(this.byFingerprint.get(fingerprint(q)) ?? [])];
  }

  /** Matches at or above `threshold` (0 to 1), best first. Exact duplicates score 1. */
  findSimilar(q: Comparable, threshold: number, limit = 5): SimilarMatch[] {
    const fp = fingerprint(q);
    const text = comparableText(q);
    const tokens = [...new Set(text.split(/[ |]+/).filter(Boolean))];
    const results: SimilarMatch[] = [];
    const seen = new Set<string>();

    for (const id of this.byFingerprint.get(fp) ?? []) {
      seen.add(id);
      results.push({ id, score: 1, exact: true });
    }

    // Count shared tokens; skip very common words when rarer ones exist.
    const total = Math.max(1, this.entries.size);
    const informative = tokens.filter((t) => (this.byToken.get(t)?.size ?? 0) / total < 0.2);
    const probe = informative.length >= 2 ? informative : tokens;
    const shared = new Map<string, number>();
    for (const token of probe) {
      for (const id of this.byToken.get(token) ?? []) shared.set(id, (shared.get(id) ?? 0) + 1);
    }
    // A 90% bigram match keeps most words; require a third of probe words in common.
    const minShared = Math.max(1, Math.floor(probe.length / 3));
    for (const [id, count] of shared) {
      if (seen.has(id) || count < minShared) continue;
      const entry = this.entries.get(id)!;
      // Dice cannot exceed 2*min/(a+b) over lengths; cheap upper bound before the real score.
      const lenA = text.length + 1;
      const lenB = entry.text.length + 1;
      if ((2 * Math.min(lenA, lenB)) / (lenA + lenB) < threshold) continue;
      const score = similarity(text, entry.text);
      if (score >= threshold) results.push({ id, score, exact: entry.fingerprint === fp });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

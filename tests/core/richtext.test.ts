import { describe, expect, it } from 'vitest';
import {
  imageRefs,
  isEntirely,
  joinRich,
  mathNodeToHtml,
  sliceRich,
  stripReviewMarks,
  text,
  toHtml,
  toOffsetText,
  toPlainText,
  trimRich,
  type RichText,
} from '../../src/core/richtext';
import { subjectCapacity } from '../../src/core/capacity';
import { syntheticGeneratorBank } from '../helpers/synthetic';

const opts = { imageUrl: (ref: string) => `app://image/${ref}` };

describe('rich text', () => {
  it('escapes all text so imported content can never become markup', () => {
    const html = toHtml(
      [text('<script>alert(1)</script>'), text('" onload="x', { b: true })],
      opts,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>&quot; onload=&quot;x</strong>');
  });

  it('renders formatting, images, tables and math', () => {
    const rich: RichText = [
      text('H'),
      text('2', { sub: true }),
      text('O', { i: true, u: true }),
      { t: 'br' },
      { t: 'img', ref: 'abc', w: 100.4 },
      { t: 'table', rows: [[[text('a')], [text('b')]]] },
      { t: 'math', mathml: { tag: 'math', children: [{ tag: 'mi', children: ['x'] }] } },
      { t: 'math', latex: 'x^2' },
    ];
    const html = toHtml(rich, { ...opts, renderLatex: (l) => `<math data-l="${l}"></math>` });
    expect(html).toContain('<sub>2</sub>');
    expect(html).toContain('<em><u>O</u></em>');
    expect(html).toContain('src="app://image/abc"');
    expect(html).toContain('width="100"');
    expect(html).toContain('<table class="q-table"><tr><td>a</td><td>b</td></tr></table>');
    expect(html).toContain('<math><mi>x</mi></math>');
    expect(html).toContain('data-l="x^2"');
    expect(toHtml([{ t: 'math', latex: '<b>' }], opts)).toBe('<code>&lt;b&gt;</code>');
  });

  it('drops MathML tags and attributes outside the allowlist', () => {
    const html = mathNodeToHtml({
      tag: 'math',
      attrs: { onclick: 'bad', display: 'block' },
      children: [
        { tag: 'script', children: ['x'] },
        { tag: 'mi', attrs: { href: 'y' }, children: ['<'] },
      ],
    });
    expect(html).toBe('<math display="block">x<mi>&lt;</mi></math>');
  });

  it('slices by offsets that include objects', () => {
    const rich: RichText = [text('ab'), { t: 'img', ref: 'r' }, text('cd', { b: true })];
    expect(toOffsetText(rich)).toBe('ab￼cd');
    expect(sliceRich(rich, 1, 4)).toEqual([
      text('b'),
      { t: 'img', ref: 'r' },
      text('c', { b: true }),
    ]);
    expect(imageRefs(rich)).toEqual(['r']);
  });

  it('trims, joins and strips review marks', () => {
    expect(trimRich([{ t: 'br' }, text('  hi '), text(' ', {}), { t: 'br' }])).toEqual([
      text('hi'),
    ]);
    expect(joinRich([[text('a')], [], [text('b')]])).toEqual([text('a'), { t: 'br' }, text('b')]);
    expect(stripReviewMarks([text('x', { low: true, hl: true, b: true })])).toEqual([
      text('x', { b: true }),
    ]);
    expect(isEntirely([text('x', { b: true }), text(' ')], 'b')).toBe(true);
    expect(toPlainText([{ t: 'img', ref: '0123456789abcdef' }])).toBe('[image:0123456789ab]');
  });

  it('marks low-confidence OCR words only in review', () => {
    const rich = [text('word', { low: true })];
    expect(toHtml(rich, opts)).toBe('word');
    expect(toHtml(rich, { ...opts, showReviewMarks: true })).toBe(
      '<mark class="ocr-low">word</mark>',
    );
  });
});

describe('capacity', () => {
  it('reports fresh counts and papers left at the recent share', () => {
    const bank = syntheticGeneratorBank(100, 1, ['Biology', 'Physics']);
    const used = bank
      .filter((q) => q.subject === 'Biology')
      .slice(0, 10)
      .map((q) => q.id);
    const caps = subjectCapacity(bank, [
      { id: 't', title: 't', createdAt: '2026-01-01', kind: 'generated', questionIds: used },
    ]);
    const bio = caps.find((c) => c.subject === 'Biology')!;
    expect(bio.active).toBe(50);
    expect(bio.fresh).toBe(40);
    expect(bio.recentShare).toBe(10);
    expect(bio.freshPapersLeft).toBe(4);
    expect(bio.recommendedPool).toBe(70);
    expect(bio.status).toBe('low');
    expect(caps.find((c) => c.subject === 'Physics')!.status).toBe('unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { DuplicateIndex, fingerprint, normalizeText, similarity } from '../../src/core/duplicates';
import { plain } from '../../src/core/richtext';

const mcq = (stem: string, options: string[]) => ({
  stem: plain(stem),
  options: options.map(plain),
});

describe('normalization', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(normalizeText('  Which  ORGANELLE, is it?? ')).toBe('which organelle is it');
    expect(normalizeText('“Quoted” – text')).toBe('quoted text');
  });

  it('fingerprints ignore option order', () => {
    const a = mcq('What is H2O?', ['Water', 'Salt', 'Sugar']);
    const b = mcq('what is h2o', ['Sugar', 'water', 'Salt.']);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe('similarity', () => {
  it('scores identical text 1 and unrelated text low', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
    expect(similarity('the mitochondrion makes atp', 'photosynthesis in leaves')).toBeLessThan(0.4);
  });

  it('scores a retyped copy with a typo above 90%', () => {
    expect(
      similarity(
        'which organelle is the main site of atp synthesis | golgi body | lysosome | mitochondrion | ribosome',
        'which organelle is the main site of atp synthesis | golgi body | lysosome | mitochondrian | ribosome',
      ),
    ).toBeGreaterThan(0.9);
  });
});

describe('DuplicateIndex', () => {
  it('finds exact and close matches and supports removal', () => {
    const index = new DuplicateIndex();
    index.add(
      'q1',
      mcq('Which organelle is the main site of ATP synthesis?', [
        'Ribosome',
        'Mitochondrion',
        'Golgi body',
        'Lysosome',
      ]),
    );
    index.add('q2', mcq('What is the capital of France?', ['Paris', 'Rome', 'Madrid', 'Berlin']));
    expect(index.size).toBe(2);

    const exact = mcq('which organelle is the main site of atp synthesis', [
      'Lysosome',
      'Golgi body',
      'Mitochondrion',
      'Ribosome',
    ]);
    expect(index.exactMatches(exact)).toEqual(['q1']);
    expect(index.findSimilar(exact, 0.9)[0]).toMatchObject({ id: 'q1', exact: true, score: 1 });

    const close = mcq('Which organelle is the main site of ATP synthesis?', [
      'Ribosome',
      'Mitochondrian',
      'Golgi body',
      'Lysosome',
    ]);
    const found = index.findSimilar(close, 0.9);
    expect(found[0].id).toBe('q1');
    expect(found[0].exact).toBe(false);

    expect(index.findSimilar(mcq('Name a prime number', ['4', '6', '7', '8']), 0.9)).toEqual([]);
    index.remove('q1');
    expect(index.findSimilar(close, 0.9)).toEqual([]);
  });

  it('checks 1,000 imports against 10,000 questions quickly', () => {
    const index = new DuplicateIndex();
    for (let i = 0; i < 10_000; i++) {
      index.add(
        `q${i}`,
        mcq(`Synthetic question ${i} about concept ${i * 7} and value ${i % 97}?`, [
          `Alpha ${i}`,
          `Beta ${i}`,
          `Gamma ${i}`,
          `Delta ${i}`,
        ]),
      );
    }
    const started = performance.now();
    let hits = 0;
    for (let i = 0; i < 1000; i++) {
      if (
        index.findSimilar(
          mcq(`Synthetic question ${i} about concept ${i * 7} and value ${i % 97}?`, [
            `Alpha ${i}`,
            `Beta ${i}`,
            `Gamma ${i}`,
            `Delta ${i}`,
          ]),
          0.9,
        ).length
      )
        hits++;
    }
    expect(hits).toBe(1000);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

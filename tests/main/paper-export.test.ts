import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildVersions } from '../../src/core/shuffle';
import { buildPaperDocx } from '../../src/main/export/word';
import { buildPaperHtml, type PaperHeader } from '../../src/shared/paper';
import { syntheticBankQuestion } from '../helpers/synthetic';

const header: PaperHeader = {
  instituteName: 'Synthetic Institute',
  instituteAddress: '',
  logoUrl: null,
  title: 'Practice Test',
  code: 'T-1',
  date: '2026-01-01',
  durationMinutes: 30,
  instructions: '',
  showTestCode: false,
  fontSizePt: 11,
  confidentialFooter: false,
};
const bank = Array.from({ length: 12 }, (_, i) => syntheticBankQuestion(i));
const questions = new Map(bank.map((q) => [q.id, q]));
const [version] = buildVersions(bank, { versions: 1, seed: 7 });
const letters = version.questions.map((q) => q.correctLetter);

describe('answer key at the end of the paper', () => {
  const html = (answerKeyAtEnd: boolean): string =>
    buildPaperHtml({
      header,
      version,
      versionCount: 1,
      questions,
      groupBySubject: false,
      fontBase: 'app://bundle/fonts',
      html: { imageUrl: (ref) => ref },
      answerKeyAtEnd,
    });

  it('adds the shuffled letters after the questions in the PDF paper', () => {
    const page = html(true);
    const key = page.slice(page.indexOf('END OF PAPER'));
    expect(key).toContain('Answer key');
    expect([...key.matchAll(/<td><strong>([A-E])<\/strong><\/td>/g)].map((m) => m[1])).toEqual(
      letters,
    );
    expect(html(false)).not.toContain('Answer key');
  });

  it('adds the same letters to the Word paper', async () => {
    const build = async (answerKeyAtEnd: boolean): Promise<string> => {
      const bytes = await buildPaperDocx(
        {
          header,
          version,
          versionCount: 1,
          questions,
          groupBySubject: false,
          logo: null,
          answerKeyAtEnd,
        },
        { image: () => null, math: async () => null },
      );
      return (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
    };
    const xml = await build(true);
    // Start at the paragraph holding the heading, which also holds the page break.
    const key = xml.slice(xml.lastIndexOf('<w:p>', xml.indexOf('Answer key')));
    expect(key).toContain('w:type="page"');
    const cells = [...key.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
    expect(cells.filter((c) => /^[A-E]$/.test(c))).toEqual(letters);
    expect(await build(false)).not.toContain('Answer key');
  });
});

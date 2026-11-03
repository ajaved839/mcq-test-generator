import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';

/**
 * Reads Excel (.xlsx) and CSV files into plain rows. Validation and mapping happen in the core
 * engine (src/core/tabular.ts) so they are tested without file I/O.
 */

export interface SheetRows {
  name: string;
  rows: unknown[][];
}

function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  // Excel on Windows often saves CSV as Windows-1252; fall back when UTF-8 decoding failed.
  if (utf8.includes('�')) {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

export async function readTable(fileName: string, bytes: Uint8Array): Promise<SheetRows[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const parsed = Papa.parse<string[]>(decodeText(bytes), { skipEmptyLines: 'greedy' });
    if (parsed.errors.length && !parsed.data.length) {
      throw new Error(`The CSV file could not be read: ${parsed.errors[0].message}`);
    }
    return [{ name: 'CSV', rows: parsed.data }];
  }
  if (lower.endsWith('.xlsx')) {
    try {
      const sheets = await readXlsxFile(Buffer.from(bytes));
      return sheets.map((s) => ({ name: s.sheet, rows: s.data as unknown[][] }));
    } catch {
      throw new Error(
        'The Excel file could not be read. Save it as .xlsx (Excel Workbook) and try again.',
      );
    }
  }
  if (lower.endsWith('.xls')) {
    throw new Error(
      'Old .xls files are not supported. Open the file in Excel and save it as .xlsx.',
    );
  }
  throw new Error('Choose an .xlsx or .csv file.');
}

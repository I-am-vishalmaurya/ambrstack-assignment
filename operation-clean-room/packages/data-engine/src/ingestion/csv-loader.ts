import { readFile } from 'node:fs/promises';
import { parse, type Options as CSVParseOptions } from 'csv-parse/sync';

/**
 * Options for the generic CSV loader.
 */
export interface CSVOptions {
  /** CSV delimiter character. Defaults to ','. */
  delimiter?: string;
  /** Whether the first row contains column headers. Defaults to true. */
  headers?: boolean;
  /** Skip a fixed number of initial lines (before headers). Defaults to 0. */
  skipLines?: number;
  /** Strip the UTF-8 BOM if present. Defaults to true. */
  stripBOM?: boolean;
  /** Trim whitespace from each field. Defaults to true. */
  trim?: boolean;
  /**
   * Optional transform applied to every raw record before it is returned.
   * Useful for coercing string fields to numbers, dates, etc.
   */
  transform?: (record: Record<string, string>) => unknown;
}

/**
 * Load and parse a CSV file into a typed array of records.
 *
 * @typeParam T - The target record type.
 * @param filePath - Absolute or relative path to the CSV file.
 * @param options  - Parsing options (see {@link CSVOptions}).
 */
export async function loadCSV<T>(
  filePath: string,
  options: CSVOptions = {},
): Promise<T[]> {
  const {
    delimiter = ',',
    headers = true,
    skipLines = 0,
    stripBOM = true,
    trim = true,
    transform,
  } = options;

  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[csv-loader] Failed to read ${filePath}:`, msg);
    throw new Error(`Failed to read CSV file ${filePath}: ${msg}`);
  }

  const content = stripBOM && rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

  const parseOptions: CSVParseOptions = {
    delimiter,
    columns: headers,
    from_line: skipLines + 1,
    skip_empty_lines: true,
    relax_column_count: true,
    cast: false,
    trim,
  };

  let rows: Record<string, string>[];
  try {
    rows = parse(content, parseOptions) as Record<string, string>[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[csv-loader] Failed to parse ${filePath}:`, msg);
    throw new Error(`Failed to parse CSV file ${filePath}: ${msg}`);
  }

  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const transformed = transform ? transform(rows[i]!) : rows[i];
      out.push(transformed as T);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[csv-loader] Transform error at row ${i + 1} in ${filePath}:`, msg);
      throw new Error(`CSV transform error at row ${i + 1} in ${filePath}: ${msg}`);
    }
  }

  return out;
}

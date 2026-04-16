import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Load and parse a standard JSON file.
 *
 * The entire file is read into memory, so this is suitable for files that
 * fit comfortably in RAM (plan_pricing.json, chargebee_subscriptions.json,
 * etc.).  For large newline-delimited JSON use {@link loadJSONL} instead.
 *
 * @typeParam T - The expected shape of the parsed JSON.
 * @param filePath - Absolute or relative path to the JSON file.
 * @returns The parsed JSON value.
 */
export async function loadJSON<T>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[json-loader] Failed to read ${filePath}:`, msg);
    throw new Error(`Failed to read JSON file ${filePath}: ${msg}`);
  }

  // Strip UTF-8 BOM if present
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[json-loader] Failed to parse ${filePath}:`, msg);
    throw new Error(`Failed to parse JSON file ${filePath}: ${msg}`);
  }
}

/**
 * Load and parse a newline-delimited JSON (JSONL / NDJSON) file.
 *
 * Uses streaming via `readline` so that arbitrarily large files can be
 * processed without loading the entire contents into memory at once.
 * Each non-empty line is parsed as a standalone JSON object.
 *
 * @typeParam T - The expected shape of each JSON line record.
 * @param filePath - Absolute or relative path to the JSONL file.
 * @returns An array of parsed records.
 *
 * @example
 * ```ts
 * const events = await loadJSONL<ProductEvent>('data/product_events.jsonl');
 * ```
 */
export async function loadJSONL<T>(filePath: string): Promise<T[]> {
  const records: T[] = [];
  let lineNumber = 0;

  let rl: ReturnType<typeof createInterface>;
  try {
    rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[json-loader] Failed to open JSONL ${filePath}:`, msg);
    throw new Error(`Failed to open JSONL file ${filePath}: ${msg}`);
  }

  try {
    for await (const line of rl) {
      lineNumber++;

      // Skip empty lines and lines that are only whitespace
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      try {
        records.push(JSON.parse(trimmed) as T);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[json-loader] JSONL parse error at line ${lineNumber} in ${filePath}:`, msg);
        throw new Error(`Failed to parse JSONL at line ${lineNumber} in ${filePath}: ${msg}`);
      }
    }
  } finally {
    rl.close();
  }

  return records;
}

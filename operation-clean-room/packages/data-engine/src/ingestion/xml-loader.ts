import { readFile } from 'node:fs/promises';
import { XMLParser, type X2jOptions } from 'fast-xml-parser';

/**
 * Options for the generic XML loader.
 */
export interface XMLOptions {
  /**
   * Tag names whose content should always be parsed as an array, even if
   * only a single element is present. This prevents the common fast-xml-parser
   * gotcha where `<items><item>A</item></items>` produces a string instead
   * of a single-element array.
   */
  arrayTags?: string[];
  /** Whether to parse tag attributes. Defaults to true. */
  parseAttributes?: boolean;
  /** Prefix for attribute keys. Defaults to '' (no prefix). */
  attributePrefix?: string;
  /** Whether to trim text values. Defaults to true. */
  trimValues?: boolean;
  /**
   * Whether to attempt to parse numbers and booleans automatically.
   * Defaults to true.
   */
  parseNumbers?: boolean;
}

/**
 * Load and parse an XML file into a plain JavaScript object.
 *
 * Uses `fast-xml-parser` under the hood.  The caller is responsible for
 * asserting or validating the shape of the returned object (via Zod, manual
 * checks, etc.).
 *
 * @typeParam T - The expected shape of the parsed XML document.
 * @param filePath - Absolute or relative path to the XML file.
 * @param options  - Parsing options (see {@link XMLOptions}).
 * @returns The parsed XML as a plain object.
 *
 * @example
 * ```ts
 * interface InvoiceDoc { invoices: { invoice: LegacyInvoice[] } }
 * const doc = await loadXML<InvoiceDoc>('data/legacy_invoices.xml', {
 *   arrayTags: ['invoice'],
 * });
 * const invoices = doc.invoices.invoice;
 * ```
 */
export async function loadXML<T>(
  filePath: string,
  options: XMLOptions = {},
): Promise<T> {
  const {
    arrayTags = [],
    parseAttributes = true,
    attributePrefix = '',
    trimValues = true,
    parseNumbers = true,
  } = options;

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[xml-loader] Failed to read ${filePath}:`, msg);
    throw new Error(`Failed to read XML file ${filePath}: ${msg}`);
  }

  // Strip UTF-8 BOM if present
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const parserOptions: Partial<X2jOptions> = {
    ignoreAttributes: !parseAttributes,
    attributeNamePrefix: attributePrefix,
    trimValues,
    parseTagValue: parseNumbers,
    isArray: (_name: string, jpath: string) => {
      // If the terminal tag name matches any entry in arrayTags, force array.
      const tag = jpath.split('.').pop() ?? '';
      return arrayTags.includes(tag);
    },
  };

  const parser = new XMLParser(parserOptions);

  try {
    return parser.parse(content) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[xml-loader] Failed to parse ${filePath}:`, msg);
    throw new Error(`Failed to parse XML file ${filePath}: ${msg}`);
  }
}

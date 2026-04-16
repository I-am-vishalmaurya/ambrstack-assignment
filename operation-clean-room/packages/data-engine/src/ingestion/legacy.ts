import { join } from 'node:path';
import { z } from 'zod';
import { parseAmbiguousDate } from '../utils/date-parser.js';
import { DATA_FILES } from '../data/paths.js';
import { loadXML } from './xml-loader.js';
import type { LegacyInvoice } from './types.js';

const legacyStatusSchema = z.enum(['paid', 'unpaid', 'overdue', 'void', 'partially_paid']);

const rawInvoiceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  customer_name: z.string(),
  amount: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  currency: z.string(),
  date: z.string(),
  status: legacyStatusSchema,
  description: z.string().nullable().optional(),
  payment_ref: z.union([z.string(), z.number(), z.null(), z.undefined()]).optional(),
});

type LegacyInvoiceDoc = {
  invoices?: {
    invoice?: unknown | unknown[];
  };
};

function asInvoiceArray(raw: unknown | unknown[] | undefined): unknown[] {
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function emptyToNullPaymentRef(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/**
 * Load and normalize legacy billing system invoices from `legacy_invoices.xml`.
 */
export async function loadLegacyInvoices(dataDir: string): Promise<LegacyInvoice[]> {
  const filePath = join(dataDir, DATA_FILES.legacyInvoices);
  try {
    const doc = await loadXML<LegacyInvoiceDoc>(filePath, {
      arrayTags: ['invoice'],
      parseNumbers: true,
    });

    const rawInvoices = asInvoiceArray(doc.invoices?.invoice);
    const neighborDates = rawInvoices
      .map((inv) => {
        const r = rawInvoiceSchema.safeParse(inv);
        return r.success ? r.data.date : null;
      })
      .filter((d): d is string => d != null);

    const out: LegacyInvoice[] = [];
    for (let i = 0; i < rawInvoices.length; i++) {
      const parsed = rawInvoiceSchema.safeParse(rawInvoices[i]);
      if (!parsed.success) {
        console.error(`[loadLegacyInvoices] Invoice ${i + 1} invalid:`, parsed.error.flatten());
        throw new Error(`Invalid legacy invoice at index ${i} in ${filePath}: ${parsed.error.message}`);
      }
      const inv = parsed.data;
      const parsedDate = parseAmbiguousDate(inv.date, {
        formatHint: 'DD/MM/YYYY',
        neighborDates,
      });
      const isoDate = parsedDate.toISOString();

      out.push({
        id: inv.id,
        customer_name: inv.customer_name,
        amount: inv.amount,
        currency: inv.currency,
        date: isoDate,
        status: inv.status,
        description: inv.description?.trim() ? inv.description : null,
        payment_ref: emptyToNullPaymentRef(inv.payment_ref),
      });
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadLegacyInvoices]', msg);
    throw new Error(`loadLegacyInvoices failed for ${filePath}: ${msg}`);
  }
}

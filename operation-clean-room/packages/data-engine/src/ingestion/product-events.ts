import { join } from 'node:path';
import { z } from 'zod';
import { DATA_FILES } from '../data/paths.js';
import { loadJSONL } from './json-loader.js';
import type { ProductEvent } from './types.js';

const productEventSchema = z.object({
  event_id: z.string().min(1),
  account_id: z.string().min(1),
  user_id: z.string().min(1),
  event_type: z.string().min(1),
  feature: z.string(),
  timestamp: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Load product usage events from `product_events.jsonl` using a streaming line reader.
 */
export async function loadProductEvents(dataDir: string): Promise<ProductEvent[]> {
  const filePath = join(dataDir, DATA_FILES.productEvents);
  try {
    const raw = await loadJSONL<unknown>(filePath);
    const out: ProductEvent[] = [];
    for (let i = 0; i < raw.length; i++) {
      const parsed = productEventSchema.safeParse(raw[i]);
      if (!parsed.success) {
        console.error(
          `[loadProductEvents] Invalid event at line ${i + 1}:`,
          parsed.error.flatten(),
        );
        throw new Error(
          `Invalid product event at index ${i} in ${filePath}: ${parsed.error.message}`,
        );
      }
      const e = parsed.data;
      out.push({
        event_id: e.event_id,
        account_id: e.account_id,
        user_id: e.user_id,
        event_type: e.event_type,
        feature: e.feature,
        timestamp: e.timestamp,
        metadata: e.metadata,
      });
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadProductEvents]', msg);
    throw new Error(`loadProductEvents failed for ${filePath}: ${msg}`);
  }
}

/**
 * Aggregate raw product events into per-account usage summaries.
 *
 * @param events - Raw product events
 * @param periodStart - Start of the aggregation period
 * @param periodEnd - End of the aggregation period
 * @returns Map of account_id to usage summary
 */
export async function aggregateUsageByAccount(
  events: ProductEvent[],
  periodStart: Date,
  periodEnd: Date,
): Promise<
  Map<
    string,
    {
      accountId: string;
      daysActive: number;
      uniqueUsers: number;
      uniqueFeatures: number;
      totalEvents: number;
      topFeatures: { feature: string; count: number }[];
      trend: 'increasing' | 'stable' | 'decreasing';
    }
  >
> {
  // TODO: Implement - aggregate events into per-account summaries
  throw new Error('Not implemented');
}

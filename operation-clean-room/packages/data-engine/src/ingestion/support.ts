import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { SupportTicket } from './types.js';

function mapPriority(raw: string): SupportTicket['priority'] {
  const p = raw.trim().toLowerCase();
  if (p === 'critical') return 'urgent';
  if (p === 'high') return 'high';
  if (p === 'medium') return 'medium';
  if (p === 'low') return 'low';
  throw new Error(`Unknown support priority: ${raw}`);
}

function mapStatus(raw: string): SupportTicket['status'] {
  const s = raw.trim().toLowerCase();
  if (s === 'resolved') return 'solved';
  if (s === 'open' || s === 'pending' || s === 'closed' || s === 'solved') {
    return s as SupportTicket['status'];
  }
  throw new Error(`Unknown support status: ${raw}`);
}

function splitTags(raw: string): string[] {
  const t = raw.trim();
  if (t.length === 0) return [];
  return t.split('|').map((x) => x.trim()).filter(Boolean);
}

function emptyToNull(s: string | undefined): string | null {
  if (s == null) return null;
  const v = s.trim();
  return v.length === 0 ? null : v;
}

function parseRating(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid csat_score: ${raw}`);
  }
  return n;
}

/**
 * Load support tickets from `support_tickets.csv`.
 */
export async function loadSupportTickets(dataDir: string): Promise<SupportTicket[]> {
  const filePath = join(dataDir, DATA_FILES.supportTickets);
  try {
    return await loadCSV<SupportTicket>(filePath, {
      transform: (row) => ({
        ticket_id: row.ticket_id,
        account_id: row.account_id,
        account_name: row.account_name,
        subject: row.subject,
        description: row.subject,
        priority: mapPriority(String(row.priority ?? '')),
        status: mapStatus(String(row.status ?? '')),
        category: row.category,
        created_at: row.created_at,
        resolved_at: emptyToNull(row.resolved_at),
        first_response_at: null,
        assignee: row.agent_name,
        satisfaction_rating: parseRating(String(row.csat_score ?? '')),
        tags: splitTags(String(row.tags ?? '')),
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadSupportTickets]', msg);
    throw new Error(`loadSupportTickets failed for ${filePath}: ${msg}`);
  }
}

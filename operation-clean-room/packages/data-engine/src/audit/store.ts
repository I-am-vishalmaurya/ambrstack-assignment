import { randomUUID } from 'node:crypto';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  module: string;
  details: Record<string, unknown>;
  durationMs: number;
}

const log: AuditEntry[] = [];

export function recordAudit(
  action: string,
  module: string,
  details: Record<string, unknown>,
  durationMs: number,
): AuditEntry {
  const entry: AuditEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    module,
    details,
    durationMs,
  };
  log.push(entry);
  return entry;
}

export function getAuditLog(): AuditEntry[] {
  return [...log];
}

export function clearAuditLog(): void {
  log.length = 0;
}

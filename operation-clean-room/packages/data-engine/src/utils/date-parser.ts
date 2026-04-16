import { isValid, parseISO } from 'date-fns';

type FormatHint = 'DD/MM/YYYY' | 'MM/DD/YYYY';

function expandTwoDigitYear(year: number): number {
  if (year >= 100) return year;
  return year < 50 ? 2000 + year : 1900 + year;
}

function utcDate(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d, 0, 0, 0, 0));
}

function tryParseIso(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = parseISO(trimmed.length === 10 ? `${trimmed}T00:00:00.000Z` : trimmed);
    return isValid(d) ? d : null;
  }
  return null;
}

const SLASHY = /^(\d{1,2})([/.\-])(\d{1,2})\2(\d{2}|\d{4})$/;

function parseNumericParts(
  a: number,
  b: number,
  yRaw: number,
  order: 'DMY' | 'MDY',
): Date {
  const year = expandTwoDigitYear(yRaw);
  // Date.UTC(year, monthIndex, day)
  if (order === 'DMY') {
    return utcDate(year, b - 1, a);
  }
  return utcDate(year, a - 1, b);
}

function classifySlashDate(a: number, b: number): 'DMY' | 'MDY' | 'ambiguous' {
  if (a > 12) return 'DMY';
  if (b > 12) return 'MDY';
  if (a === b) return 'DMY';
  return 'ambiguous';
}

function voteFromNeighbor(
  dateStr: string,
  neighborDates: string[] | undefined,
): FormatHint | null {
  if (!neighborDates?.length) return null;
  let dmyVotes = 0;
  let mdyVotes = 0;
  for (const n of neighborDates) {
    const m = n.trim().match(SLASHY);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[3]);
    const c = classifySlashDate(a, b);
    if (c === 'DMY') dmyVotes++;
    else if (c === 'MDY') mdyVotes++;
  }
  if (dmyVotes > mdyVotes) return 'DD/MM/YYYY';
  if (mdyVotes > dmyVotes) return 'MM/DD/YYYY';
  return null;
}

function parseSlashy(dateStr: string, order: 'DMY' | 'MDY'): Date {
  const m = dateStr.trim().match(SLASHY);
  if (!m) {
    throw new Error(`Expected slash/dot/dash date, got: ${dateStr}`);
  }
  const a = Number(m[1]);
  const b = Number(m[3]);
  const yRaw = Number(m[4]);
  return parseNumericParts(a, b, yRaw, order);
}

/**
 * Ambiguous date format parser.
 *
 * @param dateStr - Raw date string from the data source
 * @param context - Optional context for disambiguation
 * @returns Parsed Date object in UTC
 *
 * @throws Error if the date string cannot be parsed at all
 */
export function parseAmbiguousDate(
  dateStr: string,
  context?: {
    neighborDates?: string[];
    formatHint?: FormatHint;
  },
): Date {
  const trimmed = dateStr.trim();
  if (trimmed.length === 0) {
    throw new Error('Empty date string');
  }

  const iso = tryParseIso(trimmed);
  if (iso) return iso;

  const slash = trimmed.match(SLASHY);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[3]);
    const yRaw = Number(slash[4]);
    const kind = classifySlashDate(a, b);

    if (kind === 'DMY') {
      return parseNumericParts(a, b, yRaw, 'DMY');
    }
    if (kind === 'MDY') {
      return parseNumericParts(a, b, yRaw, 'MDY');
    }

    const hinted: FormatHint | undefined = context?.formatHint;
    if (hinted === 'DD/MM/YYYY') {
      return parseNumericParts(a, b, yRaw, 'DMY');
    }
    if (hinted === 'MM/DD/YYYY') {
      return parseNumericParts(a, b, yRaw, 'MDY');
    }

    const voted = voteFromNeighbor(trimmed, context?.neighborDates);
    if (voted === 'DD/MM/YYYY') {
      return parseNumericParts(a, b, yRaw, 'DMY');
    }
    if (voted === 'MM/DD/YYYY') {
      return parseNumericParts(a, b, yRaw, 'MDY');
    }

    return parseNumericParts(a, b, yRaw, 'MDY');
  }

  throw new Error(`Unable to parse date: ${dateStr}`);
}

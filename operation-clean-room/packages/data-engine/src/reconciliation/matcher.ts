import type { MatchResult, MatchConfidence } from './types.js';
import { normalizeCompanyName } from '../utils/normalization.js';

export interface MatchOptions {
  threshold?: number;
  idWeight?: number;
  domainWeight?: number;
  nameWeight?: number;
  allowMultipleMatches?: boolean;
}

function tokenize(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter((t) => t.length > 0));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Calculate the confidence score for a potential match between two entities.
 *
 * Scoring approach:
 * - Normalize company names and compute token Jaccard similarity.
 * - Matching domains add a 0.15 boost.
 * - Differing domains (both present) penalize heavily (cap < 0.3).
 */
export async function calculateConfidence(
  entityA: Record<string, unknown>,
  entityB: Record<string, unknown>,
): Promise<MatchConfidence> {
  const nameA = normalizeCompanyName(String(entityA['name'] ?? ''));
  const nameB = normalizeCompanyName(String(entityB['name'] ?? ''));

  const tokensA = tokenize(nameA);
  const tokensB = tokenize(nameB);
  let nameSim = jaccardSimilarity(tokensA, tokensB);

  const domainA = entityA['domain'] ? String(entityA['domain']).toLowerCase() : null;
  const domainB = entityB['domain'] ? String(entityB['domain']).toLowerCase() : null;

  const matchedFields: string[] = [];
  const unmatchedFields: string[] = [];

  let domainBoost = 0;
  const bothHaveDomains = domainA != null && domainB != null;

  if (bothHaveDomains) {
    if (domainA === domainB) {
      domainBoost = 0.15;
      matchedFields.push('domain');
    } else {
      nameSim *= 0.25;
      unmatchedFields.push('domain');
    }
  }

  if (nameSim > 0.3) {
    matchedFields.push('name');
  } else {
    unmatchedFields.push('name');
  }

  const score = Math.min(1, nameSim + domainBoost);

  return {
    score,
    matchedFields,
    unmatchedFields,
  };
}

/**
 * Match entities across two data sources using fuzzy matching.
 */
export async function matchEntities(
  sourceA: Record<string, unknown>[],
  sourceB: Record<string, unknown>[],
  options?: MatchOptions,
): Promise<MatchResult[]> {
  const threshold = options?.threshold ?? 0.6;
  const results: MatchResult[] = [];

  for (const a of sourceA) {
    let bestMatch: { entity: Record<string, unknown>; confidence: MatchConfidence } | null = null;

    for (const b of sourceB) {
      const confidence = await calculateConfidence(a, b);
      if (confidence.score >= threshold) {
        if (!bestMatch || confidence.score > bestMatch.confidence.score) {
          bestMatch = { entity: b, confidence };
        }
      }
    }

    if (bestMatch) {
      results.push({
        entityA: {
          id: String(a['id'] ?? ''),
          source: String(a['source'] ?? 'unknown'),
          ...a,
        },
        entityB: {
          id: String(bestMatch.entity['id'] ?? ''),
          source: String(bestMatch.entity['source'] ?? 'unknown'),
          ...bestMatch.entity,
        },
        confidence: bestMatch.confidence,
      });
    }
  }

  return results;
}

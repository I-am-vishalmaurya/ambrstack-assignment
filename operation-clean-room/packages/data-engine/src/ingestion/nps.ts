import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { NPSSurvey } from './types.js';

function categoryFromScore(score: number): NPSSurvey['category'] {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

/**
 * Load NPS survey responses from `nps_surveys.csv`.
 */
export async function loadNPSSurveys(dataDir: string): Promise<NPSSurvey[]> {
  const filePath = join(dataDir, DATA_FILES.npsSurveys);
  try {
    return await loadCSV<NPSSurvey>(filePath, {
      transform: (row) => {
        const score = Number(row.score);
        if (Number.isNaN(score)) {
          throw new Error(`Invalid NPS score: ${row.score}`);
        }
        const commentRaw = String(row.comment ?? '');
        return {
          response_id: String(row.survey_id ?? ''),
          account_id: String(row.account_id ?? ''),
          account_name: '',
          respondent_email: String(row.respondent_email ?? ''),
          score,
          comment: commentRaw.trim().length === 0 ? null : commentRaw,
          survey_date: String(row.survey_date ?? ''),
          segment: '',
          category: categoryFromScore(score),
        };
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadNPSSurveys]', msg);
    throw new Error(`loadNPSSurveys failed for ${filePath}: ${msg}`);
  }
}

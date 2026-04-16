import type { LoadedData } from './bootstrap.js';
import { loadAllDatasets } from './bootstrap.js';
import { defaultDataDirectory } from './paths.js';

let cachedData: LoadedData | null = null;
let loading: Promise<LoadedData> | null = null;

export async function getData(): Promise<LoadedData> {
  if (cachedData) return cachedData;
  if (loading) return loading;
  loading = loadAllDatasets(defaultDataDirectory()).then((d) => {
    cachedData = d;
    console.log('[data] All datasets loaded successfully');
    return d;
  });
  return loading;
}

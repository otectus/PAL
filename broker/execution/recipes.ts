import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const recipeFile = (name: string) => fileURLToPath(new URL('./recipes/' + name + '.py', import.meta.url));
export const recipeSource = (name: string) => readFileSync(recipeFile(name), 'utf8');
export const kernelSource = readFileSync(new URL('./kernel.py', import.meta.url), 'utf8');
export const helperDigest = createHash('sha256').update(recipeSource('lab_data')).update(recipeSource('sql')).update(kernelSource).digest('hex');
type Field = { key: string; label: string; type: 'column' | 'text' | 'number'; default?: string };
type Recipe = { label: string; code: string; fields: Field[]; packages?: string[] };
const sheet: Field = { key: 'sheet', label: 'Worksheet (optional)', type: 'text' };
export const recipes: Record<string, Recipe> = {
  summarize: { label: 'Summarize columns and missing values', code: recipeSource('summarize'), fields: [sheet] },
  plot: { label: 'Plot two columns', code: recipeSource('plot'), packages: ['matplotlib'],
    fields: [{ key: 'x', label: 'X column', type: 'column' }, { key: 'y', label: 'Y column', type: 'column' },
      { key: 'xLabel', label: 'X axis with units', type: 'text' }, { key: 'yLabel', label: 'Y axis with units', type: 'text' }, sheet] },
  compare: { label: 'Compare two tables by key', code: recipeSource('compare'), fields: [
    { key: 'key', label: 'Matching column(s)', type: 'column' }, { key: 'mode', label: 'Match by key or position', type: 'text', default: 'key' },
    { key: 'sheet1', label: 'Before worksheet', type: 'text' }, { key: 'sheet2', label: 'After worksheet', type: 'text' }] },
  contributions: { label: 'Explain a change by customer or group', code: recipeSource('contributions'), packages: ['matplotlib'], fields: [
    { key: 'key', label: 'Group by', type: 'column' }, { key: 'metric', label: 'Numeric measure', type: 'column' },
    { key: 'unit', label: 'Measure and units', type: 'text' }, sheet] },
  export: { label: 'Export matching records', code: recipeSource('export'), fields: [
    { key: 'column', label: 'Filter column', type: 'column' }, { key: 'value', label: 'Equals', type: 'text' }, sheet] },
  report: { label: 'Markdown report with a chart and source table', packages: ['matplotlib'], fields: [sheet], code: recipeSource('report') },
  alpha: { label: 'Contact sheet and transparency coverage of images', packages: ['pillow'], fields: [], code: recipeSource('alpha') },
};

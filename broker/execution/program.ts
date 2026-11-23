import { z } from 'zod';
import type { ArtifactRef } from '../tools/contracts.ts';
export type LabRequest = {
  code?: unknown; steps?: unknown; parameters?: unknown; language?: unknown; inputs?: unknown; purpose?: unknown;
  sharedPython?: boolean; notify?: boolean; analysisId?: unknown; parentId?: unknown; reuseSteps?: unknown; timeoutSeconds?: unknown; signal?: AbortSignal; turnId?: string;
  origin: 'model' | 'user' | 'schedule'; approval: 'individual' | 'grant' | 'user' | 'schedule';
};
const language = z.enum(['python', 'sql']);
const cell = z.object({ name: z.string().trim().min(1).max(120), code: z.string().min(1), language: language.default('python') });
export type CellRecord = { name: string; language: string; state: 'pending'|'running'|'completed'|'failed'|'cancelled'|'interrupted'; digest: string;
  results: ArtifactRef[]; cached?: boolean; durationMs?: number; stdout?: string; stderr?: string };
export function validateProgram(p: LabRequest) {
  const lang = language.parse(p.language ?? 'python');
  const cells = Array.isArray(p.steps) && p.steps.length === 0 || p.steps === undefined
    ? [{ name: 'Analysis', language: lang, code: typeof p.code === 'string' ? p.code : '' }]
    : z.array(cell).min(1).max(12).parse(p.steps);
  if (cells.some(s => !s.code.trim() || s.code.includes('\0')) || cells.reduce((n, s) => n + Buffer.byteLength(s.code), 0) > 65536)
    throw new Error('Give 1 byte to 64 KiB of code across up to 12 steps');
  const multi = Array.isArray(p.steps) && p.steps.length > 0;
  const sharedPython = p.sharedPython === true;
  if (sharedPython && (!multi || cells.some(cell => cell.language !== 'python')))
    throw new Error('A shared Python notebook needs named Python cells. Choose separate processes to mix Python and SQL.');
  const codeText = multi ? JSON.stringify(cells, null, 2) : cells[0].code;
  const parameters = z.record(z.string().max(128), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string()).max(50)])).parse(p.parameters ?? {});
  if (Buffer.byteLength(JSON.stringify(parameters)) > 16384) throw new Error('Analysis parameters exceed 16 KiB');
  const refs = z.array(z.object({ artifactId: z.uuid(), versionId: z.uuid().optional() })).max(8).parse(p.inputs ?? []);
  const timeout = z.number().int().min(1).max(600).parse(p.timeoutSeconds ?? 60);
  return { cells, multi, sharedPython, codeText, parameters, refs, timeout };
}

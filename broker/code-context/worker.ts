/** Reads one file at a time away from the broker's own loop. It has no files, network or state of its own to use. */
import { parentPort } from 'node:worker_threads';
import { parseSource } from './languages.ts';
parentPort!.on('message', ({ id, path, text }: { id: number; path: string; text: string }) => {
  try { parentPort!.postMessage({ id, parsed: parseSource(path, text) }); } catch (error: any) { parentPort!.postMessage({ id, error: String(error?.message || error).slice(0, 200) }); }
});

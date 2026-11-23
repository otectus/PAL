/** A single Python process for a notebook. Its state and sandbox end with the run. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sandboxed, type Bind } from './runner.ts';

type KernelCell = { name: string; code: string };
type KernelEvent = { index: number; state: 'running' | 'completed' | 'failed' };
type Callbacks = {
  scratchRoot: string; signal: AbortSignal; wallMs: number;
  onCell: (event: KernelEvent) => void;
  onOutput: (stream: 'stdout' | 'stderr', text: string) => void;
};

export async function runKernel(cells: KernelCell[], binds: Bind[], p: Callbacks) {
  const input = join(p.scratchRoot, 'kernel-input.json');
  await writeFile(input, JSON.stringify(cells), { mode: 0o400 });
  let pending = '', next = 0, running = false, failed = false;
  const result = await sandboxed({
    argv: ['/usr/bin/python3', '-I', '-u', '/work/kernel.py'], cwd: '/work', signal: p.signal, limits: { wallMs: p.wallMs },
    binds: [...binds, { source: join(import.meta.dirname, 'kernel.py'), target: '/work/kernel.py' }, { source: input, target: '/work/kernel-input.json' }],
    onOutput: p.onOutput,
    onControl: data => {
      pending += data.toString('ascii');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const event = /^(\d+) (running|completed|failed)$/.exec(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (!event || next >= cells.length || failed || Number(event[1]) !== next) continue;
        const state = event[2] as KernelEvent['state'];
        if ((state === 'running') === running) continue;
        p.onCell({ index: next, state });
        running = state === 'running';
        if (state === 'failed') failed = true;
        if (state === 'completed') next++;
      }
    },
  });
  return { ...result, completedCells: next };
}

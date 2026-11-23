/** Run the immutable code from an unpacked Workbench analysis with its original sandbox boundary. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sandboxed } from './runtime/runner.ts';
import { runKernel } from './runtime/kernel.ts';

const root = dirname(fileURLToPath(import.meta.url));
const {values, positionals} = parseArgs({ allowPositionals:true, options:{
  output:{type:'string'}, 'replace-inputs':{type:'boolean'}, help:{type:'boolean'},
} });
if (values.help) {
  console.log('node replay.mjs [--replace-inputs] [--output NEW_DIRECTORY] -- INPUT_FILES_IN_MANIFEST_ORDER');
  process.exit(0);
}
const scratch = await mkdtemp(join(tmpdir(),'analysis-replay-'));
try {
  const manifest = JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  if (manifest.version !== 1 || positionals.length !== manifest.inputs.length) throw Error('Supply the input files in manifest order.');
  const binds = [], paths = [];
  for (const [i, slot] of manifest.inputs.entries()) {
    const path = resolve(positionals[i]), info = await stat(path);
    if (!info.isFile() || info.size > 100 * 1024 ** 2) throw Error('Choose a regular input file of at most 100 MiB');
    const data = await readFile(path);
    if (!values['replace-inputs'] && createHash('sha256').update(data).digest('hex') !== slot.sha256)
      throw Error('Hash differs for ' + slot.name + '. Review the file before using --replace-inputs.');
    let name = basename(slot.name).replace(/\s+/g, '_');
    if (!name || name === '.' || name === '..') throw Error('Invalid input name');
    while (paths.includes('/work/input/'+name)) name=(i+1)+'-'+name;
    const target = '/work/input/'+name, source = join(scratch,'input-'+i);
    await writeFile(source, data, {mode:0o400}); paths.push(target); binds.push({source,target});
  }
  await writeFile(join(scratch,'inputs.json'), JSON.stringify(paths));
  binds.push({source:join(scratch,'inputs.json'),target:'/work/inputs.json'},
    {source:join(root,'parameters.json'),target:'/work/parameters.json'});
  for (const name of ['lab_data.py','sql.py']) binds.push({source:join(root,'runtime',name),target:'/work/lab/'+name});
  const cells = await Promise.all(manifest.files.map(async (path,i) => {
    const language = path.endsWith('.sql') ? 'sql' : 'python';
    if (path !== 'code/step-'+(i+1)+(language === 'sql' ? '.sql' : '.py')) throw Error('Invalid program path in manifest');
    return { name:'Step '+(i+1), language, code:await readFile(join(root,path),'utf8'), path:join(root,path) };
  }));
  const destination = values.output ? resolve(values.output) : await mkdtemp(resolve('analysis-results-'));
  if (values.output) await mkdir(destination, {mode:0o700});
  console.log('Writing results to '+destination);
  const deadline = Date.now()+Math.max(1,Math.min(600,Number(manifest.timeLimitSeconds)||60))*1000;
  const controller = new AbortController(); process.once('SIGINT',()=>controller.abort());
  let bytes = 0, count = 0;
  const onOutput = (stream, text) => process[stream].write(text);
  for (const [i, cell] of cells.entries()) {
    const wallMs = deadline - Date.now();
    if (wallMs <= 0) throw Error('Replay reached its time limit');
    const main = cell.language === 'sql' ? '/work/main.sql' : '/work/main.py';
    const entry = cell.language === 'sql' ? '/work/lab/sql.py' : main;
    const result = manifest.sharedPython
      ? await runKernel(cells, binds, {scratchRoot:scratch,signal:controller.signal,wallMs,onOutput,onCell:event=>console.log('Step '+(event.index+1)+' '+event.state)})
      : await sandboxed({argv:['/usr/bin/python3','-I','-u','-c','import runpy,sys;sys.path.insert(0,"/work/lab");runpy.run_path(sys.argv[1],run_name="__main__")',entry],
        binds:[...binds,{source:cell.path,target:main}],cwd:'/work',signal:controller.signal,limits:{wallMs},onOutput});
    for (const file of result.outputs) {
      bytes += file.bytes.length;
      if (++count > 20 || bytes > 100*1024**2) throw Error('Notebook output limit exceeded');
      const relative = manifest.sharedPython ? file.name : 'cell-'+(i+1)+'/'+file.name;
      const output = join(destination,relative);
      await mkdir(dirname(output),{recursive:true}); await writeFile(output,file.bytes,{flag:'wx',mode:0o600});
      if (!manifest.sharedPython) binds.push({source:output,target:'/work/steps/'+(i+1)+'/'+file.name});
    }
    if (result.outputProblem || result.exitCode !== 0 || result.timedOut || result.cancelled ||
        (manifest.sharedPython && result.completedCells !== cells.length))
      throw Error(result.outputProblem || (result.timedOut ? 'Time limit reached' : 'Replay stopped at step '+(i+1)+' (exit '+result.exitCode+')'));
    if (manifest.sharedPython) break;
  }
} catch (error) {
  console.error(error.message); process.exitCode=1;
} finally {
  await rm(scratch,{recursive:true,force:true});
}

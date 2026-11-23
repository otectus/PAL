import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryService} from '../../broker/graph-memory/service.ts';
import {datasetVersion} from '../../broker/graph-memory/evaluation.ts';

// Explicit local synthetic evaluation. The disposable profile has no sources,
// projection credentials or cloud consent. Never select the user's chat model.
const [option,model,count]=process.argv.slice(2);
if(option!=='--local-model'||!model||!/^([1-9]|10|11)$/.test(count||''))throw new Error('Usage: node benchmarks/memory/evaluate-curation.ts --local-model MODEL CASES (1–11)');
const dir=await mkdtemp(join(tmpdir(),'pal-curation-eval-'));
const service=new MemoryService(dir);clearInterval(service.timer);
try{
  const scope=await service.canonical.call('scope',{key:'synthetic-evaluation',label:'Synthetic evaluation'});
  await service.call('curation_configure',{expected_revision:0,profile:{reviewModel:{connectionRef:'default:ollama',modelId:model},
    dailyRequests:Number(count)*2+2,dailyInput:100000,dailyOutput:2000*(Number(count)*2+2)}});
  const start=performance.now();
  const result=await service.call('models_evaluate',{dataset:datasetVersion,max_cases:Number(count)});
  console.log(JSON.stringify({...result,elapsed_ms:Math.round(performance.now()-start),usage:(await service.call('curation_status',{scope_id:scope.id})).usage},null,2));
}finally{await service.close();await rm(dir,{recursive:true,force:true});}

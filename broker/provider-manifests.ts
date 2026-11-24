import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Core } from './core.ts';

const identifier=z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const label=z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f]+$/u);
const operation=z.enum(['inference','speech.transcribe','speech.synthesize','embed','search','storage.upsert','storage.query','storage.delete']);
const field=z.strictObject({id:identifier,label,type:z.enum(['text','boolean','integer','enum']),choices:z.array(label).min(1).max(32).optional()})
  .refine(f=>f.type==='enum'?!!f.choices:!f.choices,'Choices belong to enum fields');
export const manifestSchema=z.strictObject({version:z.literal(1),id:identifier,label,
  fields:z.array(field).max(24).default([]),operations:z.array(z.strictObject({operation,serverId:z.uuid(),tool:z.string().regex(/^[\w.:-]{1,128}$/)})).min(1).max(8),
}).refine(m=>new Set(m.operations.map(o=>o.operation)).size===m.operations.length && new Set(m.fields.map(f=>f.id)).size===m.fields.length,'Duplicate fields or operations');
type Manifest=z.infer<typeof manifestSchema>;
type Record={manifest:Manifest;revision:string};
const revision=(m:Manifest)=>createHash('sha256').update(JSON.stringify(m)).digest('hex');
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const mutation=z.strictObject({manifest:manifestSchema,expectedRevision:hash.nullable()});
const call=z.strictObject({id:identifier,revision:hash,operation,sessionId:z.uuid(),args:z.record(z.string(),z.unknown())});
export async function providerManifest(core:Core,action:string,value:unknown) {
  const records=()=>core.store.get<Record[]>('providerManifests.v1',[]);
  if(action==='list')return records();
  if(action==='preview'||action==='save'){
    const {manifest,expectedRevision}=mutation.parse(value),existing=records(),prior=existing.find(r=>r.manifest.id===manifest.id);
    if((prior?.revision??null)!==expectedRevision)throw new Error('The provider manifest changed. Review the current revision.');
    const result={manifest,revision:revision(manifest)};
    if(action==='save'){
      if(!prior&&existing.length>=64)throw new Error('Configure up to 64 service manifests');
      core.store.set('providerManifests.v1',[...existing.filter(r=>r!==prior),result]);core.changed();
    }
    return result;
  }
  if(action==='remove'){
    const p=z.strictObject({id:identifier,revision:hash}).parse(value),existing=records(),prior=existing.find(r=>r.manifest.id===p.id);
    if(prior?.revision!==p.revision)throw new Error('The provider manifest changed');
    core.store.set('providerManifests.v1',existing.filter(r=>r!==prior));core.changed();return {removed:true};
  }
  if(action!=='invoke')throw new Error('Unknown service manifest operation');
  const p=call.parse(value);
  const check=()=>{
    const entry=records().find(r=>r.manifest.id===p.id),binding=entry?.manifest.operations.find(o=>o.operation===p.operation);
    if(entry?.revision!==p.revision||!binding)throw new Error('This service operation changed or was removed');
    return binding;
  };
  check();
  await core.extensions.ensure(p.sessionId);
  const binding=check();
  return core.extensions.callBound(p.sessionId,binding.serverId,binding.tool,p.args,AbortSignal.timeout(120000),check);
}

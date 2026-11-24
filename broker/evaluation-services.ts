import { z } from 'zod';
import { responseJson } from './provider-http.ts';
const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const phrase=z.string().trim().min(1).max(1000);
const question=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('noul'),instructions:phrase,criteria:z.strictObject({true:phrase,false:phrase}).optional()}),
  z.strictObject({type:z.literal('choice'),instructions:phrase,criteria:z.record(name,phrase).refine(c=>Object.keys(c).length>=1 && Object.keys(c).length<=10)}),
  z.strictObject({type:z.literal('score'),instructions:phrase,criteria:z.array(phrase).min(1).max(10)}),
]);
export const evaluateInput=z.strictObject({state:z.string().trim().min(1).max(8000),questions:z.record(name,question).refine(q=>Object.keys(q).length>=1 && Object.keys(q).length<=12)});
const probability=z.number().min(0).max(1);
const exactKeys=(value:unknown,keys:string[])=>!!value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
export async function jevEvaluate(key:string,model:string,input:z.infer<typeof evaluateInput>,signal:AbortSignal,send=fetch) {
  if(!key||!model)throw new Error('Configure a Jev model and service key');
  const request=evaluateInput.parse(input);
  const data=await responseJson(await send('https://api.typesafe.ai/v1/systemone',{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,...request})}));
  if(typeof data.model!=='string'||!exactKeys(data.answers,Object.keys(request.questions)))throw new Error('Jev returned unexpected answer names or model');
  const answers:Record<string,unknown>={};
  for(const [id,q] of Object.entries(request.questions)){
    const a=data.answers[id];
    if(a?.type!==q.type)throw new Error('Jev returned the wrong answer type');
    if(q.type==='noul'){answers[id]={type:q.type,noul:probability.parse(a.noul)};continue;}
    const labels=Object.keys(q.criteria);
    if(!exactKeys(a.probabilities,labels))throw new Error('Invalid Jev probability map');
    const probabilities=z.record(z.string(),probability).parse(a.probabilities);
    if (q.type==='choice'&&!labels.includes(a.choice) || q.type==='score'&&(!Number.isFinite(a.score)||a.score<0||a.score>labels.length-1)) throw new Error('Jev returned a value outside the supplied choices or score range');
    answers[id]={type:q.type,...(q.type==='choice'?{choice:a.choice}:{score:a.score,legend:[...q.criteria]}),confidence:probability.parse(a.confidence),probabilities};
  }
  return {model:data.model.slice(0,200),answers,usage:{inputTokens:data.usage?.input_tokens,outputTokens:data.usage?.output_tokens}};
}
export async function voyageRerank(key:string,model:string,query:string,items:{id:string;text:string;sensitivity:string}[],signal:AbortSignal,send=fetch) {
  if(!key||!query||items.length>32||items.some(i=>i.sensitivity!=='cloud_allowed'))throw new Error('Voyage needs an authorized cloud retrieval pool');
  const data=await responseJson(await send('https://api.voyageai.com/v1/rerank',{method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,query,documents:items.map(i=>i.text),top_k:items.length,truncation:false})}));
  const rows=z.array(z.object({index:z.number().int().min(0).max(items.length-1),relevance_score:z.number()})).length(items.length).parse(data.data);
  if(new Set(rows.map(r=>r.index)).size!==items.length)throw new Error('Duplicate Voyage result index');
  return {ids:rows.map(r=>items[r.index].id),route:'voyage:'+model,usage:{inputTokens:Number.isSafeInteger(data.usage?.total_tokens)?data.usage.total_tokens:undefined}};
}

export async function jevModels(key:string,send=fetch) {
  if(!key)throw new Error('Add a Jev / TypeSafe service key');
  const result=await responseJson(await send('https://api.typesafe.ai/v1/models',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(15000)}));
  return z.object({models:z.array(z.object({name:z.string().min(1).max(256),description:z.string().max(2048),release_date:z.string().max(32)})).max(512)}).parse(result).models;
}

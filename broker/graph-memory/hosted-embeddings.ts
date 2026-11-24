import { xaiEmbedding } from './xai-embedding.ts';
import { apiJson, type ApiAccess } from '../api-providers.ts';
import { responseJson } from '../provider-http.ts';
import { googleEmbeddings } from './adapters/api.ts';

export const embeddingProviders=['ollama','google','openai','mistral','perplexity','voyage','azure_openai','litellm','compatible','openrouter','forge','edenai','xai','huggingface'] as const;
export type EmbeddingProvider=typeof embeddingProviders[number];
export async function hostedEmbeddings(provider:Exclude<EmbeddingProvider,'ollama'>,access:ApiAccess,model:string,input:string[],kind:'query'|'document',signal:AbortSignal,dimensions?:number,pooling:'mean'|'cls'='mean') {
  let vectors:unknown[];
  if(provider==='xai') {
    vectors=await xaiEmbedding(access,model,input,signal);
  } else if (provider==='litellm' && access.localBridgeEmbeddings) {
    vectors=await access.localBridgeEmbeddings(model,input,dimensions,signal);
  } else if (provider==='google') {
    vectors=await googleEmbeddings(access,model,input,kind,signal,dimensions);
  } else if (provider==='huggingface') {
    const key=access.key(); if(!key) throw new Error('Configure the huggingface embedding account key');
    const base=new URL(access.route?.().baseUrl || 'https://router.huggingface.co/v1/');
    if(base.protocol!=='https:' || base.username || base.password || base.port) throw new Error('Hugging Face embeddings require an official HTTPS endpoint');
    if(base.hostname==='router.huggingface.co') base.pathname='/hf-inference/models/'+model.split('/').map(encodeURIComponent).join('/');
    else if(base.hostname.endsWith('.endpoints.huggingface.cloud')) { base.pathname=base.pathname.replace(/\/+$/,'') || '/'; }
    else throw new Error('Hugging Face embeddings require the official router or a dedicated Inference Endpoint');
    base.search='';base.hash='';
    const raw:any=await responseJson(await (access.fetch||fetch)(base,{method:'POST',signal,redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({inputs:input})}),32*1024*1024);
    const average=(tokens:any[])=>{if(!tokens.length||tokens.some(row=>!Array.isArray(row)))throw new Error('Invalid Hugging Face feature extraction response');const width=tokens[0].length;if(!width||tokens.some(row=>row.length!==width||!row.every(Number.isFinite)))throw new Error('Invalid Hugging Face feature extraction response');if(pooling==='cls')return tokens[0];return Array.from({length:width},(_,i)=>tokens.reduce((sum,row)=>sum+row[i],0)/tokens.length);};
    if(!Array.isArray(raw)) throw new Error('Invalid Hugging Face feature extraction response');
    vectors=raw.length===input.length&&raw.every((row:any)=>Array.isArray(row)&&row.every(Number.isFinite))?raw:raw.length===input.length&&raw.every(Array.isArray)?raw.map(average):input.length===1?[average(raw)]:[];
  } else {
    let data:any;
    const json={model,input,...(dimensions?{dimensions}:{})};
    if (provider==='voyage' || provider==='perplexity') {
      const key=access.key();
      if (!key) throw new Error('Configure the '+provider+' embedding account');
      const url=provider==='voyage'?'https://api.voyageai.com/v1/embeddings':new URL('embeddings',(access.route?.().baseUrl || 'https://api.perplexity.ai/v1').replace(/\/+$/,'')+'/').href;
      const body=provider==='voyage'?{model,input,input_type:kind,output_dtype:'float',...(dimensions?{output_dimension:dimensions}:{})}:{...json,input_type:kind,encoding_format:'base64_int8'};
      data=await responseJson(await (access.fetch||fetch)(url,{method:'POST',signal,redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)}),8*1024*1024);
    } else {
      data=await apiJson(provider,access,'embeddings',{...json,model:access.route?.().deployment||model,encoding_format:'float'},signal,{},8*1024*1024);
    }
    if (!Array.isArray(data.data) || data.data.length!==input.length) throw new Error('Unexpected embedding count');
    const sorted=data.data.toSorted((a:any,b:any)=>a.index-b.index);
    vectors=sorted.map((r:any,i:number)=>{
      if(r.index!==i) throw new Error('Invalid or duplicate embedding index');
      if(provider!=='perplexity') return r.embedding;
      if(typeof r.embedding!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.embedding)) throw new Error('Invalid signed-byte embedding');
      return Array.from(new Int8Array(Buffer.from(r.embedding,'base64')));
    });
  }
  if (!Array.isArray(vectors)||vectors.length!==input.length) throw new Error('Unexpected embedding count');
  const size=dimensions || (Array.isArray(vectors[0])?vectors[0].length:0);
  if(!size || size>16384 || vectors.some(v=>!Array.isArray(v)||v.length!==size||!v.every(Number.isFinite)||v.every(n=>n===0))) throw new Error('Invalid embedding dimension or values');
  return vectors as number[][];
}

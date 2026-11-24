import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import type { ApiAccess } from '../api-providers.ts';
import { palEnv } from '../paths.ts';

export async function xaiEmbedding(access:ApiAccess,model:string,input:string[],signal:AbortSignal) {
  const endpoint=new URL(access.route?.().baseUrl || 'https://api.x.ai/v1');
  if (endpoint.origin!=='https://api.x.ai'||endpoint.pathname.replace(/\/+$/,'')!=='/v1')throw new Error('This SDK operation requires the xAI global endpoint');
  const python=palEnv('XAI_SDK_PYTHON');
  if(!python||!isAbsolute(python))throw new Error('Configure PAL_XAI_SDK_PYTHON with an isolated xai-sdk 1.21.0 environment');
  const key=access.key();if(!key)throw new Error('Configure the xAI embedding account');
  const payload=JSON.stringify({model,input,key});
  if(Buffer.byteLength(payload)>2*1024*1024)throw new Error('xAI embedding inputs exceed the size limit');
  return new Promise<unknown[]>((resolve,reject)=>{
    const child=execFile(python,['-I',fileURLToPath(new URL('./xai-embed.py',import.meta.url))],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},cwd:'/',signal,timeout:30000,maxBuffer:8*1024*1024},
      (error,out,err)=>{if(error)return reject(new Error('xAI embedding SDK request failed ('+(/^[A-Z_]{1,40}$/.test(err)?err:'runtime unavailable')+')'));
        try{resolve(JSON.parse(out));}catch{reject(new Error('Invalid xAI embedding SDK output'));}});
    child.stdin?.on('error',()=>{});child.stdin?.end(payload);
  });
}

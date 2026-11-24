import { z } from 'zod';
import type { Core } from '../core.ts';
import { hostedSpeechProviders,transcribeDetailed,voiceSchema } from '../hosted-speech.ts';
import { routeAllowed } from '../tools/contracts.ts';
import { limitedControlled } from '../authority.ts';

export const artifactTranscript=z.strictObject({sessionId:z.uuid(),artifactId:z.uuid(),versionId:z.uuid(),
  provider:z.enum(hostedSpeechProviders),settings:voiceSchema.optional(),googleCloudUri:z.string().max(2048).optional(),acknowledgeUpload:z.literal(true)});
export async function transcribeArtifact(core:Core,params:unknown,authorize?:()=>void){
  const p=artifactTranscript.parse(params),settings=p.settings||{},files=core.workbench.artifacts;
  const accountId=settings.connectionId||undefined;
  const revision=()=>[accountId?core.chatConnections.get(accountId).revision:0,p.provider==='google_cloud'?'adc':core.credentials.credentialRevision(accountId?'connection:'+accountId:'provider:'+p.provider)].join('/');
  const binding=revision();
  const check=()=>{
    authorize?.();if(revision()!==binding)throw new Error('The selected speech account changed during transcription');const session=core.store.session(p.sessionId);
    if(session.temporary||limitedControlled(session)||core.settingsFor(session.id).paused)throw new Error('Hosted transcription requires an active, saved owner conversation');
    const file=files.version(session.id,p.artifactId,p.versionId);
    if(!routeAllowed('cloud',file.policy)||file.bytes>24*1024*1024)throw new Error('Select a WAV file up to 24 MiB that allows cloud processing');
    if(p.googleCloudUri && p.provider!=='google_cloud')throw new Error('Cloud Storage recordings belong to Google Cloud Speech');
    return file;
  };
  const source=check(),controller=new AbortController();
  const end=core.jobs.add('transcription','Transcribing '+source.name,()=>controller.abort());
  try {
    const {data}=await files.bytes(p.sessionId,p.artifactId,p.versionId);check();
    core.usage.assertWithinBudget(p.provider);
    const transcript=await transcribeDetailed(core,p.provider,settings,data,AbortSignal.any([controller.signal,AbortSignal.timeout(3600000)]),{googleCloudUri:p.googleCloudUri},{fetch:async(url,init)=>{check();return fetch(url,init);}});
    check();
    const result=await files.install({sessionId:p.sessionId,name:'transcript.json',mime:'application/json',source:'derived',
      bytes:Buffer.from(JSON.stringify(transcript,null,2)),policy:source.policy,parents:[{artifactId:p.artifactId,versionId:p.versionId,relation:'transcription'}],
      provenance:{kind:'speech.transcribe',provider:p.provider,model:settings.model||'provider default',connection:settings.connectionId||'provider:'+p.provider}});
    core.store.db.prepare('INSERT INTO usage_records VALUES (?,?,?,?,?)').run(result.versionId,p.sessionId,'',Date.now(),JSON.stringify({source:p.provider,model:settings.model||'provider default',calls:1,status:'unknown',kind:'speech.transcribe',duration:transcript.duration}));
    return {transcript,artifact:{artifactId:result.artifactId,versionId:result.versionId}};
  } finally {end();}
}

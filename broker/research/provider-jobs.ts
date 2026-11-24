import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Core } from '../core.ts';
import { providerCitations } from '../provider-codecs/streaming.ts';
import type { Source } from '../types.ts';
import { perplexityRoute, resolveProviderEndpoint } from '../provider-registry.ts';
import { responseJson } from '../provider-http.ts';
import { ProviderOutputFiles, perplexityResponseTrace, type ProviderOutputArtifact, type ProviderResponseTrace } from './provider-output-files.ts';

const start = z.strictObject({sessionId:z.uuid(),requestId:z.uuid().optional(),prompt:z.string().trim().min(1).max(8000),effort:z.enum(['fast','low','medium','high','xhigh','ultra']).optional()});
const lookup = z.strictObject({sessionId:z.uuid(),id:z.uuid()});
type Job = {id:string;sessionId:string;prompt:string;model:string;effort?:string;connectionId?:string;revision:number;credentialRevision:string;
  filters?:{search_domain_filter?:string[];search_recency_filter?:string};status:string;remoteId?:string;created:number;updated:number;text?:string;sources?:Source[];trace?:ProviderResponseTrace;
  files?:ProviderOutputArtifact[];recoveryNotes?:string[];outputFilesPending?:boolean;error?:string};
const terminal = new Set(['completed','incomplete','failed','cancelled']);
const states = new Set([...terminal,'queued','in_progress','cancelling']);
export class ProviderResearchJobs {
  core:Core;
  fetch=fetch;
  private busy=new Set<string>();
  private controller=new AbortController();
  readonly outputFiles:ProviderOutputFiles;
  constructor(core:Core) {
    this.core=core;
    this.outputFiles=new ProviderOutputFiles(core);
    core.store.db.exec('CREATE TABLE IF NOT EXISTS provider_research_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS provider_jobs_by_session ON provider_research_jobs(session_id)');
  }
  private drain = new Set<Promise<Job>>();
  async close() { this.controller.abort(); await Promise.allSettled(this.drain); }
  private request(job:Job, operation:'start'|'poll'|'cancel') {
    const work=this.dispatch(job,operation);this.drain.add(work);
    work.then(()=>this.drain.delete(work),()=>this.drain.delete(work));
    return work;
  }
  private write(job:Job) {
    job.updated=Date.now();
    this.core.store.db.prepare('INSERT INTO provider_research_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(job.id,job.sessionId,JSON.stringify(job));
  }
  list(sessionId:string):Job[] {
    this.core.store.session(sessionId);
    return this.core.store.db.prepare('SELECT data FROM provider_research_jobs WHERE session_id=? ORDER BY rowid DESC LIMIT 64').all(sessionId).map(row=>JSON.parse(String(row.data)));
  }
  private find(id:string):Job|undefined {
    const row=this.core.store.db.prepare('SELECT data FROM provider_research_jobs WHERE id=?').get(id);
    return row?JSON.parse(String(row.data)):undefined;
  }
  private activeCount(sessionId:string):number {
    const row=this.core.store.db.prepare("SELECT count(*) AS total FROM provider_research_jobs WHERE session_id=? AND json_extract(data,'$.status') IN ('queued','in_progress','cancelling') AND json_type(data,'$.remoteId')='text'").get(sessionId);
    return Number(row?.total||0);
  }
  private async dispatch(job:Job, operation:'start'|'poll'|'cancel') {
    if (this.busy.has(job.id)) throw new Error('A request is already in progress for this run');
    this.busy.add(job.id);
    try {
      const core=this.core, account=job.connectionId?core.chatConnections.get(job.connectionId,'perplexity'):undefined;
      if ((account?.revision??0)!==job.revision || core.credentials.credentialRevision(account?'connection:'+account.id:'provider:perplexity')!==job.credentialRevision)
        throw new Error('The account used for this research run changed');
      const session=core.store.session(job.sessionId);
      if(core.settingsFor(session.id).paused || session.remote && session.remote.role!=='owner')throw new Error('Research is paused or access changed');
      const access=core.accountAccess('perplexity',account?.id),key=access.key();
      if (!key) throw new Error('Add a Perplexity account key');
      const base=resolveProviderEndpoint('perplexity',access.route?.());
      const endpoint=base.replace(/\/+$/,'').replace(/\/v1$/,'')+'/v1/agent';
      const url=operation==='start'?endpoint:endpoint+'/'+encodeURIComponent(job.remoteId!)+(operation==='cancel'?'/cancel':'');
      const res=await this.fetch(url,{method:operation==='poll'?'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
        body:operation==='start'?JSON.stringify({...perplexityRoute(job.model,job.effort),input:job.prompt,background:true,tools:[{type:'web_search',...(job.filters?{filters:job.filters}:{})}],max_steps:8}):undefined,
        signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(30_000)]),redirect:'error'});
      if(!res.ok && operation==='start' && res.status>=400 && res.status<500) job.status='failed';
      const result=await responseJson(res);
      const id=result.id||result.response_id;
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(typeof id==='string'?id:'') || job.remoteId && id!==job.remoteId) throw new Error('Invalid provider response ID');
      job.remoteId=id;
      if (!states.has(result.status)) throw new Error('Unexpected provider job state');
      job.status=result.status;
      job.error=undefined;
      const parts=(Array.isArray(result.output)?result.output:[]).filter((i:any)=>i.type==='message').flatMap((i:any)=>Array.isArray(i.content)?i.content:[]).filter((p:any)=>p.type==='output_text');
      job.text=parts.map((p:any)=>String(p.text||'')).join('\n').slice(0,100000) || job.text;
      const sources=providerCitations('perplexity',result,id).slice(0,100);
      if (sources.length) job.sources=sources;
      job.trace=perplexityResponseTrace(result);
      if(terminal.has(job.status)){
        try{
          const captured=await this.outputFiles.capture({sessionId:job.sessionId,response:result,connectionId:job.connectionId,accountRevision:job.revision,credentialRevision:job.credentialRevision,allowDownload:true,operationId:job.id,signal:this.controller.signal});
          job.trace=captured.trace;job.files=captured.files;job.recoveryNotes=captured.recoveryNotes;job.outputFilesPending=false;
        }catch{
          job.outputFilesPending=true;job.recoveryNotes=['Generated files could not be kept yet. Poll this completed run to retry while the provider files remain available.'];
        }
      }
      core.store.transaction(()=>{
        this.write(job);
        if(terminal.has(job.status)) {
          if(job.text) core.store.message({id:'provider-research:'+job.id,sessionId:job.sessionId,role:'assistant',text:job.text,sources:job.sources,time:Date.now()});
          core.store.db.prepare('INSERT OR IGNORE INTO usage_records VALUES(?,?,?,?,?)').run(job.id,job.sessionId,'',Date.now(),JSON.stringify({calls:1,source:'perplexity',model:result.model||job.model,kind:'research',inputTokens:result.usage?.input_tokens,outputTokens:result.usage?.output_tokens}));
        }
      });
    } catch(error:any) {
      job.error=String(error.message).slice(0,300);
      this.write(job);
      throw error;
    } finally {this.busy.delete(job.id);this.core.changed();}
    return job;
  }
  async rpc(action:string,params:any) {
    if(action==='list') return this.list(z.uuid().parse(params.sessionId));
    if(action==='start') {
      const p=start.parse(params),s=this.core.store.session(p.sessionId);
      if(s.provider!=='perplexity'||s.temporary||s.remote&&s.remote.role!=='owner') throw new Error('Open a saved Perplexity conversation with owner access');
      if(this.core.settings.paused) throw new Error('Provider operations are paused');
      const account=s.connectionId?this.core.chatConnections.get(s.connectionId,'perplexity'):undefined;
      const options=s.api?.options||{},filters={...(Array.isArray(options.searchDomains)?{search_domain_filter:options.searchDomains as string[]}:{}),...(typeof options.searchRecency==='string'?{search_recency_filter:options.searchRecency}:{})};
      const effort=perplexityRoute(s.model||'',p.effort || s.effort || options.reasoningEffort).effort;
      const existing=p.requestId?this.find(p.requestId):undefined;
      if(existing) {
        if(existing.sessionId!==s.id)throw new Error('Research request ID already exists');
        const sameIntent=existing.prompt===p.prompt&&existing.effort===effort&&existing.model===(s.model||'')&&existing.connectionId===account?.id&&JSON.stringify(existing.filters||{})===JSON.stringify(filters);
        if(!sameIntent)throw new Error('Request ID already used for different research');
        return existing;
      }
      if(this.activeCount(s.id)>=4) throw new Error('Finish an active provider research run first');
      this.core.usage.assertWithinBudget('perplexity');
      const job:Job={...(Object.keys(filters).length?{filters}:{}),id:p.requestId||randomUUID(),sessionId:s.id,prompt:p.prompt,effort,model:s.model||'',connectionId:account?.id,revision:account?.revision||0,
        credentialRevision:this.core.credentials.credentialRevision(account?'connection:'+account.id:'provider:perplexity'),status:'unknown-outcome',created:Date.now(),updated:Date.now()};
      this.write(job); // A crash before the handle is durable must never cause automatic resubmission.
      return this.request(job,'start');
    }
    const p=lookup.parse(params);this.core.store.session(p.sessionId);
    const job=this.find(p.id);
    if(!job||job.sessionId!==p.sessionId) throw new Error('Unknown provider research run');
    if(terminal.has(job.status)&&!job.outputFilesPending) return job;
    if(!job.remoteId) throw new Error('The provider did not return a handle. Check the account before starting another run.');
    if(action!=='cancel' && action!=='poll') throw new Error('Unknown provider research action');
    return this.request(job,action);
  }
  tick() {
    const rows=this.core.store.db.prepare("SELECT data FROM provider_research_jobs WHERE json_extract(data,'$.status') IN ('queued','in_progress','cancelling') AND json_extract(data,'$.updated') < ? ORDER BY json_extract(data,'$.updated') LIMIT 4").all(Date.now()-15000);
    for (const row of rows) {const job:Job=JSON.parse(String(row.data)); if (!this.busy.has(job.id)) void this.request(job,'poll').catch(()=>{});}
  }
}

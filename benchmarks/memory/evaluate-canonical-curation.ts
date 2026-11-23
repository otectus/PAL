import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Canonical} from '../../broker/graph-memory/canonical.ts';
import {MemoryService} from '../../broker/graph-memory/service.ts';
import {createStatement} from '../../broker/graph-memory/statements.ts';
import {routeFingerprint} from '../../broker/graph-memory/task-models.ts';

type Row=Record<string,any>;
const model='hf.co/empero-ai/Qwen3.8-4B-Distill-GGUF:Q8_0';
const output=resolve(process.argv[2]||'build/memory-0.1.6/canonical-curation.json');
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const cases=[
  {key:'preference',role:'user',category:'preference',modality:'actual',quote:'I prefer concise review summaries.'},
  {key:'decision',role:'user',category:'decision',modality:'actual',quote:'I choose the copper checklist for Project Orchid deployments.'},
  {key:'plan',role:'user',category:'goal',modality:'planned',quote:'I plan to publish the Orchid migration guide next month.'},
  {key:'assistant',role:'assistant',category:'project_convention',modality:'actual',quote:'Assistant recommends keeping rollback notes beside each deployment record.'},
] as const;

const directory=await mkdtemp(join(tmpdir(),'pal-canonical-curation-'));
const identities:Row[]=[];
let service:MemoryService|undefined;
const nativeFetch=globalThis.fetch;
const transport={chat:0,tags:0,show:0};
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.hostname==='127.0.0.1'&&url.port==='11434'){
    if(url.pathname==='/api/chat')transport.chat++;
    else if(url.pathname==='/api/tags')transport.tags++;
    else if(url.pathname==='/api/show')transport.show++;
  }
  return nativeFetch(input as any,init);
};

const configureService=async()=>{
  const instance=new MemoryService(directory);clearInterval(instance.timer);
  await instance.call('configure',{enabled:true,paused:false,host:'http://127.0.0.1:11434',embedding_model:'nomic-embed-text',
    extraction_model:'',allow_cloud_extraction:false,allow_cloud_memory:false});
  return instance;
};

try{
  const tags=await (await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(10000)})).json();
  const localTag=tags.models?.find((entry:Row)=>entry.model===model||entry.name===model);
  if(!localTag||typeof localTag.digest!=='string')throw new Error(`Requested local model is not installed: ${model}`);
  const routeIdentity={connectionRef:'default:ollama',connectionRevision:0,credentialRef:'none',credentialRevision:'none',adapterId:'ollama',
    endpoint:'http://127.0.0.1:11434',modelId:model,processing:'local' as const,modelVersion:localTag.model||localTag.name||model,modelDigest:localTag.digest};
  const fingerprint=routeFingerprint(routeIdentity);
  const seed=new Canonical(join(directory,'graph-memory'));
  try{
    seed.policyUpdate({policy:{enabled:true,retain_evidence:true,raw_turn_days:30,candidate_days:7}});
    for(const item of cases){
      const scope=seed.registerScope({key:`canonical-curation-${item.key}`,label:`Synthetic ${item.key}`}).id;
      const observation=seed.observeText({scope_id:scope,role:item.role,text:item.quote,sensitivity:'local_only',
        session_id:`synthetic:${item.key}`,source_event_id:`synthetic:${item.key}:1`});
      const statement=seed.tx((_,time)=>createStatement(seed,scope,{statement:{category:item.category,modality:item.modality},
        witness:{observation_id:observation.id,quote:item.quote}},time));
      identities.push({...item,scope_id:scope,observation_id:observation.id,version_id:statement.id,logical_id:statement.logical_id});
    }
  }finally{seed.close()}

  service=await configureService();
  const binding={connectionRef:'default:ollama',modelId:model,fallbackBindings:[]};
  await service.call('curation_configure',{expected_revision:0,profile:{mode:'automatic',reviewModel:binding,autoAccept:true,unmeasuredFingerprint:fingerprint,
    allowCloudCuration:false,retainCurationEvidence:true,threshold:0,dailyRequests:40,dailyInput:400000,dailyOutput:80000,
    inputLimit:16000,outputLimit:2000,timeoutMs:120000}});

  for(const item of identities){
    const preview=await service.call('curation_preview',{scope_id:item.scope_id,ids:[item.version_id]});
    const queued=await service.call('curation_run',{scope_id:item.scope_id,ids:[item.version_id],selection:preview.selection});
    if(queued.queued!==1)throw new Error(`Could not queue synthetic ${item.key} case`);
  }
  const processing:Row[]=[];
  for(let index=0;index<cases.length;index++){
    const started=performance.now(),before=transport.chat;
    if(!await service.review.process(new AbortController().signal))break;
    processing.push({wall_ms:Math.round(performance.now()-started),chat_requests:transport.chat-before});
  }

  const evaluated:Row[]=[];
  for(const item of identities){
    const list=await service.call('curation_list',{scope_id:item.scope_id,limit:10});
    const row=list.rows.find((candidate:Row)=>candidate.version_id===item.version_id);
    const inspected=await service.call('inspect',{scope_id:item.scope_id,id:item.logical_id});
    const evidence=row?.evidence?.[0]??inspected.evidence[0];
    evaluated.push({key:item.key,scope_id:item.scope_id,source:{role:item.role,observation_id:item.observation_id,
      quote:item.quote,quote_bytes:Buffer.byteLength(item.quote,'utf8'),quote_sha256:sha(item.quote)},
      target:{kind:'statement',version_id:item.version_id,logical_id:item.logical_id,category:item.category,modality:item.modality},
      job:{id:row?.id??null,state:row?.state??null,error_code:row?.error_code??null,attempts:row?.attempts??null,
        assessment_id:row?.assessment_id??null,assessment_latency_ms:row?.elapsed_ms??null},
      assessment:row?.output??null,adjudication:row?.verdict??null,
      producer:row?.producer??null,recommended_action:row?.recommended_action??null,
      decision:row?.decision_id?{id:row.decision_id,action:row.action,actor:row.actor,revision:row.decision_revision}:null,
      final_status:inspected.record.status,evidence:{id:evidence?.id??null,trust:evidence?.trust??null,
        exact_quote:evidence?.quote??evidence?.witness??null,exact_quote_bytes:Buffer.byteLength(evidence?.quote??evidence?.witness??'','utf8')}});
  }
  const statusBefore=await Promise.all(identities.map(item=>service!.call('curation_status',{scope_id:item.scope_id})));
  const usage=statusBefore[0].usage;
  const retained=evaluated.find(item=>item.decision?.action==='preserve');
  const retentionCase=retained??evaluated.find(item=>item.key==='plan'&&item.final_status==='candidate')??evaluated.find(item=>item.final_status==='candidate');
  if(!retentionCase)throw new Error('The real-model run left no live candidate for the retention-only check');
  const retentionIdentity=identities.find(item=>item.key===retentionCase.key)!;
  let retentionProtection:Row={origin:'model_decision',decision_id:retained?.decision?.id};
  if(!retained){
    const preview=await service.call('retention_preview',{scope_id:retentionIdentity.scope_id,target_ids:[retentionIdentity.version_id],reason:'automatic_preservation',timezone:'UTC'});
    const protectedResult=await service.call('retention_protect',{scope_id:retentionIdentity.scope_id,selection:preview.selection,
      expected_revision:preview.revision,reason:'automatic_preservation',items:[preview.items[0].target_id],output:join(directory,'retention-backup.sqlite')});
    retentionProtection={origin:'bounded_retention_preview_protect',preview:{counts:preview.counts,item:preview.items[0]},
      result:{protected:protectedResult.protected,already_protected:protectedResult.already_protected,revision:protectedResult.revision}};
  }
  const forecastBefore=await service.call('retention_forecast',{scope_id:retentionIdentity.scope_id,id:retentionIdentity.logical_id,timezone:'UTC'});

  await service.close();service=undefined;
  const fixture=new Canonical(join(directory,'graph-memory'));
  const expiredAt=Date.now()*1000-1_000_000;
  try{
    const evidence=fixture.one('SELECT e.id,e.observation_id,o.payload_id FROM memory_statement_evidence m JOIN evidence e ON e.id=m.evidence_id JOIN observations o ON o.id=e.observation_id WHERE m.version_id=?',retentionIdentity.version_id);
    fixture.run('UPDATE payloads SET expires_us=? WHERE id=?',expiredAt,evidence.payload_id);
    fixture.run('UPDATE memory_statement_versions SET expires_at_us=? WHERE version_id=?',expiredAt,retentionIdentity.version_id);
  }finally{fixture.close()}

  service=await configureService();
  const expiration=await service.call('expire');
  const retainedInspect=await service.call('inspect',{scope_id:retentionIdentity.scope_id,id:retentionIdentity.logical_id});
  await service.close();service=undefined;
  const retentionAudit=new Canonical(join(directory,'graph-memory'));
  let afterExpiry:Row;
  try{
    const row=retentionAudit.one(`SELECT s.status,s.erased,s.expires_at_us,e.witness,e.erased AS evidence_erased,p.body,p.erased AS payload_erased,
      (SELECT COUNT(*) FROM retention_holds h WHERE h.target_kind='statement' AND h.target_id=s.logical_id AND h.released_revision IS NULL AND (h.expires_at_us IS NULL OR h.expires_at_us>?)) AS active_holds
      FROM memory_statement_versions s JOIN memory_statement_evidence m ON m.version_id=s.version_id JOIN evidence e ON e.id=m.evidence_id
      JOIN observations o ON o.id=e.observation_id JOIN payloads p ON p.id=o.payload_id WHERE s.version_id=?`,Date.now()*1000,retentionIdentity.version_id);
    afterExpiry={status:row.status,target_erased:!!row.erased,candidate_deadline_expired:row.expires_at_us<=Date.now()*1000,
      raw_payload_erased:!!row.payload_erased,raw_payload_bytes:Buffer.byteLength(row.body||'','utf8'),retained_excerpt:row.witness,
      retained_excerpt_bytes:Buffer.byteLength(row.witness||'','utf8'),evidence_erased:!!row.evidence_erased,active_holds:row.active_holds,
      inspect_status:retainedInspect.record.status};
  }finally{retentionAudit.close()}

  service=await configureService();
  const erased=await service.call('forget',{scope_id:retentionIdentity.scope_id,id:retentionIdentity.observation_id});
  let inspectError:Row|null=null;
  try{await service.call('inspect',{scope_id:retentionIdentity.scope_id,id:retentionIdentity.logical_id})}
  catch(error:any){inspectError={code:error?.code??null,message:String(error?.message??error)}}
  const recall=await service.call('retrieve',{scope_id:retentionIdentity.scope_id,text:retentionIdentity.quote,token_budget:1000});
  await service.close();service=undefined;
  const erasureAudit=new Canonical(join(directory,'graph-memory'));
  let erasureState:Row;
  try{
    erasureState={live_payload_matches:erasureAudit.one('SELECT COUNT(*) AS n FROM payloads WHERE erased=0 AND body=?',retentionIdentity.quote).n,
      live_evidence_matches:erasureAudit.one('SELECT COUNT(*) AS n FROM evidence WHERE erased=0 AND witness=?',retentionIdentity.quote).n,
      live_statement_matches:erasureAudit.one('SELECT COUNT(*) AS n FROM memory_statement_versions WHERE erased=0 AND text=?',retentionIdentity.quote).n,
      retrieval_document_matches:erasureAudit.one('SELECT COUNT(*) AS n FROM retrieval_documents WHERE text=?',retentionIdentity.quote).n,
      remaining_assessments:erasureAudit.one('SELECT COUNT(*) AS n FROM memory_assessments WHERE version_id=?',retentionIdentity.version_id).n,
      active_holds:erasureAudit.one("SELECT COUNT(*) AS n FROM retention_holds WHERE target_kind='statement' AND target_id=? AND released_revision IS NULL",retentionIdentity.logical_id).n};
  }finally{erasureAudit.close()}
  const registryPath=join(directory,'graph-memory','erasure-registry.jsonl');
  const registry=(await readFile(registryPath,'utf8').catch(()=>'' as string)).trim().split('\n').filter(Boolean);

  const report:Row={schema_version:1,benchmark:'canonical-curation-real-model',generated_at:new Date().toISOString(),
    safety:{synthetic_only:true,disposable_profile:true,isolated_scopes:true,local_endpoint:'http://127.0.0.1:11434',cloud_requests:false,
      experimental_acceptance:{enabled:true,mechanism:'unmeasuredFingerprint',fingerprint}},
    model:{requested:model,local_tag_digest:localTag.digest,local_size_bytes:localTag.size??null,resolved_route:{...routeIdentity,fingerprint}},
    transport:{chat_requests:transport.chat,tags_requests:transport.tags,show_requests:transport.show,
      review_chat_requests:transport.chat},
    curation:{process_calls:processing,usage,cases:evaluated},
    retention_only:{case:retentionIdentity.key,protection:retentionProtection,forecast_before_fixture_deadlines:{target_kind:forecastBefore.target_kind,status:forecastBefore.status,
      baseline_expires_at_us:forecastBefore.baseline_expires_at_us,effective_expires_at_us:forecastBefore.effective_expires_at_us,
      last_support_loss_at_us:forecastBefore.last_support_loss_at_us,protection_reasons:forecastBefore.protection_reasons},
      fixture:{raw_payload_and_candidate_deadlines_moved_to_past:true},expiration,after_expiry:afterExpiry},
    source_erasure:{case:retentionIdentity.key,source_observation_id:retentionIdentity.observation_id,result:erased,
      inspection_after_erasure:inspectError,recall_items_after_erasure:recall.items.length,sqlite:erasureState,registry_entries:registry.length},
  };
  report.payload_digest_sha256=sha(JSON.stringify(report));
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({output,payload_digest_sha256:report.payload_digest_sha256,cases:evaluated.length,
    chat_requests:transport.chat,usage,retention_case:retentionIdentity.key,erasure:erasureState},null,2));
}finally{
  globalThis.fetch=nativeFetch;
  await service?.close().catch(()=>{});
  await rm(directory,{recursive:true,force:true});
}

import { createHash, randomUUID } from 'node:crypto';
import type { Canonical } from './canonical.ts';
import { fail, parse } from './contracts.ts';
import { adjudicationSchema, allowedIds, assessedValue, contractVersion, profileSchema, synthesisSchema, rubricVersion, validateAssessment, type Profile, type Assessment } from './assessment.ts';
import { amendStatement, createStatement, statementSupport } from './statements.ts';

type Row = Record<string,any>;
const now = () => Date.now()*1000;
const hash = (x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** A synthesis input's evidence as the model read it, independent of the order a query returned it in. */
const evidenceDigest = (rows:unknown)=>Array.isArray(rows)
  ?hash(rows.map((e:Row)=>[String(e?.id),String(e?.role),String(e?.quote)]).sort((a,b)=>a[0].localeCompare(b[0])))
  :null;
const pageSize = (value:unknown, fallback=25) => Math.max(1,Math.min(200,Number.isSafeInteger(value)?Number(value):fallback));
const sources = { assertion:'assertion_versions',statement:'memory_statement_versions' } as const;
const dueStates = "('queued','retryable')";
export class Curation {
  store:Canonical;
  constructor(store:Canonical){this.store=store;}
  profile(){return parse(profileSchema,this.store.meta('curation_profile',{}));}
  revision(){return this.store.meta('curation_config_revision',0);}
  settings(){return {profile:this.profile(),revision:this.revision()};}
  configure(p:Row){
    if(p.expected_revision!==this.revision())fail('REVISION_CONFLICT','Memory review settings changed. Reload before saving.');
    const profile=parse(profileSchema,{...this.profile(),...p.profile});
    if(profile.mode!=='off'&&!profile.reviewModel)fail('INVALID_ARGUMENT','Choose a memory review model');
    const c=this.store;
    return c.queue(()=>{
      c.setMeta('curation_config_revision',this.revision()+1);
      c.setMeta('curation_profile',profile);
      if(typeof p.manifest==='string')c.setMeta('curation_route_manifest',p.manifest);
      c.run("UPDATE memory_curation_jobs SET state='stale',error_code='CONFIG_CHANGED',lease_token=NULL WHERE state IN ('queued','leased','retryable','review_needed','blocked')");
      return this.settings();
    });
  }
  target(job:Row){
    const table=sources[job.kind as keyof typeof sources];
    if(!table)fail('INVALID_ARGUMENT','Invalid memory kind');
    const v=this.store.one('SELECT * FROM '+table+' WHERE version_id=? AND scope_id=? AND known_to_revision IS NULL AND erased=0',job.version_id,job.scope_id);
    if(!v.version_id)fail('SOURCE_CHANGED','Memory was corrected or forgotten');
    return v;
  }
  bundle(job:Row){
    const c=this.store,v=this.target(job);
    if(v.status!=='candidate')fail('SOURCE_CHANGED','Memory is no longer pending review');
    const retention=c.retentionDecision(c.retentionTarget(v.scope_id,v.version_id),now());
    if(!retention.recallAllowedByRetention)fail('SOURCE_CHANGED','Memory expired before review');
    const graph=job.kind==='assertion', evidence=graph?c.support(v.version_id):statementSupport(c,v.version_id);
    if(!evidence.length||evidence.length>16)fail('INCOMPLETE_EVIDENCE','Missing or oversized evidence set');
    const support=evidence.sort((a,b)=>a.id.localeCompare(b.id)).map(e=>{
      const o=c.one('SELECT o.role,o.payload_id,o.revision,o.occurred_us,o.captured_us,o.erased,p.body,p.erased AS expired,p.expires_us FROM observations o LEFT JOIN payloads p ON p.id=o.payload_id WHERE o.id=? AND o.scope_id=?',e.observation_id,v.scope_id);
      if(o.erased||o.revision!==e.source_revision||!e.witness||hashText(e.witness)!==e.digest)fail('SOURCE_CHANGED','Evidence changed');
      const full=typeof o.body==='string'&&!o.expired&&(!o.expires_us||o.expires_us>now()||c.activePin(e.observation_id));
      const context=full&&o.body.length<=8000?o.body:null;
      return {id:e.id,source:e.observation_id,context_id:context?o.payload_id:null,source_revision:e.source_revision,role:o.role,trust:e.trust,occurred_us:o.occurred_us,captured_us:o.captured_us,quote:e.witness,locator:e.locator,context,context_missing:!context,sensitivity:e.sensitivity,independence_group:e.independence_group};
    });
    const claim=graph?c.claimData(v):{category:v.category,text:v.text,modality:v.modality,epistemic_type:v.epistemic_type,valid_mode:v.valid_mode};
    if('extraction_confidence' in claim)delete (claim as Row).extraction_confidence;
    const hint=c.one('SELECT h.importance,h.durability,r.model_identity FROM memory_extractor_hints h JOIN extraction_runs r ON r.id=h.run_id WHERE h.version_id=? ORDER BY r.revision DESC LIMIT 1',v.version_id);
    const reasons=graph?[...new Set(evidence.flatMap(e=>c.holdReasons(e,claim as any,true)))]:[];
    const neighbors=graph?c.all("SELECT * FROM assertion_versions WHERE slot_id=? AND version_id!=? AND known_to_revision IS NULL AND erased=0 AND status IN ('accepted','disputed','candidate') ORDER BY aggregate_revision DESC,version_id LIMIT 10",v.slot_id,v.version_id)
      :c.all("SELECT * FROM memory_statement_versions WHERE scope_id=? AND category=? AND version_id!=? AND known_to_revision IS NULL AND erased=0 AND status IN ('accepted','disputed','candidate') ORDER BY aggregate_revision DESC,version_id LIMIT 10",v.scope_id,v.category,v.version_id);
    // Only eligible neighbors from the exact project, with one live supporting excerpt each.
    const related=neighbors.flatMap(n=>{
      const a=c.one('SELECT id FROM artifacts WHERE record_id=? AND invalidated=0',n.version_id);
      const item=a.id&&c.hydrateArtifact(a.id,v.scope_id,c.revision,undefined,'local');
      if(!item)return [];
      const e=item.evidence[0];
      return [{id:n.version_id,text:item.text,status:n.status,evidenceId:e.id,quote:e.witness,date:n.known_from_us,
        sensitivity:[n,...item.evidence].some(x=>x.sensitivity==='local_only')?'local_only':'cloud_allowed'}];
    });
    return {version_id:v.version_id,logical_id:v.logical_id,kind:job.kind,scope_id:v.scope_id,revision:v.aggregate_revision,status:v.status,claim,extractor_hint:hint.model_identity?hint:null,
      text:graph?c.assertionText(v):v.text,sensitivity:v.sensitivity,evidence:support,neighbors:related,reasons,category:graph?'assertion':v.category};
  }
  candidates(scope:string|undefined,limit:number,ids?:string[]) {
    const c=this.store,rev=this.revision(), rows:Row[]=[];
    if(scope)c.scope(scope);
    for(const [kind,table] of Object.entries(sources)){
      rows.push(...c.all(`SELECT v.version_id,v.logical_id,v.scope_id,v.expires_at_us,v.aggregate_revision,? AS kind FROM ${table} v
        WHERE v.status='candidate' AND v.erased=0 AND v.known_to_revision IS NULL
        ${scope?'AND v.scope_id=?':''} ${ids?'AND v.version_id IN (SELECT value FROM json_each(?))':''}
        AND NOT EXISTS(SELECT 1 FROM memory_curation_jobs j WHERE j.version_id=v.version_id AND j.config_revision=? AND
          (j.state NOT IN ('stale') OR (j.erasure_epoch=? AND j.policy_epoch=?)))
        ORDER BY v.expires_at_us,v.version_id LIMIT ?`,kind,...(scope?[scope]:[]),...(ids?[JSON.stringify(ids)]:[]),rev,c.epoch('erasure'),c.epoch('policy'),limit));
    }
    return rows.map(row=>{
      const f=c.retentionDecision(c.retentionTarget(row.scope_id,row.version_id),now());
      return {...row,effective_expires_at_us:f.effectiveExpiresAtUs} as Row;
    }).sort((a,b)=>(a.effective_expires_at_us??Infinity)-(b.effective_expires_at_us??Infinity)||a.version_id.localeCompare(b.version_id)).slice(0,limit);
  }
  enqueue(p:Row,internal=false,preview=false){
    const c=this.store, pf=this.profile();
    if(!internal)c.scope(p.scope_id);
    if(p.ids!==undefined&&(!Array.isArray(p.ids)||p.ids.length>200||p.ids.some((s:unknown)=>typeof s!=='string')))fail('INVALID_ARGUMENT','Select up to 200 current versions');
    const rows=this.candidates(p.scope_id,pageSize(p.limit,internal?8:50),p.ids);
    // The rows themselves show any erasure that touched this selection; an unrelated one, such as
    // routine expiry, must not void a preview the person is still reading.
    const selection=hash([rows,p.scope_id,this.revision(),c.epoch('policy')]);
    if(preview||p.dry_run)return {rows,selection,count:rows.length};
    if(!c.policy.enabled||pf.mode==='off')return {queued:0,reason:'CURATION_OFF'};
    if(!internal && p.selection!==selection)fail('REVISION_CONFLICT','Preview this selection again');
    return c.queue(()=>{
      let queued=0;
      for(const r of rows){
        const expired=r.effective_expires_at_us!=null&&r.effective_expires_at_us<=now();
        const inserted=c.run(`INSERT OR IGNORE INTO memory_curation_jobs(id,scope_id,kind,version_id,logical_id,config_revision,policy_epoch,erasure_epoch,state,created_us,due_us,priority_us,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          randomUUID(),r.scope_id,r.kind,r.version_id,r.logical_id,this.revision(),c.epoch('policy'),c.epoch('erasure'),expired?'stale':'queued',now(),now(),r.effective_expires_at_us??Number.MAX_SAFE_INTEGER,expired?'EXPIRED_BEFORE_REVIEW':null);
        if(inserted.changes&&!expired)queued++;
      }
      return {queued,selected:rows.length};
    });
  }
  claim(){
    const c=this.store;if(!c.policy.enabled||this.profile().mode==='off')return null;
    return c.queue(()=>{
      c.run("UPDATE memory_curation_jobs SET state=CASE WHEN attempts>=3 THEN 'blocked' ELSE 'retryable' END,lease_token=NULL,error_code='LEASE_EXPIRED' WHERE state='leased' AND lease_until_us<=?",now());
      const job=c.one(`SELECT * FROM memory_curation_jobs WHERE state IN ${dueStates} AND due_us<=? ORDER BY priority_us,created_us LIMIT 1`,now());
      if(!job.id)return null;
      try{
        this.live(job);
        const bundle=this.bundle(job),token=randomUUID();
        c.run("UPDATE memory_curation_jobs SET state='leased',attempts=attempts+1,input_hash=?,lease_token=?,lease_until_us=? WHERE id=?",hash(bundle),token,now()+300e6,job.id);
        return {id:job.id,token,bundle,config_revision:this.revision(),profile:this.profile()};
      }catch(e:any){
        c.run("UPDATE memory_curation_jobs SET state='stale',error_code=? WHERE id=?",e.code||'SOURCE_CHANGED',job.id);
        return null;
      }
    });
  }
  /**
   * Whether a job's settings still hold. Its sources are fenced separately and exactly: claim, finish
   * and apply rebuild the bundle and compare its digest with the one the reviewer saw, and erasing an
   * input deletes or stales the job (scrubRecord in erasure-scrub.ts). The global erasure epoch is not compared: every
   * routine expiry advances it, so comparing it discarded review results made across any unrelated
   * expiry, re-queued them, and could keep a busy store from finishing a review at all.
   */
  live(job:Row){
    const c=this.store;
    if(!c.policy.enabled||this.profile().mode==='off'||job.config_revision!==this.revision()||job.policy_epoch!==c.epoch('policy'))fail('SOURCE_CHANGED','Review settings or sources changed');
  }
  lease(p:Row){
    const job=this.store.one("SELECT * FROM memory_curation_jobs WHERE id=? AND state='leased' AND lease_token=? AND lease_until_us>?",p.id,p.token,now());
    if(!job.id)fail('SOURCE_CHANGED','Review was cancelled or its lease expired');
    this.live(job);
    return job;
  }
  reserve(p:Row){
    const c=this.store,profile=this.profile(),day=new Date().toISOString().slice(0,10);
    return c.queue(()=>{
      if(p.id)this.lease(p);
      if(p.config_revision!==this.revision())fail('SOURCE_CHANGED','Review settings changed');
      if(!Number.isSafeInteger(p.input)||!Number.isSafeInteger(p.output)||p.input<=0||p.input>profile.inputLimit||p.output<=0||p.output>profile.outputLimit)fail('INPUT_LIMIT','Request exceeds the configured token limit');
      const used=this.usage(day);
      const cost=profile.inputMicrosPerMillion===null||profile.outputMicrosPerMillion===null?null:Math.ceil((p.input*profile.inputMicrosPerMillion+p.output*profile.outputMicrosPerMillion)/1e6);
      if(used.requests+1>profile.dailyRequests||used.input_tokens+p.input>profile.dailyInput||used.output_tokens+p.output>profile.dailyOutput||
        (profile.dailyCostMicros!==null&&(cost===null||used.unknown_cost||used.cost_micros+cost>profile.dailyCostMicros)))fail('BUDGET_EXHAUSTED','Daily budget reached or price unavailable');
      const id=randomUUID();
      c.insert('memory_curation_usage',{id,day,task:p.task,input_tokens:p.input,output_tokens:p.output,cost_micros:cost,state:'reserved',route:p.route??null,input_price:profile.inputMicrosPerMillion,output_price:profile.outputMicrosPerMillion});
      return {id};
    });
  }
  usage(day=new Date().toISOString().slice(0,10)){
    return this.store.one("SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,CASE WHEN COUNT(cost_micros)=COUNT(*) THEN COALESCE(SUM(cost_micros),0) ELSE NULL END AS cost_micros,COUNT(*)-COUNT(cost_micros) AS unknown_cost,COUNT(*) FILTER(WHERE state='reserved') AS uncertain FROM memory_curation_usage WHERE day=?",day);
  }
  settle(p:Row){
    const c=this.store,row=c.one("SELECT * FROM memory_curation_usage WHERE id=? AND state='reserved'",p.id);
    if(!row.id)return;
    if(!Number.isSafeInteger(p.input)||p.input<0||!Number.isSafeInteger(p.output)||p.output<0)return;
    const cost=row.input_price===null||row.output_price===null?null:Math.ceil((p.input*row.input_price+p.output*row.output_price)/1e6);
    c.run("UPDATE memory_curation_usage SET state='reported',input_tokens=?,output_tokens=?,cost_micros=? WHERE id=?",p.input,p.output,cost,p.id);
  }
  hardGate(v:Row,b:Row,a:Assessment,pf:Profile) {
    if(v.status!=='candidate'||!pf.acceptCategories.includes(b.category)||a.support!=='supported'||a.suggestedAction!=='keep'||a.missingContext.length||
      a.conflictsWith.length||a.duplicateOf||v.modality!=='actual'||!['explicit_user','instrumented'].includes(v.epistemic_type))return false;
    if(b.kind==='statement'){
      // Only an exact first-person declaration can become an automatically
      // accepted generic statement. Broader interpretations remain reviewable.
      const direct=/^I (?:prefer|require|always use|choose) [^?!"“”\n]{1,500}[.!]?$/iu;
      if(!direct.test(v.text)||/\b(?:might|if|unless|maybe|tomorrow|plan|heard|said|hypothetically)\b/i.test(v.text)||!b.evidence.every((e:Row)=>e.context?.trim()===v.text))return false;
    }
    if(v.time_expression||v.time_precision==='approximate'||v.conflict_set_id||b.neighbors.length)return false;
    if(!b.evidence.every((e:Row)=>e.trust===v.epistemic_type&&e.context&&!e.context_missing&&a.evidenceIds.includes(e.id)))return false;
    // Entailment may resolve a missing predicate cue or typography. All other
    // deterministic holds (including polarity, role, modality, or date) stand.
    return b.reasons.every((r:string)=>['ungrounded: no cue for the predicate','ungrounded: quotation marks in the sentence'].includes(r));
  }
  recommend(job:Row,b:Row,a:Assessment,verdict:Row|null,verified:boolean){
    const pf=this.profile(),v=this.target(job),value=assessedValue(a);
    const accept=this.hardGate(v,b,a,pf)&&verdict?.entailed===true&&!verdict.ambiguous&&verdict.subjectPreserved&&verdict.polarityPreserved&&
      verdict.modalityPreserved&&verdict.timePreserved&&b.reasons.every((r:string)=>verdict.resolvedReasons.includes(r))&&
      a.evidenceIds.every(id=>verdict.evidenceIds.includes(id));
    if(accept&&verified)return 'accept';
    if(a.support==='contradicted'||a.conflictsWith.length||a.duplicateOf)return 'review';
    if(pf.retainCurationEvidence&&value!==null&&value>=pf.threshold&&['keep','preserve_uncertain'].includes(a.suggestedAction))return 'preserve';
    return a.suggestedAction==='no_change'?'no_change':'review';
  }
  verified(producer:Row,pf:Profile,category:string){
    if(!producer.adjudicate?.fingerprint||!producer.assess?.fingerprint)return false;
    const fingerprints=[producer.assess.fingerprint,producer.adjudicate.fingerprint];
    // This is the explicit experimental bypass. It is intentionally separate
    // from (and never represented as) a measured qualification.
    if(!!pf.unmeasuredFingerprint&&fingerprints.every(f=>pf.unmeasuredFingerprint===f))return true;
    const contract={contract:contractVersion,rubric:rubricVersion,parser:1,assessmentSchema:1,adjudicationSchema:1};
    const policy={acceptCategories:[...pf.acceptCategories].sort(),threshold:pf.threshold,retainCurationEvidence:pf.retainCurationEvidence};
    const identityFields=['fingerprint','connectionRef','connectionRevision','credentialRef','credentialRevision','adapterId','modelId','modelVersion','modelDigest','processing','outputMode','prompt','parser','schema','rubric'];
    const exactIdentity=(actual:Row,measured:Row)=>!!actual&&!!measured&&typeof actual.modelVersion==='string'&&actual.modelVersion.length>0&&
      identityFields.every(field=>(actual[field]??null)===(measured[field]??null));
    return this.store.all('SELECT result FROM memory_model_evaluations WHERE fingerprint=? AND rubric=?',fingerprints[0],rubricVersion).some(row=>{
      try{
        const result=JSON.parse(row.result),stats=result.categories?.[category];
        return result.qualification_basis==='measured'&&result.qualified===true&&result.qualified_categories?.includes(category)&&
          JSON.stringify(result.contract)===JSON.stringify(contract)&&JSON.stringify(result.policy)===JSON.stringify(policy)&&
          stats?.qualified===true&&stats.action_precision===1&&stats.support_precision===1&&stats.evidence_precision===1&&
          exactIdentity(producer.assess,result.assessor)&&exactIdentity(producer.adjudicate,result.adjudicator);
      }catch{return false;}
    });
  }
  finish(p:Row){
    const c=this.store,job=this.lease(p),bundle=this.bundle(job);
    if(hash(bundle)!==job.input_hash)fail('SOURCE_CHANGED','Review inputs changed');
    const output=validateAssessment(p.output,bundle),pf=this.profile();
    const verdict=p.verdict==null?null:parse(adjudicationSchema,p.verdict);
    if(verdict){
      if(verdict.targetVersionId!==bundle.version_id)fail('INVALID_CITATION','Adjudication target changed');
      allowedIds(verdict.evidenceIds,bundle.evidence.map(e=>e.id));allowedIds(verdict.resolvedReasons,bundle.reasons);
    }
    const action=this.recommend(job,bundle,output,verdict,pf.autoAccept&&this.verified(p.producer,pf,bundle.category));
    const substantive=pf.mode==='automatic'&&(action==='preserve'||action==='accept'&&pf.autoAccept);
    const write=(apply:boolean,reason:string|null=null)=>{
      const id=randomUUID(),stamp=now();
      c.insert('memory_assessments',{id,job_id:job.id,version_id:job.version_id,output:JSON.stringify(output),verdict:verdict?JSON.stringify(verdict):null,
        producer:JSON.stringify(p.producer),input_hash:job.input_hash,rubric:rubricVersion,assessed_value:assessedValue(output),created_us:stamp,elapsed_ms:p.elapsed_ms});
      const inputs=[job.version_id,...bundle.evidence.flatMap(e=>[e.id,e.source,...(e.context_id?[e.context_id]:[])]),...bundle.neighbors.flatMap(n=>[n.id,n.evidenceId])];
      for(const input of new Set(inputs))c.run('INSERT INTO memory_assessment_inputs VALUES (?,?)',id,input);
      if(apply)return this.applyDecision(job,id,action,'automatic');
      c.run("UPDATE memory_curation_jobs SET state='review_needed',lease_token=NULL,error_code=? WHERE id=?",reason,job.id);
      return {id,action,applied:false};
    };
    if(!substantive)return c.queue(()=>write(false));
    try{return this.mutate(()=>write(true));}
    catch(error:any){
      if(action!=='preserve'||error.code!=='LIMIT_EXCEEDED')throw error;
      return c.queue(()=>write(false,'RETENTION_CAPACITY'));
    }
  }
  mutate<T>(work:()=>T) {
    const c=this.store;
    return c.tx(()=>{c.batchTransaction=true;try{return work();}finally{c.batchTransaction=false;}});
  }
  amend(job:Row,v:Row,patch:Row){
    const c=this.store,stamp=c.one('SELECT transaction_us FROM commits WHERE revision=?',c.revision).transaction_us;
    if(job.kind==='statement')return amendStatement(c,v,patch,stamp);
    const id=c.amend(v,patch,stamp);
    c.run('UPDATE fact_slots SET aggregate_revision=? WHERE id=?',c.revision,v.slot_id);c.effect(v.slot_id);
    return id;
  }
  applyDecision(job:Row,assessmentId:string,action:string,actor:string){
    const c=this.store,pf=this.profile(),v=this.target(job),id=randomUUID();
    let after=v.version_id,hold=null;
    if(action==='accept'){
      after=this.amend(job,v,{status:'accepted',expires_at_us:null,...(job.kind==='assertion'?{retention_class:'evidence'}:{})});
    }else if(action==='preserve'){
      const evidenceIds: string[]=JSON.parse(c.one('SELECT output FROM memory_assessments WHERE id=?',assessmentId).output).evidenceIds;
      const r=c.preserveRetention({evidence_ids:evidenceIds.length?evidenceIds:undefined,scope_id:job.scope_id,target_kind:job.kind,target_id:v.logical_id,reason:'automatic_preservation',
        source_decision_id:id,policy_revision:this.revision(),expires_at_us:now()+pf.preserveDays*864e8,max_expires_at_us:now()+pf.maxUnresolvedDays*864e8});
      hold=r.id;
    }
    const producers=JSON.parse(c.one('SELECT producer FROM memory_assessments WHERE id=?',assessmentId).producer);
    const producerRef=Object.fromEntries(Object.entries(producers).map(([task,identity])=>{
      const route=identity as Row;
      return [task,{model:route.modelId,fingerprint:route.fingerprint}];
    }));
    c.insert('memory_curation_decisions',{id,job_id:job.id,assessment_id:assessmentId,producer_ref:JSON.stringify(producerRef),actor,rule:contractVersion,action,before_id:v.version_id,after_id:after,hold_id:hold,revision:c.revision,created_us:now()});
    c.run("UPDATE memory_curation_jobs SET state='applied',error_code=NULL,lease_token=NULL WHERE id=?",job.id);
    return {id,action,after_id:after,revision:c.revision,applied:true};
  }
  apply(p:Row){
    const c=this.store,job=c.one("SELECT * FROM memory_curation_jobs WHERE scope_id=? AND id=? AND state='review_needed'",p.scope_id,p.job_id);
    if(!job.id)fail('REVISION_CONFLICT','Recommendation is no longer pending');
    this.live(job);
    if(this.profile().mode==='preview')fail('POLICY_DENIED','Switch to Assisted or Automatic to apply decisions');
    const b=this.bundle(job),a=c.one('SELECT * FROM memory_assessments WHERE job_id=?',job.id);
    if(hash(b)!==a.input_hash||a.id!==p.assessment_id||b.revision!==p.expected_revision)fail('REVISION_CONFLICT','Review inputs changed');
    const action=this.recommend(job,b,validateAssessment(JSON.parse(a.output),b),JSON.parse(a.verdict||'null'),true);
    if(p.action!=='dismiss'&&p.action!==action||!['accept','preserve','dismiss'].includes(p.action))fail('POLICY_DENIED','Evidence does not authorize this action');
    return this.mutate(()=>this.applyDecision(job,a.id,p.action,'user'));
  }
  undo(p:Row){
    const c=this.store,d=c.one('SELECT d.*,j.scope_id,j.kind FROM memory_curation_decisions d JOIN memory_curation_jobs j ON j.id=d.job_id WHERE d.id=? AND j.scope_id=?',p.id,p.scope_id);
    if(!d.id||d.undone_revision||p.expected_revision!==d.revision)fail('REVISION_CONFLICT','Decision changed');
    const current=this.target({...d,version_id:d.after_id});
    if(d.action==='accept'&&current.aggregate_revision!==d.revision)fail('REVISION_CONFLICT','Memory changed after acceptance');
    return this.mutate(()=>{
      if(d.action==='accept'){
        if(current.slot_id&&c.one('SELECT aggregate_revision FROM fact_slots WHERE id=?',current.slot_id).aggregate_revision!==d.revision)fail('REVISION_CONFLICT','Fact was edited');
        const table=sources[d.kind as keyof typeof sources],old=c.one('SELECT * FROM '+table+' WHERE version_id=? AND erased=0',d.before_id);
        if(!old.version_id)fail('SOURCE_CHANGED','Prior evidence unavailable');
        this.amend(d,current,{status:old.status,expires_at_us:old.expires_at_us,...(d.kind==='assertion'?{retention_class:old.retention_class}:{})});
      }else if(d.action==='preserve'){
        c.releaseRetention({scope_id:p.scope_id,hold_id:d.hold_id,expected_revision:d.revision});
      }
      c.run('UPDATE memory_curation_decisions SET undone_revision=? WHERE id=?',c.revision,d.id);
      return {undone:true,revision:c.revision};
    });
  }
  list(p:Row){
    const c=this.store;c.scope(p.scope_id);
    const limit=pageSize(p.limit),offset=Math.max(0,Math.min(1000000,Math.floor(Number(p.offset)||0)));
    const filters:string[]=[],args:unknown[]=[];
    if(typeof p.state==='string'&&p.state){filters.push('j.state=?');args.push(p.state);}
    if(typeof p.action==='string'&&p.action){filters.push('d.action=?');args.push(p.action);}
    if(p.actor==='user'||p.actor==='automatic'){filters.push('d.actor=?');args.push(p.actor);}
    const filter=filters.length?' AND '+filters.join(' AND '):'';
    const rows=c.all(`SELECT j.*,a.id AS assessment_id,a.output,a.verdict,a.producer,a.assessed_value,d.id AS decision_id,d.action,d.after_id,d.revision AS decision_revision,d.undone_revision,d.actor
      FROM memory_curation_jobs j LEFT JOIN memory_assessments a ON a.job_id=j.id LEFT JOIN memory_curation_decisions d ON d.job_id=j.id WHERE j.scope_id=?${filter} ORDER BY j.created_us DESC,j.id LIMIT ? OFFSET ?`,
      p.scope_id,...args,limit+1,offset);
    return {more:rows.length>limit,rows:rows.slice(0,limit).map(r=>{
      const table=sources[r.kind as keyof typeof sources],v=c.one('SELECT * FROM '+table+' WHERE version_id=? AND erased=0',r.version_id);
      const {lease_token,input_hash,...view}=r;
      let recommendation='review';
      if(r.state==='review_needed'&&r.output){
        try{const b=this.bundle(r);recommendation=this.recommend(r,b,validateAssessment(JSON.parse(r.output),b),JSON.parse(r.verdict||'null'),true);}catch{}
      }
      return {...view,recommended_action:recommendation,text:v.version_id?(r.kind==='statement'?v.text:c.assertionText(v)):'',revision:v.aggregate_revision,status:v.status,
        output:r.output?JSON.parse(r.output):null,producer:r.producer?JSON.parse(r.producer):null,verdict:r.verdict?JSON.parse(r.verdict):null,
        evidence:v.version_id?(r.kind==='statement'?statementSupport(c,v.version_id):c.support(v.version_id)).map(e=>({id:e.id,quote:e.witness,trust:e.trust})):[]};
    })};
  }
  status(p:Row){
    const c=this.store;c.scope(p.scope_id);
    const scope=p.scope_id;
    const queue=c.all('SELECT state,COUNT(*) AS count,MIN(created_us) AS oldest_us FROM memory_curation_jobs WHERE scope_id=? GROUP BY state',scope);
    const assessments=c.one(`SELECT COUNT(*) AS count,AVG(elapsed_ms) AS average_ms,
      COUNT(*) FILTER(WHERE json_extract(output,'$.support') IN ('ambiguous','insufficient')) AS abstained,
      COUNT(*) FILTER(WHERE json_array_length(output,'$.conflictsWith')>0 OR json_extract(output,'$.support')='contradicted') AS conflicts
      FROM memory_assessments a JOIN memory_curation_jobs j ON j.id=a.job_id WHERE j.scope_id=?`,scope);
    const queued=queue.filter(r=>['queued','leased','retryable'].includes(r.state)).reduce((sum,r)=>sum+r.count,0);
    return {...this.settings(),usage:this.usage(),
      actions:c.all('SELECT d.action,d.actor,COUNT(*) AS count FROM memory_curation_decisions d JOIN memory_curation_jobs j ON j.id=d.job_id WHERE j.scope_id=? GROUP BY d.action,d.actor',scope),
      protection:c.all("SELECT reason,COUNT(*) AS count FROM retention_holds WHERE scope_id=? AND released_revision IS NULL AND (expires_at_us IS NULL OR expires_at_us>?) GROUP BY reason",scope,now()),
      assessments,estimated_inference_ms:assessments.average_ms===null?null:Math.round(queued*assessments.average_ms),
      protected_excerpt_bytes:c.one(`SELECT COALESCE(SUM(length(CAST(witness AS BLOB))),0) AS n FROM evidence WHERE erased=0 AND id IN
        (SELECT he.evidence_id FROM retention_hold_evidence he JOIN retention_holds h ON h.id=he.hold_id WHERE h.scope_id=? AND h.released_revision IS NULL AND (h.expires_at_us IS NULL OR h.expires_at_us>?))`,scope,now()).n,
      evaluations:c.all("SELECT fingerprint,dataset,evaluated_us,json_extract(result,'$.qualified') AS qualified FROM memory_model_evaluations ORDER BY evaluated_us DESC LIMIT 20"),
      queue,
      failures:c.all("SELECT error_code,COUNT(*) AS count,MIN(due_us) AS next_retry_us FROM memory_curation_jobs WHERE scope_id=? AND error_code IS NOT NULL GROUP BY error_code",p.scope_id)};
  }
  audit(version:string) {
    const c=this.store;
    const item=c.one(`SELECT a.output,a.producer,a.assessed_value,a.rubric,j.config_revision,d.action,d.actor,d.revision,d.undone_revision
      FROM memory_assessments a JOIN memory_curation_jobs j ON j.id=a.job_id LEFT JOIN memory_curation_decisions d ON d.assessment_id=a.id
      WHERE a.version_id=? OR d.after_id=? ORDER BY a.created_us DESC LIMIT 1`,version,version);
    const hint=c.one('SELECT h.importance,h.durability,r.model_identity FROM memory_extractor_hints h JOIN extraction_runs r ON r.id=h.run_id WHERE h.version_id=? ORDER BY r.revision DESC LIMIT 1',version);
    return {assessment:item.output?{...item,earlier_model:item.config_revision!==this.revision(),output:JSON.parse(item.output),producer:JSON.parse(item.producer)}:null,
      decision:c.one('SELECT actor,rule,action,before_id,after_id,revision,undone_revision,producer_ref FROM memory_curation_decisions WHERE before_id=? OR after_id=? ORDER BY revision DESC LIMIT 1',version,version),
      extractor_hint:hint.model_identity?hint:null};
  }
  manual(p:Row,method:string){
    const c=this.store;
    const target=c.retentionTarget(p.scope_id,p.id);
    if(target.kind==='observation')fail('INVALID_ARGUMENT','Choose an assertion or statement');
    const job={kind:target.kind,scope_id:p.scope_id,version_id:target.id},v=this.target(job);
    if(p.expected_revision!==v.aggregate_revision)fail('REVISION_CONFLICT','This memory changed');
    return this.mutate(()=>{
      if(method==='curation_review_later')return c.preserveRetention({scope_id:p.scope_id,target_kind:target.kind,target_id:v.logical_id,reason:'review_grace'});
      if(method==='curation_confirm_note'){
        const text=typeof p.text==='string'?p.text.trim():'';
        if(!text||text.length>2000)fail('INVALID_ARGUMENT','Confirm 1–2,000 characters for your note');
        const sourceEvent='reviewed-note:'+hash([v.version_id,text]);
        const existing=c.one("SELECT id,erased FROM observations WHERE scope_id=? AND source_event_id=?",p.scope_id,sourceEvent);
        if(existing.erased)fail('SOURCE_CHANGED','The confirmed note was forgotten');
        if(existing.id)return {id:existing.id,duplicate:true};
        const saved=c.saveText({scope_id:p.scope_id,source_role:'user',source_event_id:sourceEvent,text,sensitivity:v.sensitivity});
        c.lineage(saved.id,v.version_id,'reviewed_source');
        return saved;
      }
      if(method==='curation_statement_correct'){
        if(target.kind!=='statement')fail('INVALID_ARGUMENT','Choose a statement');
        const text=typeof p.text==='string'?p.text.trim():'';
        if(!text||text.length>4000)fail('INVALID_ARGUMENT','Enter a corrected statement of up to 4000 characters');
        const o=c.observeText({scope_id:p.scope_id,role:'user',text,sensitivity:v.sensitivity});
        const out=createStatement(c,p.scope_id,{statement:{category:v.category,modality:p.modality??v.modality},witness:{observation_id:o.id,quote:text}},now(),v);
        for(const h of c.all("SELECT * FROM retention_holds WHERE target_kind='statement' AND target_id=? AND released_revision IS NULL",v.logical_id)){
          if(h.reason==='manual_pin'){
            c.run('DELETE FROM retention_hold_evidence WHERE hold_id=?',h.id);
            for(const e of statementSupport(c,out.id))c.run('INSERT INTO retention_hold_evidence VALUES(?,?,?,1)',h.id,e.id,e.independence_group);
          }else c.run('UPDATE retention_holds SET released_revision=? WHERE id=?',c.revision,h.id);
        }
        c.events.push({type:'invalidate',cause:'correction',scope_id:p.scope_id});
        return out;
      }
      // The full supporting source and dependent passages must inherit the
      // restriction. Otherwise lexical recall or an embedding job could send
      // the same words to a remote model under another artifact identifier.
      const evidence=target.kind==='statement'?statementSupport(c,target.id):c.support(target.id);
      const roots=[...new Set(evidence.map(e=>e.observation_id as string))];
      const deps=c.descendants([...roots,target.id]);
      for(const id of deps){
        c.run("UPDATE evidence SET sensitivity='local_only' WHERE id=?",id);
        c.run("UPDATE artifacts SET sensitivity='local_only' WHERE id=?",id);
        c.run("UPDATE payloads SET sensitivity='local_only' WHERE id=? OR id IN (SELECT payload_id FROM observations WHERE id=?)",id,id);
        c.run("UPDATE assertion_versions SET sensitivity='local_only' WHERE version_id=?",id);
        c.run("UPDATE memory_statement_versions SET sensitivity='local_only' WHERE version_id=?",id);
        c.effect(id);
      }
      c.setMeta('policy_epoch',c.epoch('policy')+1);
      c.reconcileExtraction();c.events.push({type:'invalidate',cause:'policy',scope_id:p.scope_id});
      return {revision:c.revision,sensitivity:'local_only'};
    });
  }
  summaryBundle(ep:Row){
    const c=this.store;
    const a=c.hydrateArtifact(ep.summary_id,ep.scope_id,c.revision,undefined,'local');
    if(!a||a.evidence.length>16)return null;
    return {id:ep.id,scope:ep.scope_id,generation:ep.source_generation,artifact:ep.summary_id,
      policy_epoch:c.epoch('policy'),sensitivity:[a,...a.evidence].some(e=>e.sensitivity==='local_only')?'local_only':'cloud_allowed',
      evidence:a.evidence.map((e:Row)=>({id:e.id,role:e.trust,quote:e.witness}))};
  }
  nextSummary(){
    const c=this.store,pf=this.profile();
    if(!c.policy.enabled||pf.mode!=='automatic'||!pf.consolidation)return null;
    const ep=c.one(`SELECT ep.* FROM episodes ep JOIN artifacts a ON a.id=ep.summary_id AND a.invalidated=0
      WHERE ep.erased=0 AND ep.state='archived' AND NOT EXISTS(SELECT 1 FROM memory_synthesis s WHERE s.episode_id=ep.id
      AND s.generation=ep.source_generation AND s.config_revision=? AND (s.state!='leased' OR s.lease_us>?)) ORDER BY ep.revision LIMIT 1`,this.revision(),now());
    if(!ep.id)return null;
    const b=this.summaryBundle(ep),token=randomUUID();
    c.run("INSERT OR REPLACE INTO memory_synthesis(episode_id,generation,config_revision,state,lease_us,error_code,lease_token) VALUES(?,?,?,?,?,?,?)",ep.id,ep.source_generation,this.revision(),b?'leased':'blocked',now()+300e6,b?null:'INCOMPLETE_EVIDENCE',token);
    return b?{...b,token}:null;
  }
  publishSummary(p:Row){
    const c=this.store,ep=c.one('SELECT * FROM episodes WHERE id=? AND erased=0',p.id),b=this.summaryBundle(ep);
    const pf=this.profile();
    // The model saw exactly the request's evidence. Publishing needs that same evidence now: any of it
    // forgotten or changed meanwhile rejects the summary, while an erasure elsewhere does not.
    if(!b||!c.policy.enabled||pf.mode!=='automatic'||!pf.consolidation||p.revision!==this.revision()||b.artifact!==p.artifact||p.generation!==b.generation||p.policy_epoch!==b.policy_epoch||evidenceDigest(p.evidence)!==evidenceDigest(b.evidence))fail('SOURCE_CHANGED','Episode changed during synthesis');
    const sentences=parse(synthesisSchema,{sentences:p.sentences}).sentences;
    for(const sentence of sentences)allowedIds(sentence.evidenceIds,b.evidence.map((e:Row)=>e.id));
    return c.tx(()=>{
      const lease=c.one("SELECT * FROM memory_synthesis WHERE episode_id=? AND generation=? AND config_revision=? AND state='leased' AND lease_us>? AND lease_token=?",ep.id,b.generation,p.revision,now(),p.token);
      if(!lease.state)fail('SOURCE_CHANGED','Synthesis lease ended');
      const id=c.artifact(ep.scope_id,'derived_summary',ep.id,sentences.map(s=>s.text).join(' '),[b.artifact,...b.evidence.map((e:Row)=>e.id)],'',b.sensitivity);
      c.run("UPDATE memory_synthesis SET state='complete',lease_token=NULL,artifact_id=?,producer=?,sentence_links=? WHERE episode_id=? AND generation=? AND config_revision=?",id,JSON.stringify(p.producer),JSON.stringify(sentences.map(s=>s.evidenceIds)),ep.id,b.generation,p.revision);
      return {id};
    });
  }
  call(method:string,p:Row):any{
    const c=this.store;
    switch(method){
      case 'curation_review_later':case 'curation_keep_local':case 'curation_confirm_note':case 'curation_statement_correct':return this.manual(p,method);
      case 'curation_summary_next':return this.nextSummary();
      case 'curation_summary_publish':return this.publishSummary(p);
      case 'curation_summary_failed':return c.run("UPDATE memory_synthesis SET state='blocked',lease_token=NULL,error_code=? WHERE episode_id=? AND config_revision=? AND state='leased' AND lease_token=?",p.code,p.id,p.revision,p.token);
      case 'curation_evaluation_record':return c.run('INSERT OR REPLACE INTO memory_model_evaluations VALUES(?,?,?,?,?)',p.fingerprint,rubricVersion,p.dataset,JSON.stringify(p.result),now());
      case 'curation_details':{
        c.scope(p.scope_id);
        const job=c.one('SELECT * FROM memory_curation_jobs WHERE id=? AND scope_id=?',p.job_id,p.scope_id);
        if(!job.id)fail('NOT_FOUND','No such review in this project');
        const decision=c.one('SELECT * FROM memory_curation_decisions WHERE job_id=? ORDER BY revision DESC LIMIT 1',job.id);
        const id=decision.after_id||job.version_id;
        const forecast=c.retentionForecast({scope_id:p.scope_id,id});
        let context=null;
        try{context=this.bundle(job)}catch(e:any){if(!['SOURCE_CHANGED','INCOMPLETE_EVIDENCE','NOT_FOUND'].includes(e.code))throw e;}
        return {forecast,context,decision:decision.id?decision:null};
      }
      case 'curation_producer':{
        const a=c.one('SELECT a.producer FROM memory_assessments a JOIN memory_curation_jobs j ON j.id=a.job_id WHERE j.scope_id=? AND j.id=? AND a.id=?',p.scope_id,p.job_id,p.assessment_id);
        if(!a.producer)fail('NOT_FOUND','Recommendation is unavailable');
        return JSON.parse(a.producer);
      }
      case 'curation_settings':return this.settings();
      case 'curation_configure':return this.configure(p);
      case 'curation_binding_changed':return this.configure({expected_revision:this.revision(),profile:{unmeasuredFingerprint:''},manifest:p.manifest});
      case 'curation_route_snapshot':{
        if(p.revision!==this.revision())return this.settings();
        const prior=c.meta<string|null>('curation_route_manifest',null);
        if(prior!==null && prior!==p.manifest)return this.configure({expected_revision:p.revision,profile:{unmeasuredFingerprint:''},manifest:p.manifest});
        if(prior===null)c.setMeta('curation_route_manifest',p.manifest);
        return this.settings();
      }
      case 'curation_status':return this.status(p);
      case 'curation_preview':return this.enqueue(p,false,true);
      case 'curation_run':return this.enqueue(p);
      case 'curation_scan':return this.enqueue({},true);
      case 'curation_claim':return this.claim();
      case 'curation_reserve':return this.reserve(p);
      case 'curation_settle':return this.settle(p);
      case 'curation_finish':return this.finish(p);
      case 'curation_apply':return this.apply(p);
      case 'curation_undo':return this.undo(p);
      case 'curation_list':return this.list(p);
      case 'curation_cancel':
        c.scope(p.scope_id);
        return {cancelled:Number(c.run("UPDATE memory_curation_jobs SET state='cancelled',lease_token=NULL WHERE id=? AND scope_id=? AND state IN ('queued','leased','retryable','blocked')",p.job_id,p.scope_id).changes)};
      case 'curation_retry':
        c.scope(p.scope_id);
        return {queued:Number(c.run("UPDATE memory_curation_jobs SET state='queued',attempts=0,due_us=?,error_code=NULL WHERE id=? AND scope_id=? AND config_revision=? AND state IN ('cancelled','blocked','retryable')",now(),p.job_id,p.scope_id,this.revision()).changes)};
      case 'curation_fail':{
        const job=c.one("SELECT * FROM memory_curation_jobs WHERE id=? AND lease_token=? AND state='leased'",p.id,p.token);
        if(!job.id)return false;
        const retry=['RATE_LIMIT','TRANSPORT_ERROR','TIMEOUT','MODEL_UNAVAILABLE'].includes(p.code)&&job.attempts<3;
        const budget=p.code==='BUDGET_EXHAUSTED';
        c.run('UPDATE memory_curation_jobs SET state=?,due_us=?,error_code=?,lease_token=NULL WHERE id=?',p.code==='SOURCE_CHANGED'?'stale':retry||budget?'retryable':'blocked',budget?(Date.parse(new Date().toISOString().slice(0,10))+86400000)*1000:now()+30e6*2**job.attempts,p.code,job.id);return true;
      }
      default:fail('INVALID_ARGUMENT','Unknown memory review method');
    }
  }
}
function hashText(s:string){return createHash('sha256').update(s).digest('hex');}

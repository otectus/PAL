import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Canonical} from '../broker/graph-memory/canonical.ts';
import {createStatement,statementSupport} from '../broker/graph-memory/statements.ts';
import {extractionChunk,relocateWitness} from '../broker/graph-memory/extraction-chunks.ts';
const binding={connectionRef:'default:ollama',modelId:'synthetic',fallbackBindingRefs:[]};
function fixture(t:any,mode:string,options:Record<string,any>={}){
  const dir=mkdtempSync(join(tmpdir(),'pal-review-'));let store=new Canonical(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const scope=store.registerScope({key:'project-1',label:'Test'}).id;
  const scope2=store.registerScope({key:'project-2',label:'Other'}).id;
  store.policyUpdate({policy:{enabled:true}});
  store.curation.configure({expected_revision:0,profile:{mode,reviewModel:binding,retainCurationEvidence:true,...options}});
  return {get c(){return store},scope,scope2,reopen(){store.close();store=new Canonical(dir)}};
}
function make(c:Canonical,scope:string,text='I prefer short answers.',role='user',modality='actual',category='preference'){
  const obs=c.observeText({scope_id:scope,role,text});
  const v=c.tx((_,time)=>createStatement(c,scope,{statement:{category,modality},witness:{observation_id:obs.id,quote:text}},time));
  return {obs,v};
}
function outcome(lease:any){
  const b=lease.bundle,ids=b.evidence.map((e:any)=>e.id);
  return {id:lease.id,token:lease.token,output:{schemaVersion:1,targetVersionId:b.version_id,support:'supported',evidenceIds:ids,importance:4,futureUse:4,novelty:3,
    durability:'persistent',temporalStability:'stable',duplicateOf:null,conflictsWith:[],suggestedAction:'keep',reasonCodes:['direct'],explanation:'Prefers short answers.',missingContext:[]},
    producer:{assess:{fingerprint:'fixture',modelId:'synthetic'},adjudicate:{fingerprint:'fixture',modelId:'synthetic'}},elapsed_ms:1,
    verdict:{targetVersionId:b.version_id,evidenceIds:ids,resolvedReasons:[],subjectPreserved:true,polarityPreserved:true,modalityPreserved:true,timePreserved:true,entailed:true,ambiguous:false}};
}
function run(c:Canonical,scope:string){
  const preview=c.curation.call("curation_preview",{scope_id:scope});
  c.curation.enqueue({scope_id:scope,selection:preview.selection});
  return c.curation.claim()!;
}
test('preview persists an explanation across reopen, preserves baseline expiry and scrubs model-written text on forget',t=>{
  const f=fixture(t,'preview'),{obs,v}=make(f.c,f.scope),rev=f.c.revision;
  const l=run(f.c,f.scope);
  const invented=outcome(l);invented.output.evidenceIds=['foreign'];
  assert.throws(()=>f.c.curation.finish(invented),/unknown or repeated/);
  assert.equal(f.c.curation.finish(outcome(l)).applied,false);
  assert.equal(f.c.revision,rev);assert.equal(f.c.one('SELECT count(*) AS n FROM retention_holds').n,0);
  f.reopen();
  const row=f.c.curation.list({scope_id:f.scope}).rows[0];
  assert.equal(row.output.importance,4);assert.equal(row.status,'candidate');
  assert.equal(f.c.curation.list({scope_id:f.scope2}).rows.length,0);
  assert.throws(()=>f.c.curation.apply({scope_id:f.scope,job_id:l.id}),/Assisted/);
  f.c.forget({scope_id:f.scope,id:obs.id});
  assert.equal(f.c.one('SELECT count(*) AS n FROM memory_assessments').n,0);
  assert.equal(f.c.one('SELECT text FROM memory_statement_versions WHERE version_id=?',v.id).text,'');
  assert.equal(f.c.retrieve({scope_id:f.scope,text:'short answers'}).items.length,0);
});
test('automatic acceptance requires separate adjudication, route authorization and unchanged evidence; undo restores candidate',t=>{
  const f=fixture(t,'automatic',{autoAccept:true,unmeasuredFingerprint:'fixture'});
  const {v}=make(f.c,f.scope);const l=run(f.c,f.scope);
  const d=f.c.curation.finish(outcome(l)) as any;
  assert.equal(d.action,'accept');
  assert.equal(f.c.inspect({scope_id:f.scope,id:v.logical_id}).record.status,'accepted');
  assert.throws(()=>f.c.curation.finish(outcome(l)),/cancelled|expired/);
  assert.throws(()=>f.c.curation.undo({scope_id:f.scope2,id:d.id,expected_revision:d.revision}),/changed/);
  f.c.curation.undo({scope_id:f.scope,id:d.id,expected_revision:d.revision});
  assert.equal(f.c.inspect({scope_id:f.scope,id:v.logical_id}).record.status,'candidate');
});
for (const [role,modality] of [['assistant','actual'],['user','planned']]){
  test('perfect scores preserve uncertainty for '+role+' / '+modality,t=>{
    const f=fixture(t,'automatic',{autoAccept:true,unmeasuredFingerprint:'fixture'});
    const {v}=make(f.c,f.scope,'Orchid plans to release.',role,modality),l=run(f.c,f.scope);
    const d=f.c.curation.finish(outcome(l)) as any;assert.equal(d.action,'preserve');
    const r=f.c.inspect({scope_id:f.scope,id:v.id}).record;
    assert.equal(r.status,'candidate');assert.equal(r.modality,modality);
    const packet=f.c.retrieve({scope_id:f.scope,text:'Orchid release'});
    assert.ok(packet.items.some((r:any)=>r.kind==='claim'&&r.status==='candidate'));
    assert.equal(f.c.one('SELECT count(*) AS n FROM retention_holds').n,1);
    f.c.curation.undo({scope_id:f.scope,id:d.id,expected_revision:d.revision});
    assert.equal(f.c.one('SELECT count(*) AS n FROM retention_holds WHERE released_revision IS NULL').n,0);
  });
}
test('leases, budget reservations, cancellation and revision fences survive restart',t=>{
  const f=fixture(t,'assisted',{dailyRequests:1});const {obs}=make(f.c,f.scope);
  const l=run(f.c,f.scope);
  const reservation={id:l.id,token:l.token,input:200,output:300,config_revision:1,task:'assess'};
  f.c.curation.reserve(reservation);
  f.reopen();assert.throws(()=>f.c.curation.reserve(reservation),/budget/i);
  f.c.run('UPDATE memory_curation_jobs SET lease_until_us=0 WHERE id=?',l.id);
  const second=f.c.curation.claim()!;
  assert.notEqual(second.token,l.token);assert.throws(()=>f.c.curation.finish(outcome(l)),/lease expired/);
  f.c.curation.call('curation_cancel',{scope_id:f.scope2,job_id:l.id});
  assert.equal(f.c.curation.lease(second).state,'leased');
  f.c.forget({scope_id:f.scope,id:obs.id});
  assert.throws(()=>f.c.curation.finish(outcome(second)),/lease expired/);
  assert.equal(f.c.curation.usage().uncertain,1);
});
test('an erasure elsewhere, such as routine expiry, leaves previewed, queued, leased and pending review work valid',t=>{
  const f=fixture(t,'assisted'),{v}=make(f.c,f.scope);
  let n=0;
  const elsewhere=()=>{
    const epoch=f.c.epoch('erasure'),o=f.c.observeText({scope_id:f.scope2,role:'user',text:`Unrelated passage ${++n}.`});
    f.c.forget({scope_id:f.scope2,id:o.id});
    assert.equal(f.c.epoch('erasure'),epoch+1);
  };
  const preview=f.c.curation.call('curation_preview',{scope_id:f.scope});
  elsewhere();
  assert.equal(f.c.curation.enqueue({scope_id:f.scope,selection:preview.selection}).queued,1,'a preview survives an unrelated erasure');
  elsewhere();
  const lease=f.c.curation.claim()!;
  assert.equal(lease?.bundle.version_id,v.id,'a job queued before an erasure is still claimed');
  elsewhere();
  assert.equal((f.c.curation.finish(outcome(lease)) as any).applied,false,'a result computed across an erasure is kept');
  elsewhere();
  const [row]=f.c.curation.list({scope_id:f.scope}).rows;
  assert.ok(row && 'state' in row && 'id' in row && 'assessment_id' in row, 'the review row identifies its job and assessment');
  assert.deepEqual([row.state,row.recommended_action],['review_needed','accept']);
  const applied=f.c.curation.apply({scope_id:f.scope,job_id:row.id,assessment_id:row.assessment_id,expected_revision:row.revision,action:'accept'}) as any;
  assert.equal(applied.applied,true);
  assert.equal(f.c.inspect({scope_id:f.scope,id:v.logical_id}).record.status,'accepted');
  assert.equal(f.c.curation.call('curation_preview',{scope_id:f.scope}).count,0,'nothing is queued again');
});
test('synthesis publishes across an unrelated erasure, but not over evidence other than what the model read',t=>{
  const f=fixture(t,'automatic',{consolidation:true});
  f.c.observeText({scope_id:f.scope,role:'user',text:'The orchid manual uses violet headings.',session_id:'synthetic'});
  f.c.consolidate({scope_id:f.scope,id:f.c.one('SELECT id FROM episodes WHERE thread_id=?','synthetic').id});
  const request=f.c.curation.nextSummary()!;
  const other=f.c.observeText({scope_id:f.scope2,role:'user',text:'An unrelated passage.'});
  f.c.forget({scope_id:f.scope2,id:other.id});
  const input={...request,revision:f.c.curation.revision(),producer:{modelId:'synthetic'},sentences:[{text:'The manual has violet headings.',evidenceIds:[request.evidence[0].id]}]};
  assert.throws(()=>f.c.curation.publishSummary({...input,evidence:[{...request.evidence[0],quote:'Something the source never said.'}]}),/changed during synthesis/);
  assert.throws(()=>f.c.curation.publishSummary({...input,evidence:undefined}),/changed during synthesis/);
  assert.ok(f.c.curation.publishSummary(input).id);
});
test('restating a statement attaches the new witness to it instead of creating a second statement',t=>{
  const f=fixture(t,'assisted');
  const current=()=>f.c.all('SELECT * FROM memory_statement_versions WHERE scope_id=? AND known_to_revision IS NULL AND erased=0 ORDER BY known_from_revision',f.scope);
  const first=make(f.c,f.scope,'I prefer short answers.'),before=current()[0];
  const again=make(f.c,f.scope,'i prefer  short answers');
  assert.deepEqual([(again.v as any).restated,again.v.logical_id,again.v.status],[true,first.v.logical_id,'candidate']);
  const [after]=current();
  assert.equal(current().length,1,'one statement, not two');
  assert.equal(after.text,'I prefer short answers.','the wording first recorded stays');
  assert.deepEqual(statementSupport(f.c,after.version_id).map(e=>e.observation_id).sort(),[first.obs.id,again.obs.id].sort());
  assert.ok(after.expires_at_us>before.expires_at_us,'a new independent source restarts the pending deadline');
  assert.equal(f.c.curation.call('curation_preview',{scope_id:f.scope}).count,1,'one review, with both sources');
  // The same words from another source authority, category or modality are a different statement.
  make(f.c,f.scope,'I prefer short answers.','assistant');
  make(f.c,f.scope,'I prefer short answers.','user','planned');
  assert.equal(current().length,3);
});
test('chunk locators count overlapping repetitions and Unicode code points',()=>{
  const text='🫖あaaa\naaa é';const chunk=extractionChunk(text,6,80);
  assert.equal(chunk.text,'aaa é');
  assert.equal(relocateWitness(text,chunk,{quote:'aa',occurrence:1}).occurrence,3);
});

test('statement corrections preserve knowledge time, scope, pin evidence and restore-time erasure',async t=>{
  const f=fixture(t,'assisted'),{v}=make(f.c,f.scope);
  const known=f.c.revision,first=f.c.inspect({scope_id:f.scope,id:v.id}).evidence[0].id;
  const pin=f.c.pin({scope_id:f.scope,id:v.id});
  const next=f.c.curation.manual({scope_id:f.scope,id:v.id,expected_revision:v.aggregate_revision,text:'I prefer detailed answers.'},'curation_statement_correct');
  const history=f.c.inspect({scope_id:f.scope,id:v.logical_id,known_revision:known});
  assert.equal(history.record.text,'I prefer short answers.');
  assert.equal(history.history.length,1);
  const current=f.c.inspect({scope_id:f.scope,id:v.logical_id});
  assert.equal(current.record.text,'I prefer detailed answers.');
  assert.equal(current.evidence[0].trust,'explicit_user');
  assert.notEqual(current.evidence[0].id,first);
  assert.deepEqual(f.c.all('SELECT evidence_id FROM retention_hold_evidence WHERE hold_id=?',pin.id).map(e=>e.evidence_id),[current.evidence[0].id]);
  assert.ok('aggregate_revision' in next && next.id);
  f.c.curation.manual({scope_id:f.scope,id:next.id,expected_revision:next.aggregate_revision},'curation_keep_local');
  f.c.policyUpdate({policy:{allow_cloud_memory:true}});
  assert.throws(()=>f.c.inspect({scope_id:f.scope,id:next.id,model_route:'cloud'}),/Local/);
  assert.equal(f.c.retrieve({scope_id:f.scope,text:'detailed',model_route:'cloud'}).items.length,0);
  const workspace=mkdtempSync(join(tmpdir(),'pal-review-backup-'));
  t.after(()=>rmSync(workspace,{recursive:true,force:true}));
  const backup=await f.c.backup({output:join(workspace,'prior.sqlite')});
  f.c.forget({scope_id:f.scope,id:v.logical_id});
  const staging=join(workspace,'restore');
  await f.c.restore({input:backup.output,staging});
  const replay=new Canonical(staging);
  try{assert.throws(()=>replay.inspect({scope_id:f.scope,id:v.logical_id}),/erased|available/);
    assert.equal(replay.retrieve({scope_id:f.scope,text:'answers'}).items.length,0);
  }finally{replay.close()}
});

test('held-out qualification requires adequate decisions and correct hard-category acceptance',async()=>{
  const {calibrationMetrics}=await import('../broker/graph-memory/calibration.ts');
  const rows=Array.from({length:300},(_,i)=>({category:'preference',challenge:['negation','source_role','time','adversarial'][i%4],expected:'accept',action:'accept',supportCorrect:true,cited:true,elapsed:1}));
  assert.equal(calibrationMetrics(rows.slice(1)).qualified,false);
  assert.deepEqual(calibrationMetrics(rows).qualified_categories,['preference']);
  rows[2].expected='review';
  assert.equal(calibrationMetrics(rows).qualified,false);
});

test('service runs scoped review through a saved model, validates ordered IDs and aborts a cancelled dispatch',async t=>{
  const {MemoryService}=await import('../broker/graph-memory/service.ts');
  const directory=mkdtempSync(join(tmpdir(),'pal-review-service-'));
  const seed=new Canonical(join(directory,'graph-memory')),scope=seed.registerScope({key:'test',label:'Review service'}).id;
  seed.policyUpdate({policy:{enabled:true}});
  const {v}=make(seed,scope);
  const future=make(seed,scope,'I plan to publish the orchid manual.','user','planned','goal');
  seed.close();
  const service=new MemoryService(directory);clearInterval(service.timer);
  const restoreFetch=globalThis.fetch;
  t.after(async()=>{globalThis.fetch=restoreFetch;await service.close();rmSync(directory,{recursive:true,force:true})});
  const dispatches:string[]=[];
  let pending=false,started!:()=>void;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input));
    assert.equal(url.hostname,'127.0.0.1');
    if(url.pathname==='/api/show')return Response.json({capabilities:['completion']});
    if(url.pathname==='/api/tags')return Response.json({models:[{model:'synthetic',digest:'a'.repeat(64)}]});
    if(url.pathname!=='/api/chat')throw new Error('Unconfigured projection');
    const req=JSON.parse(String(init.body)),b=JSON.parse(req.messages[1].content),props=req.format.properties;
    let value:unknown;
    if(props.abstain)value={schemaVersion:1,targetVersionId:'synthetic-target',support:'insufficient',evidenceIds:['synthetic-evidence'],abstain:true};
    else if(props.orderedIds){dispatches.push('rank');value={orderedIds:['foreign-result']};}
    else if(pending){
      started();return new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));
    }else{
      const model=outcome({id:'fixture',token:'fixture',bundle:b});
      value=props.support?model.output:model.verdict;
      dispatches.push(props.support?'assess':'adjudicate');
    }
    return Response.json({model:'synthetic',done:true,done_reason:'stop',message:{content:JSON.stringify(value)},prompt_eval_count:30,eval_count:9});
  };
  service.configuration={...service.configuration,host:'http://127.0.0.1:11434',enabled:true,extraction_model:''};
  await service.call('curation_configure',{expected_revision:0,profile:{mode:'assisted',reviewModel:binding,retainCurationEvidence:true}});
  const queue=async(id:string)=>{
    const query={scope_id:scope,ids:[id]};
    const p=await service.call('curation_preview',query);
    return service.call('curation_run',{...query,selection:p.selection});
  };
  await queue(v.id);
  assert.ok(await service.review.process(new AbortController().signal));
  const [row]=(await service.call('curation_list',{scope_id:scope})).rows;
  assert.equal(row.producer.assess.modelId,'synthetic');
  assert.deepEqual(dispatches,['assess','adjudicate']);
  assert.equal(row.recommended_action,'accept');
  const applied=await service.call('curation_apply',{scope_id:scope,job_id:row.id,assessment_id:row.assessment_id,expected_revision:row.revision,action:'accept'});
  assert.equal(applied.applied,true);
  const after=await service.call('inspect',{scope_id:scope,id:v.logical_id});
  assert.equal(after.record.status,'accepted');
  await service.call('curation_undo',{scope_id:scope,id:applied.id,expected_revision:applied.revision});
  const settings=await service.call('curation_settings');
  await service.call('curation_configure',{expected_revision:settings.revision,profile:{mode:'automatic',rerank:true}});
  const ranked=await service.call('deep_recall',{scope_id:scope,text:'answers publish orchid',token_budget:2000});
  assert.equal(ranked.metrics.ranking.strategy,'fallback_INVALID_CITATION');
  assert.equal('review_pool' in ranked,false);
  assert.ok(ranked.items.length);
  await queue(future.v.id);
  pending=true;
  const began=new Promise<void>(r=>{started=r});
  const work=service.review.process(new AbortController().signal);
  await began;
  const [leased]=(await service.call('curation_list',{scope_id:scope,state:'leased'})).rows;
  assert.equal((await service.call('curation_cancel',{scope_id:scope,job_id:leased.id})).cancelled,1);
  await work;
  assert.equal((await service.call('curation_list',{scope_id:scope,state:'cancelled'})).rows.length,1);
});

test('synthesis retains sentence citations, falls back to extractive text and forgets derived content',t=>{
  const f=fixture(t,'automatic',{consolidation:true});
  const o=f.c.observeText({scope_id:f.scope,role:'user',text:'The orchid manual uses violet headings.',session_id:'synthetic'});
  const ep=f.c.one('SELECT id FROM episodes WHERE thread_id=?','synthetic');
  f.c.consolidate({scope_id:f.scope,id:ep.id});
  const request=f.c.curation.nextSummary()!;
  assert.ok(request);
  const input={...request,revision:f.c.curation.revision(),producer:{modelId:'synthetic'},sentences:[{text:'The manual has violet headings.',evidenceIds:[request.evidence[0].id]}]};
  assert.throws(()=>f.c.curation.publishSummary({...input,token:'expired-lease'}),/lease/);
  assert.throws(()=>f.c.curation.publishSummary({...input,sentences:[{text:'Foreign claim.',evidenceIds:['other-scope']}]}),/unknown/);
  const summary=f.c.curation.publishSummary(input);
  assert.equal(f.c.hydrateArtifact(summary.id,f.scope,f.c.revision,undefined,'local')?.kind,'derived_summary');
  f.c.curation.configure({expected_revision:f.c.curation.revision(),profile:{consolidation:false}});
  assert.equal(f.c.hydrateArtifact(summary.id,f.scope,f.c.revision,undefined,'local'),null);
  assert.ok(f.c.hydrateArtifact(request.artifact,f.scope,f.c.revision,undefined,'local'));
  f.c.forget({scope_id:f.scope,id:o.id});
  assert.equal(f.c.one('SELECT count(*) AS n FROM memory_synthesis').n,0);
  assert.equal(f.c.one('SELECT count(*) AS n FROM payloads WHERE body=?',input.sentences[0].text).n,0);
});

test('raw expiry scrubs assessment prose but keeps a reversible decision on a protected candidate',t=>{
  const f=fixture(t,'automatic'),{obs,v}=make(f.c,f.scope,'I plan to change the manual.','user','planned');
  const lease=run(f.c,f.scope),decision=f.c.curation.finish(outcome(lease)) as any;
  f.c.run('UPDATE payloads SET expires_us=1 WHERE id=(SELECT payload_id FROM observations WHERE id=?)',obs.id);
  f.c.expire();
  assert.equal(f.c.one('SELECT count(*) AS n FROM memory_assessments').n,0);
  const inspected=f.c.inspect({scope_id:f.scope,id:v.id});
  assert.equal(inspected.record.status,'candidate');
  assert.equal(inspected.decision.action,'preserve');
  assert.equal(f.c.curation.undo({scope_id:f.scope,id:decision.id,expected_revision:decision.revision}).undone,true);
});

test('explicit note confirmation is idempotent, preserves local sensitivity and leaves the original claim attributed',t=>{
  const f=fixture(t,'assisted');
  const src=make(f.c,f.scope,'The assistant suggests running checks.','assistant','reported');
  f.c.curation.manual({scope_id:f.scope,id:src.v.id,expected_revision:src.v.aggregate_revision},'curation_keep_local');
  const request={scope_id:f.scope,id:src.v.id,expected_revision:src.v.aggregate_revision,text:'Run the documented checks before publishing.'};
  const saved=f.c.curation.call('curation_confirm_note',request);
  assert.equal(f.c.curation.call('curation_confirm_note',request).id,saved.id);
  assert.equal(f.c.one('SELECT source_role FROM note_revisions WHERE note_id=?',saved.id).source_role,'user');
  assert.equal(f.c.one("SELECT sensitivity FROM artifacts WHERE kind='saved' AND record_id=?",saved.id).sensitivity,'local_only');
  const original=f.c.inspect({scope_id:f.scope,id:src.v.id});
  assert.equal(original.record.status,'candidate');assert.equal(original.evidence[0].trust,'derived_summary');
});

test('startup fences queued jobs when a saved route changed between broker instances',t=>{
  const f=fixture(t,'assisted');
  const revision=f.c.curation.revision(),settings=f.c.curation.call('curation_route_snapshot',{revision,manifest:'route-generation-one'});
  assert.equal(settings.revision,revision);
  make(f.c,f.scope);
  const waiting=run(f.c,f.scope);
  f.reopen();
  const changed=f.c.curation.call('curation_route_snapshot',{revision,manifest:'route-generation-two'});
  assert.equal(changed.revision,revision+1);
  assert.throws(()=>f.c.curation.finish(outcome(waiting)),/cancelled|expired/);
  assert.equal(f.c.curation.call('curation_list',{scope_id:f.scope}).rows[0].state,'stale');
});

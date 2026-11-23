import { z } from 'zod';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Canonical} from './canonical.ts';
import {createStatement} from './statements.ts';
import {claimSchema,fail} from './contracts.ts';
import {categories,assessmentSchema,assessmentPrompt,validateAssessment,adjudicationPrompt,adjudicationSchema,contractVersion,rubricVersion,allowedIds,type Profile} from './assessment.ts';
import {interval} from './evaluation.ts';
import type {ReviewInference} from './review-inference.ts';
import type {ResolvedTaskRoute,StructuredTaskResult} from './task-models.ts';
const key=z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const scenario=z.strictObject({
  id:key,group:key,split:z.enum(['tuning','heldout']),role:z.enum(['user','assistant','tool','document']),
  source:z.string().min(1).max(8000),quote:z.string().min(1).max(4000),occurrence:z.number().int().min(0).default(0),
  claim:claimSchema.optional(),statement:z.strictObject({category:z.enum(categories),modality:z.enum(['actual','planned','hypothetical','reported','inferred'])}).optional(),
  expected:z.enum(['accept','preserve','review','no_change']),support:z.enum(['supported','insufficient','ambiguous','contradicted']),
  challenge:z.enum(['direct','negation','source_role','time','conflict','attribution','multilingual','adversarial']),
});
export const corpusSchema=z.strictObject({version:key,reviewer:key,sensitivity:z.enum(['local_only','cloud_allowed']).default('local_only'),cases:z.array(scenario).min(1).max(5000)});
type Verdict={category:string,challenge:string,expected:string,action:string,supportCorrect:boolean,cited:boolean,elapsed:number,
  mode?:'semantic'|'deterministic',expectedSupport?:string,predictedSupport?:string};
type Identity={fingerprint:string,connectionRef:string,connectionRevision:number,credentialRef:string,credentialRevision:string,adapterId:string,
  modelId:string,modelVersion:string,modelDigest:string|null,processing:string,outputMode:string,prompt:string,parser:number,schema:number,rubric:string};
export const calibrationContract={contract:contractVersion,rubric:rubricVersion,parser:1,assessmentSchema:1,adjudicationSchema:1} as const;
export function calibrationPolicy(profile:Profile){return {acceptCategories:[...profile.acceptCategories].sort(),threshold:profile.threshold,retainCurationEvidence:profile.retainCurationEvidence};}
function identity<T>(out:StructuredTaskResult<T>):Identity{
  const modelVersion=out.modelVersion||out.model;
  if(!modelVersion)fail('SOURCE_CHANGED','The provider did not return a stable model identity');
  return {fingerprint:out.route.fingerprint,connectionRef:out.route.connectionRef,connectionRevision:out.route.connectionRevision,
    credentialRef:out.route.credentialRef,credentialRevision:out.route.credentialRevision,adapterId:out.route.adapterId,modelId:out.route.modelId,
    modelVersion,modelDigest:out.modelDigest??null,processing:out.route.processing,outputMode:out.outputMode,
    prompt:contractVersion,parser:1,schema:1,rubric:rubricVersion};
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function calibrationMetrics(rows:Verdict[]){
  // Deterministic parser/policy outcomes are reported, but cannot qualify a
  // semantic model or inflate its denominator.
  const deterministic=rows.filter(r=>r.mode==='deterministic'),semantic=rows.filter(r=>r.mode!=='deterministic');
  const accepted=semantic.filter(r=>r.action==='accept'),right=accepted.filter(r=>r.expected==='accept').length;
  const precision=accepted.length?right/accepted.length:null,ci=interval(right,accepted.length);
  const categoryCounts=Object.fromEntries([...new Set(semantic.map(r=>r.category))].map(cat=>{
    const group=semantic.filter(r=>r.category===cat),n=group.filter(r=>r.action==='accept'),correct=n.filter(r=>r.expected==='accept').length;
    const supportRight=n.filter(r=>r.supportCorrect).length,evidenceRight=n.filter(r=>r.cited).length;
    const actionPrecision=n.length?correct/n.length:null,supportPrecision=n.length?supportRight/n.length:null,evidencePrecision=n.length?evidenceRight/n.length:null;
    return [cat,{cases:group.length,accepted:n.length,wrong:n.length-correct,action_precision:actionPrecision,support_precision:supportPrecision,
      evidence_precision:evidencePrecision,qualified:n.length>0&&actionPrecision===1&&supportPrecision===1&&evidencePrecision===1}];
  }));
  const protectedRows=semantic.filter(r=>['preserve','accept'].includes(r.action)),valuable=semantic.filter(r=>['preserve','accept'].includes(r.expected));
  const hard=['negation','source_role','time','adversarial'];
  const supportPrecision=accepted.length?accepted.filter(r=>r.supportCorrect).length/accepted.length:null;
  const evidencePrecision=accepted.length?accepted.filter(r=>r.cited).length/accepted.length:null;
  const qualifies=accepted.length>=300&&precision!==null&&precision>=.99&&supportPrecision!==null&&supportPrecision>=.99&&evidencePrecision!==null&&evidencePrecision>=.99&&
    Object.values(categoryCounts).some(c=>c.qualified)&&ci!==null&&ci[0]>=.97&&
    hard.every(ch=>semantic.some(r=>r.challenge===ch)&&!accepted.some(r=>r.challenge===ch&&r.expected!=='accept'));
  return {qualified:qualifies,qualified_categories:qualifies?Object.entries(categoryCounts).filter(([,c])=>c.qualified).map(([name])=>name):[],
    evaluated:rows.length,semantic_evaluated:semantic.length,deterministic:{evaluated:deterministic.length,actions:Object.fromEntries([...new Set(deterministic.map(r=>r.action))].map(action=>[action,deterministic.filter(r=>r.action===action).length]))},
    accepted:accepted.length,precision,precision_interval:ci,coverage:semantic.length?accepted.length/semantic.length:0,
    support_precision:supportPrecision,evidence_precision:evidencePrecision,
    support_accuracy:semantic.length?semantic.filter(r=>r.supportCorrect).length/semantic.length:0,evidence_coverage:semantic.length?semantic.filter(r=>r.cited).length/semantic.length:0,
    preservation_recall:valuable.length?valuable.filter(r=>protectedRows.includes(r)).length/valuable.length:null,
    unnecessary_preservation:protectedRows.filter(r=>!valuable.includes(r)).length,validation_failures:semantic.filter(r=>r.action==='invalid').length,
    categories:categoryCounts,latency_ms:rows.reduce((n,r)=>n+r.elapsed,0)};
}
// Labels are used only after inference. No examples or free-text explanations
// from a private evaluation corpus enter the installation's canonical database.
export async function calibrate(review:ReviewInference,input:unknown,maxCases:unknown,settings:{profile:Profile,revision:number},signal:AbortSignal){
  const data=corpusSchema.parse(input),groups=new Map<string,string>(),ids=new Set<string>(),passages=new Set<string>();
  for(const c of data.cases){
    if(ids.has(c.id)||passages.has(c.source.normalize().trim())||groups.has(c.group)&&groups.get(c.group)!==c.split||!!c.claim===!!c.statement)fail('INVALID_ARGUMENT','Evaluation cases must be distinct, group-disjoint and specify one claim or statement');
    ids.add(c.id);passages.add(c.source.normalize().trim());groups.set(c.group,c.split);
  }
  const cases=data.cases.filter(c=>c.split==='heldout');
  if(!Number.isSafeInteger(maxCases)||Number(maxCases)<cases.length||!cases.length)fail('INVALID_ARGUMENT','Set max_cases to cover the held-out split');
  const pf=settings.profile,assessor=pf.reviewModel;
  if(!assessor)fail('INVALID_ARGUMENT','Select the assessment route');
  const dir=await mkdtemp(join(tmpdir(),'pal-calibration-')),results:Verdict[]=[];
  const c=new Canonical(dir);
  let assessorIdentity:Identity|undefined,adjudicatorIdentity:Identity|undefined,assessorRoute:ResolvedTaskRoute|undefined,adjudicatorRoute:ResolvedTaskRoute|undefined;
  try{
    c.policyUpdate({policy:{enabled:true}});
    c.setMeta('curation_profile',pf);
    for(const sample of cases){
      signal.throwIfAborted();
      const scope=c.registerScope({key:sample.id,label:'Calibration'}).id;
      const o=c.observeText({scope_id:scope,role:sample.role,text:sample.source,sensitivity:data.sensitivity});
      const witness={observation_id:o.id,quote:sample.quote,occurrence:sample.occurrence};
      const initial=sample.claim?c.remember({scope_id:scope,claim:sample.claim,witness,model_proposal:true}):c.tx((_,time)=>createStatement(c,scope,{statement:sample.statement,witness},time));
      // Measure only unresolved candidates that the deployed semantic reviewer
      // would receive. Deterministic admission is counted separately.
      const job={scope_id:scope,version_id:initial.id,kind:sample.claim?'assertion':'statement'};
      const category=sample.statement?.category||'assertion',start=Date.now();
      let action=initial.status==='accepted'?'accept':'no_change',supportCorrect=false,cited=false,predictedSupport:string|undefined;
      if(initial.status==='candidate'){
        const b=c.curation.bundle(job);
        try{
          const out=await review.generate('assess',assessor,assessmentPrompt,assessmentSchema,b,data.sensitivity==='local_only',settings,signal);
          await review.router.recheck(out.route,signal);
          const observed=identity(out);
          if(assessorIdentity&&!same(assessorIdentity,observed))fail('SOURCE_CHANGED','Assessment model identity changed during evaluation');
          assessorIdentity=observed;assessorRoute=out.route;
          const a=validateAssessment(out.value,b);
          predictedSupport=a.support;cited=a.evidenceIds.includes(b.evidence[0].id);supportCorrect=a.support===sample.support;
          let verdict=null;
          if(a.support==='supported'&&a.suggestedAction==='keep'){
            const v=await review.generate('adjudicate',pf.overrides.adjudicate||assessor,adjudicationPrompt,adjudicationSchema,b,data.sensitivity==='local_only',settings,signal);
            await review.router.recheck(v.route,signal);
            const observedVerifier=identity(v);
            if(adjudicatorIdentity&&!same(adjudicatorIdentity,observedVerifier))fail('SOURCE_CHANGED','Adjudication model identity changed during evaluation');
            adjudicatorIdentity=observedVerifier;adjudicatorRoute=v.route;verdict=v.value;
            if(verdict.targetVersionId!==b.version_id)fail('INVALID_CITATION','Unexpected evaluation target');
            allowedIds(verdict.evidenceIds,b.evidence.map(e=>e.id));allowedIds(verdict.resolvedReasons,b.reasons);
          }
          action=c.curation.recommend(job,b,a,verdict,true);
        }catch(error:any){
          if(['SOURCE_CHANGED','BUDGET_EXHAUSTED','CLOUD_TASK_DISABLED','LOCAL_ONLY_ROUTE','UNKNOWN_PROCESSING','STALE_TASK_ROUTE'].includes(error.code)||signal.aborted)throw error;
          action='invalid';
        }
      }
      results.push({category,expected:sample.expected,challenge:sample.challenge,action,cited,supportCorrect,elapsed:Date.now()-start,
        mode:initial.status==='candidate'?'semantic':'deterministic',expectedSupport:sample.support,predictedSupport});
    }
    if(assessorRoute)await review.router.recheck(assessorRoute,signal);
    if(adjudicatorRoute)await review.router.recheck(adjudicatorRoute,signal);
    const metrics=calibrationMetrics(results);
    const dataset=createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const measured=!!assessorIdentity&&!!adjudicatorIdentity&&metrics.qualified;
    const result={...metrics,qualified:measured,qualified_categories:measured?metrics.qualified_categories:[],qualification_basis:'measured',
      assessor:assessorIdentity??null,adjudicator:adjudicatorIdentity??null,contract:calibrationContract,policy:calibrationPolicy(pf),
      reviewer:data.reviewer,dataset_version:data.version,rubric:rubricVersion};
    if(!assessorIdentity)fail('INVALID_ARGUMENT','The held-out corpus contained no semantic assessment cases');
    await review.canonical.call('curation_evaluation_record',{fingerprint:assessorIdentity.fingerprint,dataset,result});
    return {...result,dataset};
  }finally{c.close();await rm(dir,{recursive:true,force:true});}
}

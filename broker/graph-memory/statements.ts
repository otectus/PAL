import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Canonical } from './canonical.ts';
import { categories } from './assessment.ts';
import { fail, parse, witnessSchema } from './contracts.ts';
import { restatedSupport } from './retention.ts';

type Row = Record<string,any>;
const details = z.strictObject({category:z.enum(categories),modality:z.enum(['actual','planned','hypothetical','reported','inferred'])});
export function statementSupport(c:Canonical,version:string) {
  return c.all('SELECT e.* FROM memory_statement_evidence m JOIN evidence e ON e.id=m.evidence_id WHERE m.version_id=? AND e.erased=0 ORDER BY e.id',version);
}
export function createStatement(c:Canonical,scope:string,proposal:Row,time:number,previous?:Row) {
  const statement=parse(details,proposal.statement), witness=c.evidence(scope,parse(witnessSchema,proposal.witness));
  const source=c.one('SELECT role FROM observations WHERE id=?',witness.observation_id);
  if(!previous){
    const restated=restatedStatement(c,scope,statement,witness,time);
    if(restated)return attachStatementSupport(c,restated,witness,time,source.role);
  }
  const logical=previous?.logical_id ?? randomUUID();
  if(!previous)c.insert('memory_statements',{id:logical,scope_id:scope});
  return writeVersion(c,{
    logical_id:logical,scope_id:scope,category:statement.category,text:witness.witness,subject_id:null,
    status:'candidate',modality:statement.modality,epistemic_type:witness.trust,valid_mode:'unknown',
    valid_from_us:null,valid_to_us:null,conflict_set_id:null,sensitivity:witness.sensitivity,
    expires_at_us:time+c.policy.candidate_days*864e8,
  },[witness],time,previous,source.role);
}
/** A statement's words as a restatement is compared: case, spacing and closing full stops aside. */
const wording=(text:string)=>text.normalize('NFC').toLocaleLowerCase('und').replace(/\s+/gu,' ').trim().replace(/[.!]+$/u,'').trimEnd();
/**
 * The current statement a new proposal restates, if any: the same project, category, modality, source
 * authority and wording, pending, accepted or disputed, and still allowed storage. Newest first. The
 * full-text index narrows the search to statements holding every word, so a scope with many
 * statements is not read in full for each new one.
 */
function restatedStatement(c:Canonical,scope:string,statement:{category:string;modality:string},witness:Row,time:number) {
  const words=wording(witness.witness),terms=[...new Set(words.match(/[\p{L}\p{N}\p{M}]+/gu)||[])].slice(0,64);
  if(!terms.length)return undefined;
  for(const prior of c.all(`SELECT v.* FROM memory_fts f JOIN retrieval_documents d ON d.rowid=f.rowid JOIN artifacts a ON a.id=d.artifact_id
      JOIN memory_statement_versions v ON v.version_id=a.record_id
      WHERE memory_fts MATCH ? AND a.scope_id=? AND a.kind='statement' AND a.invalidated=0 AND a.known_to_revision IS NULL
        AND v.category=? AND v.modality=? AND v.epistemic_type=? AND v.status IN ('candidate','accepted','disputed') AND v.known_to_revision IS NULL AND v.erased=0
      ORDER BY v.known_from_revision DESC,v.version_id LIMIT 100`,
    terms.map(term=>`"${term}"`).join(' AND '),scope,statement.category,statement.modality,witness.trust))
    if(wording(prior.text)===words&&c.retentionDecision(c.retentionTarget(scope,prior.version_id,'statement'),time).storageAllowed)return prior;
  return undefined;
}
/**
 * Re-mention: the restatement's witness becomes independent support of the statement it repeats,
 * instead of a second statement. Status, wording and confidence are unchanged, since repeating
 * something settles nothing; a pending statement's deadline restarts from a new independent source,
 * as a fresh duplicate's would have. Retention holds keep exactly the evidence they protect, and the
 * statement keeps a bounded set of recent witnesses besides (retention.ts restatedSupport).
 */
function attachStatementSupport(c:Canonical,prior:Row,witness:Row,time:number,role:string) {
  const support=statementSupport(c,prior.version_id);
  const unchanged={id:prior.version_id,logical_id:prior.logical_id,status:prior.status,aggregate_revision:prior.aggregate_revision,source_role:role,restated:true};
  if(support.some(e=>e.id===witness.id))return unchanged;
  const independent=!support.some(e=>e.independence_group===witness.independence_group);
  const expires=prior.expires_at_us===null||!independent?prior.expires_at_us:Math.max(prior.expires_at_us,time+c.policy.candidate_days*864e8);
  const sensitivity=prior.sensitivity==='local_only'||witness.sensitivity==='local_only'?'local_only':prior.sensitivity;
  const supports=restatedSupport([...support,witness],new Set([...c.heldEvidenceIds('statement',prior.logical_id),witness.id]));
  if(prior.known_from_revision!==c.revision)
    return {...writeVersion(c,{...prior,expires_at_us:expires,sensitivity},supports,time,prior,role,false),restated:true};
  // Written earlier in this same revision (an extraction batch): revised in place.
  for(const old of support)if(!supports.some(e=>e.id===old.id)){
    c.run('DELETE FROM memory_statement_evidence WHERE version_id=? AND evidence_id=?',prior.version_id,old.id);
    c.run("DELETE FROM lineage WHERE derived_id=? AND input_id=? AND role='support'",prior.version_id,old.id);
  }
  c.insert('memory_statement_evidence',{version_id:prior.version_id,evidence_id:witness.id});
  c.lineage(prior.version_id,witness.id,'support');
  c.run('UPDATE memory_statement_versions SET expires_at_us=?,sensitivity=? WHERE version_id=?',expires,sensitivity,prior.version_id);
  if(sensitivity!==prior.sensitivity)c.run("UPDATE artifacts SET sensitivity=? WHERE record_id=?",sensitivity,prior.version_id);
  c.effect(prior.version_id);
  return unchanged;
}
function writeVersion(c:Canonical,v:Row,evidence:Row[],time:number,previous?:Row,role?:string,rebindHolds=true) {
  if(previous){
    const changed=c.run('UPDATE memory_statement_versions SET known_to_revision=? WHERE version_id=? AND known_to_revision IS NULL AND erased=0',c.revision,previous.version_id);
    if(!changed.changes) fail('REVISION_CONFLICT','Statement changed');
    c.run('UPDATE artifacts SET known_to_revision=? WHERE record_id=?',c.revision,previous.version_id);
    c.invalidateDerived(previous.version_id); c.effect(previous.version_id);
  }
  const version=randomUUID();
  c.insert('memory_statement_versions',{...v,version_id:version,known_from_revision:c.revision,aggregate_revision:c.revision,known_from_us:time,known_to_revision:null,erased:0});
  for(const e of evidence){
    c.insert('memory_statement_evidence',{version_id:version,evidence_id:e.id});
    c.lineage(version,e.id,'support');
  }
  if(previous){
    c.lineage(version,previous.version_id,'supersedes');
    if(rebindHolds)c.refreshRetentionEvidence('statement',v.logical_id,version);
  }
  c.artifact(v.scope_id,'statement',version,v.text,[version],'',v.sensitivity);
  c.effect(version);
  return {id:version,logical_id:v.logical_id,status:v.status,aggregate_revision:c.revision,source_role:role};
}
export function amendStatement(c:Canonical,v:Row,patch:Row,time:number) {
  return writeVersion(c,{...v,...patch},statementSupport(c,v.version_id),time,v).id;
}
export function statementRoots(c:Canonical,scope:string,id:string) {
  return c.all('SELECT v.version_id,e.observation_id FROM memory_statement_versions v JOIN memory_statement_evidence m ON m.version_id=v.version_id JOIN evidence e ON e.id=m.evidence_id WHERE v.scope_id=? AND (v.version_id=? OR v.logical_id=?)',scope,id,id)
    .flatMap(r=>[r.version_id,r.observation_id]);
}

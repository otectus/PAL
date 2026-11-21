import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Canonical } from './canonical.ts';
import { categories } from './assessment.ts';
import { fail, parse, witnessSchema } from './contracts.ts';

type Row = Record<string,any>;
const details = z.strictObject({category:z.enum(categories),modality:z.enum(['actual','planned','hypothetical','reported','inferred'])});
export function statementSupport(c:Canonical,version:string) {
  return c.all('SELECT e.* FROM memory_statement_evidence m JOIN evidence e ON e.id=m.evidence_id WHERE m.version_id=? AND e.erased=0 ORDER BY e.id',version);
}
export function createStatement(c:Canonical,scope:string,proposal:Row,time:number,previous?:Row) {
  const statement=parse(details,proposal.statement), witness=c.evidence(scope,parse(witnessSchema,proposal.witness));
  const source=c.one('SELECT role FROM observations WHERE id=?',witness.observation_id);
  const logical=previous?.logical_id ?? randomUUID();
  if(!previous)c.insert('memory_statements',{id:logical,scope_id:scope});
  return writeVersion(c,{
    logical_id:logical,scope_id:scope,category:statement.category,text:witness.witness,subject_id:null,
    status:'candidate',modality:statement.modality,epistemic_type:witness.trust,valid_mode:'unknown',
    valid_from_us:null,valid_to_us:null,conflict_set_id:null,sensitivity:witness.sensitivity,
    expires_at_us:time+c.policy.candidate_days*864e8,
  },[witness],time,previous,source.role);
}
function writeVersion(c:Canonical,v:Row,evidence:Row[],time:number,previous?:Row,role?:string) {
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
    c.refreshRetentionEvidence('statement',v.logical_id,version);
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

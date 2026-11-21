import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {Canonical} from '../../broker/graph-memory/canonical.ts';
import {createStatement} from '../../broker/graph-memory/statements.ts';

const dir=mkdtempSync(join(tmpdir(),'cere-scale-')),c=new Canonical(dir);
try{
  const scope=c.registerScope({key:'scale',label:'Disposable scale benchmark'}).id;
  c.policyUpdate({policy:{enabled:true}});
  c.curation.configure({expected_revision:0,profile:{mode:'preview',reviewModel:{connectionRef:'default:ollama',modelId:'fixture'}}});
  // Populate full evidence, lineage, FTS documents, status and temporal versions.
  // Batched writers reduce fixture preparation time; measurements use normal entry points.
  for(let page=0;page<100;page++){
    c.tx((_,t)=>{
      c.batchTransaction=true;
      try{
        for(let i=page*100;i<(page+1)*100;i++){
          const text='I prefer build variant '+i+'.',o=c.observeText({scope_id:scope,role:'user',text,source_event_id:'scale-'+i});
          createStatement(c,scope,{statement:{category:'preference',modality:'actual'},witness:{observation_id:o.id,quote:text}},t);
        }
      }finally{c.batchTransaction=false;}
    });
  }
  // Add the remaining immutable document records using canonical artifact creation.
  const ev=c.one('SELECT id FROM evidence LIMIT 1').id;
  for(let page=0;page<80;page++)c.tx(()=>{
    for(let i=0;i<1000;i++)c.artifact(scope,'saved','scale-note-'+page+'-'+i,'Synthetic record '+page+' '+i,[ev]);
  });
  const sample=(work:()=>unknown,n:number)=>{
    const values:number[]=[];
    for(let i=0;i<n;i++){const t=performance.now();work();values.push(performance.now()-t);}
    values.sort((a,b)=>a-b);
    return {n,p50_ms:values[Math.floor(n*.5)],p95_ms:values[Math.min(n-1,Math.floor(n*.95))]};
  };
  c.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const baselineBytes=statSync(join(dir,'memory.sqlite')).size;
  const forecast=sample(()=>c.retentionPreview({scope_id:scope,limit:25}),5);
  const enqueue=sample(()=>c.curation.enqueue({scope_id:scope,limit:25},true),10);
  const leases:NonNullable<ReturnType<typeof c.curation.claim>>[]=[];
  const claim=sample(()=>{const job=c.curation.claim();if(!job)throw new Error('Fixture queue empty');leases.push(job)},20);
  const commit=sample(()=>{
    const job=leases.shift()!;
    c.curation.finish({id:job.id,token:job.token,elapsed_ms:0,producer:{assess:{fingerprint:'fixture',modelId:'fixture'}},
      output:{schemaVersion:1,targetVersionId:job.bundle.version_id,support:'ambiguous',evidenceIds:[],importance:1,futureUse:1,novelty:1,durability:'unknown',
        temporalStability:'unknown',duplicateOf:null,conflictsWith:[],suggestedAction:'no_change',reasonCodes:[],explanation:'Synthetic timing fixture.',missingContext:[]}});
  },20);
  const listing=sample(()=>c.curation.list({scope_id:scope,limit:25}),10);
  c.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(JSON.stringify({cpu:cpus()[0]?.model,node:process.version,artifacts:c.one('SELECT COUNT(*) AS n FROM artifacts').n,
    unresolved:c.one("SELECT COUNT(*) AS n FROM memory_statement_versions WHERE status='candidate'").n,forecast,enqueue,claim,commit,listing,
    added_queue_and_assessment_bytes:statSync(join(dir,'memory.sqlite')).size-baselineBytes, database_bytes:statSync(join(dir,'memory.sqlite')).size,rss_bytes:process.memoryUsage().rss,model_requests:0},null,2));
}finally{c.close();rmSync(dir,{force:true,recursive:true});}

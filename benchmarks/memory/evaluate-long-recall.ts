// Evaluate local canonical recall on an operator-supplied upstream dataset.
// Output contains identifiers and aggregate ranks only. No text is sent to a provider.
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Canonical} from '../../broker/graph-memory/canonical.ts';
const [kind,path]=process.argv.slice(2);
if(!path||!['longmemeval','locomo'].includes(kind))throw new Error('Usage: evaluate-long-recall.ts longmemeval|locomo DATASET.json');
const data=readFileSync(path),records=JSON.parse(data.toString()),dir=mkdtempSync(join(tmpdir(),'cere-long-recall-')),store=new Canonical(dir);
try{
  store.policyUpdate({policy:{enabled:true}});
  const ranks:number[]=[],sourceIds:string[]=[];
  for(const sample of records.slice(0,kind==='locomo'?4:20)){
    const id=sample.sample_id||sample.question_id,scope=store.registerScope({key:id,label:'Benchmark'}).id,external=new Map<string,string>();
    function observe(text:string,role:string,ref:string){
      const r=store.observeText({scope_id:scope,text,role});
      external.set(r.id,ref);
    }
    let queries:{question:string,evidence:string[]}[];
    if(kind==='locomo'){
      for(const [key,value] of Object.entries(sample.conversation))if(/^session_\d+$/.test(key)&&Array.isArray(value))
        for(const msg of value)observe(msg.speaker+' · '+msg.text,'user',msg.dia_id);
      queries=sample.qa.filter((q:any)=>q.category!==5&&q.evidence?.length).slice(0,5);
    }else{
      const hasTurnLabels=sample.haystack_sessions.some((s:any[])=>s.some(m=>m.has_answer));
      const gold:string[]=[];
      sample.haystack_sessions.forEach((s:any[],i:number)=>s.forEach((m,j)=>{
        const ref=i+'.'+j;observe(m.content,m.role,ref);
        if(hasTurnLabels?m.has_answer:sample.answer_session_ids.includes(sample.haystack_session_ids[i]))gold.push(ref);
      }));
      queries=[{question:sample.question,evidence:gold}];
    }
    for(const q of queries){
      if(!q.evidence.length)continue;
      const result=store.retrieve({scope_id:scope,text:q.question,max_items:5});
      const order=result.results.map((r:any)=>external.get(r.id));
      const pos=order.findIndex((ref:any)=>q.evidence.includes(ref));
      ranks.push(pos+1);sourceIds.push(id);
    }
  }
  console.log(JSON.stringify({dataset:kind,sha256:createHash('sha256').update(data).digest('hex'),scopes:new Set(sourceIds).size,questions:ranks.length,
    recall_at_5:ranks.filter(Boolean).length/ranks.length,mrr_at_5:ranks.reduce((s,r)=>s+(r?1/r:0),0)/ranks.length,model_requests:0,
    measure:'At least one labeled source in the first five canonical results; lexical baseline, no answer generator.'},null,2));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}

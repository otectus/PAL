import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';

const json=(value:unknown,status=200)=>Response.json(value,{status});
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'pal-provider-output-')),core=new Core(new Store(directory),()=>({send:async()=>{},interrupt:async()=>{},close:async()=>{}}));
  const account:any=await core.rpc('connections.save',{kind:'perplexity',name:'Files'});await core.rpc('provider.credentials',{provider:'perplexity',connectionId:account.id,key:'fixture-key'});
  const session=await core.create({provider:'perplexity',connectionId:account.id,model:'agent-fixture',cwd:directory});
  t.after(async()=>{await core.close();await rm(directory,{recursive:true,force:true});});
  const input=(response:any,changes:Record<string,unknown>={})=>({sessionId:session.id,response,connectionId:account.id,accountRevision:account.revision,credentialRevision:core.credentials.credentialRevision('connection:'+account.id),allowDownload:true,...changes});
  return{core,account,session,input};
}

test('foreground output capture keeps only authenticated share_file listings and structured traces',async t=>{
  const {core,input}=await fixture(t),calls:any[]=[],bytes=Buffer.from('title,url\nPAL,https://example.com\n');
  core.providerJobs.outputFiles.fetch=async(url,init)=>{calls.push([String(url),init]);assert.equal((init!.headers as any).Authorization,'Bearer fixture-key');assert.equal(init!.redirect,'error');
    if(String(url).endsWith('/files'))return json({object:'list',data:[{id:'file_1',object:'file',filename:'../../report.csv',bytes:bytes.length,created_at:1780923289}]});
    return new Response(bytes,{headers:{'Content-Type':'text/csv','Content-Length':String(bytes.length),'Content-Disposition':'attachment; filename="../../report.csv"'}});
  };
  const response={id:'resp_fixture',status:'completed',output:[
    {type:'search_results',queries:['PAL release'],results:[{id:7,url:'https://example.com/release',title:'Release',snippet:'Evidence',date:'2026-06-01',last_updated:'2026-06-02',source:'web'}]},
    {type:'fetch_url_results',contents:[{url:'https://example.com/release',title:'Release',snippet:'Fuller evidence'}]},
    {type:'share_file',url:'https://attacker.example/do-not-fetch'},
    {type:'message',content:[{type:'output_text',text:'Download https://attacker.example/hallucinated.exe'}]},
  ]};
  const captured=await core.providerJobs.outputFiles.capture(input(response));
  assert.equal(calls.length,2);assert.match(calls[0][0],/\/v1\/agent\/resp_fixture\/files$/);assert.match(calls[1][0],/\/files\/file_1\/content$/);
  assert.equal(calls.some(([url])=>url.includes('attacker.example')),false);
  assert.deepEqual(captured.trace.searches[0].queries,['PAL release']);assert.equal(captured.trace.searches[0].results[0].id,'7');assert.equal(captured.trace.fetches[0].contents[0].snippet,'Fuller evidence');
  assert.equal(captured.files.length,1);assert.equal(captured.files[0].name,'.. .. report.csv');assert.equal(captured.files[0].mime,'text/csv');
  const stored=await core.workbench.artifacts.bytes(input(response).sessionId,captured.files[0].artifactId,captured.files[0].versionId);assert.deepEqual(stored.data,bytes);
  assert.equal(stored.version.provenance.responseId,'resp_fixture');assert.equal(stored.version.provenance.fileId,'file_1');
});

test('durable response/file dedupe recovers the installed artifact and remains bound to its account revision',async t=>{
  const {core,account,input}=await fixture(t),bytes=Buffer.from('{"ok":true}\n');let lists=0,downloads=0;
  core.providerJobs.outputFiles.fetch=async(url)=>{if(String(url).endsWith('/files')){lists++;return json({object:'list',data:[{id:'file_json',object:'file',filename:'result.json',bytes:bytes.length,created_at:1780923289}]});}downloads++;return new Response(bytes,{headers:{'Content-Type':'application/json','Content-Length':String(bytes.length),'Content-Disposition':'attachment; filename=result.json'}});};
  const response={id:'resp_dedupe',status:'completed',output:[{type:'share_file'}]},binding=input(response),first=await core.providerJobs.outputFiles.capture(binding);
  assert.equal(lists,1);assert.equal(downloads,1);
  assert.deepEqual((await core.providerJobs.outputFiles.capture(binding)).files,first.files);assert.equal(lists,1);assert.equal(downloads,1);
  core.store.db.prepare('DELETE FROM provider_output_files WHERE response_id=?').run(response.id);
  assert.deepEqual((await core.providerJobs.outputFiles.capture(binding)).files,first.files);assert.equal(lists,1);assert.equal(downloads,1);
  await core.rpc('provider.credentials',{provider:'perplexity',connectionId:account.id,key:'replacement-key'});
  await assert.rejects(core.providerJobs.outputFiles.capture(binding),/account used for this provider response changed/);
});

test('restricted turns opt out before network access and model prose cannot invent a generated file',async t=>{
  const {core,session,input}=await fixture(t);let calls=0;core.providerJobs.outputFiles.fetch=async()=>{calls++;throw new Error('unexpected network request');};
  const prose={id:'resp_prose',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'I made https://example.com/report.pdf'}]}]};
  assert.deepEqual((await core.providerJobs.outputFiles.capture(input(prose))).files,[]);assert.equal(calls,0);
  const restricted=core.store.session(session.id);(restricted as any).remote={role:'limited'};core.store.saveSession(restricted);
  const value=await core.providerJobs.outputFiles.capture(input({id:'resp_restricted',status:'completed',output:[{type:'share_file'}]}));
  assert.equal(value.files.length,0);assert.match(value.recoveryNotes[0],/restricted remote turn/);assert.equal(calls,0);
});

test('expired files produce a short durable recovery note while MIME and size mismatches are refused',async t=>{
  const {core,input}=await fixture(t),response={id:'resp_expired',status:'completed',output:[{type:'share_file'}]};let calls=0;
  core.providerJobs.outputFiles.fetch=async(url)=>{calls++;return String(url).endsWith('/files')?json({object:'list',data:[{id:'gone',object:'file',filename:'gone.pdf',bytes:10,created_at:1780923289}]}):json({error:{message:'expired'}},404);};
  const expired=await core.providerJobs.outputFiles.capture(input(response));assert.equal(expired.files.length,0);assert.match(expired.recoveryNotes[0],/expired/);
  await core.providerJobs.outputFiles.capture(input(response));assert.equal(calls,2,'manifest and unavailable state are reused');

  const bad={id:'resp_bad_mime',status:'completed',output:[{type:'share_file'}]},pdf=Buffer.from('%PDF-1.7\n%%EOF');
  core.providerJobs.outputFiles.fetch=async(url)=>String(url).endsWith('/files')?json({object:'list',data:[{id:'bad',object:'file',filename:'report.csv',bytes:pdf.length,created_at:1780923289}]})
    :new Response(pdf,{headers:{'Content-Type':'application/pdf','Content-Length':String(pdf.length),'Content-Disposition':'attachment; filename=report.csv'}});
  await assert.rejects(core.providerJobs.outputFiles.capture(input(bad)),/filename/);
});

test('background Perplexity jobs persist generated artifacts, traces, citations and dedupe metadata',async t=>{
  const {core,session}=await fixture(t),bytes=Buffer.from('metric,value\nusers,42\n');
  core.providerJobs.fetch=async()=>json({id:'resp_background',status:'completed',model:'agent-fixture',output:[
    {type:'search_results',queries:['fixture'],results:[{id:1,url:'https://example.com/source',title:'Source',snippet:'Evidence',source:'web'}]},
    {type:'share_file'},{type:'message',content:[{type:'output_text',text:'Completed.',annotations:[{type:'url_citation',id:'web-1',url:'https://example.com/source',title:'Source'}]}]},
  ],usage:{input_tokens:2,output_tokens:1}});
  core.providerJobs.outputFiles.fetch=async(url)=>String(url).endsWith('/files')?json({object:'list',data:[{id:'background_csv',object:'file',filename:'metrics.csv',bytes:bytes.length,created_at:1780923289}]})
    :new Response(bytes,{headers:{'Content-Type':'text/csv','Content-Length':String(bytes.length),'Content-Disposition':'attachment; filename=metrics.csv'}});
  const job:any=await core.rpc('research.provider.start',{sessionId:session.id,requestId:randomUUID(),prompt:'Create a metrics file'});
  assert.equal(job.status,'completed');assert.equal(job.files.length,1);assert.equal(job.trace.searches[0].results[0].url,'https://example.com/source');assert.equal(job.sources[0].url,'https://example.com/source');assert.deepEqual(job.recoveryNotes,[]);
  const listed:any[]=await core.rpc('research.provider.list',{sessionId:session.id});assert.equal(listed[0].files[0].artifactId,job.files[0].artifactId);
});

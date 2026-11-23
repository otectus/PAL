// PAL Everywhere §10 (RES-01): a research run reads real pages, keeps an evidence ledger, writes a report whose
// citations name only sources it read, discloses pages it could not read, and Stop still yields a partial report.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import { createWebLoader, WebSearch } from '../broker/web.ts';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { until, workbenchFixture } from './fixtures/workbench.ts';

const pages: Record<string, string> = {
  'https://alpha.example/report': '<html><head><title>Alpha study</title></head><body><p>Alpha measured a 40% improvement with method X.</p></body></html>',
  'https://beta.example/critique': '<html><head><title>Beta critique</title></head><body><p>Beta found no improvement with method X and disputes Alpha.</p></body></html>',
};
function stubWeb(core: any) {
  core.web = new WebSearch(async (url: string) => {
    if (url.startsWith('https://search.example/')) return { url, status: 200, contentType: 'application/json', text: JSON.stringify({ results: [
      { title: 'Alpha study', url: 'https://alpha.example/report', content: 'Alpha snippet' },
      { title: 'Beta critique', url: 'https://beta.example/critique?utm_source=x', content: 'Beta snippet' },
      { title: 'Broken', url: 'https://gamma.example/broken', content: 'Gamma snippet' },
    ] }) };
    const page = pages[url.replace(/\?.*$/, '')];
    if (!page) throw new Error('connection refused');
    return { url, status: 200, contentType: 'text/html', text: page };
  });
}

test('a run reads the pages itself, cites only what it read and discloses what it could not read', async t => {
  const f = await workbenchFixture(t, [
    () => ({ content: '["method X results", "method X criticism"]' }),
    () => ({ content: 'Alpha reports a 40% gain [E1], but Beta disputes it [E2]. A third claim [E9] is unsupported.\n\n## Open questions\n- Why do they differ?' }),
  ]);
  stubWeb(f.core);
  await f.core.updateSettings({ webSearch: { enabled: true, provider: 'searxng', searxngUrl: 'https://search.example' } });
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, tools: true, trusted: true });
  const requestId = '7d1f1f5e-6f2b-4b9a-9c6f-3c1a2a9e5b10';
  const run = await f.core.rpc('research.start', { sessionId: session.id, question: 'Does method X improve results?', requestId });
  assert.equal((await f.core.rpc('research.start', { sessionId: session.id, question: 'Does method X improve results?', requestId })).id, run.id, 'the same request never starts a second run');
  await until(() => ['completed', 'partial', 'failed'].includes(f.core.research.get(run.id).state), 15000);
  const done = f.core.research.get(run.id);
  assert.equal(done.state, 'completed', done.error);
  assert.deepEqual(done.queries, ['method X results', 'method X criticism']);
  const read = done.evidence.filter(e => e.status === 'read'), failed = done.evidence.filter(e => e.status === 'failed');
  assert.equal(read.length, 2); assert.equal(failed.length, 1);
  assert.ok(read.every(e => e.contentHash && e.retrievedAt && e.excerpt), 'every read source has its hash, time and excerpt');
  assert.deepEqual(done.removedCitations, ['E9']);
  const { data } = await f.core.workbench.artifacts.bytes(session.id, done.report!.artifactId);
  const report = data.toString('utf8');
  assert.match(report, /\[E1\]/); assert.match(report, /\[E2\]/);
  assert.match(report, /citation removed: not a source PAL read/);
  assert.match(report, /gamma\.example\/broken · not read/);
  assert.match(report, /Beta disputes it/, 'disagreement between sources stays visible');
  // Excluding a source and writing the report again leaves it out and keeps the evidence listed.
  await f.core.rpc('research.exclude', { id: run.id, evidenceId: 'E2' });
  assert.equal(f.core.research.get(run.id).evidence.find(e => e.id === 'E2')!.status, 'excluded');
});

test('Stop yields a partial report from what was collected, without another model request', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await workbenchFixture(t, [async () => { await gate; return { content: '["slow query"]' }; }]);
  stubWeb(f.core);
  await f.core.updateSettings({ webSearch: { enabled: true, provider: 'searxng', searxngUrl: 'https://search.example' } });
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, tools: true, trusted: true });
  const run = await f.core.rpc('research.start', { sessionId: session.id, question: 'What is slow?' });
  await until(() => f.requests.length === 1);
  await f.core.rpc('research.stop', { id: run.id });
  release();
  await until(() => f.core.research.get(run.id).state === 'stopped', 15000);
  const stopped = f.core.research.get(run.id);
  assert.ok(stopped.report, 'a partial report exists');
  const { data } = await f.core.workbench.artifacts.bytes(session.id, stopped.report!.artifactId);
  assert.match(data.toString('utf8'), /Partial: Stopped before the report was written/);
  assert.equal(f.requests.length, 1, 'no synthesis request after Stop');
});

test('an empty query plan never sends the original question to web search', async t => {
  const f = await workbenchFixture(t, [() => ({ content: '[]' })]);
  let searches = 0;
  f.core.web = new WebSearch(async () => { searches++; throw new Error('unexpected search'); });
  await f.core.updateSettings({ webSearch: { enabled: true, provider: 'searxng', searxngUrl: 'https://search.example' } });
  const session = await f.core.create({ provider: 'ollama', model: 'chat:latest', cwd: f.project, trusted: true });
  const run = f.core.research.start({ sessionId: session.id, question: 'What about confidential fixture Z?' });
  await until(() => f.core.research.get(run.id).state === 'failed');
  assert.match(f.core.research.get(run.id).error!, /No web search was sent/);
  assert.equal(searches, 0);
});

import { pdf } from './fixtures/document.ts';
import { ResearchLibrary } from '../broker/research/library.ts';
import { checkReport, passages } from '../broker/research/evidence.ts';

const settled = async (core:any,id:string) => {
  await until(()=>['completed','partial','paused','stopped','failed'].includes(core.research.get(id).state),20000);
  const r=core.research.get(id);
  assert.notEqual(r.state,'failed',r.error); return r;
};

test('existing research reports keep their source excerpts when they are migrated and revised',async t=>{
  const f=await workbenchFixture(t,[()=>({content:'The release is supported [E1.P1].'})]);
  const s=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const original=await f.core.workbench.artifacts.install({sessionId:s.id,name:'Old report.md',mime:'text/markdown',bytes:Buffer.from('Original brief [E1].'),source:'model-generation',policy:{cloud:true,remote:true},provenance:{kind:'research'}});
  const now=Date.now(),id='saved-investigation';
  f.core.store.set('research.runs',[{id,sessionId:s.id,question:'What did the original source say?',preset:'quick',limits:{minutes:5,sources:12},state:'completed',created:now,updated:now,checkpoints:1,queries:[],evidence:[{id:'E1',url:'https://example.org',title:'Announcement',query:'release',status:'read',excerpt:'The original release is supported.'}],report:{artifactId:original.artifactId,versionId:original.versionId,name:'Old report.md'}}]);
  new ResearchLibrary(f.core.store);
  assert.equal(f.core.research.get(id).revisions.length,1);
  await f.core.rpc('research.exclude',{id,evidenceId:'E1'});
  await f.core.rpc('research.resynthesize',{id});
  const historical=await f.core.rpc('research.readReport',{id,versionId:original.versionId});
  assert.equal(historical.text,'Original brief [E1].');assert.equal(historical.evidence[0].status,'read');
  assert.equal(historical.evidence[0].passages[0].text,'The original release is supported.');
});

test('forgetting multiline quoted text in an old revision removes its run and derived exports',async t=>{
  const f=await workbenchFixture(t,[()=>({content:'The device has a manual [E1.P1].'})]);
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const note=f.core.notebook.create(f.project,'Manual');f.core.notebook.saveNote(note.id,'The device has a manual.',note.revision);
  const [source]=await f.core.rpc('research.sources',{sessionId:session.id,query:'Manual'});
  const run=await f.core.rpc('research.start',{sessionId:session.id,question:'What is available for the device?',scope:'project',sourceIds:[source.id]});
  const r=await settled(f.core,run.id),secret='The quoted "passage"\ncontains two lines.';
  f.core.research.library.snapshot({...r,reportText:secret});
  const exported=await f.core.rpc('research.export',{id:r.id,format:'csv'});
  const {erasureMatcher}=await import('../broker/memory.ts');
  const {eraseWorkingCopies}=await import('../broker/working-erasure.ts');
  eraseWorkingCopies(f.core.store,session,erasureMatcher({texts:[secret]}));
  assert.equal(f.core.research.library.has(r.id),false);
  assert.throws(()=>f.core.workbench.artifacts.version(session.id,exported.artifactId));
  assert.throws(()=>f.core.workbench.artifacts.version(session.id,r.report.artifactId));
});

test('a late finding, support audit and document revisions remain inspectable; refresh updates only changed evidence', async t=>{
  let edition='Offline indexing requires version 4.2.', queries=0;
  const f=await workbenchFixture(t,[body=>{
    const prompt=body.messages[0].content;
    if(prompt.startsWith('Prepare focused'))return {content:'["indexing prerequisites"]'};
    if(prompt.startsWith('Check each claim')) {
      const items=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));
      return {content:JSON.stringify(items.map((i:any)=>({index:i.index,status:'supported',quote:edition})))};
    }
    const id=/\[(E\d+\.P\d+)\][^\n]*\n[^\n]*Offline indexing requires/.exec(prompt)?.[1];
    return {content:'## Finding\n'+edition.replace(/\.$/,'')+' ['+id+'].'};
  }]);
  f.core.web=new WebSearch(async url=>{
    if(url.startsWith('https://search.example')){queries++;return {url,status:200,contentType:'application/json',text:JSON.stringify({results:[{url:'https://docs.example/ref',title:'Manual'}]})};}
    return {url,status:200,contentType:'text/html',text:'<article>'+('Preface about permissions. '.repeat(1000))+' '+edition+'</article>'};
  });
  await f.core.updateSettings({webSearch:{enabled:true,provider:'searxng',searxngUrl:'https://search.example'}});
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const raw=await f.core.rpc('research.start',{sessionId:session.id,question:'What version does offline indexing require?'});
  const first=await settled(f.core,raw.id);
  assert.ok(first.evidence[0].passages.some((p:any)=>p.text.includes(edition)));
  assert.equal(first.findings[0].status,'Supported by passage');
  assert.ok(first.findings[0].citations[0].includes('.P'));
  const before=first.report.versionId;
  edition='Offline indexing requires version 5.0.';
  await f.core.rpc('research.refresh',{id:raw.id});
  const second=await settled(f.core,raw.id);
  assert.notEqual(second.report.versionId,before);
  assert.equal(second.report.artifactId,first.report.artifactId);
  assert.match(second.changes.join('\n'),/Updated finding.*5\.0/);
  const prior=await f.core.rpc('research.readReport',{id:raw.id,versionId:before});
  assert.match(prior.text,/4\.2/);assert.doesNotMatch(prior.text,/5\.0/);
  assert.ok(prior.evidence[0].passages.some((p:any)=>p.text.includes('4.2')));
  assert.equal(queries,2);
  f.core.research.exclude(raw.id,'E1');
  const stale=f.core.research.get(raw.id);
  assert.ok(stale.stale); assert.match(stale.findings[0].status,/excluded/);
  await assert.rejects(f.core.rpc('research.export',{id:raw.id,format:'csv'}),/Rewrite/);
  assert.equal((await f.core.rpc('research.byArtifact',{sessionId:session.id,artifactId:first.report.artifactId})).id,raw.id);
});

test('a project PDF and public manual produce a protected, cited comparison, library entry, note and exports',async t=>{
  const sent:string[]=[];
  const f=await workbenchFixture(t,[body=>{
    const p=body.messages[0].content;
    if(p.startsWith('Prepare focused')){
      assert.doesNotMatch(p,/Quarterly revenue rose/);
      return {content:'["released quarterly results"]'};
    }
    if(p.startsWith('Answer this follow-up'))return {content:'Quarterly revenue rose [E1.P1].'};
    return {content:'| Item | Evidence |\n| --- | --- |\n| Revenue | Quarterly revenue rose [E1.P1]. Confirmed in the release [E2.P1]. |'};
  }]);
  f.core.web=new WebSearch(async url=>{
    sent.push(url);
    return url.startsWith('https://search.example')?{url,status:200,contentType:'application/json',text:JSON.stringify({results:[{url:'https://example.org/release',title:'Release'}]})}:
      {url,status:200,contentType:'text/plain',text:'The release confirms the quarterly result.'};
  });
  await f.core.updateSettings({webSearch:{enabled:true,provider:'searxng',searxngUrl:'https://search.example'}});
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  await f.core.workbench.artifacts.install({sessionId:session.id,bytes:pdf(),mime:'application/pdf',name:'Internal brief.pdf',source:'user-import',policy:{cloud:false,remote:false},provenance:{kind:'fixture'}});
  const [source]=await f.core.rpc('research.sources',{sessionId:session.id,query:'Internal brief'});
  assert.ok(source.id);
  const run=await f.core.rpc('research.start',{sessionId:session.id,scope:'both',sourceIds:[source.id],mode:'compare',question:'Compare the reported results.',calls:2});
  const result=await settled(f.core,run.id);
  assert.equal(result.table.rows.length,1);
  assert.match(result.evidence[0].passages[0].location,/page 1/i);assert.match(result.evidence[0].passages[0].text,/Quarterly revenue rose/);
  assert.equal(result.evidence[1].status,'read'); assert.ok(!sent.join(' ').includes('revenue'));
  assert.deepEqual(f.core.workbench.artifacts.version(session.id,result.report.artifactId).policy,{remote:false,cloud:false});
  const priorRequests=sent.length,answer=await f.core.rpc('research.ask',{id:run.id,question:'What did the internal report say?'});
  assert.match(answer.answer,/\[E1\.P1\]/);assert.equal(sent.length,priorRequests);
  for(const format of ['csv','bibtex','json','markdown']){
    const version=await f.core.rpc('research.export',{id:run.id,format});
    assert.equal(version.policy.cloud,false);
    const {data}=await f.core.workbench.artifacts.bytes(session.id,version.artifactId);
    if(format==='csv')assert.match(data.toString(),/Quarterly revenue rose \[E1.P1\]/);
    if(format==='markdown'){
      assert.match(data.toString(),/\[E1\.P1\]\(#passage-e1-p1\)/);
      assert.match(data.toString(),/## Cited passages[\s\S]*page 1[\s\S]*> Quarterly revenue rose/i);
    }
  }
  const note=await f.core.rpc('research.note',{id:run.id,text:result.findings[0].text});
  assert.match(note.text,/Quarterly revenue/);
  const other=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  await f.core.rpc('research.update',{id:run.id,pinned:true,title:'Quarterly comparison'});
  const [listed]=await f.core.rpc('research.list',{sessionId:other.id,project:true});
  assert.equal(listed.title,'Quarterly comparison');assert.equal(listed.pinned,true);assert.equal(listed.evidence,undefined);
  await f.core.rpc('research.update',{id:run.id,archived:true});
  assert.equal(f.core.research.get(run.id).archived,true);
  f.core.updateSession(session.id,{model:'cloudy:cloud'});
  const priorCalls=f.requests.length;
  await assert.rejects(f.core.rpc('research.ask',{id:run.id,question:'Repeat the private excerpt'}),/does not allow/);
  assert.equal(f.requests.length,priorCalls);
});

test('pause checkpoints the first read and continues the saved queue without refetching it',async t=>{
  const f=await workbenchFixture(t,[()=>({content:'["first query"]'}),()=>({content:'Read all [E1].'})]);
  let waitSecond=true,readFirst=0,entered=false;
  f.core.web=new WebSearch(async(url,signal)=>{
    if(url.startsWith('https://search.example'))return {url,status:200,contentType:'application/json',text:JSON.stringify({results:['first','second'].map(path=>({url:'https://docs.example/'+path,title:path}))})};
    if(url.endsWith('/first'))readFirst++;
    if(url.endsWith('/second')&&waitSecond){entered=true;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    return {url,status:200,contentType:'text/plain',text:'Source '+url};
  });
  await f.core.updateSettings({webSearch:{enabled:true,provider:'searxng',searxngUrl:'https://search.example'}});
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const r=await f.core.rpc('research.start',{sessionId:session.id,question:'What do both sources say?'});
  await until(()=>entered);
  await f.core.rpc('research.pause',{id:r.id});
  const paused=await settled(f.core,r.id);assert.equal(paused.state,'paused');assert.equal(paused.evidence.length,1);
  assert.equal(paused.pending.length,1);assert.equal(paused.report,undefined);
  const db=new ResearchLibrary(f.core.store);assert.equal(db.get(r.id).evidence.length,1);
  waitSecond=false;await f.core.rpc('research.continue',{id:r.id});
  const done=await settled(f.core,r.id);assert.equal(done.evidence.length,2);assert.equal(readFirst,1);
  f.core.research.library.put({...done,state:'reading'});
  new ResearchLibrary(f.core.store);assert.equal(f.core.research.get(r.id).state,'paused');
  await f.core.rpc('research.resynthesize',{id:r.id});
  assert.equal(f.core.research.get(r.id).state,'partial');
});

test('project-only research uses no web even on refresh, and the desktop schedule pauses if its model changes',async t=>{
  const f=await workbenchFixture(t,[()=>({content:'Project-only result [E1].'})]);
  let webCalls=0;f.core.web=new WebSearch(async()=>{webCalls++;throw new Error('Unexpected web call');});
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const note=f.core.notebook.create(f.project,'Scope'); f.core.notebook.saveNote(note.id,'The required platform is Linux.',note.revision);
  const [source]=await f.core.rpc('research.sources',{sessionId:session.id,query:'Scope'});
  const r=await f.core.rpc('research.start',{sessionId:session.id,scope:'project',sourceIds:[source.id],question:'Which platform is required?'});
  const first=await settled(f.core,r.id);assert.equal(first.evidence[0].status,'read');
  await f.core.rpc('research.update',{id:r.id,monitorDays:1});
  let current=f.core.research.get(r.id);f.core.research.library.put({...current,nextRefresh:1});
  const messages=f.core.store.messages(session.id).length;
  f.core.research.tick();await settled(f.core,r.id);
  assert.equal(f.core.store.messages(session.id).length,messages);
  current=f.core.research.get(r.id);assert.ok(current.revisions.length>=2);
  f.core.research.library.put({...current,nextRefresh:1});f.core.updateSession(session.id,{model:'cloudy:cloud'});f.core.research.tick();
  assert.equal(f.core.research.get(r.id).monitorDays,0);assert.equal(webCalls,0);
});

test('Thorough can discover 40 distinct pages with adaptive searches and enforces its requested limits',async t=>{
  let round=0;
  const f=await workbenchFixture(t,[body=>{
    const p=body.messages[0].content;
    if(p.startsWith('Prepare focused'))return {content:JSON.stringify(Array.from({length:6},(_,i)=>'group '+(++round)+' query '+i))};
    return {content:'Findings are available [E1].'};
  }]);
  f.core.web=new WebSearch(async url=>{
    if(url.startsWith('https://search.example')){
      const q=new URL(url).searchParams.get('q');
      return {url,status:200,contentType:'application/json',text:JSON.stringify({results:Array.from({length:6},(_,i)=>({url:'https://primary.example/'+encodeURIComponent(q!)+'/'+i,title:'Primary source '+i}))})};
    }
    return {url,status:200,contentType:'text/plain',text:'Unique evidence from '+url};
  });
  await f.core.updateSettings({webSearch:{enabled:true,provider:'searxng',searxngUrl:'https://search.example'}});
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const r=await f.core.rpc('research.start',{sessionId:session.id,preset:'thorough',parallel:true,calls:5,sources:40,question:'Cover all primary source groups.'});
  const done=await settled(f.core,r.id);
  assert.equal(done.evidence.length,40);assert.ok(done.queries.length>6);assert.ok(done.callsUsed<=5);assert.equal(done.state,'partial');
});

test('passage selection ranks a late exact match above repeated boilerplate',()=>{
  const parts=passages('E1',[{location:'Manual',text:'Introduction. '.repeat(16000)+'The offline indexing prerequisite is version 4.2.'}],'offline indexing prerequisite',1);
  assert.match(parts[0].text,/version 4\.2/);
});

test('claim checks skip headings and accept only passage IDs actually sent to the model',()=>{
  const p={id:'E1.P1',text:'A source can mention [E1.P2] in its own text.',location:'Page 1'};
  const evidence=[{id:'E1',url:'',title:'Document',status:'read' as const,query:'',passages:[p,{...p,id:'E1.P2',location:'Page 2'}]}];
  const result=checkReport('**Evidence:**\n- **Finding:** The first passage mentions a reference [E1.P1].\nThe other passage is unseen [E1.P2].',evidence,new Set(['E1.P1']));
  assert.equal(result.findings.length,2);
  assert.deepEqual(result.removed,['E1.P2']);
  assert.deepEqual(result.findings[0].citations,['E1.P1']);
  const multiline={...p,text:'JSON text MUST use\n   UTF-8.'};
  const quoted=checkReport('> “JSON text MUST use UTF-8.”\n\n— Section 8.1 [E1.P1, E1.P2]',[{...evidence[0],passages:[multiline]}],new Set(['E1.P1']));
  assert.equal(quoted.findings.length,1);assert.equal(quoted.findings[0].quote,multiline.text);assert.deepEqual(quoted.removed,['E1.P2']);
  const range=checkReport('Shared evidence [E1.P1–E1.P2]. Unseen [E1.P1–E2.P9].',evidence,new Set(['E1.P1','E1.P2']));
  assert.deepEqual(range.findings[0].citations,['E1.P1','E1.P2']);assert.deepEqual(range.removed,['E1.P1–E2.P9']);
});

test('web passages preserve section names and paragraph boundaries when a page redirects',async()=>{
  const reader=new WebSearch(async()=>({url:'https://example.org/new',status:200,contentType:'text/html',text:'<html><body><article><h1>Release notes</h1><h2>Requirements</h2><p>Works offline.</p><p>Requires version 4.</p></article></body></html>'}));
  const result=await reader.read('https://example.org/old',new AbortController().signal,{parsePdf:async()=>({units:[],warnings:[]})});
  assert.equal(result.url,'https://example.org/new');
  assert.ok(result.units?.some(u=>u.location.includes('Release notes › Requirements')&&u.text.includes('Works offline. Requires version 4.')));
});

test('the research reader accepts a larger PDF while keeping ordinary pages under their smaller limit',async()=>{
  const read=(prefix:string,document:boolean)=>createWebLoader({lookup:async()=>[{address:'8.8.8.8',family:4}],request:((_url:any,_p:any,receive:any)=>{
    const response=Object.assign(Readable.from([Buffer.from(prefix.slice(0,2)),Buffer.from(prefix.slice(2)),Buffer.alloc(3*1024*1024)]),{headers:{'content-type':'application/pdf'},statusCode:200});
    queueMicrotask(()=>receive(response));return Object.assign(new EventEmitter(),{end(){}});
  }) as any})('https://example.org/paper',new AbortController().signal,{document});
  assert.ok((await read('%PDF-',true)).bytes!.length>2*1024*1024);
  await assert.rejects(read('hello',true),/2 MB limit/);
  await assert.rejects(read('%PDF-',false),/2 MB limit/);
});

test('research reads a selected workspace file and bound collection, and rechecks the binding for follow-ups',async t=>{
  const f=await workbenchFixture(t,[()=>({content:'The zircon flag enables offline mode [E2.P1].'})]);
  const {session}=await f.session();
  const guide=join(f.project,'field-guide.md');
  await writeFile(guide,'# Field guide\n\nThe zircon flag enables offline mode.');
  await writeFile(join(f.project,'field-requirements.txt'),'The deployment requires the zircon flag.');
  let c=await f.core.rpc('collections.create',{name:'Field collection',grounding:'strict'});
  c=await f.core.rpc('collections.addSource',{id:c.id,expectedRevision:c.revision,path:guide});
  await f.core.rpc('collections.index',{id:c.id});
  await until(()=>!!f.core.collections.job?.done);
  await f.core.rpc('collections.bind',{id:c.id,target:'session',sessionId:session.id,bound:true});
  const picks=await f.core.rpc('research.sources',{sessionId:session.id,query:'field'});
  const file=picks.find((p:any)=>p.kind==='file' && p.title==='field-requirements.txt'),collection=picks.find((p:any)=>p.kind==='collection');
  assert.ok(file&&collection);
  const run=await f.core.rpc('research.start',{sessionId:session.id,question:'How does the zircon flag enable offline mode?',scope:'project',sourceIds:[file.id,collection.id]});
  const done=await settled(f.core,run.id);
  assert.match(done.evidence[0].passages[0].text,/zircon flag/);
  assert.match(done.evidence[1].passages[0].location,/field-guide\.md/);
  await f.core.rpc('collections.bind',{id:c.id,target:'session',sessionId:session.id,bound:false});
  const sent=f.requests.length;
  await assert.rejects(f.core.rpc('research.ask',{id:run.id,question:'What does the guide say?'}),/collection is unavailable/);
  assert.equal(f.requests.length,sent);
});

test('literature screening follows publisher references, records failed access and keeps bibliographic citations portable',async t=>{
  const f=await workbenchFixture(t,[body=>{
    const p=body.messages[0].content;
    if(p.startsWith('Prepare focused'))return {content:p.includes('Earlier searches')?'[]':'["synthetic field trials"]'};
    return {content:'| Study | Design |\n| --- | --- |\n| Trial A | Controlled field trial [E1.P1] |'};
  }]);
  const calls:string[]=[];
  f.core.web=new WebSearch(async url=>{
    calls.push(url);
    const reply=(contentType:string,text:string)=>({url,status:200,contentType,text});
    if(url.startsWith('https://search.example'))return reply('application/json',JSON.stringify({results:[{title:'Other',url:'https://other.example/unavailable'}]}));
    if(url.startsWith('https://api.crossref.org'))return reply('application/json',JSON.stringify({message:{items:[{DOI:'10.1234/trial',title:['Trial A'],published:{'date-parts':[[2025,2,1]]},author:[{given:'Ada',family:'Morse'}],reference:[{DOI:'10.1234/original'}]}]}}));
    if(url.includes('other.example'))throw new Error('subscription required');
    return reply('text/plain','Controlled field trial '+url);
  });
  await f.core.updateSettings({webSearch:{enabled:true,provider:'searxng',searxngUrl:'https://search.example'}});
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const r=await f.core.rpc('research.start',{sessionId:session.id,preset:'thorough',mode:'literature',question:'Which trials used field controls?',criteria:['Controlled field study']});
  const done=await settled(f.core,r.id);
  assert.ok(done.evidence.some((e:any)=>e.doi==='10.1234/original' && e.query==='Reference cited by E1' && e.status==='read'));
  assert.ok(done.evidence.some((e:any)=>e.status==='failed'));
  assert.equal(done.evidence[0].publishedAt,'2025-02-01');
  const bib=await f.core.rpc('research.export',{id:r.id,format:'bibtex'}),file=await f.core.workbench.artifacts.bytes(session.id,bib.artifactId);
  assert.match(file.data.toString(),/Ada Morse/);assert.match(file.data.toString(),/10\.1234\/trial/);
  calls.length=0;
  await f.core.rpc('research.refresh',{id:r.id});
  const refreshed=await settled(f.core,r.id);
  assert.ok(calls.some(url=>url.includes('api.crossref.org')));
  assert.ok(refreshed.evidence.some((e:any)=>e.doi==='10.1234/trial' && e.authors==='Ada Morse'));
  calls.length=0;
  const restricted=await f.core.rpc('research.start',{sessionId:session.id,preset:'quick',mode:'literature',sites:['other.example'],question:'Which trials used field controls?'});
  await settled(f.core,restricted.id);
  assert.ok(calls.every(url=>!url.includes('crossref')));
});

test('managed API research uses each conversation provider, records its usage and checks passage citations',async t=>{
  const f=await workbenchFixture(t);
  const calls:string[]=[];
  await f.core.updateSettings({compatible:{baseUrl:'https://model.example/v1',label:'Test model',requiresKey:false},webSearch:{enabled:true,provider:'searxng',searxngUrl:'https://search.example'}});
  f.core.credentials.key=()=> 'fixture-only';
  const access=f.core.apiAccess.bind(f.core);
  const targets={openai:'api.openai.com',anthropic:'api.anthropic.com',google:'generativelanguage.googleapis.com',compatible:'model.example'};
  f.core.apiAccess=(provider,sessionId)=>({...access(provider,sessionId),fetch:async(url,init)=>{
    assert.ok(sessionId);assert.equal(new URL(String(url)).hostname,targets[provider]);
    const body=JSON.parse(String(init?.body));
    const prompt=body.input??body.messages?.[0].content??body.contents?.[0].parts[0].text;
    calls.push(provider);
    const text=prompt.startsWith('Prepare focused')?'["method X"]':'Method X was measured [E1.P1], with a bogus location [E2.P42].';
    const usage={input_tokens:100,output_tokens:20};
    if(provider==='openai')return Response.json({output:[{content:[{type:'output_text',text}]}],usage});
    if(provider==='anthropic')return Response.json({content:[{type:'text',text}],usage});
    if(provider==='google')return Response.json({candidates:[{content:{parts:[{text}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}});
    return Response.json({choices:[{message:{content:text}}],usage:{prompt_tokens:100,completion_tokens:20}});
  }});
  stubWeb(f.core);
  for(const provider of ['openai','anthropic','google','compatible'] as const){
    const s=await f.core.create({provider,model:'fixture-model',cwd:f.project});
    const r=await f.core.rpc('research.start',{sessionId:s.id,question:'What was measured?',calls:2});
    const done=await settled(f.core,r.id);
    assert.equal(calls.filter(p=>p===provider).length,2);assert.deepEqual(done.removedCitations,['E2.P42']);
    assert.ok(f.core.usage.rows(0).some(row=>row.provider===provider&&row.inputTokens===100));
  }
});

test('follow-ups search the frozen source beyond the original passages and erasure removes the stored copies',async t=>{
  const f=await workbenchFixture(t,[body=>{
    const prompt=body.messages[0].content;
    if(prompt.startsWith('Answer this follow-up')){
      const block=String(prompt).split(/(?=\[E1\.P\d+\])/).find(v=>v.startsWith('[E1.') && v.includes('Tungsten coefficient: 17'));
      const id=block?.match(/^\[(E1\.P\d+)\]/)?.[1];
      return {content:'The coefficient is 17 ['+id+'].'};
    }
    return {content:'Main finding [E1].'};
  }]);
  const session=await f.core.create({provider:'ollama',model:'chat:latest',cwd:f.project});
  const body=Array.from({length:18},(_,i)=>('Offline indexing specification '+i+'. ').repeat(60)).join('\n')+'\nTungsten coefficient: 17.';
  const s=f.core.notebook.create(f.project,'Test reference');f.core.notebook.saveNote(s.id,body,s.revision);
  const [source]=await f.core.rpc('research.sources',{sessionId:session.id,query:'Test reference'});
  const run=await f.core.rpc('research.start',{sessionId:session.id,question:'Which offline indexing specification applies?',scope:'project',sourceIds:[source.id]});
  const done=await settled(f.core,run.id);
  assert.ok(!done.evidence[0].passages.some((p:any)=>p.text.includes('Tungsten')));
  const answer=await f.core.rpc('research.ask',{id:run.id,question:'Find the tungsten coefficient'});
  assert.match(answer.answer,/coefficient is 17 \[E1\.P\d+\]/);
  const {eraseResearchCopies}=await import('../broker/research/library.ts');
  eraseResearchCopies(f.core.store,session.id,s=>s.includes('Tungsten coefficient: 17.'));
  assert.throws(()=>f.core.research.get(run.id),/no longer exists/);
  assert.equal(f.core.store.db.prepare('SELECT count(*) AS n FROM research_source_text WHERE run_id=?').get(run.id)?.n,0);
  assert.equal(f.core.store.db.prepare('SELECT count(*) AS n FROM research_versions WHERE run_id=?').get(run.id)?.n,0);
});

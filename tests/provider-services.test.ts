import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { hostedEmbeddings } from '../broker/graph-memory/hosted-embeddings.ts';
import { ServiceVectorRepository, type VectorConfig } from '../broker/graph-memory/adapters/vector-services.ts';
import { artifactPointId } from '../broker/graph-memory/adapters/qdrant.ts';
import { jevEvaluate,voyageRerank } from '../broker/evaluation-services.ts';
import { hostedSearch } from '../broker/hosted-search.ts';
import { synthesize,transcribe } from '../broker/hosted-speech.ts';
import { migrateProviderReferences } from '../broker/provider-import.ts';

// A fresh deadline for each request: one made when the file loads expires while earlier tests run.
const signal=()=>AbortSignal.timeout(60000);
const json=(v:unknown)=>Response.json(v);
async function fixture(t:any) {
  const dir=await mkdtemp(join(tmpdir(),'pal-provider-fixture-'));
  const store=new Store(dir);
  const core=new Core(store,()=>({send:async()=>{},interrupt:async()=>{},close:async()=>{}}));
  t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true});});
  return {core,dir};
}
test('provider migration backs up the previous SQLite profile once and imports PyGPT as inert data',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-provider-migration-'));
  t.after(()=>rm(directory, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}));
  const store=new Store(directory);store.set('settings',store.settings());
  migrateProviderReferences(store);
  const backup=join(directory,'migration-backups','pre-provider-v2.sqlite'),before=await stat(backup);
  assert.equal(before.mode&0o777,0o600);migrateProviderReferences(store);assert.equal((await stat(backup)).mtimeMs,before.mtimeMs);
  const original=new DatabaseSync(backup,{readOnly:true});assert.ok(original.prepare("SELECT 1 FROM meta WHERE key='settings'").get());assert.equal(original.prepare("SELECT 1 FROM meta WHERE key='providerSchemaVersion'").get(),undefined);original.close();
  const core=new Core(store);t.after(()=>core.close());
  const input=JSON.stringify({providers:{x_ai:{name:'Work',settings:{api_key:'private-value',api_base:'https://api.x.ai/v1'},python:'arbitrary source'},huggingface_router:{name:'Hub'},custom_unmapped:{}},'bing.search':true});
  const preview=await core.rpc('connections.importPreview',{json:input});
  assert.deepEqual(preview.accounts.map((r:any)=>[r.kind,r.variant]),[['xai',undefined],['huggingface','router']]);
  assert.equal(preview.notices.length,1);assert.ok(preview.unmapped.includes('custom_unmapped'));assert.doesNotMatch(JSON.stringify(preview),/private-value|arbitrary source/);
  await assert.rejects(core.rpc('connections.importApply',{json:input,digest:'a'.repeat(64)}),/Preview/);
  const result=await core.rpc('connections.importApply',{json:input,digest:preview.digest});assert.equal(result.created.length,2);
  assert.equal((await core.rpc('connections.importPreview',{json:input})).duplicates.length,2);
  assert.equal(core.accountAccess('xai',result.created[0]).key(),'');
});
test('named accounts on the same origin isolate keys, revisions, and prepared research jobs',async t=>{
  const {core,dir}=await fixture(t);
  const a=await core.rpc('connections.save',{kind:'perplexity',name:'Work'}),b=await core.rpc('connections.save',{kind:'perplexity',name:'Home'});
  await core.rpc('provider.credentials',{provider:'perplexity',key:'fixture-a',connectionId:a.id});
  assert.equal(core.accountAccess('perplexity',b.id).key(),'');
  const session=await core.create({provider:'perplexity',connectionId:a.id,model:'agent-fixture',cwd:dir});
  const requests:any[]=[];core.providerJobs.fetch=async(url,init)=>{requests.push({url:String(url),...init});return json(requests.length===1?{id:'receipt-1',status:'queued'}:{id:'receipt-1',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Report',annotations:[{url:'https://example.com/',title:'Reference'}]}]}],usage:{input_tokens:2,output_tokens:1}});};
  const p={sessionId:session.id,requestId:randomUUID(),prompt:'Research fixture',effort:'high'};
  const job=await core.rpc('research.provider.start',p);assert.equal(job.remoteId,'receipt-1');
  assert.equal((await core.rpc('research.provider.start',p)).id,job.id);assert.equal(requests.length,1);
  assert.equal(JSON.parse(requests[0].body).model,undefined);
  await assert.rejects(core.rpc('research.provider.start',{...p,prompt:'Different'}),/already used/);
  const done=await core.rpc('research.provider.poll',{sessionId:session.id,id:job.id});
  assert.equal(done.text,'Report');assert.equal(done.sources[0].title,'Reference');assert.equal(requests[1].method,'GET');
  const access=core.accountAccess('perplexity',a.id);await core.rpc('provider.credentials',{provider:'perplexity',connectionId:a.id,key:'fixture-b'});
  assert.throws(()=>access.key(),/changed/);
  core.providerJobs.fetch=async()=>{throw new Error('connection interrupted');};
  const lost={...p,requestId:randomUUID()};await assert.rejects(core.rpc('research.provider.start',lost),/interrupted/);
  assert.equal((await core.rpc('research.provider.start',lost)).status,'unknown-outcome');
});
test('provider research idempotency and active caps inspect rows beyond the display page',async t=>{
  const {core,dir}=await fixture(t);
  await core.rpc('provider.credentials',{provider:'perplexity',key:'fixture-key'});
  const session=await core.create({provider:'perplexity',model:'agent-fixture',cwd:dir});
  const other=await core.create({provider:'perplexity',model:'agent-fixture',cwd:dir});
  let requests=0;
  core.providerJobs.fetch=async()=>json(++requests===1?{id:'durable-receipt',status:'queued'}:{id:'durable-receipt',status:'completed',output:[]});
  const params={sessionId:session.id,requestId:randomUUID(),prompt:'Durable lookup fixture',effort:'medium'};
  const target:any=await core.rpc('research.provider.start',params);
  const insert=core.store.db.prepare('INSERT INTO provider_research_jobs VALUES(?,?,?)');
  for(let i=0;i<3;i++){
    const id=randomUUID(),now=Date.now()-100_000-i;
    insert.run(id,session.id,JSON.stringify({id,sessionId:session.id,prompt:'Older active '+i,model:'agent-fixture',revision:0,credentialRevision:'fixture',status:'in_progress',remoteId:'older-'+i,created:now,updated:now}));
  }
  for(let i=0;i<70;i++){
    const id=randomUUID(),now=Date.now()-i;
    insert.run(id,session.id,JSON.stringify({id,sessionId:session.id,prompt:'Completed '+i,model:'agent-fixture',revision:0,credentialRevision:'fixture',status:'completed',remoteId:'done-'+i,created:now,updated:now}));
  }
  assert.equal((await core.rpc('research.provider.start',params)).id,target.id,'idempotent receipt survives beyond the 64-row display page');
  assert.equal(requests,1);
  await assert.rejects(core.rpc('research.provider.start',{...params,prompt:'Changed intent'}),/different research/);
  await assert.rejects(core.rpc('research.provider.start',{...params,sessionId:other.id}),/already exists/);
  await assert.rejects(core.rpc('research.provider.start',{sessionId:session.id,requestId:randomUUID(),prompt:'Fifth active job'}),/Finish an active/);
  const done:any=await core.rpc('research.provider.poll',{sessionId:session.id,id:target.id});
  assert.equal(done.status,'completed','poll resolves a handle beyond the display page');
  await assert.rejects(core.rpc('research.provider.poll',{sessionId:other.id,id:target.id}),/Unknown provider research run/);
});
test('embedding services enforce ordering, signed-byte encoding, dimensions and input roles',async()=>{
  for(const provider of ['openai','mistral','openrouter','edenai','forge','azure_openai','litellm','compatible','voyage','perplexity'] as const){
    const request:any[]=[];const encoded=provider==='perplexity';
    const rows=[{index:1,embedding:encoded?'Af8=':[1,-1]},{index:0,embedding:encoded?'/wE=':[-1,1]}];
    const access={key:()=>'fixture',route:()=>({baseUrl:'https://example.com/v1',deployment:provider==='azure_openai'?'embedding-deployment':undefined}),endpoint:()=>({baseUrl:'https://example.com/v1',requiresKey:true}) as any,
      fetch:async(url:any,init:any)=>{request.push([url,JSON.parse(init.body)]);return json({data:rows});}};
    const vectors=await hostedEmbeddings(provider,access,'model',['a','b'],'document',signal(),2);
    assert.deepEqual(vectors,[[-1,1],[1,-1]]);assert.equal(request.length,1);
    if(encoded||provider==='voyage')assert.equal(request[0][1].input_type,'document');
    const bad={...access,fetch:async()=>json({data:[rows[0],rows[0]]})};
    await assert.rejects(hostedEmbeddings(provider,bad,'model',['a','b'],'query',signal(),2),/index/);
  }
});
test('Hugging Face hosted embeddings use feature extraction with explicit pooling',async()=>{
  const requests:any[]=[];
  const access={key:()=> 'hf-key',route:()=>({baseUrl:'https://router.huggingface.co/v1/'}),fetch:async(url:any,init:any)=>{requests.push([String(url),JSON.parse(init.body)]);return json([[[1,3],[3,5]],[[2,4],[4,6]]]);}};
  assert.deepEqual(await hostedEmbeddings('huggingface',access as any,'org/embed',['a','b'],'document',signal(),2,'mean'),[[2,4],[3,5]]);
  assert.equal(requests[0][0],'https://router.huggingface.co/hf-inference/models/org/embed');
  assert.deepEqual(requests[0][1],{inputs:['a','b']});
  assert.equal((access as any).route().baseUrl,'https://router.huggingface.co/v1/');
});
test('local vectors survive reopening, enforce scope and forget erased content',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pal-vector-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cfg:VectorConfig={engine:'simple',endpoint:'',database:'db',namespace:'fixture',tenant:'home',external:false},fingerprint='f'.repeat(64);
  let repo=new ServiceVectorRepository(cfg,fingerprint,2,dir,'');await repo.initialize();
  const m: any={ownerId:'owner',scopeId:'project',artifactKind:'assertion',artifactId:'record',contentRevision:2,embeddingFingerprint:fingerprint,generation:1,sensitivity:'private',validFromUs:null,validToUs:null,sourceGeneration:0,erasureEpoch:5,expiresAtUs:null};
  const q={vector:[1,0],ownerId:'owner',scopeIds:['project'],embeddingFingerprint:fingerprint,generation:1,currentErasureEpoch:5,nowUs:10};
  await repo.publish({pointId:artifactPointId(m),metadata:m,vector:[1,0]});await repo.close();
  repo=new ServiceVectorRepository(cfg,fingerprint,2,dir,'');await repo.initialize();t.after(()=>repo.close());
  assert.equal((await repo.query(q))[0].score,1);assert.deepEqual(await repo.query({...q,scopeIds:['other']}),[]);
  await repo.deleteByArtifacts(['record'],4);assert.equal((await repo.query(q)).length,1);
  await repo.deleteByArtifacts(['record'],5);assert.deepEqual(await repo.query(q),[]);
});
test('Jev answers match requested names and Voyage reranks only permitted candidates',async()=>{
  const input={state:'Fixture text',questions:{relevant:{type:'noul' as const,instructions:'Is this relevant?'}}};
  const r=await jevEvaluate('fixture','model',input,signal(),async()=>json({model:'model',answers:{relevant:{type:'noul',noul:.8}}}));
  assert.deepEqual(r.answers.relevant,{type:'noul',noul:.8});
  await assert.rejects(jevEvaluate('fixture','model',input,signal(),async()=>json({model:'m',answers:{wrong:{}}})),/names/);
  const items=[{id:'a',text:'one',sensitivity:'cloud_allowed'},{id:'b',text:'two',sensitivity:'cloud_allowed'}];
  assert.deepEqual((await voyageRerank('fixture','rank','query',items,signal(),async()=>json({data:[{index:1,relevance_score:.8},{index:0,relevance_score:.1}]}))).ids,['b','a']);
  await assert.rejects(voyageRerank('fixture','rank','query',[{...items[0],sensitivity:'private'}],signal(),async()=>{assert.fail('unexpected request');}),/authorized/);
});
test('raw search, verbatim transcription and synthesis use their selected service and format',async()=>{
  const credentials:any={key:()=>'fixture'},core:any={credentials,accountAccess:()=>({key:()=>'fixture'})};
  assert.deepEqual((await hostedSearch('perplexity','query',{} as any,credentials,signal(),async()=>json({results:[{url:'https://example.com',title:'Example',snippet:'Found'}]})))[0].content,'Found');
  const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
  assert.equal(await transcribe(core,'openai',{model:'whisper-1'},wav,signal(),async(url,init)=>{assert.match(String(url),/audio\/transcriptions$/);assert.equal((init!.body as FormData).get('model'),'whisper-1');return json({text:'spoken'});}),'spoken');
  const audio=[];for await(const chunk of synthesize(core,'azure_speech',{region:'eastus'},'Read a < b',signal(),async(url,init)=>{assert.match(String(url),/eastus\.tts/);assert.match(String(init!.body),/a &lt; b/);return new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'audio/pcm'}});}))audio.push(chunk);
  assert.equal(audio.length,1);
});
test('prepared video dispatch stores a single job handle, validated bytes and durable artifact',async t=>{
  const {core,dir}=await fixture(t);await core.rpc('provider.credentials',{provider:'xai',key:'fixture'});
  const s=await core.create({provider:'xai',model:'chat',cwd:dir}),media=core.workbench.timedMedia;
  const bytes=execFileSync('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','color=c=black:s=32x32:r=2','-t','1','-c:v','mpeg4','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
  let starts=0;media.fetch=async(url,opts)=>{if(opts?.method==='POST'){starts++;return json({request_id:'video-fixture'});}if(String(url).endsWith('/out.mp4'))return new Response(bytes);return json({status:'done',video:{url:'https://api.x.ai/out.mp4'}});};
  const prepared=await core.rpc('media.timed.prepare',{provider:'xai',sessionId:s.id,model:'video-fixture',kind:'video.generate',prompt:'A test',duration:3});
  const p={sessionId:s.id,id:prepared.id};
  await core.rpc('media.timed.start',p);await core.rpc('media.timed.start',p);
  for(let i=0;i<50&&core.workbench.operations.get(p.id).state!=='running';i++)await new Promise(r=>setTimeout(r,10));
  await core.rpc('media.timed.poll',p);
  for(let i=0;i<100&&!core.workbench.operations.get(p.id).results.length;i++)await new Promise(r=>setTimeout(r,10));
  const done=core.workbench.operations.get(p.id);assert.equal(done.state,'completed',JSON.stringify(done.error));assert.equal(starts,1);
  const file=core.workbench.artifacts.version(s.id,done.results[0].artifactId,done.results[0].versionId);
  assert.match((await core.workbench.artifacts.thumbnail(s.id,file.artifactId,file.versionId))!,/^data:image\/png;base64,/);
  assert.equal(file.mime,'video/mp4');assert.equal((file.provenance.media as any).width,32);
});

test('Runs cancels a video job through its own service, says the provider may still bill it, and can look again later',async t=>{
  const {core,dir}=await fixture(t);await core.rpc('provider.credentials',{provider:'xai',key:'fixture'});
  const s=await core.create({provider:'xai',model:'chat',cwd:dir}),media=core.workbench.timedMedia;
  let polls=0;media.fetch=async(_url,opts)=>{if(opts?.method==='POST')return json({request_id:'video-cancel'});polls++;return json({status:'pending'});};
  const prepared=await core.rpc('media.timed.prepare',{provider:'xai',sessionId:s.id,model:'video-fixture',kind:'video.generate',prompt:'A test',duration:3}),id=prepared.id;
  await core.rpc('media.timed.start',{sessionId:s.id,id});
  for(let i=0;i<50&&core.workbench.operations.get(id).state!=='running';i++)await new Promise(r=>setTimeout(r,10));
  const cancelled=await core.rpc('operations.cancel',{id});
  assert.equal(cancelled.state,'unknown');assert.match(cancelled.cancellation,/may finish or bill/);assert.equal(cancelled.remote,true);
  const before=polls;await core.rpc('operations.check',{id});
  for(let i=0;i<50&&polls===before;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(polls>before,'checking again asks the provider about the same job');
  // A job that was never sent ends without any request.
  const unsent=await core.rpc('media.timed.prepare',{provider:'xai',sessionId:s.id,model:'video-fixture',kind:'video.generate',prompt:'Never sent',duration:3});
  assert.equal((await core.rpc('operations.cancel',{id:unsent.id})).state,'cancelled');
});

test('original PDF handles are tied to the session, consent, current account and current file permission',async t=>{
  const {core,dir}=await fixture(t);
  await core.rpc('provider.credentials',{provider:'xai',key:'fixture-key'});
  const s=await core.create({provider:'xai',model:'grok-fixture',cwd:dir});
  const version=await core.workbench.artifacts.install({sessionId:s.id,bytes:Buffer.from('%PDF-1.7\nfixture\n%%EOF'),name:'test.pdf',mime:'application/pdf',source:'user-import',provenance:{kind:'test'},policy:{cloud:true,remote:true}});
  let uploads=0,removes=0;
  core.providerFiles.fetch=async(url,options)=>{
    assert.equal(String(url).startsWith('https://api.x.ai/v1/files'),true);
    assert.equal((options!.headers as any).Authorization,'Bearer fixture-key');
    if(options!.method==='DELETE'){removes++;return json({deleted:true});}
    uploads++;assert.ok((options!.body as FormData).get('file'));return json({id:'file-fixture'});
  };
  const p={sessionId:s.id,artifactId:version.artifactId,versionId:version.versionId};
  await assert.rejects(core.rpc('originalFiles.upload',p));
  const h=await core.rpc('originalFiles.upload',{...p,acknowledgeUpload:true});
  assert.deepEqual(core.providerFiles.resolve(s.id,[h.id]),[{type:'input_file',file_id:'file-fixture'}]);
  assert.throws(()=>core.providerFiles.resolve(randomUUID(),[h.id]),/Unknown/);
  const removal={sessionId:s.id,id:h.id};
  await core.rpc('originalFiles.remove',removal);await core.rpc('originalFiles.remove',removal);
  assert.equal(uploads,1);assert.equal(removes,1);
  assert.throws(()=>core.providerFiles.resolve(s.id,[h.id]),/unavailable/);
  assert.deepEqual(core.providerFiles.historyParts(s.id,[h.id]),[]);
});
test('service manifests are inert versioned data with existing extension authority checked again on invocation',async t=>{
  const {core}=await fixture(t),serverId=randomUUID(),sessionId=randomUUID();
  const manifest={version:1,id:'example',label:'Example search',operations:[{operation:'search',serverId,tool:'example_search'}]};
  await assert.rejects(core.rpc('providerManifests.save',{manifest:{...manifest,command:'invalid'},expectedRevision:null}));
  const preview=await core.rpc('providerManifests.preview',{manifest,expectedRevision:null});
  assert.deepEqual(await core.rpc('providerManifests.list',{}),[]);
  const saved=await core.rpc('providerManifests.save',{manifest,expectedRevision:null});assert.equal(saved.revision,preview.revision);
  await assert.rejects(core.rpc('providerManifests.save',{manifest,expectedRevision:null}),/changed/);
  core.extensions.ensure=async()=>{};
  core.extensions.callBound=async(_session,server,tool,args,_signal,authorize)=>{
    assert.equal(server,serverId);assert.equal(tool,'example_search');authorize();
    await core.rpc('providerManifests.remove',{id:manifest.id,revision:saved.revision});
    authorize();return args as any;
  };
  await assert.rejects(core.rpc('providerManifests.invoke',{id:'example',revision:saved.revision,operation:'search',sessionId,args:{query:'test'}}),/removed/);
});

test('provider-native computer actions require the current offered tool, a reviewed frame and per-action approval',async t=>{
  const {ProviderComputer,computerTool,frameResult}=await import('../broker/provider-computer.ts'),sharp=(await import('sharp')).default;
  const frame=await sharp({create:{width:32,height:24,channels:3,background:'white'}}).png().toBuffer(),requested:string[]=[],inputs:any[]=[];
  let enabled=true,allow=true;
  const core:any={store:{session:()=>({provider:'openai',title:'Fixture',id:'s'})},credentials:{credentialRevision:()=>'1'},toolsFor:()=>enabled?[computerTool]:[],
    approval:async(_id:string,p:any)=>{requested.push(p.kind);return {choice:allow?'allow':'deny'};},
    remoteView:{start:async()=>({viewId:'v'}),frame:async()=>({output:'fixture',data:'data:image/png;base64,'+frame.toString('base64'),revision:1}),stop(){},send:async(_id:string,_device:string,p:any,check:()=>void)=>{check();inputs.push(p);}}};
  const computer=new ProviderComputer(core),click={items:[{type:'click',x:512,y:384,button:'left'}]};
  await assert.rejects(computer.run('s',click,signal()),/fresh/);
  assert.ok(Reflect.get(await computer.run('s',{items:[{type:'screenshot'}]},signal()),frameResult).image);
  assert.deepEqual(requested,['computer','capture']);
  allow=false;await assert.rejects(computer.run('s',click,signal()),/declined/);assert.equal(inputs.length,0);
  allow=true;await computer.run('s',click,signal());assert.deepEqual(inputs,[{kind:'click',x:0.5,y:0.5,frameRevision:1}]);
  enabled=false;await assert.rejects(computer.run('s',click,signal()),/turned off/);
});

test('Eden async video polls its public_id, downloads the result and records upstream provenance',async t=>{
  const {core,dir}=await fixture(t);await core.rpc('provider.credentials',{provider:'edenai',key:'fixture'});
  const s=await core.create({provider:'edenai',model:'provider/chat',cwd:dir}),media=core.workbench.timedMedia;
  const bytes=execFileSync('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','color=c=black:s=32x32:r=2','-t','1','-c:v','mpeg4','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
  const model='video/generation_async/bytedance';let calls=0;
  media.fetch=async(url,opts)=>{
    if(opts?.method==='POST'){calls++;assert.equal(new URL(String(url)).pathname,'/v3/universal-ai/async');assert.deepEqual(JSON.parse(String(opts.body)),{model,input:{text:'Test video',duration:5,dimension:'1280x720'}});return json({public_id:'eden-fixture',status:'processing'});}
    if(String(url).endsWith('out.mp4'))return new Response(bytes);
    assert.ok(String(url).endsWith('/v3/universal-ai/async/eden-fixture'));
    return json({public_id:'eden-fixture',provider:'bytedance',status:'success',output:{video_resource_url:'https://api.edenai.run/out.mp4'}});
  };
  const prepared=await core.rpc('media.timed.prepare',{provider:'edenai',sessionId:s.id,model,kind:'video.generate',prompt:'Test video',resolution:'720p',duration:5});
  const p={sessionId:s.id,id:prepared.id};await core.rpc('media.timed.start',p);
  for(let n=0;n<60&&core.workbench.operations.get(p.id).state!=='running';n++)await new Promise(r=>setTimeout(r,10));
  await core.rpc('media.timed.poll',p);
  for(let n=0;n<100&&!core.workbench.operations.get(p.id).results.length;n++)await new Promise(r=>setTimeout(r,10));
  const done=core.workbench.operations.get(p.id);assert.equal(done.state,'completed',JSON.stringify(done.error));assert.equal(calls,1);
  const file=core.workbench.artifacts.version(s.id,done.results[0].artifactId,done.results[0].versionId);assert.equal(file.provenance.upstream,'bytedance');
});

test('Gemini media interactions restore video and music, validate playable bytes, and retain lyrics',async t=>{
  const {core,dir}=await fixture(t);await core.rpc('provider.credentials',{provider:'google',key:'fixture'});
  const s=await core.create({provider:'google',model:'model',cwd:dir}),media=core.workbench.timedMedia;
  for(const music of [false,true]){
    const bytes=music?execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=200:duration=0.2','-f','mp3','pipe:1']):
      execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=s=32x32:r=2','-t','1','-c:v','mpeg4','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1']);
    let starts=0;const kind=music?'music.generate':'video.generate',model=music?'lyria-3.5':'gemini-omni-1.2-flash';
    media.fetch=async(url,init)=>{assert.match(String(url),/interactions/);assert.equal(new Headers(init!.headers).get('x-goog-api-key'),'fixture');
      if(init?.method==='POST'){starts++;const body=JSON.parse(String(init.body));assert.equal(body.response_format.type,music?'audio':'video');if(!music)return json({id:'fixture-video',status:'in_progress'});}
      return json({id:music?'fixture-music':'fixture-video',status:'completed',steps:[{type:'model_output',content:[{type:music?'audio':'video',data:bytes.toString('base64')},...(music?[{type:'text',text:'Fixture lyrics'}]:[])]}]});};
    const job=await core.rpc('media.timed.prepare',{sessionId:s.id,provider:'google',kind,model,prompt:'example'}),ref={sessionId:s.id,id:job.id};await core.rpc('media.timed.start',ref);
    for(let i=0;i<100;i++){const j=core.workbench.operations.get(job.id);if(j.state==='completed'||j.state==='unknown')break;if(j.state==='running')await core.rpc('media.timed.poll',ref);await new Promise(r=>setTimeout(r,15));}
    const done=core.workbench.operations.get(job.id);assert.equal(done.state,'completed',JSON.stringify(done.error));assert.equal(starts,1);
    const version=core.workbench.artifacts.version(s.id,done.results[0].artifactId,done.results[0].versionId);assert.equal(version.mime,music?'audio/mpeg':'video/mp4');if(music)assert.equal(version.provenance.lyrics,'Fixture lyrics');
  }
});

test('desktop snapshot publishes actual setup schemas and named Azure metadata survives reload',async t=>{
  const {core}=await fixture(t),traits=core.snapshot().providerTraits;
  assert.deepEqual(traits.azure_openai.variants?.find(v=>v.id==='v1')?.auth,['api-key','entra']);
  assert.ok(traits.xai.optionsSchema?.some(f=>f.key==='collectionSearch'));
  const account=await core.rpc('connections.save',{kind:'azure_openai',name:'East US research',variant:'v1',endpoint:{baseUrl:'https://east.openai.azure.com/openai'},deployment:'research-east',underlyingModel:'gpt-5',region:'eastus',auth:'api-key'});
  await core.rpc('provider.credentials',{provider:'azure_openai',connectionId:account.id,key:'private-test-key'});
  const [visible]=(await core.rpc('connections.list',{})).filter((a:any)=>a.id===account.id);
  assert.equal(visible.region,'eastus');assert.equal(visible.underlyingModel,'gpt-5');assert.equal(visible.deployment,'research-east');assert.ok(visible.keySet);
  assert.equal(visible.endpoint.baseUrl.replace(/\/$/,''),'https://east.openai.azure.com/openai/v1');
  const ref='connection:'+account.id;await core.rpc('connections.remove',{id:account.id});
  assert.equal(core.credentials.credentialRevision(ref),'missing');
});

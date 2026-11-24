import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiteLlmBridgeService } from '../broker/provider-bridge/service.ts';
import { BridgeRuntime, bridgePython, bridgeRoot } from '../broker/provider-bridge/runtime.ts';
import { Core } from '../broker/core.ts';
import { Store } from '../broker/store.ts';
import { ApiAdapter } from '../broker/api-providers.ts';
import { hostedEmbeddings } from '../broker/graph-memory/hosted-embeddings.ts';

function processFixture(captured:any[]) {
  const child:any=new EventEmitter(),stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough();
  Object.assign(child,{stdin,stdout,stderr,kill(){child.emit('exit',0,null);return true;}});
  let buffer='';stdin.setEncoding('utf8');stdin.on('data',(chunk:string)=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const message=JSON.parse(line);captured.push(message);if(message.operation==='cancel')continue;
    const value=message.operation==='chat'?{text:'bridge answer',model:message.payload.model}:{model:message.payload.model,vectors:message.payload.input.map((_:string,i:number)=>[i+1,2])};stdout.write(JSON.stringify({type:'result',id:message.id,value})+'\n');}});
  queueMicrotask(()=>stdout.write(JSON.stringify({type:'ready',ok:true,version:'fixture'})+'\n'));return child;
}

test('LiteLLM bridge isolates account workers, passes credentials only in private requests, and validates results',async()=>{
  const messages:any[]=[],accounts:any={one:{id:'one',revision:1,apiKey:()=> 'secret-one'},two:{id:'two',revision:2,apiKey:()=> 'secret-two',baseUrl:'https://gateway.example/v1'}};
  let workers=0;const service=new LiteLlmBridgeService(id=>accounts[id],()=>{workers++;return processFixture(messages)});
  const signal=AbortSignal.timeout(1000);
  assert.deepEqual(await service.chat({connectionId:'one',connectionRevision:1,model:'anthropic/claude',messages:[{role:'user',content:'hello'}]},signal),{text:'bridge answer',model:'anthropic/claude',toolCalls:[]});
  const embedded=await service.embeddings({connectionId:'two',connectionRevision:2,model:'cohere/embed',input:['a','b']},signal);
  assert.deepEqual(embedded.vectors,[[1,2],[2,2]]);assert.equal(embedded.dimension,2);assert.equal(workers,2);
  assert.equal(messages[0].auth.apiKey,'secret-one');assert.equal(messages[1].auth.apiKey,'secret-two');assert.equal(messages[1].auth.baseUrl,'https://gateway.example/v1');
  assert.ok(!JSON.stringify(await service.status('one')).includes('secret-one'));
  await assert.rejects(service.chat({connectionId:'one',connectionRevision:9,model:'m',messages:[{role:'user',content:'x'}]},signal),/changed/);
  service.close();
});

test('Core provider bridge entry binds the named account and conversation revisions',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-provider-bridge-core-')),core=new Core(new Store(directory));
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('managed bridge attempted HTTP');};
  t.after(async()=>{globalThis.fetch=originalFetch;await core.close();await rm(directory,{recursive:true,force:true});});
  const connection:any=await core.rpc('connections.save',{kind:'litellm',variant:'bridge',name:'Local bridge',processing:'local'});
  await core.rpc('provider.credentials',{provider:'litellm',connectionId:connection.id,key:'bridge-fixture'});
  const sent:any[]=[];(core.providerBridge.service as any).factory=()=>processFixture(sent);
  await core.rpc('provider.credentials',{provider:'openai',key:'openai-fixture'});
  const session=await core.create({provider:'openai',cwd:directory,model:'fixture'}),project=core.projects.list().find(row=>row.cwd===session.cwd);
  const request={sessionId:session.id,expectedSessionRevision:session.configRevision||'0',expectedProjectRevision:project?.revision||'0',connectionId:connection.id,connectionRevision:connection.revision,
    model:'anthropic/claude',messages:[{role:'user',content:'hello'}]};
  const result:any=await core.rpc('providerBridge.chat',request);assert.equal(result.text,'bridge answer');assert.equal(sent[0].auth.apiKey,'bridge-fixture');
  await assert.rejects(core.rpc('providerBridge.chat',{...request,expectedSessionRevision:'999'}),/configuration changed/);
  const conversation=await core.create({provider:'litellm',connectionId:connection.id,cwd:directory,model:'anthropic/claude'});
  await core.send({id:conversation.id,text:'ordinary conversation'});await (core.adapters.get(conversation.id) as ApiAdapter).task;
  assert.equal(core.store.messages(conversation.id).at(-1)?.text,'bridge answer');assert.equal(sent.at(-1).operation,'chat');
  assert.deepEqual(await hostedEmbeddings('litellm',core.accountAccess('litellm',connection.id),'cohere/embed',['a','b'],'document',AbortSignal.timeout(1000)),[[1,2],[2,2]]);
  assert.equal(sent.at(-1).operation,'embeddings');assert.ok(!sent.some(message=>JSON.stringify(message).includes('127.0.0.1/litellm-bridge')));
});

const weather={type:'function' as const,function:{name:'weather',description:'Weather of a city',parameters:{type:'object',properties:{city:{type:'string'}}}}};
test('a tool round through the bridge keeps the call, its result, the reasoning and the picture together, and streams',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-provider-bridge-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const output:any[]=[],requests:any[]=[],called:any[]=[];let history:any[]=[];
  const session={id:'bridge-test',provider:'litellm',nativeId:null,title:'Test',cwd:directory,mode:'managed',status:'idle',created:0,updated:0,draft:'',scroll:0,model:'openai/fixture',connectionId:'one',connectionRevision:3} as any;
  const adapter=new ApiAdapter(session,{token:'t',native(){},event:(event:any)=>output.push(event),approve:async()=>({choice:'deny'}),personality:()=>''} as any,{
    load:()=>structuredClone(history),save:(messages:any[])=>{history=structuredClone(messages);},tools:()=>[weather],call:async(name:string,args:any)=>{called.push([name,args]);return{celsius:-4};},options:()=>({temperature:0.2}),
  } as any,{key:()=>'secret',retry:{maxRetries:0} as any,fetch:async()=>{throw new Error('the bridge sent HTTP itself');},localBridgeChat:async(request:any,_signal:AbortSignal,delta?:(text:string)=>void)=>{
    requests.push(structuredClone(request));
    if(requests.length===1){delta?.('Let me ');delta?.('look. ');return{text:'Let me look. ',toolCalls:[{id:'call_9',name:'weather',arguments:'{"city":"Oslo"}'}],state:{reasoning_content:'I should look.',thinking_blocks:[{type:'thinking',thinking:'…',signature:'S'}]},usage:{prompt_tokens:20,completion_tokens:9}};}
    delta?.('It is ');delta?.('cold.');return{text:'It is cold.',toolCalls:[],usage:{prompt_tokens:30,completion_tokens:3}};
  }} as any);
  t.after(()=>adapter.close());
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  history=[{role:'user',content:'What is this?',images:[png]},{role:'assistant',content:'A dot.'}];
  await adapter.send('Weather in Oslo?');await adapter.task;
  assert.deepEqual(called,[['weather',{city:'Oslo'}]]);assert.equal(requests.length,2);assert.equal(requests[0].temperature,0.2);assert.deepEqual(requests[0].tools,[weather.function]);
  assert.deepEqual(requests[0].messages.find((message:any)=>message.content==='What is this?').images,[{mime:'image/png',data:png}]);
  const [asked,result]=requests[1].messages.slice(-2);
  assert.equal(asked.role,'assistant');assert.deepEqual(asked.toolCalls,[{id:'call_9',name:'weather',arguments:'{"city":"Oslo"}'}]);assert.deepEqual(asked.state,{reasoning_content:'I should look.',thinking_blocks:[{type:'thinking',thinking:'…',signature:'S'}]});
  assert.equal(result.role,'tool');assert.equal(result.toolCallId,'call_9');assert.equal(result.name,'weather');assert.match(result.content,/-4/);
  assert.deepEqual(output.filter(event=>event.type==='delta').map(event=>event.text),['Let me ','look. ','It is ','cold.']);
  assert.deepEqual(output.filter(event=>event.type==='message').map(event=>event.text),['Let me look. ','It is cold.']);
  // Reasoning belongs to the account that made it: another one gets the conversation without it.
  session.connectionId='two';await adapter.send('And now?');await adapter.task;
  assert.ok(requests[2].messages.some((message:any)=>message.toolCalls?.length),'the readable history stays');assert.ok(!JSON.stringify(requests[2].messages).includes('thinking_blocks'));
});

// A stand-in for LiteLLM that answers with what it was given, in LiteLLM's documented form.
const fakeLiteLlm=`
import asyncio, json
class Data:
    def __init__(self, **values): self.__dict__.update(values)
    def model_dump(self): return {key: value.model_dump() if hasattr(value, "model_dump") else value for key, value in self.__dict__.items()}
def answer(message, finish="stop"): return Data(model="echo", choices=[Data(message=message, finish_reason=finish)], usage=Data(prompt_tokens=2, completion_tokens=1))
async def acompletion(**given):
    if given["model"] == "fails": raise RuntimeError("refused for key " + given["api_key"])
    if given["model"] == "toolless": raise ImportError("No module named 'mcp'")
    if given["model"] == "waits": await asyncio.sleep(60)
    if given.get("stream"):
        assert given["stream_options"] == {"include_usage": True}
        async def parts():
            for text in ("Streamed ", None, "reply"): yield Data(choices=[Data(delta=Data(content=text))])
            yield Data(choices=[])
        return parts()
    return answer(Data(content=json.dumps({key: value for key, value in given.items() if key != "api_key"}), tool_calls=[Data(id="c1", function=Data(name="weather", arguments="{}"))], thinking_blocks=[Data(type="thinking", signature="S")], reasoning_content=None))
def stream_chunk_builder(chunks, messages=None):
    assert messages is not None
    return answer(Data(content="".join(chunk.choices[0].delta.content or "" for chunk in chunks if chunk.choices), tool_calls=None))
async def aembedding(**given): return Data(model="echo", data=[{"index": 1, "embedding": [2.0]}, {"index": 0, "embedding": [1.0]}])
`;
test('the worker hands LiteLLM complete messages, streams what comes back and never says a key',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-provider-bridge-worker-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'litellm'));await writeFile(join(directory,'litellm/__init__.py'),fakeLiteLlm);
  await mkdir(join(directory,'litellm-9.9.0.dist-info'));await writeFile(join(directory,'litellm-9.9.0.dist-info/METADATA'),'Metadata-Version: 2.1\nName: litellm\nVersion: 9.9.0\n');
  const worker=fileURLToPath(new URL('../broker/provider-bridge/worker.py',import.meta.url));
  const start=()=>spawn('python3',['-I','-u','-c','import runpy,sys; sys.dont_write_bytecode=True; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[2],run_name="__main__")',directory,worker],{stdio:['pipe','pipe','pipe']});
  const service=new LiteLlmBridgeService(id=>({id,revision:1,apiKey:()=>'sk-very-secret',baseUrl:'http://127.0.0.1:9/v1'}),start as any);t.after(()=>service.close());
  const ask=(model:string,messages:any[],delta?:(text:string)=>void,signal=AbortSignal.timeout(20_000))=>service.chat({connectionId:'one',connectionRevision:1,model,messages,tools:[weather.function],temperature:0.5,maxOutputTokens:9},signal,delta);
  assert.deepEqual(await service.status('one'),{available:true,running:true,version:'9.9.0'});
  const whole:any=await ask('echo',[{role:'system',content:'Be brief.'},{role:'user',content:'Look',images:[{mime:'image/png',data:'QUJD'}]},{role:'assistant',content:'',toolCalls:[{id:'c0',name:'weather',arguments:'{"city":"Oslo"}'}],state:{reasoning_content:'Hm',thinking_blocks:[{type:'thinking',signature:'S'}],api_key:'not a state'}},{role:'tool',content:'-4',name:'weather',toolCallId:'c0'}]);
  const given=JSON.parse(whole.text);
  assert.deepEqual(given.messages,[{role:'system',content:'Be brief.'},{role:'user',content:[{type:'text',text:'Look'},{type:'image_url',image_url:{url:'data:image/png;base64,QUJD'}}]},
    {role:'assistant',content:null,tool_calls:[{id:'c0',type:'function',function:{name:'weather',arguments:'{"city":"Oslo"}'}}],reasoning_content:'Hm',thinking_blocks:[{type:'thinking',signature:'S'}]},{role:'tool',content:'-4',tool_call_id:'c0'}]);
  assert.equal(given.api_base,'http://127.0.0.1:9/v1');assert.equal(given.temperature,0.5);assert.equal(given.max_tokens,9);assert.deepEqual(given.tools,[weather]);
  assert.deepEqual(whole.toolCalls,[{id:'c1',name:'weather',arguments:'{}'}]);assert.deepEqual(whole.state,{thinking_blocks:[{type:'thinking',signature:'S'}]});assert.deepEqual(whole.usage,{prompt_tokens:2,completion_tokens:1});
  const parts:string[]=[],streamed=await ask('echo',[{role:'user',content:'Hi'}],text=>parts.push(text));
  assert.deepEqual(parts,['Streamed ','reply']);assert.equal(streamed.text,'Streamed reply');assert.ok(!('state' in streamed));
  await assert.rejects(ask('fails',[{role:'user',content:'Hi'}]),(error:Error)=>/RuntimeError: refused for key \[redacted\]/.test(error.message));
  await assert.rejects(ask('toolless',[{role:'user',content:'Hi'}]),/needs its mcp part/);
  const stop=new AbortController(),waiting=ask('waits',[{role:'user',content:'Hi'}],undefined,stop.signal);setTimeout(()=>stop.abort(new Error('stopped')),100);await assert.rejects(waiting,/stopped/);
  assert.deepEqual((await service.embeddings({connectionId:'one',connectionRevision:1,model:'echo',input:['a','b']},AbortSignal.timeout(5000))).vectors,[[1],[2]],'in the order they were asked for');
});

test('a worker that stops, says too much or cannot start is answered for, and the next message starts another',async()=>{
  const children:any[]=[];let act:(child:any)=>void=()=>{};
  const fake=()=>{const child:any=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:0,kill(){child.killed++;return true;}});children.push(child);act(child);return child;};
  const service=new LiteLlmBridgeService(id=>({id,revision:1,apiKey:()=>'k'}),fake),ask=(signal=AbortSignal.timeout(2000))=>service.chat({connectionId:'one',connectionRevision:1,model:'m',messages:[{role:'user',content:'x'}]},signal);
  const ready=(child:any)=>queueMicrotask(()=>child.stdout.write('{"type":"ready","ok":true,"version":"1"}\n')),reply=(child:any)=>{child.stdin.setEncoding('utf8');child.stdin.on('data',(line:string)=>child.stdout.write(JSON.stringify({type:'result',id:JSON.parse(line).id,value:{text:'fine'}})+'\n'));};
  act=child=>queueMicrotask(()=>child.emit('error',Object.assign(new Error('spawn python3 ENOENT'),{code:'ENOENT'})));
  await assert.rejects(ask(),/Python 3 was not found/);
  act=child=>{ready(child);child.stdin.on('data',()=>{child.stdout.write('{"type":"par');child.emit('exit',1,null);});};
  await assert.rejects(ask(),/worker exited \(1\)/);
  // A half line of the one that ended does not spoil the first line of the next, and its late exit does not stop it.
  act=child=>{ready(child);child.stdin.on('data',()=>child.stdout.write('x'.repeat(17*1024*1024)));};
  await assert.rejects(ask(),/exceeded its response limit/);assert.equal(children[2].killed,1);
  act=child=>{ready(child);reply(child);};
  const next=ask();children[2].emit('exit',null,'SIGTERM');assert.equal((await next).text,'fine');assert.equal(children.length,4);
  service.stop('one');act=()=>{};const controller=new AbortController(),slow=ask(controller.signal);setTimeout(()=>controller.abort(new Error('stopped while it loads')),20);await assert.rejects(slow,/stopped while it loads/);
  service.close();
});

const fakeTool=`
import json, os, pathlib, sys, time
action, root = sys.argv[1], pathlib.Path(sys.argv[3])
mode = (root.parent / "mode").read_text() if (root.parent / "mode").exists() else ""
def say(**event): print(json.dumps(event), flush=True)
if action == "remove":
    for name in ("manifest.json", "venv/bin/python"): (root / name).unlink(missing_ok=True)
    say(state="removed")
elif mode == "fails": say(state="working", stage="packages"); say(state="error", message="a file did not match its fingerprint"); raise SystemExit(1)
elif mode == "dies": raise SystemExit(3)
elif mode == "waits": say(state="working", stage="packages"); time.sleep(60)
else:
    (root / "venv/bin").mkdir(parents=True, exist_ok=True); python = root / "venv/bin/python"
    if not python.exists(): python.symlink_to(sys.executable)
    for stage in ("environment", "packages", "checking"): say(state="working", stage=stage)
    (root / "manifest.json").write_text(json.dumps({"version": 1, "litellm": "9.9.0", "python": str(python)})); say(state="installed")
`;
test('PAL keeps a LiteLLM of its own only when asked, and puts it away again',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-litellm-runtime-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const env={PATH:process.env.PATH,XDG_DATA_HOME:directory} as any,root=bridgeRoot(env),tool=join(directory,'tool.py');await mkdir(join(directory,'pal'),{recursive:true});await writeFile(tool,fakeTool);
  const mode=(value:string)=>writeFile(join(directory,'pal/mode'),value);
  let changes=0,stopped=0;const stages=new Set<string>(),runtime=new BridgeRuntime(()=>{changes++;if(runtime.status().stage)stages.add(runtime.status().stage);},()=>{stopped++;},env);runtime.command=['python3',tool];t.after(()=>runtime.close());
  const offered=/^litellm==(\S+)/m.exec(await readFile(new URL('../tools/litellm-lock.txt',import.meta.url),'utf8'))![1];
  assert.deepEqual(runtime.status(),{source:'system',python:'python3',version:'',offered,installed:false,busy:false,stage:'',error:''});assert.equal(bridgePython(env),'python3');
  assert.throws(()=>runtime.install({}),/Confirm downloading/);assert.throws(()=>runtime.remove({confirmed:'yes'}),/Confirm removing/);assert.equal(existsSync(root),false);
  await mode('fails');assert.equal(runtime.install({confirmed:true}).busy,true);assert.throws(()=>runtime.install({confirmed:true}),/already being/);await runtime.idle();
  assert.equal(runtime.status().error,'a file did not match its fingerprint');assert.equal(runtime.status().busy,false);assert.equal(stopped,1,'a running worker is stopped first');
  await mode('dies');runtime.install({confirmed:true});await runtime.idle();assert.equal(runtime.status().error,'It did not finish. Nothing was changed.');
  await mode('waits');runtime.install({confirmed:true});for(let i=0;i<200&&!runtime.status().stage.startsWith('Downloading');i++)await new Promise(done=>setTimeout(done,10));assert.equal((await runtime.cancel()).busy,false);assert.equal(runtime.status().error,'Stopped. Nothing was changed.');assert.equal(runtime.status().installed,false);
  await mode('');assert.equal(runtime.install({confirmed:true}).error,'');await runtime.idle();
  const kept=runtime.status();assert.deepEqual([kept.source,kept.python,kept.version,kept.installed,kept.error],['managed',join(root,'venv/bin/python'),'9.9.0',true,'']);assert.equal(bridgePython(env),join(root,'venv/bin/python'));assert.ok(changes>3&&stages.size>=1);
  assert.equal(bridgePython({...env,PAL_LITELLM_PYTHON:'/opt/mine/python'}),'/opt/mine/python','the environment the person chose comes first');
  runtime.remove({confirmed:true});await runtime.idle();assert.equal(runtime.status().installed,false);assert.equal(bridgePython(env),'python3');
  // A folder that is not as PAL made it is not used.
  await mkdir(join(directory,'other/bin'),{recursive:true});await writeFile(join(directory,'other/bin/python'),'');await rm(join(root,'venv'),{recursive:true,force:true});await symlink(join(directory,'other'),join(root,'venv'));
  await writeFile(join(root,'manifest.json'),JSON.stringify({version:1,litellm:'9.9.0',python:join(root,'venv/bin/python')}));assert.equal(bridgePython(env),'python3');
  await rm(join(root,'venv'));await mkdir(join(root,'venv/bin'),{recursive:true});await writeFile(join(root,'venv/bin/python'),'');await writeFile(join(root,'manifest.json'),JSON.stringify({version:1,litellm:'9.9.0',python:'/usr/bin/python3'}));assert.equal(bridgePython(env),'python3');
});

test('the LiteLLM that PAL keeps is pinned to exact files',async()=>{
  const lock=await readFile(new URL('../tools/litellm-lock.txt',import.meta.url),'utf8'),entries=lock.replace(/\\\n/g,' ').split('\n').filter(line=>line.trim()&&!line.startsWith('#'));
  assert.ok(entries.length>50);for(const entry of entries){assert.match(entry,/^[a-z0-9-]+==[A-Za-z0-9.]+ +--hash=sha256:[0-9a-f]{64}/);assert.ok(!/https?:|git\+|@/.test(entry),entry);}
  assert.ok(entries.some(entry=>entry.startsWith('litellm=='))&&entries.some(entry=>entry.startsWith('mcp==')),'LiteLLM and the part it needs for tools');
});

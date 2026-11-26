import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,writeFile,access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../broker/store.ts';
import { erasureMatcher } from '../broker/memory.ts';
import { eraseWorkingCopies } from '../broker/working-erasure.ts';
import type { Session } from '../broker/types.ts';

test('erasure text matching preserves unrelated words while finding copied passages',()=>{
  const short=erasureMatcher({texts:['yes']});
  assert.equal(short('yes'),true);
  assert.equal(short('Review yesterday’s independent work'),false);
  assert.equal(short('The answer is yes, pending review.'),false);

  const passage=erasureMatcher({texts:['the orchid release phrase']});
  assert.equal(passage('Notes: the orchid release phrase. Do not repeat it.'),true);
  assert.equal(passage('Notes: the orchid release phrasebook is obsolete.'),false);
  assert.equal(erasureMatcher({texts:['Caf\u00e9 launch']})('The Cafe\u0301 launch remains private.'),true);
});

test('working-copy erasure uses source identities and removes actual copied files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pal-erasure-boundaries-'));
  const store=new Store(directory);
  try{
    const phrase='the orchid release phrase',session:Session={id:'session',provider:'codex',nativeId:null,title:'Yesterday plan',cwd:directory,mode:'managed',status:'idle',created:1,updated:1,draft:'Notes: '+phrase,scroll:0,draftAttachments:[],model:''};
    store.saveSession(session);
    const attachmentPath=join(directory,'draft-attachments','source');
    await mkdir(join(directory,'draft-attachments'),{recursive:true});await writeFile(attachmentPath,'Copied: '+phrase);
    const asset={id:'asset',path:attachmentPath,name:'source.txt',kind:'text' as const,mime:'text/plain',size:phrase.length,sha256:'unused'};
    session.draftAttachments=[asset];store.saveSession(session);store.set('attachment:asset',{sessionId:session.id,asset});
    store.set('submission:'+session.id,{turnId:'source-turn',text:'Paraphrased private source',attachmentIds:['asset']});
    store.set('capsule:'+session.cwd,{goal:'Paraphrased goal',decisions:['Private decision'],constraints:[],questions:[],nextSteps:[],sources:[{messageId:'source-message'}]});
    store.set('workflow:results',[{id:'remove',sessionId:session.id,messageId:'source-message'},{id:'keep',sessionId:session.id,messageId:'other'}]);

    eraseWorkingCopies(store,session,erasureMatcher({texts:[phrase],message_ids:['source-message'],turn_ids:['source-turn']}));

    const saved=store.session(session.id);
    assert.equal(saved.title,'Yesterday plan');
    assert.equal(saved.draft,'[Content removed by memory erasure]');
    assert.deepEqual(saved.draftAttachments,[]);
    await assert.rejects(access(attachmentPath));
    assert.equal(store.get<any>('submission:'+session.id,null).text,'[Content removed by memory erasure]');
    const capsule=store.get<any>('capsule:'+session.cwd,null);
    assert.equal(capsule.goal,'[Content removed by memory erasure]');assert.deepEqual(capsule.decisions,[]);assert.deepEqual(capsule.sources,[]);
    assert.deepEqual(store.get<any[]>('workflow:results',[]).map(row=>row.id),['keep']);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('a conversation store written before secure delete is compacted once, so text a forget scrubbed earlier leaves the file',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pal-freed-space-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const token='zqxjcalendulazz',file=join(dir,'pal.sqlite');
  const onDisk=()=>['pal.sqlite','pal.sqlite-wal'].some(name=>{try{return readFileSync(join(dir,name)).includes(Buffer.from(token));}catch{return false;}});
  // A store as an earlier version left it: no secure_delete, and a long message whose text a forget then scrubbed.
  const old=new DatabaseSync(file);
  old.exec('PRAGMA journal_mode=WAL;CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE sessions (id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL)');
  const put=old.prepare('INSERT INTO messages VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),message=(id:string,text:string)=>put.run(id,'s',JSON.stringify({id,sessionId:'s',role:'user',text,time:1}));
  message('m1','Before the secret.');
  message('m2',`My locker pin is ${token}. `+'Context for the request. '.repeat(1200));
  message('m3','After the secret.');
  message('m2','[Content removed by memory erasure]');
  old.exec('PRAGMA wal_checkpoint(TRUNCATE)');old.close();
  assert.ok(onDisk(),'the earlier store kept the scrubbed text in freed space');
  const store=new Store(dir);
  try {
    assert.equal(onDisk(),false,'opening it once leaves no copy of the scrubbed text');
    assert.deepEqual(store.messages('s').map(m=>[m.id,m.text]),[['m1','Before the secret.'],['m2','[Content removed by memory erasure]'],['m3','After the secret.']],'every message is kept, in order');
    assert.equal(store.get('secureDeleteCompacted',0),1);
  } finally { store.close(); }
  const fresh=await mkdtemp(join(tmpdir(),'pal-fresh-store-'));
  t.after(()=>rm(fresh,{recursive:true,force:true}));
  const created=new Store(fresh);
  try { assert.equal(created.get('secureDeleteCompacted',0),1,'a new store starts with secure delete and needs no compaction'); } finally { created.close(); }
});

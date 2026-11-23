import assert from 'node:assert/strict';
import test from 'node:test';
import { compareResultTables } from '../broker/execution/compare-results.ts';

test('result comparison matches keys and named columns across reorders, quoted fields and newlines', async () => {
  const data: Record<string,string> = {a:'id,value\n"a,1",1\n"b\n2",2\n',b:'value,id\n5,"b\n2"\n4,"a,1"\n9,c\n'};
  const operation = (id:string) => ({sessionId:'s',results:[{artifactId:id,versionId:id}]}) as any;
  const artifacts:any = {version:(_s:string,id:string)=>({name:'out.csv',artifactId:id,versionId:id,bytes:Buffer.byteLength(data[id]),provenance:{}}),bytes:async(_s:string,id:string)=>({data:Buffer.from(data[id])})};
  const compare = async () => (await compareResultTables(artifacts,operation('a'),operation('b'),{keys:['id']})).tables[0];
  const t = await compare();
  assert.equal(t.added,1); assert.equal(t.removed,0); assert.equal(t.modified,2);
  assert.equal(t.examples![0].changes![0].delta,3); assert.equal(t.examples![0].beforeRecord,1); assert.equal(t.examples![0].afterRecord,2);
  data.b += '8,c\n';
  const ambiguous = await compare();
  assert.match(ambiguous.warning!, /Duplicate key/);
  assert.equal(ambiguous.modified,undefined);
});

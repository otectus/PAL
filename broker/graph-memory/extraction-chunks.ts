import { span, occurrenceAt } from './ontology.ts';

// Offsets are Unicode code points, identical to the canonical witness locator.
// Prefer a sentence boundary so a negation or quoted speaker is not clipped.
export function extractionChunk(text:string,start:number,limit=8000){
  const chars=Array.from(text);
  let end=Math.min(start+limit,chars.length);
  if(end<chars.length){
    for(let i=end;i>start+limit/2;i--)if(/[.!?。！？\n]/u.test(chars[i-1])){end=i;break;}
  }
  return {text:chars.slice(start,end).join(''),start,end,total:chars.length};
}
export function relocateWitness(source:string,chunk:ReturnType<typeof extractionChunk>,witness:{quote:string,occurrence:number}){
  if(!chunk.start)return witness;
  const local=span(chunk.text,witness.quote,witness.occurrence);
  const occurrence=occurrenceAt(source,witness.quote,chunk.start+local.start);
  if(occurrence<0)throw new Error('Witness does not resolve in source');
  return {...witness,occurrence};
}

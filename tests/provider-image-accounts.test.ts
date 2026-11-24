import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { XaiImages } from '../broker/media/backends/xai.ts';
import { OpenRouterImages } from '../broker/media/backends/openrouter.ts';
import { OpenAiImages } from '../broker/media/backends/openai.ts';
import type { BackendContext, ResolvedInputs, ValidatedImageRequest } from '../broker/media/contracts.ts';

test('named xAI, Azure and OpenRouter image requests preserve references, endpoint, headers and actual output',async()=>{
  const pixel=await sharp({create:{width:4,height:4,channels:3,background:'blue'}}).jpeg().toBuffer();
  for(const provider of ['xai','azure_openai','openrouter']){
    const backend=provider==='xai'?new XaiImages('grok-imagine-image-2.0'):provider==='azure_openai'?new OpenAiImages('deployment-1','https://east.openai.azure.com/openai/v1/',async()=>({'api-key':'east-key'})):new OpenRouterImages('vendor/image','https://openrouter.ai/api/v1/');
    const request:ValidatedImageRequest={operation:'generate',prompt:'circle',references:[],format:'jpeg',count:1,adjustments:[],connectionId:'account',connectionRevision:1};
    const inputs:ResolvedInputs={references:[],guides:[]};
    for(const edit of [false,true]){
      if(edit){request.operation='edit';inputs.target={mime:'image/jpeg',bytes:pixel,width:4,height:4,role:'target'};inputs.references=[inputs.target];}
      let approved=0;
      const context:BackendContext={key:()=> 'key',beforeDispatch(){approved++;},dispatched(){assert.equal(approved,1);},signal:AbortSignal.timeout(2000),fetch:async(url,init)=>{
        const b=JSON.parse(String(init!.body)),h=new Headers(init!.headers);
        assert.equal(b.prompt,'circle');assert.equal(h.get(provider==='azure_openai'?'api-key':'authorization'),provider==='azure_openai'?'east-key':'Bearer key');
        if(provider==='openrouter'){assert.equal(new URL(String(url)).pathname,'/api/v1/images');if(edit)assert.match(b.input_references[0].image_url.url,/^data:image\/jpeg/);}
        else {assert.match(String(url),edit?/images\/edits$/:/images\/generations$/);if(edit)assert.ok(provider==='xai'?b.image.url:b.images[0].image_url);}
        return Response.json({data:[{b64_json:pixel.toString('base64'),media_type:'image/jpeg'}],usage:{cost:0.01}});
      }};
      const events=[];for await(const event of backend.run(request,inputs,context))events.push(event);
      const image=events.find(e=>e.type==='image');assert.ok(image);assert.deepEqual(image.bytes,pixel);
    }
  }
});

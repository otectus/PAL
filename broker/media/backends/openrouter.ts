import sharp from 'sharp';
import { capability } from '../../tools/contracts.ts';
import { responseJson } from '../../provider-http.ts';
import { BackendRefusal, type BackendContext, type ImageCapabilities, type ImageEvent, type ImageRequest, type ResolvedInputs, type ValidatedImageRequest } from '../contracts.ts';

export class OpenRouterImages {
  readonly model:string;readonly base:string;
  constructor(model:string,base:string){this.model=model;this.base=base;}
  describe():ImageCapabilities {
    const source='OpenRouter Images API', selected=capability('unknown',source,'Depends on the selected upstream model'), no=capability('unsupported',source);
    return {backend:'openrouter',model:this.model,route:'cloud',generate:selected,edit:selected,mask:no,maskBehavior:'none',
      maxReferences:1,formats:['png','jpeg','webp'],transparency:no,sizes:[],maxCount:1,partials:no,seed:no,negativePrompt:no,
      usage:capability('declared',source),cancel:no,query:no,billed:true,notes:['Use an image model from the selected OpenRouter account. Reference input requires a model that accepts input_references.']};
  }
  validate(request:ImageRequest){
    if(request.count!==1||request.references.length>1||request.partials||request.seed!==undefined||request.negativePrompt||request.size||request.quality||request.aspectRatio||request.imageSize||request.background==='transparent')
      throw new BackendRefusal('unsupported_parameter','Choose a single OpenRouter image and at most one reference with the model’s default dimensions');
    if(request.mask&&!request.protectOutside)throw new BackendRefusal('unsupported_mask','Enable local outside-mask protection for a masked edit');
    return {request,adjustments:[]};
  }
  async *run(request:ValidatedImageRequest,inputs:ResolvedInputs,context:BackendContext):AsyncIterable<ImageEvent>{
    const key=context.key();if(!key)throw new BackendRefusal('missing_key','Configure the OpenRouter image account');
    const references=inputs.references.map(r=>({type:'image_url',image_url:{url:'data:'+r.mime+';base64,'+r.bytes.toString('base64')}}));
    context.signal.throwIfAborted();context.beforeDispatch();context.dispatched();
    const response=await context.fetch(new URL('images',this.base),{method:'POST',redirect:'error',signal:context.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:this.model,prompt:request.prompt,...(references.length?{input_references:references}:{})})});
    if(!response.ok&&response.status>=400&&response.status<500&&response.status!==408){await response.body?.cancel();throw new BackendRefusal('provider_rejected','OpenRouter Images returned HTTP '+response.status);}
    const result=await responseJson(response,80*1024*1024);
    if(result.data?.length!==1||typeof result.data[0]?.b64_json!=='string')throw new Error('OpenRouter returned an invalid image count or format');
    yield {type:'accepted'};
    const raw=Buffer.from(result.data[0].b64_json,'base64'),decoder=sharp(raw,{limitInputPixels:64000000});
    const {format}=await decoder.metadata();if(!format||!['png','jpeg','webp'].includes(format))throw new Error('OpenRouter returned an unsupported image type');
    const bytes=format===request.format?raw:await decoder.toFormat(request.format).toBuffer();
    yield {type:'image',index:0,bytes,mime:'image/'+request.format};
    if(typeof result.usage?.cost==='number'&&Number.isFinite(result.usage.cost))yield {type:'usage',usage:{cost:result.usage.cost}};
  }
}

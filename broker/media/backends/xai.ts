import { capability } from '../../tools/contracts.ts';
import { responseJson } from '../../provider-http.ts';
import { BackendRefusal, type BackendContext, type ImageBackend, type ImageCapabilities, type ImageEvent, type ImageRequest, type ResolvedInputs, type ValidatedImageRequest } from '../contracts.ts';

export const xaiImageModels = ['grok-imagine-image-2.0'];
export class XaiImages implements ImageBackend {
  model: string;
  base:string;
  constructor(model:string,base='https://api.x.ai/v1/') { this.model=model; this.base=base; }
  describe():ImageCapabilities {
    const source='xAI Imagine image API', known=xaiImageModels.includes(this.model);
    const available=capability(known?'declared':'unknown',source), unavailable=capability('unsupported',source);
    return {backend:'xai',model:this.model,route:'cloud',generate:available,edit:available,mask:unavailable,maskBehavior:'none',
      maxReferences:5,formats:['jpeg'],transparency:unavailable,sizes:[],aspectRatios:['1:1','16:9','9:16','4:3','3:4','3:2','2:3'],imageSizes:['1k','2k'],
      maxCount:4,partials:unavailable,seed:unavailable,negativePrompt:unavailable,usage:capability('unknown',source),cancel:unavailable,query:unavailable,
      notes:['Billed to the selected xAI account. A submitted request may complete after Stop.'],billed:true};
  }
  validate(request:ImageRequest) {
    const c=this.describe();
    if (request.format!=='jpeg' || request.partials || request.size || request.background==='transparent' || request.negativePrompt || request.seed!==undefined || request.quality)
      throw new BackendRefusal('unsupported_parameter','Choose JPEG output and a supported aspect ratio and resolution for Grok Imagine');
    if (request.mask && !request.protectOutside) throw new BackendRefusal('unsupported_mask','Enable outside-mask pixel protection to apply a local mask');
    if (request.references.length>5 || !Number.isInteger(request.count) || request.count<1 || request.count>c.maxCount || request.aspectRatio && !c.aspectRatios!.includes(request.aspectRatio) || request.imageSize && !c.imageSizes!.includes(request.imageSize))
      throw new BackendRefusal('unsupported_parameter','Unsupported Imagine count, references, aspect ratio or resolution');
    return {request,adjustments:[]};
  }
  async *run(request:ValidatedImageRequest, inputs:ResolvedInputs, context:BackendContext):AsyncIterable<ImageEvent> {
    const images=inputs.references.map(image=>({type:'image_url',url:'data:'+image.mime+';base64,'+image.bytes.toString('base64')}));
    const key=context.key();
    if (!key) throw new BackendRefusal('key','Add a key for the xAI image account');
    context.signal.throwIfAborted(); context.beforeDispatch(); context.dispatched();
    const response=await context.fetch(this.base+'images/'+(images.length?'edits':'generations'),{
      method:'POST',redirect:'error',signal:context.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:this.model,prompt:request.prompt,n:request.count,response_format:'b64_json',aspect_ratio:request.aspectRatio,resolution:request.imageSize,
        ...(images.length===1?{image:images[0]}:images.length?{images}:{})})});
    const value=await responseJson(response,80*1024*1024);
    if (!Array.isArray(value.data) || value.data.length!==request.count) throw new Error('Grok Imagine returned an unexpected image count');
    yield {type:'accepted'};
    for (const [index,item] of value.data.entries()) {
      if(typeof item?.b64_json!=='string') throw new Error('Grok Imagine returned no image data');
      const bytes=Buffer.from(item.b64_json,'base64');
      if (bytes[0]!==255 || bytes[1]!==216) throw new Error('Grok Imagine returned an invalid JPEG');
      yield {type:'image',bytes,mime:'image/jpeg',index};
    }
  }
}

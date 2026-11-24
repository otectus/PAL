import sharp from 'sharp';
import { z } from 'zod';
import type { Core } from './core.ts';
import type { OllamaTool } from './ollama.ts';

export const computerToolName='pal_reviewed_computer';
export const computerTool:OllamaTool={type:'function',function:{name:computerToolName,description:'Perform a reviewed action on the selected display',parameters:{type:'object',properties:{},additionalProperties:false}}};
export const frameResult=Symbol('reviewed display frame');
const coordinate=z.number().int().nonnegative(),point=z.tuple([coordinate,coordinate]);
const action=z.object({type:z.string().max(32).optional(),action:z.string().max(32).optional(),x:coordinate.optional(),y:coordinate.optional(),coordinate:point.optional(),button:z.string().max(12).optional(),text:z.string().max(2000).optional(),keys:z.array(z.string().max(16)).max(1).optional(),repeat:z.number().int().min(1).max(100).optional()}).strict();
const actions=z.array(action).min(1).max(8);
const width=1024,height=768;
type View = {viewId:string; revision:number; binding:string;time:number;timer?:NodeJS.Timeout};
export class ProviderComputer {
  core:Core;private views=new Map<string,View>();
  constructor(core:Core){this.core=core;}
  stop(id:string){const view=this.views.get(id);if(view){clearTimeout(view.timer);this.core.remoteView.stop(view.viewId,'provider:'+id);this.views.delete(id);}}
  async run(id:string,raw:unknown,signal:AbortSignal) {
    const {items,checks}=z.strictObject({items:actions,checks:z.array(z.object({id:z.string().max(256),code:z.string().max(128),message:z.string().max(2048)})).max(8).optional()}).parse(raw);
    const current=()=>{
      signal.throwIfAborted();const s=this.core.store.session(id);
      if(!this.core.toolsFor(id).some(t=>t.function.name===computerToolName))throw new Error('Provider computer control was turned off');
      return [s.provider,s.connectionId||'',s.connectionId?this.core.chatConnections.get(s.connectionId).revision:0,s.configRevision||'0',this.core.credentials.credentialRevision(s.connectionId?'connection:'+s.connectionId:'provider:'+s.provider)].join('/');
    };
    const binding=current(),authorize=()=>{if(current()!==binding)throw new Error('Review the changed conversation before sharing the desktop');};
    const device='provider:'+id;let view=this.views.get(id);
    if(view&&(view.binding!==binding||Date.now()-view.time>120000)){this.stop(id);view=undefined;}
    for(const item of items){
      const kind=item.action||item.type;
      if(kind==='screenshot')continue;
      if(!view?.revision)throw new Error('Request a fresh desktop screenshot before giving input');
      const x=item.coordinate?.[0]??item.x,y=item.coordinate?.[1]??item.y;
      let input:Parameters<Core['remoteView']['send']>[2];
      if(kind==='left_click'&&item.text)throw new Error('Modifier keys are unavailable for a click');
      if((item.repeat||1)>1)throw new Error('Press one key at a time');
      if(kind==='click'||kind==='left_click'||kind==='move'||kind==='mouse_move'){
        if(x===undefined||y===undefined||x>=width||y>=height||item.button&&item.button!=='left')throw new Error('Choose a left click or pointer move within the reviewed screen');
        input={kind:kind==='click'||kind==='left_click'?'click':'move',x:x/width,y:y/height};
      }else if(kind==='type'&&item.text)input={kind:'type',text:item.text};
      else if(kind==='keypress'||kind==='key'){
        const named=item.keys?.[0]||item.text||'',key=({return:'Enter',enter:'Enter',kp_enter:'Enter',esc:'Escape',escape:'Escape',backspace:'Backspace',tab:'Tab'} as Record<string,string>)[named.toLowerCase()];
        if(!key)throw new Error('Only Enter, Escape, Tab and Backspace are available');
        input={kind:'key',key};
      }else throw new Error('This computer action is unavailable in PAL');
      const answer=await this.core.approval(id,{kind:'computer',title:'Allow this provider to control the desktop?',detail:JSON.stringify(item)+'\n'+(checks||[]).map(c=>c.message).join('\n'),choices:['allow','deny']});
      authorize();if(answer.choice!=='allow')throw new Error('The user declined desktop input');
      await this.core.remoteView.send(view.viewId,device,{...input,frameRevision:view.revision},authorize);
    }
    authorize();
    if(!view){
      const answer=await this.core.approval(id,{kind:'computer',title:'Capture a display for this provider?',detail:'PAL will show you the screen before sharing it.',choices:['allow','deny']});
      authorize();if(answer.choice!=='allow')throw new Error('The user declined screen capture');
      const started=await this.core.remoteView.start(device,'Provider in '+this.core.store.session(id).title);
      view={viewId:started.viewId,revision:0,time:Date.now(),binding};this.views.set(id,view);
    }
    try{
      const captured=await this.core.remoteView.frame(view.viewId,device,width);
      const png=await sharp(Buffer.from(captured.data.split(',')[1],'base64')).resize(width,height,{fit:'fill'}).png().toBuffer();
      authorize();const answer=await this.core.approval(id,{kind:'capture',title:'Share this screen with the selected provider?',detail:'Display '+captured.output+' · 1024 × 768\n'+(checks||[]).map(c=>c.message).join('\n'),image:'data:image/png;base64,'+png.toString('base64'),choices:['allow','deny']});
      authorize();if(answer.choice!=='allow')throw new Error('The user declined to share the screen');
      view.revision=captured.revision;view.time=Date.now();clearTimeout(view.timer);
      view.timer=setTimeout(()=>this.stop(id),120000);view.timer.unref();
      return {shared:true,[frameResult]:{image:png.toString('base64'),checks}};
    }catch(e){this.stop(id);throw e;}
  }
}

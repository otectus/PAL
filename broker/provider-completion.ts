import { providerTokens } from './provider-codecs/streaming.ts';
/** Non-streamed task output. Reasoning/tool payloads remain private to the originating provider. */
export function taskOutput(value:any) {
  const message = value.choices?.[0]?.message, candidate=value.candidates?.[0];
  const parts=Array.isArray(value.output) ? value.output.filter((i:any)=>i.type==='message').flatMap((i:any)=>i.content||[])
    : Array.isArray(value.content) ? value.content : candidate?.content?.parts||[];
  const refusal=message?.refusal || parts.some((part:any)=>part.type==='refusal');
  const reason=value.status==='incomplete'?value.incomplete_details?.reason||'incomplete':value.status||value.stop_reason||candidate?.finishReason||value.choices?.[0]?.finish_reason;
  const finish = refusal?'refusal':['length','incomplete','max_tokens','max_output_tokens','MAX_TOKENS'].includes(reason)?'output_limit':
    ['completed','stop','end_turn','STOP'].includes(reason)?'complete':['SAFETY','BLOCKLIST','PROHIBITED_CONTENT','content_filter'].includes(reason)?'content_filter':'transport_error';
  const u=value.usage || value.usageMetadata || {};
  return {text:typeof message?.content==='string'?message.content:parts.filter((p:any)=>!p.thought && (!p.type || p.type==='output_text'||p.type==='text') && typeof p.text==='string').map((p:any)=>p.text).join('\n'),
    finish,model:value.model||value.modelVersion,usage:providerTokens(u)} as const;
}

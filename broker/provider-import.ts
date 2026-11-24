import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Core } from './core.ts';
import { isApiProvider, providerLabels } from './provider-catalog.ts';
import { privateDir } from './paths.ts';
import { providerImportAliases, providerDefinition } from './provider-registry.ts';
import type { Store } from './store.ts';
import { validEndpoint } from './compatible-endpoint.ts';
import { ollamaHost } from './ollama.ts';
import { credentialDestination } from './connections.ts';
import type { CredentialProvider, CredentialReferenceImport } from './credentials.ts';

const defaultProviders = ['openai','anthropic','google'] as const;
export function migrateProviderReferences(store: Store) {
  if (store.get('providerSchemaVersion',0) >= 2) return;
  if (store.db.prepare('SELECT 1 FROM sessions UNION ALL SELECT 1 FROM meta WHERE key IN (\'settings\',\'chatConnectionsMigrated\') LIMIT 1').get()) {
    const folder = privateDir(join(store.directory,'migration-backups')), target = join(folder,'pre-provider-v2.sqlite');
    if (!existsSync(target)) {
      const temp = join(folder,randomUUID()+'.tmp');
      try { store.db.prepare('VACUUM INTO ?').run(temp); chmodSync(temp,0o600); renameSync(temp,target); }
      finally { if(existsSync(temp))unlinkSync(temp); }
    }
  }
  store.transaction(() => {
    store.set('defaultProviderReferences',Object.fromEntries(defaultProviders.map(p=>[p,'provider:'+p])));
    store.set('providerSchemaVersion',2);
  });
}

const record = (value:unknown):Record<string,any> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,any> : {};
const normalized = (url:string) => url.replace(/\/+$/,'');
const input = z.strictObject({json:z.string().min(2).max(2_000_000),digest:z.string().regex(/^[a-f0-9]{64}$/).optional(),includeSecrets:z.boolean().optional(),acknowledgeSecrets:z.literal(true).optional()});
const flatProviders=[
  {id:'openai',key:'api_key',endpoint:'api_endpoint'},{id:'google',key:'api_key_google',endpoint:'api_endpoint_google'},
  {id:'anthropic',key:'api_key_anthropic',endpoint:'api_endpoint_anthropic'},{id:'huggingface',key:'api_key_hugging_face',endpoint:'api_endpoint_hugging_face'},
  {id:'deepseek_api',key:'api_key_deepseek',endpoint:'api_endpoint_deepseek'},{id:'x_ai',key:'api_key_xai',endpoint:'api_endpoint_xai',management:'api_key_management_xai'},
  {id:'perplexity',key:'api_key_perplexity',endpoint:'api_endpoint_perplexity'},{id:'mistral_ai',key:'api_key_mistral',endpoint:'api_endpoint_mistral'},
  {id:'open_router',key:'api_key_open_router',endpoint:'api_endpoint_open_router'},{id:'forge',key:'api_key_forge',endpoint:'api_endpoint_forge'},
  {id:'edenai',key:'api_key_edenai',endpoint:'api_endpoint_edenai'},
] as const;
const legacy: Array<[RegExp,string]> = [
  [/assistants?(?:_api|\.api)|openai_assistants/i,'OpenAI Assistants settings require review. Choose a Responses model for new conversations.'],
  [/sonar/i,'Review historical Sonar settings and choose a current Perplexity Agent model or effort.'],
  [/sora|veo-3\.1.*preview/i,'Historical video model. Choose a current Gemini Omni or Grok Imagine video model.'],
  [/bing/i,'Bing Search retired. Choose a raw-search provider. For legacy Bing speech, set up an Azure Speech resource.'],
  [/google_custom|google_cse/i,'Google Custom Search is available to existing customers until January 1, 2027.'],
  [/recognize_google/i,'The legacy Google SpeechRecognition wrapper requires an explicit migration to Google Cloud Speech.'],
  [/openai_whisper/i,'Choose OpenAI transcription in Voice settings.'],
];
type MigrationSelection = {provider:string; source:string; originalModel:string; suggestedPreset?:string};
const sonarPresets: Record<string,string> = {'sonar':'fast','sonar-pro':'fast','sonar-reasoning-pro':'low','sonar-deep-research':'high'};

function retiredSelections(data:Record<string,unknown>):MigrationSelection[] {
  const selected=new Map<string,MigrationSelection>();
  function visit(value:unknown, source:string, depth:number, modelField:boolean) {
    if (depth>6 || selected.size>=128) return;
    if (typeof value==='string' && modelField) {
      const originalModel=value.trim().toLowerCase();
      const suggestedPreset=Object.hasOwn(sonarPresets,originalModel)?sonarPresets[originalModel]:undefined;
      const provider=suggestedPreset?'perplexity':/^(?:sora(?:-2(?:-pro)?)?|openai_assistants|assistants_api)$/.test(originalModel)?'openai':
        /^veo-3\.1-(?:fast-)?generate-preview$/.test(originalModel)?'google':undefined;
      if (provider) selected.set(source+'|'+originalModel,{provider,source,originalModel,...(suggestedPreset?{suggestedPreset}:{})});
      return;
    }
    if (Array.isArray(value)) { if(modelField)value.slice(0,256).forEach((entry,i)=>visit(entry,source+'['+i+']',depth+1,true));return; }
    for (const [field,entry] of Object.entries(record(value))) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(field)) continue;
      const isModel=/^(?:model(?:s|_id|_name|_current)?|api_model|preset|mode|model\.[a-z0-9_.-]+)$/i.test(field);
      if (isModel || modelField || ['providers','settings','config'].includes(field) || source==='providers')
        visit(entry,source?source+'.'+field:field,depth+1,isModel||modelField);
    }
  }
  visit(data,'',0,false);
  return [...selected.values()];
}

export function importProviderData(core:Core, action:'preview'|'apply', params:unknown) {
  const p=input.parse(params), data=record(JSON.parse(p.json)), accounts:any[]=[], plans:any[]=[], unmapped=new Set<string>(), notices=new Set<string>(),skipped:any[]=[];
  const existing=core.chatConnections.list(), duplicates:string[]=[],isPyGpt=typeof record(data.__meta__)['app.version']==='string'||typeof record(data.__meta__).version==='string';
  const literal=(value:unknown,source:string)=>{
    if(value===undefined||value===null||value==='')return undefined;
    if(typeof value!=='string'||value.length>8192||/[\s\x00-\x1f\x7f]/.test(value)||/(?:\$(?:[A-Z_{(])|`|\{providers\[|^(?:(?:env|file):|~?\/[^/]+\/))/i.test(value)){skipped.push({source,reason:'Not a safe literal API key'});return undefined;}
    return value;
  };
  function consider(upstream:string,raw:unknown,custom=false) {
    const r=record(raw), settings={...r,...record(r.settings)};
    const kind=custom?'compatible':Object.hasOwn(providerImportAliases,upstream)?providerImportAliases[upstream]:upstream;
    const primary=literal(settings.api_key??settings.key??settings.token,upstream+'.api_key'),management=literal(settings.management_api_key??record(settings.extra).management_api_key,upstream+'.management_api_key');
    if (kind!=='ollama'&&!isApiProvider(kind)) {unmapped.add(upstream);if(primary||management)skipped.push({source:upstream,reason:'Unsupported provider account'});return;}
    const variant=upstream==='huggingface_api'?'inference':upstream==='huggingface_router'?'router':undefined;
    const name=String(r.name||r.label||providerLabels[kind]).trim().slice(0,60);
    const address=settings.api_base||settings.base_url||settings.endpoint||settings.host;
    const supported=new Set(['name','label','settings','id','provider','api_base','base_url','endpoint','host','api_key','key','token','extra','management_api_key']);
    for(const key of Object.keys(settings))if(!supported.has(key))unmapped.add(upstream+'.'+key);
    if(address!==undefined && (typeof address!=='string'||/[\x00-\x20`$]/.test(address))) {unmapped.add(upstream+'.endpoint');return;}
    if(address){try{const u=new URL(address);if(u.username||u.password||u.search||u.hash||!['https:','http:'].includes(u.protocol))throw 0;}catch{unmapped.add(upstream+'.endpoint');return;}}
    const url=normalized(address || (kind==='ollama'?'http://127.0.0.1:11434':providerDefinition(kind)?.baseUrl||''));
    if(!url){notices.add(name+' needs an explicit endpoint before import.');return;}
    try { if (kind==='ollama') ollamaHost(url); else validEndpoint({baseUrl:url},core.settings.compatible); }
    catch {unmapped.add(upstream+'.endpoint');return;}
    const account={kind,name,...(variant?{variant}:{}),...(kind==='ollama'?{host:url}:{endpoint:{baseUrl:url}})},matched=existing.find(row=>row.kind===kind&&row.name===name&&normalized(row.compatible?.baseUrl||row.ollama?.host||'')===url&&row.variant===variant);
    if(accounts.some(row=>row.kind===kind&&row.name===name&&(row.host||row.endpoint?.baseUrl)===url&&row.variant===variant)){duplicates.push(name);return;}
    if(matched)duplicates.push(name);else accounts.push(account);
    plans.push({account,existingId:matched?.id,secrets:[...(primary&&kind!=='ollama'?[{provider:kind,key:primary,source:upstream+'.api_key',label:'API key'}]:[]),...(management&&kind==='xai'?[{provider:'xai_management',key:management,source:upstream+'.management_api_key',label:'Management API key'}]:[])]});
  }
  const provided=record(data.providers);for(const [id,row] of Object.entries(provided))consider(id,row);
  for(const flat of flatProviders){if(Object.hasOwn(provided,flat.id))continue;const key=data[flat.key],endpoint=data[flat.endpoint],management='management' in flat?data[flat.management]:undefined;if(key!==undefined||endpoint!==undefined||management!==undefined)consider(flat.id,{api_key:key,api_base:endpoint,management_api_key:management});}
  if(Array.isArray(data.api_custom_providers))for(const row of data.api_custom_providers)consider(String(record(row).id||'custom'),row,true);
  if(accounts.length>128)throw new Error('Import up to 128 accounts at a time');
  const flatFields=new Set<string>(flatProviders.flatMap(row=>[row.key,row.endpoint,...('management' in row?[row.management]:[])]));
  for(const field of Object.keys(data))if(!['providers','api_custom_providers','__meta__'].includes(field)&&!flatFields.has(field as any)&&(!isPyGpt||/^(?:api_(?:key|endpoint|native)|provider)/i.test(field)))unmapped.add(field);
  if(Array.isArray(data['app.env'])&&data['app.env'].length)notices.add('Application environment entries are never imported. Configure supported credentials explicitly.');
  for(const [pattern,note] of legacy)if(pattern.test(p.json))notices.add(note);
  const candidates=plans.flatMap(plan=>plan.secrets.map((secret:any)=>({account:plan.account.name,provider:secret.provider,label:secret.label,source:secret.source,target:plan.existingId?'existing named account':'new named account'})));
  const secretPreview={available:candidates.length,selected:p.includeSecrets===true?candidates.length:0,requiresConfirmation:p.includeSecrets===true&&candidates.length>0,...(p.includeSecrets?{accounts:candidates}:{}),skipped};
  const migrations=retiredSelections(data);
  for(const item of migrations) notices.add(item.suggestedPreset
    ? item.originalModel+' was selected in '+item.source+'. Review the '+item.suggestedPreset+' Perplexity Agent preset before starting a new conversation.'
    : item.originalModel+' was selected in '+item.source+'. Choose a current replacement in the provider settings.');
  const preview={accounts,duplicates,migrations,notices:[...notices],unmapped:[...unmapped].slice(0,4096),credentials:secretPreview,secrets:p.includeSecrets?'Review every credential target and confirm the private import.':'Secrets are excluded by default. Select “Import credentials” to review their targets.'};
  const digest=core.credentials.importProof(p.json+'\0'+JSON.stringify(preview));
  if(action==='preview')return {...preview,digest};
  if(digest!==p.digest)throw new Error('Preview the current accounts before applying the import');
  if(p.includeSecrets&&candidates.length&&!p.acknowledgeSecrets)throw new Error('Confirm that the reviewed provider credentials may be saved privately');
  let rollback:(()=>void)|undefined;
  try{return core.store.transaction(()=>{
    const created:string[]=[],references:CredentialReferenceImport[]=[];
    for(const plan of plans){const connection=plan.existingId?core.chatConnections.get(plan.existingId):core.chatConnections.save(plan.account,false);if(!plan.existingId)created.push(connection.id);if(!p.includeSecrets)continue;
      for(const secret of plan.secrets){const management=secret.provider==='xai_management',credentialRef='connection:'+connection.id+(management?':xai-management':''),origin=management?'https://management-api.x.ai':credentialDestination(connection);references.push({provider:secret.provider as CredentialProvider,key:secret.key,credentialRef,origin});}
    }
    if(migrations.length) {
      const previous=core.store.get<MigrationSelection[]>('providerImportMigrations',[]);
      const unique=new Map([...previous,...migrations].map(item=>[JSON.stringify(item),item]));
      core.store.set('providerImportMigrations',[...unique.values()]);
    }
    if(references.length)rollback=core.credentials.importReferences(references);
    return{created,duplicates,migrations,notices:[...notices],credentialsImported:references.length};
  });}catch(error){rollback?.();throw error;}
}

import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fstatSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { privateDir } from './paths.ts';
import { apiProviders, type ApiProvider } from './provider-catalog.ts';

export const serviceCredentialIds = ['elevenlabs', 'voyage', 'jev', 'azure_speech', 'google_search','ollama_cloud','xai_management'] as const;
export type CredentialProvider = ApiProvider | typeof serviceCredentialIds[number];
const credentialProviders:CredentialProvider[]=[...apiProviders,...serviceCredentialIds];
const environment: Record<CredentialProvider, string[]> = { xai_management:['XAI_MANAGEMENT_API_KEY'],ollama_cloud:['OLLAMA_API_KEY'],elevenlabs:['ELEVENLABS_API_KEY'], openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], azure_openai: ['AZURE_OPENAI_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'], mistral: ['MISTRAL_API_KEY'], xai: ['XAI_API_KEY'], perplexity: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], huggingface: ['HF_TOKEN'], litellm: ['LITELLM_API_KEY'], forge: ['FORGE_API_KEY'], edenai: ['EDENAI_API_KEY'], voyage: ['VOYAGE_API_KEY'], jev: ['TYPESAFE_API_KEY'], azure_speech: ['AZURE_SPEECH_KEY'], google_search: ['GOOGLE_SEARCH_API_KEY'], compatible: [] };
type CredentialReference = { provider: CredentialProvider; key: string; origin?: string; revision: string };
export type CredentialReferenceImport = { provider: CredentialProvider; key: string; origin?: string; credentialRef: string };
type SavedCredentials = Partial<Record<CredentialProvider, string>> & {
  origins?: Partial<Record<CredentialProvider, string>>;
  revisions?: Partial<Record<CredentialProvider, string>>;
  references?: Record<string, CredentialReference>;
  legacyCompatibleRef?: string;
};
/**
 * Secrets never enter the shared settings, transcript database, or snapshot. M13: the compatible
 * endpoint's key is saved together with the origin it was entered for, and is used only for that
 * origin; changing the endpoint's host never forwards the key there.
 */
export class ProviderCredentials {
  readonly directory: string;
  constructor(directory: string) { this.directory=directory; }
  private saved(): SavedCredentials {
    let fd: number;
    try { fd = openSync(join(this.directory, 'provider-credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot read the private provider credentials file'); }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 512 * 1024) throw new Error();
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const origins = value.origins && typeof value.origins === 'object' && !Array.isArray(value.origins) ? Object.fromEntries(Object.entries(value.origins).filter(([, origin]) => typeof origin === 'string')) : {};
      const revisions = value.revisions && typeof value.revisions === 'object' && !Array.isArray(value.revisions) ? Object.fromEntries(Object.entries(value.revisions).filter(([, revision]) => typeof revision === 'string')) : {};
      const references = value.references && typeof value.references === 'object' && !Array.isArray(value.references) ? Object.fromEntries(Object.entries(value.references).flatMap(([ref, entry]: [string, any]) => {
        if (!/^(?:provider|connection):[^\s\x00-\x1f\x7f]{1,256}$/u.test(ref) || !entry || typeof entry !== 'object' || !credentialProviders.includes(entry.provider) || typeof entry.key !== 'string' || typeof entry.revision !== 'string' || entry.origin !== undefined && typeof entry.origin !== 'string') return [];
        return [[ref, { provider: entry.provider, key: entry.key, revision: entry.revision, ...(entry.origin !== undefined ? { origin: entry.origin } : {}) }]];
      })) : {};
      const legacyCompatibleRef = typeof value.legacyCompatibleRef === 'string' && /^connection:[^\s\x00-\x1f\x7f]{1,256}$/u.test(value.legacyCompatibleRef) ? value.legacyCompatibleRef : undefined;
      return { ...Object.fromEntries(credentialProviders.flatMap(p => typeof value[p] === 'string' ? [[p, value[p]]] : [])), origins, revisions, references, ...(legacyCompatibleRef ? { legacyCompatibleRef } : {}) };
    } catch { throw new Error('Provider credentials must be a private, owner-only JSON file'); }
    finally { closeSync(fd); }
  }
  /** A key bound to an origin is returned only for that origin. */
  key(provider: CredentialProvider, origin?: string, credentialRef?: string) {
    const saved = this.saved(), scoped = credentialRef ? saved.references?.[credentialRef] : undefined;
    if (scoped) return scoped.provider === provider && (scoped.origin === undefined || scoped.origin === origin) ? scoped.key : '';
    if (credentialRef?.startsWith('connection:') && credentialRef !== saved.legacyCompatibleRef) return '';
    const bound = saved.origins?.[provider];
    if (bound !== undefined && bound !== origin) return '';
    return saved[provider] || environment[provider].map(name => process.env[name]?.trim()).find(Boolean) || '';
  }
  private environmentRevision(provider:CredentialProvider) {
    const value=environment[provider].map(name=>process.env[name]?.trim()).find(Boolean);
    if(!value)return 'missing';
    const file=join(privateDir(this.directory),'revision-salt');
    let salt:Buffer;
    try{salt=readFileSync(file);}
    catch(e:any){
      if(e.code!=='ENOENT')throw e;
      const temp=join(this.directory,'.salt-'+randomUUID());
      writeFileSync(temp,randomBytes(32),{mode:0o600,flag:'wx'});
      try{linkSync(temp,file);}catch(err:any){if(err.code!=='EEXIST')throw err;}finally{unlinkSync(temp);}
      salt=readFileSync(file);
    }
    return 'environment:'+createHmac('sha256',salt).update(provider+'\0'+value).digest('hex');
  }
  credentialRevision(credentialRef: string) {
    const saved = this.saved(), scoped = saved.references?.[credentialRef];
    if (scoped) return scoped.revision;
    if (credentialRef.startsWith('provider:')) {
      const provider = credentialRef.slice('provider:'.length) as CredentialProvider;
      if (credentialProviders.includes(provider)) {
        if(saved[provider])return saved.revisions?.[provider] || 'legacy:'+provider;
        const revision=this.environmentRevision(provider);
        return revision==='missing' ? (saved.revisions?.[provider] || revision) : revision;
      }
    }
    // Legacy compatible credentials remain origin-bound until they are next saved for a connection.
    if (credentialRef === saved.legacyCompatibleRef) return saved.revisions?.compatible ?? (saved.compatible ? 'legacy-compatible' : 'missing');
    return 'missing';
  }
  status(origin?: string, credentialRef?: string) {
    const saved = this.saved();
    return Object.fromEntries(credentialProviders.map(p => {
      const scoped = credentialRef ? saved.references?.[credentialRef] : undefined;
      const bound = scoped?.provider === p ? scoped.origin : saved.origins?.[p];
      const legacyAllowed = !credentialRef?.startsWith('connection:') || p === 'compatible' && credentialRef === saved.legacyCompatibleRef;
      const fromEnv = !scoped && legacyAllowed && environment[p].some(k => process.env[k]?.trim());
      const usable = scoped ? scoped.provider === p && !!scoped.key && (bound === undefined || bound === origin) : legacyAllowed && !!saved[p] && (bound === undefined || bound === origin);
      return [p, { configured: usable || fromEnv,
        source: usable ? 'saved' : fromEnv ? 'environment' : 'missing', environment: environment[p].join(' / '), ...(bound !== undefined ? { boundTo: bound } : {}) }];
    }));
  }
  private write(saved:SavedCredentials){
    const bytes=JSON.stringify(saved);if(Buffer.byteLength(bytes)>512*1024)throw new Error('The private provider credential store is full');
    const temporary=join(privateDir(this.directory),'.credentials-'+randomUUID());
    try{writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});renameSync(temporary,join(this.directory,'provider-credentials.json'));}
    finally{try{unlinkSync(temporary);}catch{}}
  }
  update(provider: unknown, key: unknown, origin?: string, credentialRef?: string) {
    if (!(typeof provider==='string'&&credentialProviders.includes(provider as CredentialProvider)) || typeof key !== 'string' || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('Choose an API provider and enter a key without whitespace');
    if (provider === 'compatible' && key && !origin) throw new Error('Set the compatible endpoint before saving its key');
    if (credentialRef !== undefined && !/^(?:provider|connection):[^\s\x00-\x1f\x7f]{1,256}$/u.test(credentialRef)) throw new Error('Invalid credential reference');
    privateDir(this.directory);
    const saved = this.saved();
    if (credentialRef) {
      saved.references = { ...(saved.references || {}) };
      // Keep a revisioned empty tombstone so revoking a scoped key never falls back to another account.
      saved.references[credentialRef] = { provider: provider as CredentialProvider, key, revision: randomUUID(), ...(origin !== undefined ? { origin } : {}) };
    } else {
      saved.origins = { ...(saved.origins || {}) };
      saved.revisions = { ...(saved.revisions || {}) };
      if (key) saved[provider as CredentialProvider] = key; else delete saved[provider as CredentialProvider];
      saved.revisions[provider as CredentialProvider] = randomUUID();
      if (provider === 'compatible' && key) saved.origins.compatible = origin; else if (provider === 'compatible') delete saved.origins.compatible;
    }
    this.write(saved);
    return this.status(origin, credentialRef);
  }
  /**
   * Atomically imports already-reviewed literal secrets into private, revisioned connection references.
   * The returned rollback is synchronous so a caller can pair this file update with its SQLite transaction.
   */
  importReferences(entries:CredentialReferenceImport[]) {
    if(!Array.isArray(entries)||entries.length>128)throw new Error('Import up to 128 credential references at a time');
    const refs=new Set<string>();
    for(const entry of entries){
      if(!entry||!credentialProviders.includes(entry.provider)||typeof entry.key!=='string'||!entry.key||entry.key.length>8192||/[\s\x00-\x1f\x7f]/.test(entry.key))throw new Error('Provider imports require literal API keys without whitespace');
      if(!/^connection:[^\s\x00-\x1f\x7f]{1,256}$/u.test(entry.credentialRef)||refs.has(entry.credentialRef))throw new Error('Provider imports require unique named-account credential references');
      if(entry.origin!==undefined&&(typeof entry.origin!=='string'||!entry.origin||entry.origin.length>4096||/[\x00-\x1f\x7f]/.test(entry.origin)))throw new Error('Provider imports require a bounded endpoint binding');
      refs.add(entry.credentialRef);
    }
    privateDir(this.directory);const before=this.saved(),next:SavedCredentials={...before,references:{...(before.references||{})}};
    for(const entry of entries)next.references![entry.credentialRef]={provider:entry.provider,key:entry.key,revision:randomUUID(),...(entry.origin?{origin:entry.origin}:{})};
    this.write(next);let rolledBack=false;return()=>{if(!rolledBack){rolledBack=true;this.write(before);}};
  }
  /** Opaque HMAC for binding an import preview to its exact source without returning a hash oracle for secrets. */
  importProof(value:string) {
    if(typeof value!=='string'||value.length>4_000_000)throw new Error('Invalid provider import proof');
    const file=join(privateDir(this.directory),'import-proof-key');let key:Buffer;
    try{key=readFileSync(file);}catch(error:any){if(error.code!=='ENOENT')throw error;const temp=join(this.directory,'.import-proof-'+randomUUID());writeFileSync(temp,randomBytes(32),{mode:0o600,flag:'wx'});try{linkSync(temp,file);}catch(inner:any){if(inner.code!=='EEXIST')throw inner;}finally{unlinkSync(temp);}key=readFileSync(file);}
    if(key.length!==32)throw new Error('Invalid private provider import key');
    return createHmac('sha256',key).update(value).digest('hex');
  }
  removeAccount(id:string){
    const saved=this.saved(),ref='connection:'+id;
    if(!saved.references?.[ref]&&!saved.references?.[ref+':xai-management'])return;
    delete saved.references[ref];delete saved.references[ref+':xai-management'];
    this.write(saved);
  }
  /** Binds the pre-reference compatible key to the one migrated default connection, never every same-origin account. */
  bindLegacyCompatible(credentialRef: string, origin: string) {
    if (!/^connection:[^\s\x00-\x1f\x7f]{1,256}$/u.test(credentialRef)) throw new Error('Invalid credential reference');
    const saved = this.saved();
    if (!saved.compatible || saved.legacyCompatibleRef || saved.origins?.compatible !== origin) return false;
    saved.legacyCompatibleRef = credentialRef;
    privateDir(this.directory);
    this.write(saved);
    return true;
  }
}

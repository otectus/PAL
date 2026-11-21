import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir } from './paths.ts';
import { apiProviders, type ApiProvider } from './provider-catalog.ts';

type CredentialProvider = ApiProvider | 'elevenlabs';
const credentialProviders:CredentialProvider[]=[...apiProviders,'elevenlabs'];
const environment: Record<CredentialProvider, string[]> = { elevenlabs:['ELEVENLABS_API_KEY'], openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], compatible: [] };
type CredentialReference = { provider: CredentialProvider; key: string; origin?: string; revision: string };
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
    if (provider === 'compatible' && credentialRef && credentialRef !== saved.legacyCompatibleRef) return '';
    const bound = saved.origins?.[provider];
    if (bound !== undefined && bound !== origin) return '';
    return saved[provider] || environment[provider].map(name => process.env[name]?.trim()).find(Boolean) || '';
  }
  credentialRevision(credentialRef: string) {
    const saved = this.saved(), scoped = saved.references?.[credentialRef];
    if (scoped) return scoped.revision;
    if (credentialRef.startsWith('provider:')) {
      const provider = credentialRef.slice('provider:'.length) as CredentialProvider;
      if (credentialProviders.includes(provider)) return saved.revisions?.[provider] ?? (environment[provider].some(name => process.env[name]?.trim()) ? `environment:${environment[provider].join('|')}` : 'missing');
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
      const legacyAllowed = p !== 'compatible' || !credentialRef || credentialRef === saved.legacyCompatibleRef;
      const usable = scoped ? scoped.provider === p && !!scoped.key && (bound === undefined || bound === origin) : legacyAllowed && !!saved[p] && (bound === undefined || bound === origin);
      return [p, { configured: usable || environment[p].some(k => process.env[k]?.trim()),
        source: usable ? 'saved' : environment[p].some(k => process.env[k]?.trim()) ? 'environment' : 'missing', environment: environment[p].join(' / '), ...(bound !== undefined ? { boundTo: bound } : {}) }];
    }));
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
    const temporary = join(this.directory, `.credentials-${randomUUID()}`);
    try { writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' }); renameSync(temporary, join(this.directory, 'provider-credentials.json')); }
    finally { try { unlinkSync(temporary); } catch {} }
    return this.status(origin, credentialRef);
  }
  /** Binds the pre-reference compatible key to the one migrated default connection, never every same-origin account. */
  bindLegacyCompatible(credentialRef: string, origin: string) {
    if (!/^connection:[^\s\x00-\x1f\x7f]{1,256}$/u.test(credentialRef)) throw new Error('Invalid credential reference');
    const saved = this.saved();
    if (!saved.compatible || saved.legacyCompatibleRef || saved.origins?.compatible !== origin) return false;
    saved.legacyCompatibleRef = credentialRef;
    privateDir(this.directory);
    const temporary = join(this.directory, `.credentials-${randomUUID()}`);
    try { writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' }); renameSync(temporary, join(this.directory, 'provider-credentials.json')); }
    finally { try { unlinkSync(temporary); } catch {} }
    return true;
  }
}

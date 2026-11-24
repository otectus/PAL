import { sessionRoute } from '../workspace/policy.ts';
import type { Core } from '../core.ts';
import type { Session } from '../types.ts';
import { ownerControlled } from '../authority.ts';
import { validReferences, type Reference } from '../workspace/references.ts';
import { readText, readable } from '../workspace/files.ts';
import { mimeFor } from '../artifacts/store.ts';
import { localOnly, routeAllowed, strictest, type DestinationPolicy } from '../tools/contracts.ts';
import { hash, passages, publicPolicy, type Evidence, type ResearchRun } from './evidence.ts';

type SourceRef = Extract<Reference, { kind: 'artifact' | 'file' | 'collection' }> | { kind: 'note'; id: string };
const encode = (ref: SourceRef) => Buffer.from(JSON.stringify(ref)).toString('base64url');
function decode(id: string): SourceRef {
  const raw = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
  if (raw?.kind === 'note' && typeof raw.id === 'string') return { kind: 'note', id: raw.id };
  const [ref] = validReferences([raw]);
  if (ref.kind === 'artifact' || ref.kind === 'file' || ref.kind === 'collection') return ref;
  throw new Error('Select a document, collection or project note');
}
export async function sourceChoices(core: Core, session: Session, query = '') {
  if (!ownerControlled(session) || session.temporary) return [];
  const choices = await core.workbench.references.search(session, query);
  const result: { id: string; title: string; kind: string; detail: string }[] = choices.flatMap((c) => {
    const ref = c.ref;
    if (ref.kind !== 'file' && ref.kind !== 'artifact' && ref.kind !== 'collection') return [];
    if (
      ref.kind === 'artifact' &&
      !['text', 'document', 'table'].includes(
        core.workbench.artifacts.version(session.id, ref.artifactId, ref.versionId).kind,
      )
    )
      return [];
    return [{ id: encode(ref), title: c.label, kind: ref.kind, detail: c.detail }];
  });
  for (const note of core.notebook
    .list()
    .notes.filter((n) => n.project === session.cwd && n.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 40))
    result.push({
      id: encode({ kind: 'note', id: note.id }),
      title: note.title,
      kind: 'note',
      detail: 'Project note · local models',
    });
  return result;
}
function info(core: Core, session: Session, ref: SourceRef) {
  if (!ownerControlled(session) || session.temporary)
    throw new Error('Project research requires an owner-controlled saved conversation');
  const bench = core.workbench;
  switch (ref.kind) {
    case 'note': {
      const note = core.notebook.get(ref.id);
      if (note.project !== session.cwd || !note.updated) throw new Error('That note is no longer in this project');
      return { title: note.title, policy: localOnly };
    }
    case 'collection': {
      const c = core.collections.bound(session).find((x) => x.id === ref.id);
      if (!c || core.withheld(session.id, 'memory')) throw new Error('That collection is unavailable in this conversation');
      return { title: c.name, policy: c.allowCloud ? publicPolicy : localOnly, stamp: c.scopeId + ':' + c.revision };
    }
    case 'artifact': {
      const v = bench.artifacts.version(session.id, ref.artifactId, ref.versionId);
      if (!['text', 'document', 'table'].includes(v.kind)) throw new Error('Choose a readable document or table');
      return { title: v.name, policy: v.policy };
    }
    case 'file': {
      const root = bench.roots.get(session.id, ref.rootId);
      readable(root, ref.path);
      return { title: root.name + '/' + ref.path, policy: root.policy.destinations };
    }
  }
}
export function validateSources(core: Core, session: Session, ids: string[]) {
  return ids.map((id) => info(core, session, decode(id)).policy);
}
export function savedEvidencePolicy(core: Core, owner: Session, evidence: Evidence[]) {
  const policies = evidence.filter(e => e.sourceId && e.status === 'read').map(e => {
    const source = info(core, owner, decode(e.sourceId!));
    if (e.collectionStamp && e.collectionStamp !== source.stamp)
      throw new Error('The selected collection changed. Refresh its evidence before using it again.');
    return strictest(e.policy || localOnly, source.policy);
  });
  return strictest(...policies);
}

/** Re-authorize saved excerpts at every outbound use, including follow-up questions and scheduled refresh. */
export async function authorizeEvidence(core: Core, session: Session, evidence: Evidence[], signal: AbortSignal) {
  if (!evidence.some(e => e.sourceId && e.status === 'read')) return publicPolicy;
  const route = await sessionRoute(session, core.settings, signal, core.chatConnections.endpoint(session));
  const policy = savedEvidencePolicy(core, session, evidence);
  if (!routeAllowed(route.route, policy)) throw new Error('A selected source does not allow this model’s processing destination');
  return policy;
}
export async function projectEvidence(
  core: Core,
  session: Session,
  run: ResearchRun,
  id: string,
  key: string,
  signal: AbortSignal,
): Promise<{ entry: Evidence; units: { location: string; text: string }[] }> {
  const ref = decode(key),
    { title, policy, stamp } = info(core, session, ref);
  const route = (await sessionRoute(session, core.settings, signal, core.chatConnections.endpoint(session))).route;
  if (!routeAllowed(route, policy)) throw new Error(title + ' does not allow this model’s processing destination');
  let units: { location: string; text: string }[],
    truncated = false;
  if (ref.kind === 'note') {
    const n = core.notebook.get(ref.id);
    units = [{ location: 'Note revision ' + n.revision, text: n.text }];
  } else if (ref.kind === 'collection') {
    const packet = await core.collections.context(
      session,
      run.question,
      3600,
      route === 'local' ? 'local' : 'cloud',
      signal,
      [ref.id],
    );
    if (!packet.text) throw new Error('No collection excerpts matched this question');
    const envelope = JSON.parse(packet.text.replace(/^<pal_document_data>\s*|\s*<\/pal_document_data>$/g, ''));
    units = envelope.items.map((item: { source: string; excerpt: string }) => ({
      location: title + ' · ' + item.source,
      text: item.excerpt,
    }));
  } else {
    let bytes: Buffer, mime: string;
    if (ref.kind === 'artifact') {
      const source = await core.workbench.artifacts.bytes(session.id, ref.artifactId, ref.versionId);
      bytes = source.data;
      mime = source.version.mime;
    } else {
      const root = core.workbench.roots.get(session.id, ref.rootId);
      if ((await core.workbench.roots.status(root)) !== 'available') throw new Error('The selected folder is unavailable');
      bytes = (await readText(root, ref.path, signal)).bytes;
      mime = mimeFor(ref.path, bytes);
    }
    if (mime === 'application/octet-stream' && !bytes.includes(0)) mime = 'text/plain';
    const parsed = await core.workbench.extractor.parseFile(bytes, title, mime, signal);
    units = parsed.units.map((u) => ({
      location: Object.entries(u.locator)
        .map(([k, v]) => k + ' ' + v)
        .join(', '),
      text: u.text,
    }));
    truncated = parsed.status === 'partial';
  }
  signal.throwIfAborted();
  const parts = passages(id, units, [run.question, ...run.criteria, ...run.focus].join(' '));
  if (!parts.length) throw new Error('No readable evidence matched this source');
  return {
    units,
    entry: {
      id,
      sourceId: key,
      collectionStamp: stamp,
      title,
      url: '',
      status: 'read',
      query: 'Selected project material',
      contentHash: hash(units.map((u) => u.text).join('\n')),
      passages: parts,
      excerpt: parts[0].text,
      policy,
      retrievedAt: new Date().toISOString(),
      truncated,
    },
  };
}

import { z } from 'zod';
import type { Workbench } from '../workbench.ts';
import { describeOperation } from '../media/tools.ts';
import { terminalStates } from '../operations/store.ts';
import { safeName } from './store.ts';

const imageRef = z.object({ artifactId: z.uuid(), versionId: z.uuid() });
const kitSchema = z.object({
  name: z.string().trim().min(1).max(80),
  style: z.string().trim().max(1200),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(12),
  typography: z.string().trim().max(200),
  guides: z.array(imageRef).max(8),
});
type Kit = z.infer<typeof kitSchema>;
const setSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kit: kitSchema,
  briefs: z.array(z.string().trim().min(1).max(1200)).min(1).max(16),
});
export class ImageSets {
  private active = new Set<string>();
  private workbench: Workbench;
  constructor(workbench: Workbench) {
    this.workbench = workbench;
  }
  get store() {
    return this.workbench.artifacts;
  }
  private guides(sessionId: string, kit: Kit) {
    return kit.guides.map((g) => {
      const v = this.store.version(sessionId, g.artifactId, g.versionId);
      if (v.kind !== 'image') throw new Error('Choose image versions for style references');
      return { ...g, relation: 'style-guide' };
    });
  }
  library(sessionId: string) {
    const list = (kind: string) => {
      const result: { artifactId: string; versionId: string; name: string }[] = [];
      let before: string | undefined;
      do {
        const page = this.store.list(sessionId, { project: true, provenanceKind: kind, before, limit: 200 });
        result.push(...page.artifacts.map((a) => ({ artifactId: a.id, versionId: a.latestVersionId, name: a.name })));
        before = page.before;
      } while (before);
      return result;
    };
    return { kits: list('style-kit'), sets: list('image-set') };
  }
  async save(sessionId: string, p: any, isSet: boolean) {
    const spec = isSet ? setSchema.parse(p) : kitSchema.parse(p);
    const guides = this.guides(sessionId, 'kit' in spec ? spec.kit : spec);
    if (!isSet && p.shared === true && guides.some((g) => !this.store.artifact(g.artifactId).shared)) {
      throw new Error(
        'Share the guide images with this project before sharing their style kit, or save the kit in this conversation.',
      );
    }
    const v = await this.store.install({
      sessionId,
      bytes: Buffer.from(JSON.stringify(spec, null, 2)),
      mime: 'application/json',
      name: safeName(spec.name),
      parents: guides,
      policy: this.store.inherit(sessionId, guides),
      source: 'derived',
      provenance: { kind: isSet ? 'image-set' : 'style-kit' },
    });
    if (p.shared === true && !isSet) this.store.update(sessionId, v.artifactId, { shared: true });
    return { artifactId: v.artifactId, versionId: v.versionId, name: spec.name };
  }
  async open(sessionId: string, r: unknown) {
    const { artifactId, versionId } = imageRef.parse(r);
    const { version, data } = await this.store.bytes(sessionId, artifactId, versionId);
    if (version.provenance.kind === 'style-kit') return { kit: kitSchema.parse(JSON.parse(data.toString())) };
    if (version.provenance.kind !== 'image-set') throw new Error('Choose an image set');
    const spec = setSchema.parse(JSON.parse(data.toString()));
    const members = this.states(sessionId, versionId, spec.briefs);
    return { spec, members };
  }
  private states(sessionId: string, setVersion: string, briefs: string[]) {
    const states = this.workbench.core.store.db
      .prepare('SELECT member,operation_id,approved FROM image_set_members WHERE session_id=? AND version_id=?')
      .all(sessionId, setVersion);
    const entries = new Map(states.map((r) => [Number(r.member), r]));
    return briefs.map((brief, index) => {
      const row = entries.get(index);
      let operation;
      if (row?.operation_id) {
        try {
          const op = this.workbench.operations.get(String(row.operation_id));
          if (op.sessionId === sessionId) operation = describeOperation(op);
        } catch {
          /* Original operation may have expired. Its approved asset stays usable. */
        }
      }
      const approved = row?.approved ? imageRef.parse(JSON.parse(String(row.approved))) : undefined;
      return {
        brief,
        index,
        operation,
        approved: approved && this.store.authorized(sessionId, approved.artifactId) ? approved : undefined,
      };
    });
  }
  async render(sessionId: string, p: any) {
    const indexes = z.array(z.int().min(0).max(15)).min(1).max(16).parse(p.indexes);
    const submitted: number[] = [];
    for (const index of new Set(indexes)) {
      try {
        await this.member(sessionId, { ...p, index }, 'render');
        submitted.push(index);
      } catch (e: any) {
        return { submitted, stoppedAt: index, reason: String(e.message) };
      }
    }
    return { submitted };
  }
  async member(sessionId: string, p: any, action: 'render' | 'approve' | 'preview') {
    const set = await this.open(sessionId, p);
    const index = z.int().min(0).parse(p.index);
    if (!set.spec || !set.members || index >= set.spec.briefs.length) throw new Error('Choose a set member');
    const key = sessionId + ':' + p.versionId + ':' + index;
    if (this.active.has(key)) throw new Error('This member is already being updated');
    this.active.add(key);
    try {
      const member = this.states(sessionId, p.versionId, set.spec.briefs)[index];
      const db = this.workbench.core.store.db;
      if (action === 'approve') {
        const chosen = imageRef.parse(p.chosen);
        if (
          !member.operation?.images?.some((r) => r.artifactId === chosen.artifactId && r.versionId === chosen.versionId)
        )
          throw new Error('Choose a result from this member');
        this.store.version(sessionId, chosen.artifactId, chosen.versionId);
        db.prepare('UPDATE image_set_members SET approved=? WHERE session_id=? AND version_id=? AND member=?').run(
          JSON.stringify(chosen),
          sessionId,
          p.versionId,
          index,
        );
        return chosen;
      }
      const kit = set.spec.kit;
      const guides = this.guides(sessionId, kit);
      const prompt = [
        member.brief,
        kit.style,
        kit.palette.length ? 'Palette: ' + kit.palette.join(', ') : '',
        kit.typography ? 'Typography: ' + kit.typography : '',
      ]
        .filter(Boolean)
        .join('\n');
      const request = {
        prompt,
        count: 1,
        format: 'png',
        operation: guides.length ? 'reference' : 'generate',
        references: guides.map((r) => ({ artifactId: r.artifactId, versionId: r.versionId, role: 'style' })),
      };
      if (action === 'preview')
        return this.workbench.dispatch('images.preview', { sessionId, connectionId: p.connectionId, request });
      if (member.operation && !terminalStates.includes(member.operation.state)) return member.operation;
      if ((member.operation || member.approved) && p.regenerate !== true)
        return member.operation || { state: 'approved' };
      return await this.workbench.startUserImage(
        { sessionId, connectionId: p.connectionId, request, acknowledgeBilling: p.acknowledgeBilling === true },
        false,
        (id) => {
          db.prepare(
            `INSERT INTO image_set_members(session_id,version_id,member,operation_id) VALUES(?,?,?,?)
          ON CONFLICT(session_id,version_id,member) DO UPDATE SET operation_id=excluded.operation_id`,
          ).run(sessionId, p.versionId, index, id);
        },
      );
    } finally {
      this.active.delete(key);
    }
  }
}

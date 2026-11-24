/**
 * Documents for other people: Markdown, text, tables, transcripts or a conversation as a Word, PDF, HTML or Markdown file
 * (PAL Everywhere §15.2). Each export is a new file that names its source and the adapter that wrote it. Word and HTML
 * are written by PAL itself; PDF is printed by pal-document, PAL's own helper, without network access. Nothing in a
 * document is run or fetched, and the file carries its title and date but no account or computer name.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workbench } from '../workbench.ts';
import { privateDir } from '../paths.ts';
import { safeName, type ArtifactVersion } from '../artifacts/store.ts';
import { localOnly, type DestinationPolicy } from '../tools/contracts.ts';
import { isolation, sandboxed } from '../execution/runner.ts';
import { clock, isTimedText, parseCues } from '../media/recordings.ts';
import { exportConversation } from '../conversation-export.ts';
import { parseCsv, previewTable } from '../table-preview.ts';
import { inlineText, markdownLimits, parseMarkdown, type Document, type Inline } from './markdown.ts';
import { renderHtml } from './html.ts';
import { renderDocx, type Page } from './docx.ts';
import { fillTemplate, templates } from './templates.ts';

export type DocumentFormat = 'docx' | 'pdf' | 'html' | 'md';
export const documentLimits = { wallMs: 60_000, outputBytes: 50 * 1024 * 1024, csvRows: 5000 };
const adapterVersion = '1';
const mimes: Record<DocumentFormat, string> = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', html: 'text/html', md: 'text/markdown' };
const adapters: Record<DocumentFormat, string> = { docx: 'pal-docx', pdf: 'pal-document', html: 'pal-html', md: 'pal-markdown' };

let located: string | null | undefined;
/** The PDF helper: an explicit override, the installed copy beside the broker, or the development build. */
export function documentHelper(): string | null {
  const configured = process.env.PAL_DOCUMENT_HELPER;
  if (configured !== undefined) return configured && existsSync(configured) ? configured : null;
  if (located !== undefined) return located;
  located = ['../../native/pal-document', '../../build/pal-document'].map(path => fileURLToPath(new URL(path, import.meta.url)))
    .find(path => { try { const info = statSync(path); return info.isFile() && (info.mode & 0o111) !== 0; } catch { return false; } }) || null;
  return located;
}
export function resetDocumentHelper() { located = undefined; }

/** Text that is not Markdown keeps its own lines. */
function plainDocument(text: string): Document {
  const lines = (part: string): Inline[] => part.split('\n').flatMap((line, index) => [...(index ? [{ type: 'break' as const }] : []), { type: 'text' as const, text: line }]);
  return { blocks: text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/).filter(part => part.trim()).map(part => ({ type: 'paragraph' as const, children: lines(part) })), notes: [] };
}
function tableDocument(text: string, name: string): Document {
  const table = previewTable(text, name), rows = parseCsv(text.replace(/^\uFEFF/, ''), table.delimiter).rows.slice(1);
  if (!table.columns.length) throw new Error('This table has no rows');
  if (table.columns.length > markdownLimits.columns) throw new Error(`A table with more than ${markdownLimits.columns} columns does not fit a page`);
  const cell = (value: unknown): Inline[] => [{ type: 'text', text: String(value ?? '') }];
  const more = rows.length > documentLimits.csvRows ? `The first ${documentLimits.csvRows} of ${rows.length} rows.` : '';
  return { blocks: [{ type: 'table', align: table.columns.map(column => column.type === 'number' || column.type === 'integer' ? 'right' : null), head: table.columns.map(column => cell(column.name)), rows: rows.slice(0, documentLimits.csvRows).map(row => table.columns.map((_column, index) => cell(row[index]))) },
    ...(more ? [{ type: 'paragraph' as const, children: [{ type: 'em' as const, children: cell(more) }] }] : [])], notes: [] };
}
function transcriptDocument(text: string): Document {
  return { blocks: parseCues(text).map(cue => ({ type: 'paragraph' as const, children: [{ type: 'code' as const, text: clock(cue.start) }, { type: 'text' as const, text: ' ' }, ...(cue.speaker ? [{ type: 'strong' as const, children: [{ type: 'text' as const, text: cue.speaker + ': ' }] }] : []), { type: 'text' as const, text: cue.text.replace(/\n/g, ' ') }] })), notes: [] };
}
type Source = { document: Document; markdown: string; name: string; policy: DestinationPolicy; parent?: { artifactId: string; versionId: string }; origin: Record<string, unknown> };
export type RenderRequest = { format: unknown; page?: unknown; title?: unknown; markdown?: unknown; artifactId?: unknown; versionId?: unknown; rootId?: unknown; path?: unknown; conversation?: unknown; messageIds?: unknown };

export class Documents {
  workbench: Workbench;
  constructor(workbench: Workbench) { this.workbench = workbench; }
  private get core() { return this.workbench.core; }
  /** What can be written here, and why not. */
  formats() {
    return [
      { id: 'pdf', label: 'PDF', available: !!documentHelper(), ...(documentHelper() ? {} : { reason: 'PAL’s PDF helper (pal-document) is not installed. Rebuild or reinstall PAL.' }) },
      { id: 'docx', label: 'Word', available: true }, { id: 'html', label: 'Web page', available: true }, { id: 'md', label: 'Markdown', available: true },
    ];
  }
  templates() { return templates.map(({ id, name, purpose }) => ({ id, name, purpose: purpose.replace('{{project}}', 'a project') })); }
  fill(sessionId: string, p: { template: unknown; title?: unknown }) {
    const session = this.core.store.session(sessionId), template = templates.find(item => item.id === p.template);
    const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 200) : template?.name || '';
    return { markdown: fillTemplate(String(p.template), { title, date: this.core.temporal.now(sessionId).localDate, project: session.cwd ? session.cwd.split('/').filter(Boolean).pop() || '' : '' }), title };
  }
  /** Keeps a written document as a file of this conversation. */
  async save(sessionId: string, p: { title: unknown; markdown: unknown; artifactId?: unknown; versionId?: unknown }) {
    if (typeof p.markdown !== 'string' || !p.markdown.trim() || p.markdown.length > markdownLimits.chars) throw new Error('Write the document first (up to 600,000 characters)');
    const base = p.artifactId ? this.workbench.artifacts.version(sessionId, p.artifactId, p.versionId) : undefined;
    const name = base?.name || safeName(p.title, 'Document') + '.md';
    return this.workbench.artifacts.install({ sessionId, bytes: Buffer.from(p.markdown), name, mime: 'text/markdown', source: base ? 'derived' : 'user-import', label: 'document',
      ...(base ? { artifactId: base.artifactId, policy: base.policy, parents: [{ artifactId: base.artifactId, versionId: base.versionId, relation: 'edit' }] } : {}), provenance: { kind: 'document', title: String(p.title || '').slice(0, 200) } });
  }
  private async source(sessionId: string, p: RenderRequest): Promise<Source> {
    const chosen = [p.markdown !== undefined, !!p.artifactId, !!p.rootId, p.conversation === true].filter(Boolean).length;
    if (chosen !== 1) throw new Error('Choose one thing to export: text, a file or the conversation');
    if (p.markdown !== undefined) {
      if (typeof p.markdown !== 'string' || !p.markdown.trim()) throw new Error('There is nothing to export');
      return { document: parseMarkdown(p.markdown), markdown: p.markdown, name: 'Document', policy: localOnly, origin: { kind: 'text' } };
    }
    if (p.conversation === true) {
      const exported = exportConversation(this.core.store, sessionId, this.core.settings.assistantName, { format: 'markdown', ...(p.messageIds !== undefined ? { messageIds: p.messageIds } : {}) });
      return { document: parseMarkdown(exported.text), markdown: exported.text, name: exported.filename.replace(/\.md$/, ''), policy: localOnly, origin: { kind: 'conversation', messages: exported.messages } };
    }
    let name: string, text: string, policy: DestinationPolicy = localOnly, parent: Source['parent'], origin: Record<string, unknown>, mime = '';
    if (p.artifactId) {
      const { version, data } = await this.workbench.artifacts.bytes(sessionId, p.artifactId, p.versionId);
      if (!/^text\/|json|subrip/.test(version.mime)) throw new Error(`${version.name} is not a text document`);
      name = version.name; text = data.toString('utf8'); policy = version.policy; mime = version.mime; parent = { artifactId: version.artifactId, versionId: version.versionId }; origin = { kind: 'artifact', ...parent };
    } else {
      const file: any = await this.workbench.dispatch('files.text', { sessionId, rootId: p.rootId, path: p.path });
      const root = this.workbench.roots.get(sessionId, String(p.rootId));
      name = String(p.path).split('/').pop() || 'Document'; text = file.text; policy = root.policy.destinations; origin = { kind: 'file', rootId: root.id, path: String(p.path), version: file.version };
    }
    if (text.length > markdownLimits.chars && !/\.(csv|tsv)$/i.test(name)) throw new Error('This document is longer than PAL exports (600,000 characters)');
    const document = /\.(md|markdown)$/i.test(name) || mime === 'text/markdown' ? parseMarkdown(text)
      : /\.(csv|tsv)$/i.test(name) || /csv|tab-separated/.test(mime) ? tableDocument(text, name)
      : isTimedText(mime, name) || /\.(vtt|srt)$/i.test(name) ? transcriptDocument(text)
      : /\.html?$/i.test(name) || mime === 'text/html' ? (() => { throw new Error('Export the page from Canvas; a web page is not converted'); })()
      : plainDocument(text);
    return { document, markdown: text, name: name.replace(/\.[^.]+$/, ''), policy, ...(parent ? { parent } : {}), origin };
  }
  async render(sessionId: string, p: RenderRequest, signal = AbortSignal.timeout(documentLimits.wallMs + 10_000)): Promise<ArtifactVersion> {
    if (this.core.store.session(sessionId).temporary) throw new Error('Temporary conversations do not keep files');
    const format = p.format as DocumentFormat, page: Page = p.page === 'Letter' ? 'Letter' : 'A4';
    if (!(format in mimes)) throw new Error('Choose PDF, Word, a web page or Markdown');
    return this.write(sessionId, await this.source(sessionId, p), format, page, p.title, signal);
  }
  /** A finished report of another part of PAL, with that report's own policy and lineage. */
  report(sessionId: string, p: { markdown: string; name: string; title: string; format: 'pdf' | 'docx'; policy: DestinationPolicy; parent: { artifactId: string; versionId: string } }) {
    return this.write(sessionId, { document: parseMarkdown(p.markdown), markdown: p.markdown, name: p.name, policy: p.policy, parent: p.parent, origin: { kind: 'artifact', ...p.parent } }, p.format, 'A4', p.title, AbortSignal.timeout(documentLimits.wallMs + 10_000));
  }
  private async write(sessionId: string, source: Source, format: DocumentFormat, page: Page, given: unknown, signal: AbortSignal): Promise<ArtifactVersion> {
    if (!source.document.blocks.length) throw new Error('There is nothing to export');
    const heading = source.document.blocks.find(block => block.type === 'heading');
    const title = (typeof given === 'string' && given.trim() ? given : heading && heading.type === 'heading' ? inlineText(heading.children) : source.name).replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 200) || 'Document';
    const bytes = format === 'docx' ? await renderDocx(source.document, { title, page, created: Date.now() })
      : format === 'html' ? Buffer.from(renderHtml(source.document, { title }))
      : format === 'md' ? Buffer.from(source.markdown) : await this.pdf(renderHtml(source.document, { title, printed: true }), title, page, signal);
    signal.throwIfAborted();
    return this.workbench.artifacts.install({ sessionId, bytes, name: `${safeName(title, 'Document')}.${format}`, mime: mimes[format], source: 'derived', label: 'document', policy: source.policy,
      ...(source.parent ? { parents: [{ ...source.parent, relation: 'document-export' }] } : {}),
      provenance: { kind: 'document-export', format, adapter: adapters[format], adapterVersion, page, source: source.origin, title } });
  }
  private async pdf(html: string, title: string, page: Page, signal: AbortSignal): Promise<Buffer> {
    const helper = documentHelper();
    if (!helper) throw Object.assign(new Error('PAL’s PDF helper (pal-document) is not installed. Rebuild or reinstall PAL, or export as Word.'), { code: 'unavailable' });
    const scratch = await mkdtemp(join(privateDir(join(this.core.store.directory, 'documents')), 'pdf-'));
    try {
      const input = join(scratch, 'input.html');
      await writeFile(input, html, { mode: 0o600 });
      if ((await isolation()).available) {
        const result = await sandboxed({ argv: ['/work/pal-document', '/work/input.html', '/work/output/document.pdf', page, title], binds: [{ source: helper, target: '/work/pal-document' }, { source: input, target: '/work/input.html' }], cwd: '/work', env: { QT_QPA_PLATFORM: 'offscreen' },
          limits: { wallMs: documentLimits.wallMs, outputBytes: documentLimits.outputBytes, files: 1 }, signal });
        signal.throwIfAborted();
        const bytes = result.outputs[0]?.bytes;
        if (result.exitCode !== 0 || !bytes?.length) throw new Error(result.timedOut ? 'Printing the PDF took too long' : result.outputProblem || result.stderr.trim().split('\n').slice(-1)[0] || 'The PDF could not be written');
        return this.checked(bytes);
      }
      const output = join(scratch, 'document.pdf');
      await new Promise<void>((resolve, reject) => execFile(helper, [input, output, page, title], { timeout: documentLimits.wallMs, signal, env: { PATH: '/usr/bin', LANG: 'C.UTF-8', HOME: scratch, QT_QPA_PLATFORM: 'offscreen' } }, (error, _out, stderr) => error ? reject(new Error(String(stderr).trim().split('\n').slice(-1)[0] || 'The PDF could not be written')) : resolve()));
      return this.checked(await readFile(output));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  private checked(bytes: Buffer) {
    if (bytes.length > documentLimits.outputBytes) throw new Error('The PDF is larger than 50 MiB');
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The PDF could not be written');
    return bytes;
  }
}

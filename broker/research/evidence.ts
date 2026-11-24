import { createHash } from 'node:crypto';
import { routeFields, type ResearchBinding } from './routes.ts';
import { z } from 'zod';
import type { DestinationPolicy } from '../tools/contracts.ts';
import type { Recency } from '../web-plan.ts';

export const modes = ['answer', 'compare', 'check', 'literature'] as const;
export const presets = { quick: { minutes: 5, sources: 12, calls: 3 }, thorough: { minutes: 20, sources: 40, calls: 10 } };
export const listText = z.array(z.string().trim().min(1).max(500)).max(12);
export const startSchema = z.object({
  ...routeFields,
  sessionId: z.string().min(1),
  question: z.string().trim().min(5).max(2000),
  preset: z.enum(['quick', 'thorough']).default('quick'),
  scope: z.enum(['web', 'project', 'both']).default('web'),
  mode: z.enum(modes).default('answer'),
  sourceIds: z.array(z.string().min(1).max(8192)).max(12).default([]),
  urls: z.array(z.string().max(2048)).max(12).default([]),
  plan: listText.default([]),
  criteria: listText.default([]),
  sites: z.array(z.string()).max(5).default([]),
  siteMode: z.enum(['only', 'prefer']).default('only'),
  output: z.enum(['brief', 'timeline', 'matrix']).optional(),
  recency: z.enum(['day', 'week', 'month', 'year']).optional(),
  parallel: z.boolean().default(false),
  minutes: z.number().int().min(1).max(60).optional(),
  sources: z.number().int().min(1).max(60).optional(),
  calls: z.number().int().min(2).max(20).optional(),
  requestId: z.string().min(1).max(128).optional(),
});
export type Passage = { id: string; text: string; location: string };
export type Evidence = {
  id: string;
  title: string;
  url: string;
  resolvedUrl?: string;
  query: string;
  status: 'read' | 'excluded' | 'failed' | 'duplicate';
  retrievedAt?: string;
  publishedAt?: string;
  doi?: string;
  authors?: string;
  contentHash?: string;
  excerpt?: string;
  snippet?: string;
  error?: string;
  passages?: Passage[];
  sourceId?: string;
  collectionStamp?: string;
  policy?: DestinationPolicy;
  duplicateOf?: string;
  reason?: string;
  retraction?: string;
  truncated?: boolean;
};
export type Finding = { text: string; citations: string[]; status: string; quote?: string };
export type Candidate = {
  url: string;
  title: string;
  query: string;
  snippet?: string;
  doi?: string;
  authors?: string;
  publishedAt?: string;
  retraction?: string;
  references?: string[];
};
export type Table = { columns: string[]; rows: string[][] };
export type ResearchRun = {
  id: string;
  sessionId: string;
  binding?: ResearchBinding;
  provider?: ResearchBinding['provider'];
  model?: string;
  requestId?: string;
  title: string;
  question: string;
  preset: 'quick' | 'thorough';
  limits: typeof presets.quick;
  state: 'planning' | 'searching' | 'reading' | 'synthesizing' | 'completed' | 'partial' | 'stopped' | 'paused' | 'failed' | 'cancelled' | 'interrupted';
  scope: 'web' | 'project' | 'both';
  mode: (typeof modes)[number];
  criteria: string[];
  sourceIds: string[];
  urls: string[];
  sites: string[];
  siteMode: 'only' | 'prefer';
  output?: 'brief' | 'timeline' | 'matrix';
  recency?: Recency;
  plan: string[];
  parallel: boolean;
  queries: string[];
  evidence: Evidence[];
  pending: Candidate[];
  pendingQueries: string[];
  round: number;
  planned: boolean;
  searchedCrossref?: boolean;
  callsUsed: number;
  pageReads: number;
  processed: string[];
  report?: { artifactId: string; versionId: string; name: string };
  reportText?: string;
  synthesis?: {branches?: Record<string, string>; body?: string; truncated?: boolean};
  resumeAt?: 'collect' | 'rewrite';
  summary?: string;
  error?: string;
  removedCitations?: string[];
  note?: string;
  findings: Finding[];
  table: Table;
  changes: string[];
  revisions: { versionId: string; time: number; summary: string }[];
  progress: string;
  activity: { time: number; text: string }[];
  focus: string[];
  stale: boolean;
  partial: boolean;
  created: number;
  updated: number;
  checkpoints: number;
  monitorDays: number;
  nextRefresh: number;
  monitorRoute?: string;
  pinned: boolean;
  archived: boolean;
};
export const publicPolicy = { remote: true, cloud: true };
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const busyStates = ['planning', 'searching', 'reading', 'synthesizing'];
export const instructions = {
  answer: 'Answer the question. Explain the strongest evidence, disagreements, and open questions.',
  compare:
    'Compare the alternatives against the requested criteria. Supply a Markdown table. Cite each substantive cell or write Unknown.',
  check:
    'Trace the claim to its original source, look for counterevidence, and give a scoped verdict including exceptions and dates.',
  literature:
    'Screen the studies against the criteria. Report design, sample, outcome, limitations and disagreements in a cited Markdown table. Distinguish abstracts from full text. Identify excluded studies and reasons. Describe search coverage.',
};
const words = (s: string) =>
  new Set(
    (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || []).filter(
      (t) =>
        ![
          'the',
          'and',
          'for',
          'from',
          'this',
          'with',
          'what',
          'which',
          'that',
          'does',
          'are',
          'how',
          'can',
          'source',
          'about',
          'should',
          'have',
          'into',
          'was',
          'were',
        ].includes(t),
    ),
  );
/** Rank bounded, exact substrings from the entire extracted document. Offsets refer to normalized text. */
export function passages(id: string, units: { location: string; text: string }[], question: string, limit = 4): Passage[] {
  const terms = words(question),
    candidates: { text: string; location: string; score: number; order: number }[] = [];
  for (const unit of units) {
    const content = unit.text;
    for (let i = 0; i < content.length; ) {
      let end = Math.min(i + 950, content.length);
      if (end < content.length) {
        const boundary = content.lastIndexOf(' ', end);
        if (boundary > i + 650) end = boundary;
      }
      const text = content.slice(i, end).trim();
      if (text) {
        const tokens = words(text),
          matches = [...terms].filter((t) => tokens.has(t));
        candidates.push({
          text,
          location: unit.location + ' · characters ' + (i + 1) + '–' + end,
          score: matches.length,
          order: candidates.length,
        });
      }
      if (end === content.length) break;
      i = end - 80;
    }
  }
  const ranked = candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const selected: typeof ranked = [],
    seen = new Set<string>();
  for (const part of ranked) {
    if (seen.has(part.text)) continue;
    seen.add(part.text);
    selected.push(part);
    if (selected.length === limit) break;
  }
  return selected
    .sort((a, b) => a.order - b.order)
    .map((p, i) => ({ id: id + '.P' + (i + 1), text: p.text, location: p.location }));
}
export function material(evidence: Evidence[], question: string, budget = 62000, supplied?: Set<string>) {
  const terms = words(question),
    blocks: string[] = [];
  const score = (p: Passage) => [...words(p.text)].filter((t) => terms.has(t)).length;
  const ranked = evidence
    .filter((e) => e.status === 'read')
    .map((e) => ({ source: e, parts: [...(e.passages || [])].sort((a, b) => score(b) - score(a)) }))
    .filter((row) => row.parts.length);
  // Small models still see an excerpt from each source. Use the most relevant window when a passage must be shortened.
  const share = Math.floor(budget / Math.max(1, ranked.length));
  for (let i = 0; i < 4; i++)
    for (const { source, parts } of ranked) {
      const p = parts[i];
      if (!p) continue;
      const attribution = [
        source.title.slice(0, 96),
        p.location.slice(0, 96),
        source.authors?.slice(0, 80),
        source.publishedAt,
        source.doi && 'DOI ' + source.doi.slice(0, 100),
        source.retraction?.slice(0, 100),
      ].filter(Boolean);
      const header = '[' + p.id + '] ' + attribution.join(' · ') + '\n';
      const room = Math.min(p.text.length, (i === 0 ? Math.min(share, budget) : budget) - header.length - 2);
      if (room < Math.min(32, p.text.length)) continue;
      let start = 0;
      if (room < p.text.length) {
        const windows = Array.from({ length: Math.ceil(p.text.length / room) }, (_, n) =>
          Math.min(n * room, p.text.length - room),
        );
        start = windows.sort(
          (a, b) => score({ ...p, text: p.text.slice(b, b + room) }) - score({ ...p, text: p.text.slice(a, a + room) }),
        )[0];
      }
      const block = header + p.text.slice(start, start + room);
      supplied?.add(p.id);
      blocks.push(block);
      budget -= block.length + 2;
    }
  return blocks.join('\n\n');
}

/** Prefer explicit URLs, then spread reads among the requested subquestions and independently published sources. */
export function nextCandidate(run: ResearchRun) {
  const domains = new Map<string, number>(),
    queries = new Map<string, number>();
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  for (const e of run.evidence) {
    if (!e.url || e.status !== 'read') continue;
    domains.set(host(e.url), (domains.get(host(e.url)) || 0) + 1);
    queries.set(e.query, (queries.get(e.query) || 0) + 1);
  }
  const terms = words(run.question + ' ' + run.focus.join(' '));
  const rank = (c: Candidate) => {
    const overlap = [...words(c.title + ' ' + (c.snippet || ''))].filter((w) => terms.has(w)).length;
    return (
      (run.urls.includes(c.url) ? 1000 : 0) +
      (run.sites.some((s) => host(c.url) === s || host(c.url).endsWith('.' + s)) ? 6 : 0) -
      (queries.get(c.query) || 0) * 4 -
      (domains.get(host(c.url)) || 0) * 2 +
      Math.min(4, overlap)
    );
  };
  return run.pending.reduce((best, c) => (rank(c) > rank(best) ? c : best));
}

/** Evidence coverage is directly inspectable. A lexical match is a lead, never a claim of support. */
export function coverage(plan: string[], evidence: Evidence[], findings: Finding[]) {
  return plan.map((question) => {
    const terms = words(question),
      parts = evidence.filter((e) => e.status === 'read').flatMap((e) => e.passages || []);
    const matches = parts
      .map((p) => ({ p, score: [...words(p.text)].filter((w) => terms.has(w)).length }))
      .filter((row) => row.score >= Math.min(2, Math.max(1, terms.size)))
      .sort((a, b) => b.score - a.score);
    const refs = matches.slice(0, 2).map((row) => row.p.id);
    const cited = refs.some((ref) => findings.some((f) => f.citations.includes(ref)));
    return {
      question,
      citations: refs,
      status: cited ? 'Matching passage cited' : refs.length ? 'Matching passage found' : 'No matching passage',
    };
  });
}
export function citations(text: string) {
  return [...new Set([...text.matchAll(/\[(E\d+(?:\.P\d+)?)\]/g)].map((m) => m[1]))];
}
/** Restore the verbatim bytes of a quotation when a report has reflowed line breaks from a source. */
export function quotedSpan(quote: string | undefined, refs: string[], spans: Map<string, Passage>) {
  if (!quote || quote.trim().length < 8 || quote.length > 1200) return;
  const words = quote
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(words.join('\\s+'));
  for (const ref of refs) {
    const match = spans.get(ref)?.text.match(pattern);
    if (match) return match[0];
  }
}
/** Bundle the cited passages so a saved Markdown file stays inspectable outside the reader. */
export function portableMarkdown(report: string, evidence: Evidence[]) {
  const cited = new Set(citations(report));
  const appendix = evidence
    .filter((e) => e.status === 'read')
    .flatMap((e) => (e.passages || []).filter((p) => cited.has(p.id)).map((p) => ({ source: e, passage: p })));
  if (!appendix.length) return report;
  const anchor = (id: string) => 'passage-' + id.toLowerCase().replace('.', '-');
  const links = new Set(appendix.map(({ passage }) => passage.id));
  const linked = report.replace(/\[(E\d+\.P\d+)\]/g, (label, id) =>
    links.has(id) ? label + '(#' + anchor(id) + ')' : label,
  );
  return (
    linked.trimEnd() +
    '\n\n## Cited passages\n\n' +
    appendix
      .map(
        ({ source, passage }) =>
          '<a id="' +
          anchor(passage.id) +
          '"></a>\n\n### ' +
          passage.id +
          ' · ' +
          source.title +
          '\n\n' +
          passage.location +
          '\n\n' +
          passage.text
            .split('\n')
            .map((line) => '> ' + line)
            .join('\n'),
      )
      .join('\n\n') +
    '\n'
  );
}
export function checkReport(body: string, evidence: Evidence[], supplied: Set<string>) {
  const ids = new Set<string>(),
    spans = new Map<string, Passage>();
  for (const source of evidence.filter((e) => e.status === 'read')) {
    for (const p of source.passages || [])
      if (supplied.has(p.id)) {
        ids.add(source.id);
        ids.add(p.id);
        spans.set(p.id, p);
      }
  }
  const removed: string[] = [];
  const remove = (id: string) => {
    removed.push(id);
    return '[citation removed: not a source PAL read]';
  };
  const ranges = body.replace(/\[(E\d+)\.P(\d+)\s*[-–—]\s*(?:(E\d+)\.)?P(\d+)\]/g, (label, source, first, other, last) => {
    const start = Number(first),
      end = Number(last);
    if ((other && other !== source) || start < 1 || end < start || end > 24) return remove(label.slice(1, -1));
    return Array.from({ length: end - start + 1 }, (_, i) => '[' + source + '.P' + (start + i) + ']').join('');
  });
  const normalized = ranges.replace(
    /\[(E\d+(?:\.P\d+)?(?:\s*(?:,|;|&|\band\b)\s*E\d+(?:\.P\d+)?)+)\]/g,
    (_, group: string) => (group.match(/E\d+(?:\.P\d+)?/g) || []).map((id) => '[' + id + ']').join(''),
  );
  const text = normalized.replace(/\[(E\d+(?:\.P\d+)?)\]/g, (raw, id) => {
    if (ids.has(id)) return raw;
    return remove(id);
  });
  const findings: Finding[] = [];
  const lines: string[] = [];
  for (const line of text.split(/\n+/)) {
    const attribution = line.trim().replace(/^>\s*/, '');
    if (
      lines.length &&
      citations(attribution).length &&
      (/^[—–]\s/.test(attribution) || /^(?:\[E\d+(?:\.P\d+)?\]\s*)+[.!]?$/.test(attribution))
    )
      lines[lines.length - 1] += ' ' + attribution;
    else lines.push(line);
  }
  for (const line of lines) {
    const value = line
      .replace(/^\s*>\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .trim();
    if (
      !value ||
      value.startsWith('#') ||
      /^\|?[\s:|\-]+\|?$/.test(value) ||
      value.endsWith('?') ||
      /^(?:\*\*|__)[^.!?]{1,80}:(?:\*\*|__)$/.test(value)
    )
      continue;
    // Keep a qualifying clause with its sentence, and table cells with their individual citations.
    const parts = value.includes('|')
      ? value.split('|').filter((v) => citations(v).length)
      : value.split(/(?<=[.!?])\s+(?=[\p{Lu}\d])/u);
    for (const part of parts) {
      const refs = citations(part),
        quote = part.match(/[“"]([^“”"\n]{8,})[”"]/u)?.[1];
      const exact = quotedSpan(quote, refs, spans);
      findings.push({
        text: part.trim(),
        citations: refs,
        status: exact ? 'Quoted passage' : refs.length ? 'Cited · review support' : 'Needs evidence',
        ...(exact ? { quote: exact } : {}),
      });
    }
  }
  return { text, findings: findings.slice(0, 200), removed: [...new Set(removed)] };
}
export function readTable(text: string): Table {
  const lines = text.split('\n'),
    at = lines.findIndex((line, i) => line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || ''));
  if (at < 0) return { columns: [], rows: [] };
  const cells = (s: string) =>
    s
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((v) => v.trim().replaceAll('\\|', '|'));
  const columns = cells(lines[at]),
    rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.includes('|')) break;
    const row = cells(line);
    if (row.length === columns.length) rows.push(row);
  }
  return { columns, rows };
}
export function sourceTable(sources: Evidence[]): Table {
  return {
    columns: ['Source', 'Status', 'Location', 'Excerpt'],
    rows: sources.flatMap((e) =>
      (e.passages?.length ? e.passages : [{ id: e.id, location: e.url, text: e.error || '' }]).map((p) => [
        e.title,
        e.status,
        p.location,
        p.text + ' [' + p.id + ']',
      ]),
    ),
  };
}
export function asCsv(t: Table) {
  const cell = (s: string) => '"' + (/^[\s]*[=+@-]/.test(s) ? "'" : '') + s.replaceAll('"', '""') + '"';
  return [t.columns, ...t.rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

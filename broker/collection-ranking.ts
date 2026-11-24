/**
 * Choosing which excerpts of a document collection a turn receives (PAL Everywhere §11.2). Memory finds candidates by
 * words and, when an embedding model is available, by meaning; this decides what goes into the limited space:
 *
 * - the same passage is given once, with the other places it appears;
 * - one long document does not push out the others;
 * - passages that say nearly the same thing with different numbers or a negation are kept together and marked, so a
 *   contradiction or an older version stays visible instead of being silently resolved;
 * - an excerpt from a file that changed since it was indexed says so.
 *
 * Everything here is arithmetic on text the collection already holds: no model is asked and nothing leaves the computer.
 */
/** How memory matched it: by its words, by meaning, by both, or through a link between records. */
export type Matched = 'words' | 'meaning' | 'both' | 'link';
export type Candidate = { key: string; source: string; file: string; collection: string; collectionId: string; location: string; text: string; why: Matched; stale: boolean };
/** `weak` is a match by one ordinary word when nothing better was found: it may not answer the question, and says so. */
export type Excerpt = Candidate & { also: string[]; conflict?: string; weak?: boolean };
export const rankingLimits = { candidates: 24, perFile: 2, weak: 2, duplicate: 0.9, same: 0.85, coverage: 0.34, shingle: 3, reserveTokens: 40 };

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.6);
const stop = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its many may me much must my of on or our s should so t than that the their them then there these they this to us was we were what when where which who why will with would you your'.split(' '));
export const words = (text: string) => text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu) || [];
export const contentWords = (text: string) => words(text).filter(word => !stop.has(word));
/** A word's stem, enough that "attempts" finds "attempt" and "happens" finds "happen". */
const stem = (word: string) => word.length > 4 ? word.replace(/(?:ies|es|s|ed|ing)$/, '').replace(/(.)\1$/, '$1') || word : word;
/** Every stem in a text, with the parts of names such as run_with_retry or on-call beside the whole. */
function stems(text: string) {
  const out = new Set<string>();
  for (const word of words(text)) { out.add(stem(word)); for (const part of word.split(/[._-]/)) if (part) out.add(stem(part)); }
  return out;
}
/** What a question asks for: each content word, satisfied by itself or by all of its parts. */
function askedFor(query: string) {
  return [...new Set(contentWords(query))].filter(word => word.length > 1 || /\p{N}/u.test(word)).map(word => {
    const parts = word.split(/[._-]/).filter(part => part && !stop.has(part)).map(stem);
    return { whole: stem(word), parts, specific: /\p{N}/u.test(word) || parts.length > 1 };
  });
}
function coverage(asked: ReturnType<typeof askedFor>, found: Set<string>) {
  const hits = asked.filter(term => found.has(term.whole) || term.parts.length > 0 && term.parts.every(part => found.has(part)));
  return { share: asked.length ? hits.length / asked.length : 0, specific: hits.some(term => term.specific) };
}
function shingles(text: string) {
  const list = words(text), out = new Set<string>();
  for (let i = 0; i + rankingLimits.shingle <= list.length; i++) out.add(list.slice(i, i + rankingLimits.shingle).join(' '));
  if (!out.size && list.length) out.add(list.join(' '));
  return out;
}
export function overlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const item of small) if (large.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}
const numbers = (text: string) => (text.match(/\d+(?:[.,:]\d+)*\s*%?/g) || []).map(value => value.replace(/\s+/g, '')).sort().join(' ');
const negations = (text: string) => (text.toLowerCase().match(/\b(?:no|not|never|none|cannot|can't|won't|don't|doesn't|isn't|aren't|without|disabled|deprecated|removed)\b/g) || []).sort().join(' ');
const negation = new Set(['no', 'not', 'never', 'none', 'cannot', 'without', 'disabled', 'deprecated', 'removed']);
const normal = (text: string) => words(text).join(' ');
/** Why two similar passages differ in what they state, or '' when they state the same. */
export function disagreement(left: string, right: string): string {
  if (numbers(left) !== numbers(right)) return 'different numbers';
  if (negations(left) !== negations(right)) return 'one negates the other';
  return '';
}
/** What a sentence is about: its content words without the numbers and negations that may be what differs. */
const about = (sentence: string) => new Set(contentWords(sentence).filter(word => !/^\d/.test(word) && !negation.has(word)));
const sentences = (text: string) => text.split(/(?<=[.!?;])\s+|\n+/).map(part => part.trim()).filter(part => part.length > 12 && part.length < 400);
/**
 * Where two passages answer the question differently: a sentence of each about the same thing, with other numbers or a
 * negation. Only sentences that concern what was asked count, so unrelated figures in long passages do not.
 */
export function contradiction(left: string, right: string, query: string): string {
  const asked = new Set(contentWords(query)), concerns = (words: Set<string>) => { let hits = 0; for (const word of words) if (asked.has(word)) hits++; return hits >= Math.min(2, asked.size) && hits > 0; };
  const prepared = (text: string) => sentences(text).map(sentence => ({ sentence, words: about(sentence) })).filter(entry => entry.words.size >= 3 && concerns(entry.words)).slice(0, 40);
  const others = prepared(right);
  for (const one of prepared(left)) for (const other of others) {
    let shared = 0; for (const word of one.words) if (other.words.has(word)) shared++;
    if (shared >= 3 && shared / Math.min(one.words.size, other.words.size) >= rankingLimits.same) { const found = disagreement(one.sentence, other.sentence); if (found) return found; }
  }
  return '';
}

/**
 * The excerpts that fit `budget` tokens, in order of use. `candidates` come best first; `query` adds weight to passages
 * that cover more of what was asked, and to files and headings it names.
 */
export function selectExcerpts(candidates: Candidate[], query: string, budget: number, options: { perFile?: number; max?: number } = {}): { excerpts: Excerpt[]; duplicates: number; dropped: number } {
  const perFile = options.perFile ?? rankingLimits.perFile, max = options.max ?? 8, asked = askedFor(query);
  const scored = candidates.slice(0, rankingLimits.candidates).map((candidate, index) => {
    const inText = coverage(asked, stems(candidate.text)), inName = coverage(asked, stems(`${candidate.source} ${candidate.location}`.replace(/[./\\_-]/g, ' ')));
    const covered = inText.share, named = inName.share, specific = inText.specific || inName.specific;
    // Retrieval order leads; coverage and names decide between neighbours.
    return { candidate, covered, named, specific, shingles: shingles(candidate.text), normal: normal(candidate.text), score: 1 / (4 + index) + 0.12 * covered + 0.08 * named };
  }).sort((a, b) => b.score - a.score);
  // One ordinary word in common is seldom an answer: a match by words alone has to share more than a third of what was
  // asked. When nothing does, the best of the rest are given as weak matches instead of hiding evidence.
  const strong = scored.filter(entry => entry.candidate.why !== 'words' || asked.length < 3 || entry.specific || entry.covered + entry.named >= rankingLimits.coverage);
  const entries = strong.length ? strong : scored.slice(0, rankingLimits.weak), weak = !strong.length;
  // The same passage in several places is one excerpt that names them all.
  const unique: ((typeof entries)[number] & { also: string[] })[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    const same = unique.find(kept => kept.normal === entry.normal || (entry.normal.length > 40 && (kept.normal.includes(entry.normal) || entry.normal.includes(kept.normal))) ||
      (overlap(kept.shingles, entry.shingles) >= rankingLimits.duplicate && !disagreement(kept.candidate.text, entry.candidate.text)));
    if (!same) { unique.push({ ...entry, also: [] }); continue; }
    duplicates++;
    const place = entry.candidate.source + (entry.candidate.location ? `, ${entry.candidate.location}` : '');
    if (entry.candidate.file !== same.candidate.file && !same.also.includes(place)) same.also.push(place);
  }
  // First what each document has best, then more from the same documents while space is left.
  const taken = new Map<string, number>(), first: typeof unique = [], later: typeof unique = [];
  for (const entry of unique) { const used = taken.get(entry.candidate.file) || 0; if (used < perFile) { taken.set(entry.candidate.file, used + 1); first.push(entry); } else later.push(entry); }
  const chosen: typeof unique = [];
  let spent = 0, dropped = 0;
  for (const entry of [...first, ...later]) {
    const cost = estimateTokens(entry.candidate.text) + rankingLimits.reserveTokens;
    if (chosen.length >= max || spent + cost > budget) { dropped++; continue; }
    chosen.push(entry); spent += cost;
  }
  const excerpts: Excerpt[] = chosen.map(entry => {
    // A related passage that states something else is worth a word, whichever of the two is right.
    let conflict = '';
    for (const rival of chosen) {
      if (conflict || rival === entry || rival.candidate.file === entry.candidate.file) continue;
      const reason = contradiction(entry.candidate.text, rival.candidate.text, query);
      if (reason) conflict = `${rival.candidate.source} (${reason})`;
    }
    return { ...entry.candidate, also: entry.also, ...(conflict ? { conflict } : {}), ...(weak ? { weak: true } : {}) };
  });
  return { excerpts, duplicates, dropped };
}

/** Splits the locator PAL writes at the start of a chunk from the chunk's own text. */
export function locate(text: string): { location: string; text: string } {
  const match = /^§ ([^\n]{1,260})\n([\s\S]*)$/.exec(text);
  if (match) return { location: match[1].trim(), text: match[2] };
  // A document's page, sheet or section is the heading its extracted text starts with.
  const place = /^# ((?:page|sheet|rows?|lines?|paragraphs?|table|section|member|slide|cells?)\b[^\n]{0,200})\n([\s\S]+)$/i.exec(text);
  return place ? { location: place[1].trim(), text: place[2].trim() } : { location: '', text };
}

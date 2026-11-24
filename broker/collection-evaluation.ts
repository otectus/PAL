/**
 * Measuring collection retrieval on questions whose answers are known (PAL Everywhere §11.2): whether the right files
 * were given, whether each excerpt points at the right place, whether a contradiction stayed visible, and whether a
 * question the documents do not answer got nothing, or only what is marked as a weak match. It scores what retrieval returned; it asks no model.
 */
export type EvaluationQuery = { q: string; sources: string[]; location?: string; conflict?: boolean; needs?: string };
export type Returned = { source: string; location: string; conflict?: string; also?: string[]; weak?: boolean };
export type Score = { questions: number; answerable: number; recall: number; precision: number; meanReciprocalRank: number; location: number; conflicts: number; refusal: number; missed: string[] };
/** 'a|b' names either of two files: the same text kept twice. */
const matches = (expected: string, row: Returned) => expected.split('|').some(name => row.source === name || (row.also || []).some(place => place === name || place.startsWith(name + ',')));

export function scoreRetrieval(queries: EvaluationQuery[], answers: Returned[][]): Score {
  let found = 0, wanted = 0, relevant = 0, returned = 0, reciprocal = 0, located = 0, locations = 0, conflicts = 0, marked = 0, refused = 0, unanswerable = 0, answerable = 0;
  const missed: string[] = [];
  queries.forEach((query, index) => {
    const rows = answers[index] || [];
    if (!query.sources.length) { unanswerable++; if (rows.every(row => row.weak)) refused++; else missed.push(`answered anyway: ${query.q}`); return; }
    answerable++;
    for (const expected of query.sources) { wanted++; if (rows.some(row => matches(expected, row))) found++; else missed.push(`${query.q} → ${expected}`); }
    returned += rows.length; relevant += rows.filter(row => query.sources.some(expected => matches(expected, row))).length;
    const first = rows.findIndex(row => query.sources.some(expected => matches(expected, row))); if (first >= 0) reciprocal += 1 / (first + 1);
    if (query.location) { locations++; if (rows.some(row => query.sources.some(expected => matches(expected, row)) && row.location.includes(query.location!))) located++; else missed.push(`${query.q} → location ${query.location}`); }
    if (query.conflict) { conflicts++; if (query.sources.every(expected => rows.some(row => matches(expected, row) && row.conflict))) marked++; else missed.push(`${query.q} → contradiction not marked`); }
  });
  const share = (part: number, whole: number) => whole ? Math.round(part / whole * 1000) / 1000 : 1;
  return { questions: queries.length, answerable, recall: share(found, wanted), precision: share(relevant, returned), meanReciprocalRank: share(reciprocal, answerable), location: share(located, locations), conflicts: share(marked, conflicts), refusal: share(refused, unanswerable), missed };
}

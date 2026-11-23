/**
 * Table previews before analysis (PAL Everywhere §15.2): a CSV's columns with inferred types, missing values, row
 * count, a few sample rows and any parse problems, so a person can check the input before a run. Parsing follows RFC
 * 4180 (quoted fields, doubled quotes, line breaks inside quotes); nothing is executed and formulas stay text.
 */
export type ColumnPreview = { name: string; type: 'number' | 'integer' | 'date' | 'boolean' | 'text' | 'empty'; missing: number; distinct: number; example?: string };
export const tableLimits = { rows: 200_000, sample: 5, bytes: 64 * 1024 * 1024 };

export function parseCsv(text: string, delimiter = ','): { rows: string[][]; problems: string[] } {
  const rows: string[][] = [], problems: string[] = [];
  let row: string[] = [], field = '', quoted = false, line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else { if (c === '\n') line++; field += c; }
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; line++; if (rows.length > tableLimits.rows) { problems.push(`Only the first ${tableLimits.rows} rows are previewed`); break; } }
    else field += c;
  }
  if (quoted) problems.push(`A quoted field starting before line ${line} is never closed`);
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows: rows.filter(cells => !(cells.length === 1 && cells[0] === '')), problems };
}
const isInteger = (v: string) => /^[+-]?\d+$/.test(v), isNumber = (v: string) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v));
const isBoolean = (v: string) => /^(true|false|yes|no)$/i.test(v);

export function previewTable(text: string, name = 'table.csv') {
  const delimiter = /\.tsv$/i.test(name) || (!text.split('\n', 1)[0].includes(',') && text.split('\n', 1)[0].includes('\t')) ? '\t' : ',';
  const { rows, problems } = parseCsv(text.replace(/^﻿/, ''), delimiter);
  if (!rows.length) return { delimiter, rows: 0, columns: [] as ColumnPreview[], sample: [] as string[][], problems: ['The file has no rows'] };
  const header = rows[0], body = rows.slice(1), width = header.length;
  const ragged = body.filter(cells => cells.length !== width).length;
  if (ragged) problems.push(`${ragged} row${ragged === 1 ? '' : 's'} have a different number of fields than the header (${width})`);
  if (body.some(cells => cells.some(cell => /^[=+\-@]/.test(cell) && !isNumber(cell)))) problems.push('Some cells start like spreadsheet formulas; they are kept as text and never evaluated');
  const columns: ColumnPreview[] = header.map((name, index) => {
    const values = body.map(cells => (cells[index] ?? '').trim()), present = values.filter(value => value !== '' && !/^(na|n\/a|null|none|-)$/i.test(value));
    const type: ColumnPreview['type'] = !present.length ? 'empty' : present.every(isInteger) ? 'integer' : present.every(isNumber) ? 'number' : present.every(isDate) ? 'date' : present.every(isBoolean) ? 'boolean' : 'text';
    return { name: name.trim() || `column ${index + 1}`, type, missing: values.length - present.length, distinct: new Set(present).size, ...(present[0] !== undefined ? { example: present[0].slice(0, 80) } : {}) };
  });
  return { delimiter, rows: body.length, columns, sample: body.slice(0, tableLimits.sample).map(cells => cells.map(cell => cell.slice(0, 200))), problems };
}

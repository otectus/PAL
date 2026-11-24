/**
 * A restrictive subset of .gitignore: comments, * and **, patterns with a slash counted from the folder the file is in,
 * and a trailing slash for folders only. A line that starts with ! is never used, so nothing a pattern leaves out can be
 * brought back by a later one.
 */
import { matchesGlob } from 'node:path';

export type IgnoreRule = { glob: string; anchored: boolean; folder: boolean };
export const ignoreLimits = { bytes: 32_768, rules: 256, pattern: 512 };
/** The rules in a file, or undefined when it is too large to apply as a whole. */
export function parseIgnore(text: string): IgnoreRule[] | undefined {
  if (Buffer.byteLength(text) > ignoreLimits.bytes) return undefined;
  const rules: IgnoreRule[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const folder = line.endsWith('/'), pattern = line.replace(/^\\(?=[#!])/, '').replace(/\/+$/, ''), glob = pattern.replace(/^\/+/, '');
    if (!glob) continue;
    if (glob.length > ignoreLimits.pattern || rules.length >= ignoreLimits.rules) return undefined;
    rules.push({ glob, anchored: pattern.includes('/'), folder });
  }
  return rules;
}
/** Whether a path, or a folder it is in, is left out. Paths are relative to the file's folder and use forward slashes. */
export function ignored(rules: IgnoreRule[], path: string, directory: boolean) {
  const parts = path.split('/').filter(Boolean);
  return rules.length > 0 && parts.some((part, index) => {
    const inner = index < parts.length - 1 || directory, prefix = parts.slice(0, index + 1).join('/');
    return rules.some(rule => (!rule.folder || inner) && matchesGlob(rule.anchored ? prefix : part, rule.glob));
  });
}

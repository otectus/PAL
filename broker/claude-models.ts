/**
 * What the Claude API takes differs by model generation, and it answers HTTP 400 to what a model does not take: a thinking
 * token budget, a temperature, an earlier computer tool, a forced tool. These are the documented rules as of the manifest
 * date. A model newer than any listed here is treated like the newest one, because each generation has only removed
 * settings; an unrecognized name keeps the older, permissive rules so that a proxy's own models are not refused.
 */
export const claudeManifest = '2026-11';
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeRules = {
  /** The model decides when to think, or thinks within a token budget it is given. */
  thinking: 'adaptive' | 'budget' | 'unknown';
  /** Whether a thinking token budget is accepted at all. */
  budget: boolean;
  /** Whether a temperature is accepted. */
  sampling: boolean;
  efforts: readonly string[];
  /** The computer tool this model accepts on the Claude API. */
  computer: 'toolset' | 'computer_20251124' | 'computer_20250124';
  /** Its web tools can filter what they found before it is read. */
  filteredWeb: boolean;
  /** Its reasoning is read back only behind exactly the text it was made with, so an edited history drops it. */
  bound: boolean;
  /** Whether a request may force one named tool. */
  forcedTool: boolean;
};
const all = claudeEfforts, four = ['low', 'medium', 'high', 'max'] as const;
const permissive: ClaudeRules = { thinking: 'unknown', budget: true, sampling: true, efforts: ['low', 'medium', 'high'], computer: 'computer_20251124', filteredWeb: false, bound: false, forcedTool: true };
const newest: ClaudeRules = { thinking: 'adaptive', budget: false, sampling: false, efforts: all, computer: 'toolset', filteredWeb: true, bound: true, forcedTool: false };
/** The earlier adaptive generation: no budget and no temperature, but reasoning that is not tied to the conversation. */
const settled: ClaudeRules = { ...newest, computer: 'computer_20251124', bound: false, forcedTool: true };

export function claudeVersion(model: string): { family: string; version: number } | undefined {
  // claude-opus-5-5, claude-sonnet-4-5-20250929 and the earlier claude-3-5-sonnet-20241022, with a gateway's prefix or not.
  const id = model.toLowerCase().split('/').at(-1)!;
  const current = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:[-@:].*)?$/.exec(id);
  if (current) return { family: current[1] === 'mythos' ? 'fable' : current[1], version: Number(current[2]) + Number(current[3] || 0) / 10 };
  const earlier = /^claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/.exec(id);
  return earlier ? { family: earlier[3], version: Number(earlier[1]) + Number(earlier[2] || 0) / 10 } : undefined;
}
export function claudeRules(model: string): ClaudeRules {
  const found = claudeVersion(model);
  if (!found) return permissive;
  const { family, version } = found;
  if (family === 'fable') return version >= 5.1 ? newest : settled;
  if (family === 'haiku') return version >= 5 ? { ...newest, filteredWeb: false } : { ...permissive, thinking: 'budget', efforts: [], computer: 'computer_20250124' };
  if (version > 5) return newest;
  if (family === 'opus' && version === 5) return { ...settled, computer: 'toolset' };
  if (family === 'sonnet' && version === 5 || family === 'opus' && version >= 4.7) return settled;
  if (version === 4.6) return { ...settled, budget: true, sampling: true, efforts: four };
  if (family === 'opus' && version === 4.5) return { ...permissive, thinking: 'budget' };
  return { ...permissive, thinking: 'budget', efforts: [], computer: 'computer_20250124' };
}
/** What one conversation asks of a model it cannot take, said before anything is sent. */
export function claudeRefusal(model: string, p: { temperature?: number; thinkingBudget?: unknown; adaptiveThinking?: unknown; effort?: string }): string | undefined {
  const rules = claudeRules(model);
  if (p.temperature !== undefined && !rules.sampling) return `${model} does not take a temperature. Clear it in this conversation’s model options.`;
  if (p.thinkingBudget !== undefined && !rules.budget) return `${model} decides how much to think by itself. Clear the thinking token budget and choose a reasoning effort instead.`;
  if (p.adaptiveThinking === true && rules.thinking === 'budget') return `${model} thinks within a token budget. Set a thinking token budget instead of Think before answering.`;
  if (p.adaptiveThinking === true && p.thinkingBudget !== undefined) return 'Choose either Think before answering or a thinking token budget.';
  if (p.effort && rules.thinking !== 'unknown' && !rules.efforts.includes(p.effort)) return rules.efforts.length ? `${model} accepts these efforts: ${rules.efforts.join(', ')}.` : `${model} does not take a reasoning effort.`;
  return undefined;
}
/** The efforts a catalog entry declares, or the dated rules when the catalog says nothing. */
export function claudeEffortsOf(id: string, entry: any): string[] {
  const declared = entry?.capabilities?.effort;
  if (declared && typeof declared === 'object') return declared.supported === false ? [] : claudeEfforts.filter(effort => declared[effort]?.supported === true);
  return [...claudeRules(id).efforts];
}
const reasoning = (block: any) => block?.type === 'thinking' || block?.type === 'redacted_thinking';
/** The same reply without the reasoning a changed request may no longer carry; its text and tool calls stay. */
export const withoutReasoning = (blocks: any[]) => blocks.filter(block => !reasoning(block));
export const hasReasoning = (blocks: any[]) => blocks.some(reasoning);

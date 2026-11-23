import type { ProviderEvent, ToolActivity } from './types.ts';

function short(value: unknown, limit: number) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length <= limit) return text || undefined;
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

/** Keep one useful subject across revisions, without saving a second copy of an entire input. */
export function toolCall(name: unknown, args: any, status?: ToolActivity['status'], description?: string): ToolActivity {
  const code = name === 'functions.exec' || name === 'codelab_run' ? args?.code : undefined;
  const target = [args?.command, args?.cmd, args?.file_path, args?.path, args?.query, args?.pattern,
    args?.url, args?.title, args?.label, args?.description, code].find(value => typeof value === 'string' && value.trim());
  const explanation = short(description || args?.description, 500);
  return { name: short(name, 160), target: short(target, 2000), description: explanation === target ? undefined : explanation, status };
}

// A child reports which tool ran and how it ended. Its output belongs to its own conversation.
export function agentTool(id: string, agentId: string, activity: ToolActivity): ProviderEvent {
  const { name, status, action, exitCode, durationMs } = activity;
  return { type: 'agentTool', id, toolActivity: { name, status, action, exitCode, durationMs, agentId } };
}

export function codexTool(item: any, completed: boolean, agentId?: string): ProviderEvent {
  const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode as number : undefined;
  const status = item.status === 'declined' ? 'declined'
    : ['interrupted', 'cancelled', 'canceled'].includes(item.status) ? 'interrupted'
    : item.status === 'failed' || item.success === false || item.error || item.result?.isError === true || (exitCode !== undefined && exitCode !== 0) ? 'failed'
    : completed ? 'completed' : 'started';
  const name = item.namespace && item.tool ? `${item.namespace}.${item.tool}` : item.tool || item.type;
  const info = toolCall(name, item.arguments || item.action, status);
  if (completed && !item.tool && ['dynamicToolCall', 'mcpToolCall'].includes(item.type)) info.name = undefined;
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (actions.length && actions.every((entry: any) => entry?.type === actions[0]?.type)
      && ['read', 'search', 'listFiles'].includes(actions[0]?.type)) info.action = actions[0].type;
  info.exitCode = exitCode;
  if (Number.isSafeInteger(item.durationMs) && item.durationMs >= 0) info.durationMs = item.durationMs;
  if (agentId) return agentTool(item.id, agentId, info);

  const paths = Array.isArray(item.changes) ? item.changes.slice(0, 12).map((change: any) => short(change?.path, 300)).filter(Boolean) : [];
  info.target = short(item.command || item.query || paths.join(', '), 2000) || info.target;
  const blocks = item.result?.content || item.contentItems;
  const output = completed && Array.isArray(blocks)
    ? blocks.filter(block => ['text', 'inputText'].includes(block?.type) && typeof block.text === 'string').map(block => block.text).join('\n') : '';
  return { type: 'tool', id: item.id, toolActivity: info, data: item,
    text: item.aggregatedOutput || item.error?.message || output || item.command || item.tool || item.type };
}

/** An ending event often omits the tool name, subject, or exit details seen on an earlier revision. */
export function mergeToolActivity(previous: ToolActivity | undefined, incoming: ToolActivity): ToolActivity {
  return { ...previous, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)) };
}

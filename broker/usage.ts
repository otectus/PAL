/**
 * One usage ledger for the desktop and every phone (PAL Everywhere §17.4).
 *
 * It reads the rows PAL already records (`usage_records`): helper calls and Workbench operations, and now every
 * provider-reported request of a conversation PAL runs, plus one row per CLI turn. Each row keeps how much is
 * known about it:
 * - `reported`: the provider stated the counts;
 * - `estimated`: PAL measured what it sent (UTF-8 bytes / 2), never shown as an exact token count;
 * - `unknown`: nothing usable was reported;
 * - `subscription`: a Codex or Claude Code turn billed through that tool's own plan, which PAL cannot price.
 *
 * Cost is computed only from prices the owner entered. A missing price is unknown, never zero. The monthly limit
 * is PAL's own stop before it sends another paid request; it is not a provider billing cap and cannot recall a
 * request already sent.
 */
import { randomUUID } from 'node:crypto';
import type { Core } from './core.ts';
import type { TurnPlan } from './context-plan.ts';
import { isApiProvider } from './provider-catalog.ts';
import { remoteError } from './execution.ts';

export type UsageStatus = 'reported' | 'estimated' | 'unknown' | 'subscription';
export type Price = { input: number; output: number; image?: number };
export type UsagePolicy = { revision: string; currency: string; prices: Record<string, Price>; monthlyLimit: number | null; warnAt: number | null };
export type UsageRow = { time: number; sessionId: string; operationId: string; kind: string; provider: string; model: string; status: UsageStatus;
  inputTokens: number; outputTokens: number; cachedTokens: number; images: number; calls: number; estimatedInputTokens: number; cost: number | null };

const defaultPolicy: UsagePolicy = { revision: '0', currency: 'USD', prices: {}, monthlyLimit: null, warnAt: null };
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export class UsageLedger {
  core: Core;
  /** CLI turns already counted (one row each, whatever number of plans they record). */
  private counted = new Set<string>();
  constructor(core: Core) { this.core = core; }

  policy(): UsagePolicy { return { ...defaultPolicy, ...this.core.store.get<Partial<UsagePolicy>>('usage.policy', {}) }; }
  setPolicy(p: any) {
    const current = this.policy();
    if (p?.expectedRevision !== undefined && p.expectedRevision !== current.revision) throw remoteError('REVISION_CONFLICT', 'Usage settings changed on another device. Review them again.');
    if (p.currency !== undefined && (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency))) throw new Error('Choose a three-letter currency code');
    const currency = p.currency ?? current.currency;
    const limit = (value: unknown) => value === null ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e7 ? value : undefined;
    const monthlyLimit = p.monthlyLimit === undefined ? current.monthlyLimit : limit(p.monthlyLimit), warnAt = p.warnAt === undefined ? current.warnAt : limit(p.warnAt);
    if (monthlyLimit === undefined || warnAt === undefined) throw new Error('Limits are amounts of 0 or more, or empty');
    let prices = current.prices;
    if (p.prices !== undefined) {
      if (!p.prices || typeof p.prices !== 'object' || Array.isArray(p.prices) || Object.keys(p.prices).length > 200) throw new Error('Prices are a map of provider:model to prices per million tokens');
      prices = {};
      for (const [key, value] of Object.entries(p.prices as Record<string, any>)) {
        if (!/^[a-z]+:[^\s]{1,200}$/.test(key) || !value || typeof value !== 'object') throw new Error(`Invalid price entry ${key.slice(0, 60)}`);
        const amounts = [value.input, value.output, ...(value.image !== undefined ? [value.image] : [])];
        if (amounts.some(rate => typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) throw new Error(`Enter a non-negative input, output and optional image price for ${key}`);
        prices[key] = { input: value.input, output: value.output, ...(value.image !== undefined ? { image: value.image } : {}) };
      }
    }
    const next: UsagePolicy = { revision: String(BigInt(current.revision) + 1n), currency, prices, monthlyLimit, warnAt };
    this.core.store.set('usage.policy', next); this.core.changed();
    return next;
  }
  /** A ledger row for a request whose plan PAL just recorded. */
  recordTurn(sessionId: string, plan: TurnPlan) {
    if (plan.boundary === 'cli-owned') {
      const key = sessionId + ':' + plan.turnId;
      if (!plan.turnId || this.counted.has(key)) return;
      this.counted.add(key); if (this.counted.size > 5000) this.counted.clear();
      this.insert(sessionId, { kind: 'turn', source: plan.provider, model: plan.model, status: 'subscription', calls: 1, turnId: plan.turnId });
      return;
    }
    if (!plan.reported) return;
    const estimated = plan.layers.reduce((sum, layer: any) => sum + number(layer.tokens ?? layer.estimate), 0);
    this.insert(sessionId, { kind: 'turn', source: plan.provider, model: plan.model, status: 'reported', calls: 1, turnId: plan.turnId,
      inputTokens: number(plan.reported.inputTokens), outputTokens: number(plan.reported.outputTokens), estimatedInputTokens: estimated });
  }
  private insert(sessionId: string, data: Record<string, unknown>) {
    this.core.store.db.prepare('INSERT INTO usage_records VALUES (?,?,?,?,?)').run(randomUUID(), sessionId, '', Date.now(), JSON.stringify(data));
  }
  private price(provider: string, model: string) { const prices = this.policy().prices; return prices[`${provider}:${model}`] ?? prices[`${provider}:*`]; }
  /** Every row since a time, normalized: older rows from helpers and operations keep what they reported. */
  rows(since: number): UsageRow[] {
    return this.core.store.db.prepare('SELECT session_id,operation_id,time,data FROM usage_records WHERE time>=? ORDER BY time DESC LIMIT 20000').all(since).map(row => {
      let data: any = {}; try { data = JSON.parse(String(row.data)); } catch {}
      const provider = String(data.source || data.provider || ''), model = String(data.model || '');
      const inputTokens = number(data.inputTokens ?? data.input_tokens), outputTokens = number(data.outputTokens ?? data.output_tokens);
      const kind = String(data.kind || 'call'), images = number(data.images ?? (kind.startsWith('image') ? data.count ?? 1 : 0));
      const status: UsageStatus = ['reported', 'estimated', 'unknown', 'subscription'].includes(data.status) ? data.status : inputTokens || outputTokens ? 'reported' : 'unknown';
      const price = this.price(provider, model);
      const cost = status === 'subscription' || !price ? null : (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output + images * (price.image ?? 0);
      return { time: Number(row.time), sessionId: String(row.session_id), operationId: String(row.operation_id), kind, provider, model, status, inputTokens, outputTokens,
        cachedTokens: number(data.cachedTokens ?? data.cached_tokens), images, calls: number(data.calls) || 1, estimatedInputTokens: number(data.estimatedInputTokens), cost };
    });
  }
  /** Totals for a period, by day, provider and model, and project; identical for the desktop and any phone. */
  summary(p: { days?: number; sessionId?: string } = {}) {
    const days = Math.max(1, Math.min(366, Math.round(p.days ?? 30))), since = Date.now() - days * 86400000;
    const projects = new Map<string, string>(), project = (sessionId: string) => {
      if (!projects.has(sessionId)) { let cwd = ''; try { cwd = this.core.store.session(sessionId).cwd; } catch { cwd = sessionId ? '(deleted conversation)' : '(PAL)'; } projects.set(sessionId, cwd); }
      return projects.get(sessionId)!;
    };
    const rows = this.rows(since).filter(row => !p.sessionId || row.sessionId === p.sessionId);
    type Total = { calls: number; inputTokens: number; outputTokens: number; images: number; cost: number; priced: number; unpriced: number; reported: number; estimated: number; unknown: number; subscription: number };
    const empty = (): Total => ({ calls: 0, inputTokens: 0, outputTokens: 0, images: 0, cost: 0, priced: 0, unpriced: 0, reported: 0, estimated: 0, unknown: 0, subscription: 0 });
    const add = (total: Total, row: UsageRow) => {
      total.calls += row.calls; total.inputTokens += row.inputTokens; total.outputTokens += row.outputTokens; total.images += row.images; total[row.status] += row.calls;
      if (row.cost === null) total.unpriced += row.calls; else { total.cost += row.cost; total.priced += row.calls; }
    };
    const totals = empty(), byDay = new Map<string, Total>(), byProvider = new Map<string, Total>(), byProject = new Map<string, Total>();
    for (const row of rows) {
      add(totals, row);
      const day = new Date(row.time).toISOString().slice(0, 10);
      for (const [map, key] of [[byDay, day], [byProvider, `${row.provider || 'unknown'}${row.model ? ' · ' + row.model : ''}`], [byProject, project(row.sessionId)]] as const) { const entry = map.get(key) ?? empty(); add(entry, row); map.set(key, entry); }
    }
    const policy = this.policy(), month = this.monthSpend();
    const warnings: string[] = [];
    if (totals.unpriced) warnings.push(`${totals.unpriced} request${totals.unpriced === 1 ? ' has' : 's have'} no price: costs shown cover priced requests only.`);
    if (totals.estimated || totals.unknown) warnings.push('Some requests reported no exact counts; they are listed as estimated or unknown, never as exact.');
    if (policy.warnAt !== null && month >= policy.warnAt) warnings.push(`This month’s priced use (${month.toFixed(2)} ${policy.currency}) passed your warning amount.`);
    const list = (map: Map<string, Total>) => [...map.entries()].map(([key, total]) => ({ key, ...total })).sort((a, b) => b.calls - a.calls);
    return { days, since, until: Date.now(), currency: policy.currency, totals, byDay: list(byDay).sort((a, b) => a.key.localeCompare(b.key)), byProvider: list(byProvider), byProject: list(byProject),
      month: { spent: month, monthlyLimit: policy.monthlyLimit, warnAt: policy.warnAt, reached: policy.monthlyLimit !== null && month >= policy.monthlyLimit }, policy, warnings };
  }
  /** Priced spending in the current calendar month (UTC). */
  monthSpend() {
    const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
    return this.rows(start.getTime()).reduce((sum, row) => sum + (row.cost ?? 0), 0);
  }
  /** PAL's own stop before another paid API request leaves, once the monthly limit the owner set is reached. */
  assertWithinBudget(provider: string) {
    if (!isApiProvider(provider) || provider === 'compatible') return;
    const policy = this.policy();
    if (policy.monthlyLimit === null) return;
    const spent = this.monthSpend();
    if (spent >= policy.monthlyLimit) throw remoteError('LIMIT_EXCEEDED', `This month’s priced API use (${spent.toFixed(2)} ${policy.currency}) reached the limit you set (${policy.monthlyLimit.toFixed(2)}). Raise it in Settings → Usage & budgets to continue.`);
  }
}

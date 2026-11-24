/**
 * Time in conversations: what a model is told about now, the two read-only clock tools, and the small record of
 * when each turn was received, sent and finished that elapsed-time answers come from.
 *
 * Two times travel with a turn. The message anchor is when PAL received the person's message and the zone it was
 * resolved in; "tomorrow" in that message means the day after that date, however long the message waited. The
 * request sample is taken again just before every request PAL controls, and answers "what time is it now".
 *
 * The block is request-only: it is composed from validated values, never saved as anyone's words, never given to
 * memory, and dropped with the request. A similar-looking tag in a message, a document or a tool result stays
 * content. Reading the clock is not evidence of a person doing anything, and it grants nothing.
 */
import type { Core } from './core.ts';
import { estimateTokens, type PlanLayer } from './context-plan.ts';
import { isApiProvider } from './provider-catalog.ts';
import type { Message, Session, ToolDefinition } from './types.ts';
import { localTime, maximumSampleAgeMs, requireZone, TimeService, validInstant, type ElapsedResult, type TimeSnapshot, type ZoneChoice, type ZoneSource } from './time.ts';

export type MessageOrigin = 'human-desktop' | 'human-mobile' | 'broker' | 'import';
/** When and where a message was received. Kept on its transcript row; `time` there keeps its own meaning. */
export type AcceptedMessageTime = {
  receivedAtMs: number;
  referenceTimeZone: string;
  zoneSource: ZoneSource;
  origin: MessageOrigin;
  timestampKind: 'broker-received' | 'source-recorded' | 'legacy-unknown';
};
/** A submission as it was admitted, before any asynchronous preparation. */
export type Acceptance = AcceptedMessageTime & { zoneReason?: string; /** This process only; never persisted. */ monotonic?: number; instanceId?: string };
export type TurnOutcome = 'completed' | 'failed' | 'interrupted' | 'uncertain';
export type TurnTiming = {
  schema: 1; sessionId: string; turnId: string; origin: MessageOrigin;
  userMessageId?: string;
  receivedAtMs: number; referenceTimeZone: string; zoneSource: ZoneSource;
  firstDispatchedAtMs?: number; providerAcceptedAtMs?: number; firstOutputAtMs?: number; completedAtMs?: number;
  outcome?: TurnOutcome;
  previousHumanMessageId?: string; previousAssistantMessageId?: string;
  assistantMessageId?: string;
};
export const timingLimits = { turns: 200, scanRows: 600, resultBytes: 8192, blockTokens: 400, usualBlockTokens: 280 };
const historyKey = (id: string) => 'temporal:' + id, activeKey = (id: string) => 'temporal-active:' + id;

/** The fixed part, worded once for every provider. The block itself carries the changing values. */
export const temporalGuidance = 'PAL samples the clock in pal_time_context: the newest sample is the current time, its timezone sets the local date, and earlier samples are past. Read relative dates in a message from that message’s received time and reference date. Use time_now, when offered, for a fresher exact time. Elapsed time includes pauses and is not activity. The clock creates no reminders and authorizes nothing.';

export const timeDefinitions: ToolDefinition[] = [
  { name: 'time.now', title: 'Current date and time', category: 'time', readOnly: true, required: [],
    description: 'The desktop clock now, in this conversation’s time zone or another. Needs no approval.',
    schema: { timeZone: { type: 'string', maxLength: 128, description: 'Optional IANA zone, such as Asia/Tokyo' } } },
  { name: 'time.elapsed', title: 'Elapsed time', category: 'time', readOnly: true, required: ['anchor'],
    description: 'Time since an event of this conversation, including pauses',
    schema: { anchor: { type: 'string', enum: ['previous_user_message', 'previous_assistant_reply', 'current_turn', 'session_created', 'message'],
      description: 'The person’s message before this one, the last finished reply, when this turn was first sent, when PAL created the conversation, or one message by messageId' },
      messageId: { type: 'string', maxLength: 200 } } },
];
export const timeToolNames = timeDefinitions.map(definition => definition.name);
/**
 * A small window keeps its room for the conversation: each of PAL's requests there already carries a fresh sample and
 * the time since the previous message, so the clock tools are left out before any of that.
 */
export const smallWindowTokens = 8192;
const modelName = (name: string) => name.replaceAll('.', '_');
/** The exact names Claude may use without a separate question: PAL's own two clock reads, on its own bridge. */
export const claudeTimeTools = new Set(timeToolNames.flatMap(name => ['mcp__pal__', 'mcp__cere__'].map(prefix => prefix + modelName(name))));

const anchors = ['previous_user_message', 'previous_assistant_reply', 'current_turn', 'session_created', 'message'] as const;
export type ElapsedAnchor = typeof anchors[number];
export function validTimeArguments(name: string, args: unknown): { timeZone?: string; anchor?: ElapsedAnchor; messageId?: string } {
  const p = args === undefined || args === null ? {} : args;
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid tool arguments');
  const value = p as Record<string, unknown>;
  if (name === 'time.now') {
    if (Object.keys(value).some(key => key !== 'timeZone')) throw new Error('Invalid tool arguments');
    if (value.timeZone === undefined) return {};
    if (typeof value.timeZone !== 'string' || value.timeZone.length > 128) throw new Error('Choose a time zone by its name, such as America/New_York or Asia/Tokyo');
    return { timeZone: requireZone(value.timeZone) };
  }
  if (Object.keys(value).some(key => key !== 'anchor' && key !== 'messageId')) throw new Error('Invalid tool arguments');
  if (!anchors.includes(value.anchor as ElapsedAnchor)) throw new Error('Choose what to measure from: ' + anchors.join(', '));
  if (value.messageId !== undefined && (value.anchor !== 'message' || typeof value.messageId !== 'string' || !value.messageId || value.messageId.length > 200)) throw new Error('messageId applies only to the message anchor');
  if (value.anchor === 'message' && value.messageId === undefined) throw new Error('The message anchor needs a messageId');
  return { anchor: value.anchor as ElapsedAnchor, ...(value.messageId ? { messageId: value.messageId as string } : {}) };
}

const erasedText = '[Content removed by memory erasure]';
/**
 * A row the person wrote that a later turn may measure from: never PAL's own rows, answers, messages that were not
 * sent, or a message the person has since forgotten, whose time must not be given away either.
 */
export function humanSubmission(message: Pick<Message, 'role' | 'kind' | 'timing' | 'text'>) {
  return message.role === 'user' && !['answer', 'delegation', 'queue-cancelled'].includes(message.kind || '') && message.timing?.origin !== 'broker' && message.text !== erasedText;
}
const assistantReply = (message: Message) => message.role === 'assistant' && message.kind !== 'question' && !!message.text.trim() && message.text !== erasedText;

/** What a model is told, in a fixed order of validated values. Unavailable fields are left out, never invented. */
export function timeBlock(snapshot: TimeSnapshot, turn?: { receivedAtMs: number; referenceTimeZone: string }, earlier?: { previousHumanAtMs?: number; gapMs?: number }): string {
  const lines = [`sampled_at_utc: ${snapshot.utcIso}`, `local_datetime: ${snapshot.localIso}`, `timezone: ${snapshot.timeZone}`, `timezone_source: ${snapshot.zoneSource}`, `weekday: ${snapshot.weekday}`, `clock_source: ${snapshot.clockSource}`];
  if (snapshot.clockStatus !== 'normal') lines.push(`clock_status: ${snapshot.clockStatus}`);
  if (turn && validInstant(turn.receivedAtMs)) {
    lines.push(`message_received_at_utc: ${new Date(turn.receivedAtMs).toISOString()}`, `message_reference_date: ${localTime(turn.receivedAtMs, turn.referenceTimeZone).date}`);
    if (turn.referenceTimeZone !== snapshot.timeZone) lines.push(`message_reference_timezone: ${turn.referenceTimeZone}`);
  }
  if (earlier?.previousHumanAtMs !== undefined) lines.push(`previous_human_message_at_utc: ${new Date(earlier.previousHumanAtMs).toISOString()}`);
  if (earlier?.gapMs !== undefined) lines.push(`gap_between_human_submissions_ms: ${earlier.gapMs}`, 'elapsed_basis: wall-clock-estimate');
  return `<pal_time_context version="1">\n${lines.join('\n')}\n</pal_time_context>`;
}

/** One request's time block, and how to rebuild it when the request leaves later than it was composed. */
export type RequestTime = {
  text: string; minimal: boolean; snapshot: TimeSnapshot;
  detail: NonNullable<PlanLayer['detail']>;
  /** A newer block when this one is older than the freshness limit, its clock jumped, or a retry was delayed. */
  refresh(retry: boolean): string | undefined;
};

export class Temporal {
  private core: Core;
  readonly service: TimeService;
  /** The turn in progress per conversation, and process readings of recent events. Neither is a stored clock. */
  private active = new Map<string, TurnTiming & { dispatchedAt?: { instanceId: string; monotonic: number; wall: number } }>();
  private readings = new Map<string, { instanceId: string; monotonic: number }>();
  /** Why a conversation's last request carried no time, for the Context view. */
  private omitted = new Map<string, string>();
  constructor(core: Core, service = new TimeService()) { this.core = core; this.service = service; }

  get settings() { return this.core.settings.time; }
  enabled() { return this.settings.enabled; }
  timingEnabled() { return this.settings.enabled && this.settings.conversationTiming; }

  // ——— Admission ———

  /** Captured at the moment a submission is admitted, before any preparation. Nothing is stored yet. */
  accept(session: Pick<Session, 'timeZone'>, origin: MessageOrigin, p: { device?: string; schedule?: string } = {}): Acceptance {
    const reading = this.service.read(), choice = this.service.zone({ conversation: session.timeZone, settings: this.settings, device: origin === 'human-mobile' ? p.device : undefined, schedule: p.schedule });
    return { receivedAtMs: reading.wall, referenceTimeZone: choice.zone, zoneSource: choice.source, origin, timestampKind: 'broker-received', ...(choice.reason ? { zoneReason: choice.reason } : {}),
      monotonic: reading.monotonic, instanceId: this.service.clock.instanceId };
  }
  /** What a transcript row keeps of an acceptance: nothing process-relative. Nothing is added while time awareness is off. */
  messageTiming(acceptance: Acceptance | undefined): AcceptedMessageTime | undefined {
    if (!acceptance || !this.enabled()) return undefined;
    const { receivedAtMs, referenceTimeZone, zoneSource, origin, timestampKind } = acceptance;
    return { receivedAtMs, referenceTimeZone, zoneSource, origin, timestampKind };
  }
  /** The parts of an acceptance a queued message keeps until it is sent. */
  queuedAcceptance(acceptance: Acceptance): Acceptance {
    const { monotonic: _monotonic, instanceId: _instance, ...stored } = acceptance;
    return stored;
  }
  private remember(messageId: string, at?: { instanceId?: string; monotonic?: number }) {
    if (!at?.instanceId || at.monotonic === undefined) return;
    this.readings.delete(messageId);
    this.readings.set(messageId, { instanceId: at.instanceId, monotonic: at.monotonic });
    while (this.readings.size > 2000) this.readings.delete(this.readings.keys().next().value!);
  }
  noteMessage(messageId: string, acceptance: Acceptance | undefined) { if (acceptance) this.remember(messageId, acceptance); }

  // ——— The turn record ———

  /**
   * Starts a turn's record. Its predecessors come from transcript order before this message, so a message queued
   * after it can never become one of them.
   */
  begin(sessionId: string, turnId: string, acceptance: Acceptance, userMessageId?: string) {
    const turn: TurnTiming = { schema: 1, sessionId, turnId, origin: acceptance.origin, ...(userMessageId ? { userMessageId } : {}),
      receivedAtMs: acceptance.receivedAtMs, referenceTimeZone: acceptance.referenceTimeZone, zoneSource: acceptance.zoneSource };
    if (this.timingEnabled()) {
      const before = this.predecessors(sessionId, userMessageId);
      if (before.human) turn.previousHumanMessageId = before.human.id;
      if (before.assistant) turn.previousAssistantMessageId = before.assistant.id;
    }
    this.active.set(sessionId, turn);
    if (userMessageId) this.remember(userMessageId, acceptance);
    this.saveActive(turn);
    return turn;
  }
  /** The last eligible human message and assistant reply before a message, newest first and bounded. */
  private predecessors(sessionId: string, userMessageId?: string): { human?: Message; assistant?: Message } {
    let human: Message | undefined, assistant: Message | undefined, before: number | null = null, scanned = 0;
    let reached = !userMessageId || !this.core.store.messageById(userMessageId);
    while (scanned < timingLimits.scanRows && !(human && assistant)) {
      const rows = this.core.store.messageRows(sessionId, before, 100);
      if (!rows.length) break;
      for (const row of rows) {
        before = row.cursor; scanned++;
        const message = JSON.parse(row.data) as Message;
        if (!reached) { reached = message.id === userMessageId; continue; }
        if (!human && humanSubmission(message)) human = message;
        if (!assistant && assistantReply(message)) assistant = message;
        if (human && assistant) break;
      }
      if (rows.length < 100) break;
    }
    return { human, assistant };
  }
  private saveActive(turn: TurnTiming) {
    if (!this.timingEnabled()) return;
    const { dispatchedAt: _process, ...stored } = turn as TurnTiming & { dispatchedAt?: unknown };
    try { this.core.store.session(turn.sessionId); this.core.store.set(activeKey(turn.sessionId), stored); } catch { /* the conversation is gone */ }
  }
  private current(sessionId: string, turnId?: string) {
    const turn = this.active.get(sessionId);
    return turn && (turnId === undefined || turn.turnId === turnId) ? turn : undefined;
  }
  /** The request left the broker. Later rounds of the same turn keep the first time. */
  dispatched(sessionId: string, turnId?: string) {
    const turn = this.current(sessionId, turnId);
    if (!turn || turn.firstDispatchedAtMs !== undefined) return;
    const reading = this.service.read();
    turn.firstDispatchedAtMs = reading.wall;
    turn.dispatchedAt = { instanceId: this.service.clock.instanceId, monotonic: reading.monotonic, wall: reading.wall };
    this.saveActive(turn);
  }
  accepted(sessionId: string, turnId?: string) {
    const turn = this.current(sessionId, turnId);
    if (!turn || turn.providerAcceptedAtMs !== undefined) return;
    turn.providerAcceptedAtMs = this.service.read().wall;
    this.saveActive(turn);
  }
  firstOutput(sessionId: string) {
    const turn = this.current(sessionId);
    if (turn && turn.firstOutputAtMs === undefined) turn.firstOutputAtMs = this.service.read().wall;
  }
  /** Ends the turn as it was observed. A passing hour or a restart never completes one. */
  finished(sessionId: string, outcome: TurnOutcome, assistantMessageId?: string, turnId?: string) {
    const turn = this.current(sessionId, turnId);
    if (!turn) return;
    this.active.delete(sessionId);
    const reading = this.service.read();
    if (outcome === 'completed') {
      turn.completedAtMs = reading.wall;
      if (assistantMessageId) { turn.assistantMessageId = assistantMessageId; this.remember(assistantMessageId, { instanceId: this.service.clock.instanceId, monotonic: reading.monotonic }); }
    }
    turn.outcome = outcome;
    if (!this.timingEnabled()) return;
    const { dispatchedAt: _process, ...stored } = turn;
    try {
      this.core.store.session(sessionId);
      this.core.store.set(historyKey(sessionId), { schema: 1, turns: [...this.history(sessionId), stored].slice(-timingLimits.turns) });
      this.core.store.set(activeKey(sessionId), null);
    } catch { /* the conversation is gone */ }
  }
  history(sessionId: string): TurnTiming[] {
    const saved = this.core.store.get<any>(historyKey(sessionId), null);
    // A record this build cannot read is ignored, never a reason to fail the conversation.
    return saved && saved.schema === 1 && Array.isArray(saved.turns) ? saved.turns.filter((turn: any) => turn && turn.schema === 1 && typeof turn.turnId === 'string') : [];
  }
  /** After a restart, a turn that was running is recorded as it was left: its outcome is not known. */
  recover(sessionId: string) {
    const saved = this.core.store.get<any>(activeKey(sessionId), null);
    if (!saved || saved.schema !== 1 || typeof saved.turnId !== 'string') return;
    this.core.store.set(historyKey(sessionId), { schema: 1, turns: [...this.history(sessionId), { ...saved, outcome: saved.firstDispatchedAtMs ? 'uncertain' : 'interrupted' }].slice(-timingLimits.turns) });
    this.core.store.set(activeKey(sessionId), null);
  }
  forget(sessionId: string) { this.active.delete(sessionId); this.omitted.delete(sessionId); this.lastCli.delete(sessionId); }
  /** Forgotten messages take their times with them: turns they began, and every pointer to them. Runs inside the erasure's transaction. */
  erase(sessionId: string, messageIds: ReadonlySet<string>) {
    if (!messageIds.size) return;
    for (const id of messageIds) this.readings.delete(id);
    const pointers = ['previousHumanMessageId', 'previousAssistantMessageId', 'assistantMessageId'] as const;
    const clean = (turn: TurnTiming) => { const next = { ...turn }; for (const key of pointers) if (next[key] && messageIds.has(next[key]!)) delete next[key]; return next; };
    const history = this.history(sessionId), kept = history.filter(turn => !(turn.userMessageId && messageIds.has(turn.userMessageId))).map(clean);
    if (JSON.stringify(kept) !== JSON.stringify(history)) this.core.store.set(historyKey(sessionId), { schema: 1, turns: kept });
    const running = this.active.get(sessionId);
    if (running) this.active.set(sessionId, { ...clean(running), ...(running.dispatchedAt ? { dispatchedAt: running.dispatchedAt } : {}) });
  }
  /** Keys this service keeps for a conversation, removed with it. */
  static keys = ['temporal:', 'temporal-active:'];

  // ——— What a request is told ———

  /** The zone this turn's "now" is told in: frozen for the turn, resolved afresh outside one. */
  private zoneFor(sessionId: string): ZoneChoice {
    const turn = this.active.get(sessionId);
    if (turn) return { zone: turn.referenceTimeZone, source: turn.zoneSource };
    return this.service.zone({ conversation: this.core.store.findSession(sessionId)?.timeZone, settings: this.settings });
  }
  private earlier(sessionId: string, turn: TurnTiming) {
    if (!this.timingEnabled() || turn.origin === 'broker' || !turn.previousHumanMessageId) return undefined;
    const previous = this.core.store.messageById(turn.previousHumanMessageId);
    if (!previous || previous.sessionId !== sessionId || !humanSubmission(previous)) return undefined;
    const at = previous.timing?.receivedAtMs ?? previous.time;
    if (!validInstant(at)) return undefined;
    const gapMs = turn.receivedAtMs - at;
    // A gap that would be negative is left out rather than shown as zero.
    return { previousHumanAtMs: at, ...(gapMs >= 0 ? { gapMs } : {}) };
  }
  /** The block for one request, within `budget` tokens: elapsed fields go before the current time does. */
  request(sessionId: string, budget = timingLimits.blockTokens, channel = 'system message'): RequestTime | undefined {
    if (!this.enabled()) { this.omitted.set(sessionId, 'setting_off'); return undefined; }
    try {
      const turn = this.active.get(sessionId);
      const compose = () => {
        const snapshot = this.service.snapshot(this.zoneFor(sessionId)), earlier = turn && this.earlier(sessionId, turn);
        const full = timeBlock(snapshot, turn, earlier);
        const minimal = estimateTokens(full) > Math.min(budget, timingLimits.blockTokens);
        return { snapshot, minimal, earlier: minimal ? undefined : earlier, text: minimal ? timeBlock(snapshot) : full };
      };
      let made = compose();
      this.omitted.delete(sessionId);
      return {
        get text() { return made.text; }, get minimal() { return made.minimal; }, get snapshot() { return made.snapshot; },
        get detail() {
          return { timezone: made.snapshot.timeZone, timezoneSource: made.snapshot.zoneSource, sampledAt: made.snapshot.utcIso, local: made.snapshot.localIso, channel, refresh: 'every request',
            clock: made.snapshot.clockStatus, ...(made.earlier?.gapMs !== undefined ? { elapsed: 'wall-clock-estimate' } : { elapsed: made.minimal ? 'no_room' : 'not_supplied' }) };
        },
        refresh: (retry: boolean) => {
          if (!this.enabled()) return made.text ? (made = { ...made, text: '' }).text : undefined;
          const now = this.service.read();
          if (!retry && now.wall - made.snapshot.sampledAtMs <= maximumSampleAgeMs && now.wall >= made.snapshot.sampledAtMs && made.snapshot.clockRevision === this.service.clockRevision) return undefined;
          made = compose();
          return made.text;
        },
      };
    } catch {
      // Conversation goes on without time rather than with an old sample.
      this.omitted.set(sessionId, 'time_unavailable');
      return undefined;
    }
  }
  /** What a CLI is given with one message: the guidance travels with its other instructions, the sample with the turn. */
  cliBlock(sessionId: string, channel: string): RequestTime | undefined {
    const request = this.request(sessionId, timingLimits.blockTokens, channel);
    if (request) this.lastCli.set(sessionId, { text: request.text, detail: { ...request.detail, refresh: channel === 'prepended to the message' ? 'once per message' : 'once per message, and time_now' } });
    else this.lastCli.delete(sessionId);
    return request;
  }
  private lastCli = new Map<string, { text: string; detail: NonNullable<PlanLayer['detail']> }>();
  /** The Context view's line about time for the last request. */
  layer(sessionId: string, request?: RequestTime): PlanLayer {
    return { id: 'temporal-context', label: 'Current date and time', trust: 'pal', tokens: request ? estimateTokens(request.text) + estimateTokens(temporalGuidance) : null, included: !!request,
      ...(request ? { detail: request.detail } : { reason: this.omitted.get(sessionId) || 'setting_off' }), };
  }
  /** A CLI's time line: what its adapter sent with the turn, or that the turn has not left yet. */
  cliLayer(sessionId: string, sent: boolean): PlanLayer {
    const last = sent ? this.lastCli.get(sessionId) : undefined;
    return { id: 'temporal-context', label: 'Current date and time', trust: 'pal', tokens: last ? estimateTokens(last.text) + estimateTokens(temporalGuidance) : null, included: !!last,
      ...(last ? { detail: last.detail } : { reason: this.enabled() ? sent ? this.omitted.get(sessionId) || 'not_supplied' : 'not_sent_yet' : 'setting_off' }) };
  }

  // ——— Tools ———

  /** The clock reads this conversation is offered. They need no desktop category, web access or memory. */
  definitions(sessionId: string): ToolDefinition[] {
    let settings; try { settings = this.core.settingsFor(sessionId); } catch { return []; }
    if (!this.enabled() || settings.paused) return [];
    return timeDefinitions.filter(definition => definition.name !== 'time.elapsed' || this.timingEnabled());
  }
  offered(sessionId: string, name: string) { return this.definitions(sessionId).some(definition => definition.name === name); }
  /** Runs one clock read for a conversation, checked again here whatever was advertised. */
  call(sessionId: string, name: string, args: unknown): TimeSnapshot | ElapsedResult {
    if (!this.offered(sessionId, name)) throw new Error('This tool is disabled in PAL settings');
    const p = validTimeArguments(name, args);
    const result = name === 'time.now' ? this.now(sessionId, p.timeZone) : this.elapsed(sessionId, p.anchor!, p.messageId);
    if (Buffer.byteLength(JSON.stringify(result)) > timingLimits.resultBytes) throw new Error('The clock result exceeded its limit');
    return result;
  }
  now(sessionId: string | undefined, timeZone?: string): TimeSnapshot {
    const zone = timeZone === undefined ? undefined : requireZone(timeZone);
    return this.service.snapshot(zone ? { zone, source: 'explicit-query' } : sessionId ? this.zoneFor(sessionId) : this.service.zone({ settings: this.settings }));
  }
  /** Elapsed time from this conversation's own events only; another conversation's message is never acknowledged. */
  elapsed(sessionId: string, anchor: ElapsedAnchor, messageId?: string): ElapsedResult {
    const store = this.core.store, session = store.session(sessionId), turn = this.active.get(sessionId);
    const unknown = (reason: string, words: string) => this.service.sinceWall(anchor, undefined, { reason, anchor: words });
    if (anchor === 'session_created') return this.service.sinceWall(anchor, session.created, { anchor: 'When PAL created this conversation. An imported conversation may have begun earlier.' });
    if (anchor === 'current_turn') {
      if (!turn) return unknown('no_turn', 'No turn is running.');
      if (!turn.dispatchedAt) return unknown('not_dispatched', 'This turn has not been sent to the model yet, or PAL did not see it leave.');
      return this.service.sinceMonotonic(anchor, turn.dispatchedAt, 'Since this turn was first sent to the model. Time spent waiting in the queue is not included.');
    }
    if (anchor === 'message') {
      const message = store.messageById(messageId!);
      if (!message || message.sessionId !== sessionId || message.text === erasedText) return unknown('anchor_unavailable', 'No such message in this conversation.');
      return this.service.sinceWall(anchor, message.timing?.receivedAtMs ?? message.time, { anchorId: message.id, at: this.readings.get(message.id),
        anchor: message.timing ? 'When PAL received this message.' : message.role === 'assistant' ? 'When this reply’s transcript row began; its finishing time was not recorded.' : 'This message’s transcript time.' });
    }
    if (anchor === 'previous_user_message') {
      const id = turn ? turn.previousHumanMessageId : undefined;
      const found = turn && this.timingEnabled() ? (id ? store.messageById(id) : undefined) : this.predecessors(sessionId).human;
      const message = found && found.sessionId === sessionId && humanSubmission(found) ? found : undefined;
      if (!message) return unknown('anchor_unavailable', 'No earlier message from the person is recorded in this conversation.');
      return this.service.sinceWall(anchor, message.timing?.receivedAtMs ?? message.time, { anchorId: message.id, at: this.readings.get(message.id),
        anchor: turn?.origin === 'broker' ? 'The person’s latest message before this automatic turn.' : 'The person’s message before the current one.' });
    }
    const recorded = [...this.history(sessionId)].reverse().find(past => past.outcome === 'completed' && past.assistantMessageId && past.completedAtMs !== undefined && past.turnId !== turn?.turnId);
    const row = recorded && store.messageById(recorded.assistantMessageId!);
    if (recorded && row && row.sessionId === sessionId && assistantReply(row)) return this.service.sinceWall(anchor, recorded.completedAtMs, { anchorId: row.id, at: this.readings.get(row.id), anchor: 'When the last reply before this turn finished.' });
    const fallback = turn?.previousAssistantMessageId ? store.messageById(turn.previousAssistantMessageId) : this.predecessors(sessionId, turn?.userMessageId).assistant;
    if (!fallback || fallback.sessionId !== sessionId || !assistantReply(fallback)) return unknown('anchor_unavailable', 'No earlier reply is recorded in this conversation.');
    return this.service.sinceWall(anchor, fallback.time, { anchorId: fallback.id, reason: 'completion_time_unknown', anchor: 'When that reply began. When it finished was not recorded.' });
  }

  // ——— The desktop's own views ———

  /** How long a conversation has been going, for a person: a recorded span, not a measure of activity. */
  conversation(sessionId: string) {
    return { created: this.elapsed(sessionId, 'session_created'), previousMessage: this.elapsed(sessionId, 'previous_user_message'), previousReply: this.elapsed(sessionId, 'previous_assistant_reply') };
  }
  /** The zone a conversation's next message from this computer would be told in. */
  preview(sessionId?: string): ZoneChoice { return this.service.zone({ conversation: sessionId ? this.core.store.findSession(sessionId)?.timeZone : undefined, settings: this.settings }); }
  /** Sets or clears one conversation's own zone. Timers, schedules and other conversations are untouched. */
  setZone(sessionId: string, timeZone: unknown) {
    const zone = timeZone === null || timeZone === '' ? undefined : requireZone(timeZone);
    return this.core.updateSession(sessionId, { timeZone: zone });
  }
}
/** Whether a provider's turns are composed by PAL itself, so the sample is renewed for each of its requests. */
export const palComposed = (provider: string) => provider === 'ollama' || isApiProvider(provider);

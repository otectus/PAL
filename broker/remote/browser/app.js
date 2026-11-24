// PAL's browser companion (broker/remote/browser.ts). It proves which browser this is with two keys that the browser
// keeps and cannot export, speaks the same protocol as PAL Mobile, and shows everything it receives as text.
import { base64, canonical, derSignature, digest, pairingCode, random, sha256 } from '/protocol.js';

const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
const sign = async (key, value) => base64(derSignature(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonical(value))))));
const publicKey = async pair => base64(await crypto.subtle.exportKey('spki', pair.publicKey));
const newKeys = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

// One identity for each address, kept by the browser: two keys that can sign and cannot be read.
const database = () => new Promise((done, fail) => { const request = indexedDB.open('pal-companion', 1); request.onupgradeneeded = () => request.result.createObjectStore('identity'); request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
const stored = async (mode, work) => { const db = await database(); try { return await new Promise((done, fail) => { const transaction = db.transaction('identity', mode), request = work(transaction.objectStore('identity')); transaction.oncomplete = () => done(request?.result); transaction.onerror = () => fail(transaction.error); }); } finally { db.close(); } };
const loadIdentity = () => stored('readonly', store => store.get('self'));
const saveIdentity = value => stored('readwrite', store => store.put(value, 'self'));
const dropIdentity = () => stored('readwrite', store => store.delete('self'));

const state = { identity: undefined, socket: undefined, welcome: undefined, operations: new Set(), pending: new Map(), sessions: [], total: 0, selected: '', messages: new Map(), before: null, approvals: [], access: undefined, retry: 0, wanted: false, pairing: undefined };
const show = (id, on) => { $(id).hidden = !on; };
const say = text => { $('status').textContent = text; };
const problem = (id, text) => { $(id).textContent = text || ''; show(id, !!text); };
const element = (tag, text, name) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (name) node.className = name; return node; };
const may = method => state.operations.has(method);

function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/browser/v1`, 'cere.mobile.v1');
  return new Promise((done, fail) => { socket.onopen = () => done(socket); socket.onerror = () => fail(new Error('The desktop does not answer.')); });
}
// Pairing: the code proves the person read it from the desktop; the words prove nobody stood between.
async function pair(code, name) {
  const socket = await connect(), keys = { connection: await newKeys(), action: await newKeys() };
  const next = () => new Promise((done, fail) => { socket.onmessage = event => done(JSON.parse(event.data)); socket.onclose = () => fail(new Error('The desktop ended the pairing.')); });
  let answer = next(); socket.send(JSON.stringify({ v: 1, type: 'browser.offer' })); const first = await answer;
  if (first.type !== 'browser.offer') { socket.close(); throw new Error('No pairing is open on the desktop. Choose “Pair a browser” there first.'); }
  const offer = first.offer, body = { type: 'browser-response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: await digest(offer), nonce: offer.nonce, deviceId: crypto.randomUUID(), name, keyVersion: 1, connectionKey: await publicKey(keys.connection), actionKey: await publicKey(keys.action), deviceNonce: random(32) };
  const transcript = { domain: 'pal.browser.pair.response.v1', response: body }, response = { ...body, connectionProof: await sign(keys.connection.privateKey, transcript), actionProof: await sign(keys.action.privateKey, transcript) };
  const secret = await crypto.subtle.importKey('raw', encoder.encode(pairingCode(code)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const codeProof = base64(await crypto.subtle.sign('HMAC', secret, encoder.encode(canonical({ domain: 'pal.browser.pair.code.v1', offer, response: body }))));
  answer = next(); socket.send(JSON.stringify({ v: 1, type: 'browser.pair', response, codeProof })); const received = await answer;
  if (received.type !== 'pair.received') { socket.close(); throw new Error(received.message || 'The desktop refused this code.'); }
  const words = await (await fetch('/words.json')).json(), sum = await sha256(await digest(offer) + '.' + await digest(response));
  $('sas').textContent = [...sum.slice(0, 6)].map(value => words[value]).join(' ');
  $('pairAccess').textContent = offer.role === 'observer' ? `This browser will read conversations of ${offer.name} and can Stop and Deny.` : `This browser will read and send messages in the projects chosen on ${offer.name}.`;
  show('pair', false); show('compare', true); say('Waiting for the desktop…'); state.pairing = socket;
  const outcome = await next(); state.pairing = undefined;
  if (outcome.type !== 'pair.confirmed') throw new Error(outcome.reason === 'expired' ? 'The code ended before the desktop confirmed. Make a new one there.' : 'The desktop did not confirm this browser.');
  const identity = { deviceId: body.deviceId, desktopId: offer.desktopId, desktop: offer.name, name, connection: keys.connection.privateKey, action: keys.action.privateKey };
  await saveIdentity(identity); return identity;
}

// A connection: a challenge, a signature, and then requests that each have an answer.
async function open() {
  const { identity } = state; state.wanted = true; say('Connecting…');
  let socket; try { socket = await connect(); } catch { return later(); }
  state.socket = socket;
  const hello = { v: 1, type: 'hello', protocolMin: 0, protocolMax: 0, desktopId: identity.desktopId, deviceId: identity.deviceId, keyVersion: 1, clientNonce: random(32), appVersion: 'browser-1' };
  socket.onmessage = async event => {
    if (typeof event.data !== 'string') return;
    const frame = JSON.parse(event.data);
    if (frame.type === 'auth.challenge') {
      const { challengeId, serverNonce, epoch, audience, expiresAt } = frame, challenge = { challengeId, serverNonce, epoch, audience, expiresAt };
      socket.send(JSON.stringify({ v: 1, type: 'auth', challengeId, signature: await sign(identity.connection, { domain: 'cere.mobile.auth.v1', helloDigest: await digest(hello), challenge, desktopId: identity.desktopId, deviceId: identity.deviceId, keyVersion: 1, epoch }) }));
    } else if (frame.type === 'welcome') { state.welcome = frame; state.operations = new Set(frame.operations); state.retry = 0; say(`Connected to ${identity.desktop}`); await sync(); }
    else if (frame.type === 'response') { const waiting = state.pending.get(frame.id); state.pending.delete(frame.id); if (waiting) frame.error ? waiting.fail(Object.assign(new Error(frame.error.message), { code: frame.error.code })) : waiting.done(frame.result); }
    else if (frame.type === 'event') await event_(frame);
  };
  socket.onclose = event => {
    if (state.socket !== socket) return; state.socket = undefined; state.welcome = undefined;
    for (const waiting of state.pending.values()) waiting.fail(new Error('The connection ended. Check whether it happened before trying again.')); state.pending.clear();
    if (event.code === 4003 && event.reason === 'AUTH_REVOKED') return forgotten('The desktop removed this browser.');
    later(event.code === 4001);
  };
  socket.send(JSON.stringify(hello));
}
function later(refused = false) {
  if (!state.wanted) return;
  state.retry++;
  if (refused && state.retry > 2) { say('The desktop did not accept this browser.'); problem('pairError', 'This browser is no longer paired with the desktop, or its access ended. Pair it again.'); show('workspace', false); show('showAccess', true); show('pair', true); return; }
  say('Not connected. Trying again…'); setTimeout(() => { if (state.wanted && !state.socket) open(); }, Math.min(30000, 1000 * 2 ** Math.min(state.retry, 5)));
}
function request(method, params = {}, extra = {}) {
  if (!state.socket || !state.welcome) return Promise.reject(new Error('Not connected to the desktop.'));
  const id = crypto.randomUUID();
  return new Promise((done, fail) => { state.pending.set(id, { done, fail }); state.socket.send(JSON.stringify({ v: 1, type: 'request', id, method, params, ...extra })); });
}
const mutate = (method, params) => request(method, params, { commandId: crypto.randomUUID() });
/** An action the desktop wants proved: signed for exactly these parameters, once. */
async function signed(method, params, key) {
  const { identity, welcome } = state, commandId = crypto.randomUUID(), paramsDigest = await digest(params);
  const challenge = await request('commands.challenge', { method, paramsDigest, commandId });
  const transcript = { domain: 'cere.mobile.action.v1', desktopId: identity.desktopId, deviceId: identity.deviceId, keyVersion: 1, scopeVersion: welcome.scopeVersion, epoch: welcome.epoch, authSessionId: welcome.authSessionId, challengeId: challenge.challengeId, nonce: challenge.nonce, method, paramsDigest, commandId };
  return request(method, params, { commandId, proof: { challengeId: challenge.challengeId, signature: await sign(key, transcript) } });
}

async function sync() {
  const snapshot = await request('sync.open', state.selected ? { selectedSessionId: state.selected } : {});
  state.sessions = snapshot.sessions; state.total = snapshot.sessionIds.length; state.approvals = snapshot.approvals || []; state.access = snapshot.permissions; state.projects = snapshot.projects; state.providers = snapshot.providers || {};
  show('pair', false); show('compare', false); show('workspace', true); show('showAccess', true);
  if (!$('workspace').dataset.view) $('workspace').dataset.view = 'list';
  if (state.selected && state.sessions.some(session => session.id === state.selected)) replaceMessages(snapshot.messages, snapshot.messagesBefore); else if (state.selected) choose('');
  drawSessions(); drawApprovals(); drawConversation(); if (state.selected) drawMessages(atBottom());
}
let pendingSync;
async function event_(frame) {
  if (frame.name === 'message.upsert') { if (frame.data.sessionId === state.selected) { const bottom = atBottom(); state.messages.set(frame.data.id, frame.data); drawMessages(bottom); } }
  else if (frame.name === 'device.revoked') forgotten('The desktop removed this browser.');
  else if (frame.name === 'remote.disabled') say('Remote access was switched off on the desktop.');
  else { clearTimeout(pendingSync); pendingSync = setTimeout(() => sync().catch(error => say(error.message)), 300); }
}
function replaceMessages(items, before) { state.messages = new Map(items.map(item => [item.id, item])); state.before = before; }
function earlierMessages(items, before) { state.messages = new Map([...items.map(item => [item.id, item]), ...state.messages]); state.before = before; }
const providerName = session => state.providers?.[session.provider]?.traits?.label || session.provider;
const current = () => state.sessions.find(session => session.id === state.selected);
const working = session => ['starting', 'working', 'waiting', 'stopping'].includes(session.status);
function drawSessions() {
  const list = $('sessions'), wanted = $('filter').value.trim().toLowerCase(); list.replaceChildren();
  for (const session of state.sessions.filter(item => !wanted || `${item.title} ${item.provider} ${providerName(item)}`.toLowerCase().includes(wanted))) {
    const button = element('button'), row = element('li'); button.type = 'button'; button.setAttribute('aria-current', String(session.id === state.selected));
    button.append(element('b', session.title || 'Conversation'), element('span', [providerName(session), working(session) ? session.status : '', state.approvals.some(item => item.sessionId === session.id) ? 'asks for something' : ''].filter(Boolean).join(' · ')));
    button.onclick = () => choose(session.id); row.append(button); list.append(row);
  }
  if (!list.children.length) list.append(element('li', wanted ? 'No conversation matches.' : 'No conversation in the projects this browser may see.', 'muted'));
  show('more', state.sessions.length < state.total);
}
async function choose(id) {
  state.selected = id; state.messages = new Map(); state.before = null; $('workspace').dataset.view = id ? 'conversation' : 'list'; drawSessions(); drawConversation();
  if (!id) return;
  try { const page = await request('sessions.messages', { sessionId: id, limit: 100 }); if (state.selected !== id) return; replaceMessages(page.items, page.before); drawMessages(true); if (may('sessions.read')) mutate('sessions.read', { sessionId: id }).catch(() => {}); $('main').focus({ preventScroll: true }); } catch (error) { problem('notice', error.message); }
}
const atBottom = () => { const list = $('messages'); return list.scrollHeight - list.scrollTop - list.clientHeight < 80; };
function drawMessages(follow) {
  const list = $('messages'), height = list.scrollHeight, top = list.scrollTop; list.replaceChildren();
  for (const item of state.messages.values()) {
    const mine = item.role === 'user' && item.kind !== 'delegation', row = element('li', undefined, item.desktopOnly || item.kind === 'delegation' ? 'note' : mine ? 'mine' : '');
    if (!row.classList.contains('note')) row.append(element('span', `${mine ? 'You' : state.identity.desktop} · ${new Date(item.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, 'who'));
    row.append(element('span', item.text, 'body'));
    if (item.contentTruncated) { const all = element('button', 'Show the whole message', 'quiet'); all.type = 'button'; all.onclick = async () => { all.disabled = true; try { let text = ''; for (let part = 0; part < item.textParts.count; part++) text += (await request('sessions.messagePart', { sessionId: item.sessionId, messageId: item.id, revision: item.revision, part })).content; state.messages.set(item.id, { ...item, text, contentTruncated: false }); drawMessages(false); } catch (error) { problem('notice', error.message); all.disabled = false; } }; row.append(all); }
    list.append(row);
  }
  list.scrollTop = follow ? list.scrollHeight : top + (list.scrollHeight - height > 0 && top === 0 ? list.scrollHeight - height : 0);
  show('earlier', !!state.before);
}
function drawConversation() {
  const session = current(); problem('notice', '');
  $('title').textContent = session ? session.title || 'Conversation' : 'Choose a conversation';
  $('about').textContent = session ? [providerName(session), session.model, working(session) ? session.status : ''].filter(Boolean).join(' · ') : '';
  show('back', !!session); show('stop', !!session && working(session) && may('sessions.stop')); $('stop').disabled = session?.status === 'stopping';
  const send = !!session && may('sessions.send') && session.canSend === true; show('composer', send); $('send').disabled = !!session && working(session) && !session.canQueue;
  show('readonly', !!session && !send); $('readonly').textContent = !session || send ? '' : may('sessions.send') ? 'Continue this conversation on the desktop.' : 'This browser reads; it does not send.';
  if (!session) $('messages').replaceChildren();
}
function drawApprovals() {
  const list = $('approvalList'), waiting = state.approvals; list.replaceChildren(); show('showApprovals', waiting.length > 0); $('showApprovals').textContent = waiting.length === 1 ? '1 request' : `${waiting.length} requests`;
  for (const item of waiting) {
    const box = element('section', undefined, 'request'), row = element('div', undefined, 'row'), problem_ = element('p', undefined, 'problem'); problem_.hidden = true;
    box.append(element('h3', item.title), element('p', state.sessions.find(session => session.id === item.sessionId)?.title || '', 'muted'), element('pre', item.detail + (Object.keys(item.fields || {}).length ? '\n\n' + Object.entries(item.fields).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n') : '')));
    const answer = async (choice, button) => {
      button.disabled = true; const params = { approvalId: item.id, revision: item.revision, digest: item.digest, choice };
      try { await (choice === 'allow' ? signed('approvals.answer', params, state.identity.action) : mutate('approvals.answer', params)); state.approvals = state.approvals.filter(other => other.id !== item.id); drawApprovals(); if (!state.approvals.length) $('approvals').close(); } catch (error) { problem_.textContent = error.message; problem_.hidden = false; button.disabled = false; }
    };
    if (item.choices?.includes('deny') !== false) { const deny = element('button', 'Deny'); deny.type = 'button'; deny.onclick = () => answer('deny', deny); row.append(deny); }
    if (item.canAnswer && item.choices?.includes('allow') && !item.questions?.length && state.welcome?.role === 'limited') { const allow = element('button', 'Allow', 'primary'); allow.type = 'button'; allow.onclick = async () => { if (await ask('Allow this?', item.title, 'Allow')) answer('allow', allow); }; row.append(allow); }
    else row.append(element('span', 'Allow it on the desktop or a paired phone.', 'muted'));
    box.append(row, problem_); list.append(box);
  }
  if (!waiting.length) list.append(element('p', 'Nothing is waiting.', 'muted'));
}
function ask(title, body, yes) {
  $('confirmTitle').textContent = title; $('confirmBody').textContent = body; $('confirmYes').textContent = yes; $('confirm').showModal(); $('confirmNo').focus();
  return new Promise(done => { const end = value => { $('confirm').close(); done(value); }; $('confirmYes').onclick = () => end(true); $('confirmNo').onclick = () => end(false); $('confirm').oncancel = () => done(false); });
}
async function forgotten(reason) { state.wanted = false; const socket = state.socket; state.socket = undefined; socket?.close(); await dropIdentity().catch(() => {}); state.identity = undefined; state.selected = ''; state.messages = new Map(); state.sessions = []; state.approvals = []; show('workspace', false); show('showAccess', false); show('showApprovals', false); begin(reason); }
function begin(reason) { say('Not paired'); show('compare', false); show('pair', true); problem('pairError', reason || ''); $('name').value ||= /Firefox/.test(navigator.userAgent) ? 'Firefox' : /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome/.test(navigator.userAgent) ? 'Chrome' : /Safari/.test(navigator.userAgent) ? 'Safari' : 'Browser'; $('code').focus(); }

$('pairForm').onsubmit = async event => {
  event.preventDefault(); problem('pairError', ''); $('pairSubmit').disabled = true;
  try { await dropIdentity().catch(() => {}); state.identity = await pair($('code').value, $('name').value.trim()); $('code').value = ''; state.retry = 0; await open(); }
  catch (error) { show('compare', false); begin(error.message); } finally { $('pairSubmit').disabled = false; }
};
$('pairCancel').onclick = () => { state.pairing?.close(); };
$('filter').oninput = drawSessions;
$('back').onclick = () => { $('workspace').dataset.view = 'list'; };
$('more').onclick = async () => { $('more').disabled = true; try { const page = await request('sessions.list', { offset: state.sessions.length }); const known = new Set(state.sessions.map(session => session.id)); state.sessions.push(...page.items.filter(session => !known.has(session.id))); state.total = page.total; drawSessions(); } catch (error) { say(error.message); } finally { $('more').disabled = false; } };
$('earlier').onclick = async () => { const id = state.selected; $('earlier').disabled = true; try { const page = await request('sessions.messages', { sessionId: id, before: state.before, limit: 100 }); if (state.selected === id) { earlierMessages(page.items, page.before); drawMessages(false); } } catch (error) { problem('notice', error.message); } finally { $('earlier').disabled = false; } };
$('stop').onclick = () => mutate('sessions.stop', { sessionId: state.selected }).catch(error => problem('notice', error.message));
$('composer').onsubmit = async event => {
  event.preventDefault(); const session = current(), text = $('text').value; if (!session || !text.trim()) return;
  $('send').disabled = true; problem('notice', '');
  try {
    const fresh = await request('sessions.get', { sessionId: session.id }), pauses = fresh.workbenchTakeover === 'acknowledge' ? fresh.workbenchFamilies : [];
    if (pauses.length && !await ask('Continue here?', `This conversation uses ${pauses.join(', ')} on the desktop. Sending from this browser pauses them until the desktop continues it.`, 'Continue here')) return;
    const params = { sessionId: session.id, text, expectedDraftRevision: fresh.draftRevision || '0', expectedConfigRevision: fresh.configRevision || '0', ...(fresh.routeRevision ? { expectedRouteRevision: fresh.routeRevision } : {}), ...(pauses.length ? { workbenchAcknowledged: pauses } : {}) };
    await signed('sessions.send', params, state.identity.connection); $('text').value = '';
  } catch (error) { problem('notice', error.message); } finally { drawConversation(); }
};
$('text').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('composer').requestSubmit(); } };
$('showApprovals').onclick = () => { drawApprovals(); $('approvals').showModal(); };
$('showAccess').onclick = async () => {
  const list = $('accessList'); list.replaceChildren(); problem('accessProblem', ''); $('access').showModal();
  const row = (name, value) => list.append(element('dt', name), element('dd', value));
  row('Desktop', state.identity?.desktop || ''); row('Name', state.identity?.name || '');
  try { const self = await request('devices.self'); row('Access', self.role === 'observer' ? 'Reads; can Stop and Deny' : 'Reads and sends'); row('Projects', (state.projects || []).map(project => project.name).join(', ') || 'None'); row('Until', new Date(self.expiresAt).toLocaleDateString([], { dateStyle: 'long' })); } catch (error) { problem('accessProblem', error.message); }
};
$('forget').onclick = async () => { $('access').close(); if (!await ask('Forget this browser?', 'Its keys are deleted here and the desktop stops accepting it. Pair it again to come back.', 'Forget')) return; if (state.welcome) await mutate('devices.selfRevoke', {}).catch(() => {}); forgotten(''); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
addEventListener('online', () => { if (state.wanted && !state.socket) { state.retry = 0; open(); } });

if (!globalThis.crypto?.subtle || !globalThis.indexedDB) { say('This browser cannot keep a key safely.'); show('pair', true); problem('pairError', 'Open this page over https, or at 127.0.0.1 on the desktop itself.'); show('pairForm', false); }
else loadIdentity().then(identity => { state.identity = identity; if (identity) open(); else begin(''); }, () => begin('This browser does not let the page keep its keys. Allow storage for this address, and do not use a private window.'));

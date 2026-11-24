// A stand-in browser for the desktop's pairing check: answers the open offer with the page's own protocol code, prints
// the six words it computed, and then how the desktop decided. Usage: browser-answer.ts ORIGIN CODE
import { randomUUID, webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
// @ts-expect-error plain JavaScript served to browsers
import { base64, canonical, derSignature, digest, pairingCode, random, sha256 } from '../../broker/remote/browser/protocol.js';

const [origin, code] = process.argv.slice(2), encoder = new TextEncoder();
const keys = async () => webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as Promise<any>;
const sign = async (key: any, value: unknown) => base64(derSignature(new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(canonical(value))))));
const open = async (pair: any) => base64(await webcrypto.subtle.exportKey('spki', pair.publicKey));
const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/browser/v1', 'cere.mobile.v1', { origin });
const frames: any[] = [], waiting: ((value: any) => void)[] = []; socket.on('message', bytes => { const frame = JSON.parse(String(bytes)); waiting.length ? waiting.shift()!(frame) : frames.push(frame); });
const next = () => frames.length ? Promise.resolve(frames.shift()) : new Promise<any>(done => waiting.push(done));
await new Promise((done, fail) => { socket.once('open', done); socket.once('error', fail); });
socket.send(JSON.stringify({ v: 1, type: 'browser.offer' })); const { offer } = await next(), connection = await keys(), action = await keys();
const body = { type: 'browser-response', v: 1, desktopId: offer.desktopId, pairingId: offer.pairingId, offerDigest: await digest(offer), nonce: offer.nonce, deviceId: randomUUID(), name: 'Work laptop', keyVersion: 1, connectionKey: await open(connection), actionKey: await open(action), deviceNonce: random(32) };
const transcript = { domain: 'pal.browser.pair.response.v1', response: body }, response = { ...body, connectionProof: await sign(connection.privateKey, transcript), actionProof: await sign(action.privateKey, transcript) };
const secret = await webcrypto.subtle.importKey('raw', encoder.encode(pairingCode(code)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const codeProof = base64(await webcrypto.subtle.sign('HMAC', secret, encoder.encode(canonical({ domain: 'pal.browser.pair.code.v1', offer, response: body }))));
socket.send(JSON.stringify({ v: 1, type: 'browser.pair', response, codeProof })); const received = await next(); if (received.type !== 'pair.received') { console.log(JSON.stringify(received)); process.exit(1); }
const words = await (await fetch(origin + '/words.json')).json() as string[], sum = await sha256(await digest(offer) + '.' + await digest(response)); console.log([...sum.slice(0, 6)].map((value: number) => words[value]).join(' '));
const outcome = await next(); console.log(outcome.type); socket.close(); process.exit(outcome.type === 'pair.confirmed' ? 0 : 1);

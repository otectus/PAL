// The few values both sides have to agree on byte for byte. Nothing here touches the page.
const encoder = new TextEncoder();
export const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const random = length => base64(crypto.getRandomValues(new Uint8Array(length)));
/** The same text for the same value on both sides (RFC 8785, for the plain values the protocol uses). */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
export const digest = async value => base64(await sha256(canonical(value)));
/** The browser signs as two numbers; the desktop reads the usual ASN.1 form. */
export function derSignature(raw) {
  const integer = bytes => { let at = 0; while (at < bytes.length - 1 && bytes[at] === 0) at++; const rest = bytes.slice(at), pad = rest[0] & 0x80 ? [0] : []; return [2, rest.length + pad.length, ...pad, ...rest]; };
  const body = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}
/** A code as it was typed: spaces, dashes and look-alike letters do not matter. */
export const pairingCode = text => text.toUpperCase().replace(/[^0-9A-Z]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');

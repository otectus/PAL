/**
 * Opt-in announcement on the local network (mobile plan §Reachability): `_pal._tcp.local` by multicast DNS, only while
 * the owner turned it on and an authorized gateway is listening on a local-network address. It says the protocol's major
 * version, the port and the desktop's ID; never a name, a project, a pairing secret or a token. An address found this way
 * is only a hint: the phone connects to it through the TLS pin it already holds.
 *
 * This answers questions about its own service and nothing else. It sends only on the addresses the gateway listens on,
 * and says goodbye when the gateway stops.
 */
import dgram from 'node:dgram';
import { BlockList, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export const serviceType = '_pal._tcp.local';
const group = '224.0.0.251', ttl = 120, PTR = 12, TXT = 16, SRV = 33, A = 1, ANY = 255;
export type Announcement = { id: string; major: number; port: number; addresses: string[] };
type Question = { name: string; type: number; unicast: boolean };

function encodeName(name: string) {
  const parts = name.split('.').filter(Boolean).map(part => { const bytes = Buffer.from(part); if (!bytes.length || bytes.length > 63) throw new Error('Invalid name'); return Buffer.concat([Buffer.from([bytes.length]), bytes]); });
  return Buffer.concat([...parts, Buffer.from([0])]);
}
function readName(data: Buffer, at: number): { name: string; next: number } {
  const labels: string[] = []; let position = at, next = -1, jumps = 0;
  for (;;) {
    if (position >= data.length) throw new Error('Truncated name');
    const length = data[position];
    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= data.length || ++jumps > 8) throw new Error('Invalid name');
      if (next < 0) next = position + 2;
      position = (length & 0x3f) << 8 | data[position + 1]; continue;
    }
    if (length > 63) throw new Error('Invalid name');
    if (!length) { if (next < 0) next = position + 1; break; }
    if (position + 1 + length > data.length || labels.length > 32) throw new Error('Truncated name');
    labels.push(data.subarray(position + 1, position + 1 + length).toString('utf8')); position += 1 + length;
  }
  return { name: labels.join('.').toLowerCase(), next };
}
/** The questions of a query; undefined for anything else or anything malformed. */
export function parseQuery(data: Buffer): { id: number; questions: Question[] } | undefined {
  try {
    if (data.length < 12 || data.length > 9000 || data.readUInt16BE(2) & 0x8000) return undefined;
    const count = data.readUInt16BE(4), questions: Question[] = []; let at = 12;
    for (let i = 0; i < Math.min(count, 32); i++) {
      const { name, next } = readName(data, at);
      if (next + 4 > data.length) return undefined;
      questions.push({ name, type: data.readUInt16BE(next), unicast: !!(data.readUInt16BE(next + 2) & 0x8000) }); at = next + 4;
    }
    return questions.length ? { id: data.readUInt16BE(0), questions } : undefined;
  } catch { return undefined; }
}
export function names(id: string) { const short = id.replace(/[^0-9a-f]/gi, '').slice(0, 12).toLowerCase(); return { instance: `pal-${short}.${serviceType}`, host: `pal-${short}.local` }; }
function record(name: string, type: number, data: Buffer, life: number, unique: boolean) {
  const head = Buffer.alloc(10); head.writeUInt16BE(type, 0); head.writeUInt16BE(unique ? 0x8001 : 1, 2); head.writeUInt32BE(life, 4); head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), head, data]);
}
/** The answer to questions about this service from one of its addresses; undefined when none of them concerns it. */
export function answer(announcement: Announcement, address: string, questions: Question[], options: { id?: number; legacy?: boolean; goodbye?: boolean } = {}): Buffer | undefined {
  const { instance, host } = names(announcement.id), life = options.goodbye ? 0 : options.legacy ? 10 : ttl;
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, announcement.port >> 8, announcement.port & 255]), encodeName(host)]);
  const text = [`v=${announcement.major}`, `id=${announcement.id}`].map(value => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]));
  const unique = !options.legacy;
  const build = { ptr: () => record(serviceType, PTR, encodeName(instance), life, false), srv: () => record(instance, SRV, srv, life, unique), txt: () => record(instance, TXT, Buffer.concat(text), life, unique), a: () => record(host, A, Buffer.from(address.split('.').map(Number)), life, unique), list: () => record('_services._dns-sd._udp.local', PTR, encodeName(serviceType), life, false) };
  const answers: Buffer[] = [], extra: Buffer[] = [];
  for (const question of questions) {
    const wants = (type: number) => question.type === type || question.type === ANY;
    if (question.name === serviceType && wants(PTR)) { answers.push(build.ptr()); extra.push(build.srv(), build.txt(), build.a()); }
    else if (question.name === '_services._dns-sd._udp.local' && wants(PTR)) answers.push(build.list());
    else if (question.name === instance) { if (wants(SRV)) { answers.push(build.srv()); extra.push(build.a()); } if (wants(TXT)) answers.push(build.txt()); }
    else if (question.name === host && wants(A)) answers.push(build.a());
  }
  if (!answers.length) return undefined;
  const head = Buffer.alloc(12); head.writeUInt16BE(options.legacy ? options.id || 0 : 0, 0); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(options.legacy ? questions.length : 0, 4); head.writeUInt16BE(answers.length, 6); head.writeUInt16BE(extra.length, 10);
  const echoed = options.legacy ? questions.map(question => { const tail = Buffer.alloc(4); tail.writeUInt16BE(question.type, 0); tail.writeUInt16BE(1, 2); return Buffer.concat([encodeName(question.name), tail]); }) : [];
  return Buffer.concat([head, ...echoed, ...answers, ...extra]);
}
/** A local-network address, where announcing makes sense; VPN and public addresses are never announced on. */
export const announceable = (address: string) => isIPv4(address) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);

type Bound = { socket: dgram.Socket; address: string; replies: number[]; network?: BlockList };
/** The network this address is on, so a question that came from another one is left alone. */
function networkOf(address: string) {
  const info = Object.values(networkInterfaces()).flat().find(item => item?.address === address && item.family === 'IPv4'), [base, bits] = info?.cidr?.split('/') || [];
  if (!base || !bits) return undefined;
  const list = new BlockList(); list.addSubnet(base, Number(bits)); return list;
}
export class Discovery {
  private bound = new Map<string, Bound>();
  private current?: Announcement;
  private timers = new Set<NodeJS.Timeout>();
  problem = '';
  private port: number;
  private create: () => dgram.Socket;
  private network: (address: string) => BlockList | undefined;
  constructor(options: { port?: number; create?: () => dgram.Socket; network?: (address: string) => BlockList | undefined } = {}) { this.port = options.port ?? 5353; this.network = options.network || networkOf; this.create = options.create || (() => dgram.createSocket({ type: 'udp4', reuseAddr: true })); }
  get active() { return [...this.bound.keys()]; }
  /** Announces exactly this, or nothing. Calling it again with the same values changes nothing. */
  async set(announcement: Announcement | undefined) {
    const wanted = announcement ? announcement.addresses.filter(announceable) : [];
    const same = JSON.stringify(announcement) === JSON.stringify(this.current) && wanted.length === this.bound.size && wanted.every(address => this.bound.has(address));
    if (same) return;
    await this.stop();
    if (!announcement || !wanted.length) return;
    this.current = announcement; this.problem = '';
    for (const address of wanted) {
      try { await this.bind(address); } catch (error: any) { this.problem = error?.code === 'EADDRINUSE' ? 'Another program on this computer keeps the multicast DNS port to itself, so phones cannot find it here.' : String(error?.message || error).slice(0, 200); }
    }
  }
  private async bind(address: string) {
    const socket = this.create(), network = this.network(address), entry: Bound = { socket, address, replies: [], ...(network ? { network } : {}) };
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind({ port: this.port, exclusive: false }, () => { socket.off('error', reject); resolve(); }); });
    socket.on('error', () => { this.bound.delete(address); try { socket.close(); } catch { /* gone */ } });
    try { socket.setMulticastTTL(255); socket.setMulticastLoopback(true); socket.addMembership(group, address); socket.setMulticastInterface(address); }
    catch (error) { socket.close(); throw error; }
    socket.on('message', (data, from) => this.receive(entry, data, from));
    this.bound.set(address, entry);
    // Announced twice, a second apart, as the standard asks.
    this.announce(entry);
    const again = setTimeout(() => { this.timers.delete(again); this.announce(entry); }, 1000); again.unref(); this.timers.add(again);
  }
  private announce(entry: Bound, goodbye = false) {
    if (!this.current) return;
    const { instance } = names(this.current.id);
    const message = answer(this.current, entry.address, [{ name: serviceType, type: PTR, unicast: false }, { name: instance, type: ANY, unicast: false }], { goodbye });
    if (message) try { entry.socket.send(message, this.port, group, () => {}); } catch { /* closing */ }
  }
  /** At most ten answers a second on an interface, and only about this service. */
  private receive(entry: Bound, data: Buffer, from: dgram.RemoteInfo) {
    if (entry.network && (!isIPv4(from.address) || !entry.network.check(from.address))) return;
    const query = parseQuery(data); if (!query || !this.current) return;
    const legacy = from.port !== 5353, message = answer(this.current, entry.address, query.questions, { id: query.id, legacy });
    if (!message) return;
    const now = Date.now(); entry.replies = entry.replies.filter(time => now - time < 1000);
    if (entry.replies.length >= 10) return;
    entry.replies.push(now);
    const direct = legacy || query.questions.some(question => question.unicast);
    try { entry.socket.send(message, direct ? from.port : this.port, direct ? from.address : group, () => {}); } catch { /* closing */ }
  }
  async stop() {
    for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    const closing = [...this.bound.values()];
    for (const entry of closing) this.announce(entry, true);
    this.bound.clear(); this.current = undefined;
    await Promise.all(closing.map(entry => new Promise<void>(resolve => { setTimeout(() => { try { entry.socket.close(() => resolve()); } catch { resolve(); } }, 20); })));
  }
}

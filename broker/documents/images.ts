/** Images inside a document: only bytes it already carries, as bounded PNG or JPEG data. No address is ever fetched. */
export type Embedded = { mime: 'image/png' | 'image/jpeg'; data: Buffer; width: number; height: number };
export const imageLimits = { bytes: 5 * 1024 * 1024, edge: 12_000 };

function size(data: Buffer, mime: Embedded['mime']): { width: number; height: number } | undefined {
  if (mime === 'image/png') return data.length > 24 && data.readUInt32BE(0) === 0x89504e47 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : undefined;
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  for (let at = 2; at + 9 < data.length;) {
    if (data[at] !== 0xff) return undefined;
    const marker = data[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
    if (marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
    at += 2 + data.readUInt16BE(at + 2);
  }
  return undefined;
}
export function embeddedImage(source: string): Embedded | undefined {
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(source);
  if (!match || match[2].length > imageLimits.bytes * 4 / 3 + 4) return undefined;
  const data = Buffer.from(match[2], 'base64'), mime = match[1] as Embedded['mime'], box = size(data, mime);
  if (!box || !box.width || !box.height || box.width > imageLimits.edge || box.height > imageLimits.edge) return undefined;
  return { mime, data, ...box };
}

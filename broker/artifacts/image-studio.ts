import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, type ArtifactVersion, safeName, artifactLimits } from './store.ts';
import { zipFilesAsync } from './zip.ts';
import { contactSheet, inspect, normalizeMask } from '../media/transforms.ts';
import { z } from 'zod';

const ref = z.object({ artifactId: z.uuid(), versionId: z.uuid() });
const refs = z.array(ref).min(1).max(16);
const readImage = (data: Buffer) =>
  sharp(data, { limitInputPixels: artifactLimits.imagePixels }).rotate().toColourspace('srgb');
type ImageRef = z.infer<typeof ref>;

export async function similarImages(store: ArtifactStore, session: string, input: ImageRef, scope: string) {
  async function fingerprint(v: ArtifactVersion): Promise<Uint8Array> {
    const cached = store.store.db
      .prepare('SELECT fingerprint FROM image_analysis WHERE version_id=?')
      .get(v.versionId)?.fingerprint;
    if (cached instanceof Uint8Array) return cached;
    const { data } = await store.bytes(session, v.artifactId, v.versionId);
    const signature = await readImage(data)
      .resize(8, 8, { fit: 'fill' })
      .flatten({ background: '#808080' })
      .removeAlpha()
      .raw()
      .toBuffer();
    store.store.db
      .prepare(
        'INSERT INTO image_analysis(version_id,fingerprint) VALUES(?,?) ON CONFLICT(version_id) DO UPDATE SET fingerprint=excluded.fingerprint',
      )
      .run(v.versionId, signature);
    return signature;
  }
  const target = store.version(session, input.artifactId, input.versionId);
  const signature = await fingerprint(target);
  const best: (ReturnType<ArtifactStore['list']>['artifacts'][number] & { similarity: number })[] = [];
  let before: string | undefined;
  do {
    const page = store.list(session, { scope, kind: 'image', before, limit: 100 });
    for (const item of page.artifacts) {
      if (item.id === target.artifactId) continue;
      const other = await fingerprint(item.latest).catch(() => null);
      if (!other || other.length !== signature.length) continue;
      let dist = 0;
      for (let i = 0; i < other.length; i++) dist += Math.abs(other[i] - signature[i]);
      best.push({ ...item, similarity: Math.round(100 * (1 - dist / (255 * other.length))) });
    }
    best.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
    best.splice(60);
    before = page.before;
  } while (before);
  return { artifacts: best.filter((item) => store.authorized(session, item.id)) };
}

function connectedPixels(width: number, height: number, seeds: number[], include: (index: number) => boolean) {
  const queue = new Int32Array(width * height),
    visited = Buffer.alloc(width * height);
  let front = 0,
    back = 0;
  const visit = (index: number) => {
    if (visited[index]) return;
    visited[index] = include(index) ? 255 : 1;
    if (visited[index] === 255) queue[back++] = index;
  };
  for (const seed of seeds) visit(seed);
  while (front < back) {
    const i = queue[front++];
    if (i % width) visit(i - 1);
    if (i % width < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < visited.length - width) visit(i + width);
  }
  return visited;
}

/** Select a connected colour region. A bounded preview grid keeps pointer latency and memory independent of source size. */
export async function selectColour(
  data: Buffer,
  point: { x: number; y: number },
  tolerance: number,
  invert: boolean,
  subject = false,
) {
  const { width, height } = await inspect(data);
  if (
    ![point?.x, point?.y].every(Number.isFinite) ||
    point.x < 0 ||
    point.x >= width ||
    point.y < 0 ||
    point.y >= height
  )
    throw new Error('Choose a pixel inside the image');
  const size = Math.min(1, 1024 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * size)),
    h = Math.max(1, Math.round(height * size));
  const pixels = await readImage(data).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const start = Math.floor((point.y * h) / height) * w + Math.floor((point.x * w) / width);
  const cutoff = Math.min(255, Math.max(0, Number.isFinite(tolerance) ? tolerance : 32));
  const near = (a: number, b: number) => {
    for (let c = 0; c < 4; c++) if (Math.abs(pixels[4 * a + c] - pixels[4 * b + c]) > cutoff) return false;
    return true;
  };
  let visited: Buffer;
  if (subject) {
    // Estimate background from the most frequent perimeter colours. Flooding from the perimeter
    // keeps enclosed regions of matching colour (e.g. white lettering on a white backdrop).
    const border: number[] = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
    const bins = new Map<number, { count: number; index: number }>();
    for (const i of border) {
      const key =
        ((pixels[4 * i] >> 4) << 12) |
        ((pixels[4 * i + 1] >> 4) << 8) |
        ((pixels[4 * i + 2] >> 4) << 4) |
        (pixels[4 * i + 3] >> 4);
      const bin = bins.get(key);
      if (bin) bin.count++;
      else bins.set(key, { count: 1, index: i });
    }
    const palette = [...bins.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .filter((bin) => bin.count >= border.length * 0.03 && !near(bin.index, start))
      .map((bin) => bin.index);
    if (!palette.length)
      throw new Error('The subject blends into the border. Lower color tolerance or paint the selection.');
    const background = connectedPixels(w, h, border, (i) => palette.some((colour) => near(i, colour)));
    visited = connectedPixels(w, h, [start], (i) => background[i] !== 255);
  } else {
    visited = connectedPixels(w, h, [start], (i) => near(i, start));
  }
  for (let i = 0; i < visited.length; i++) visited[i] = (visited[i] === 255) !== invert ? 255 : 0;
  const alpha = await sharp(visited, { raw: { width: w, height: h, channels: 1 } })
    .resize(width, height, { kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

export async function cutout(data: Buffer, mask: Buffer) {
  const facts = await inspect(data);
  const { bytes } = await normalizeMask(mask, facts);
  const alpha = await sharp(bytes).greyscale().raw().toBuffer();
  const { data: pixels, info } = await readImage(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < alpha.length; i++) pixels[4 * i + 3] = Math.round((pixels[4 * i + 3] * alpha[i]) / 255);
  return sharp(pixels, { raw: info }).png().toBuffer();
}

export async function difference(a: Buffer, b: Buffer) {
  const [left, right] = await Promise.all(
    [a, b].map((data) => readImage(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true })),
  );
  if (left.info.width !== right.info.width || left.info.height !== right.info.height)
    throw new Error('Pixel differences require equal dimensions');
  let changed = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    if (left.data.readUInt32BE(i) === right.data.readUInt32BE(i)) left.data[i + 3] = 0;
    else {
      left.data.writeUInt32BE(0xff2860c0, i);
      changed++;
    }
  }
  const overlay = await sharp(left.data, { raw: left.info })
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return { overlay: 'data:image/png;base64,' + overlay.toString('base64'), changed };
}

export async function extendedCanvas(data: Buffer, ratio: number) {
  if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4)
    throw new Error('Choose an aspect ratio between 1:4 and 4:1');
  const base = await readImage(data).ensureAlpha().png().toBuffer(),
    original = await inspect(base);
  const w = Math.max(original.width, Math.round(original.height * ratio)),
    h = Math.max(original.height, Math.round(original.width / ratio));
  if (w === original.width && h === original.height)
    throw new Error('Choose a different aspect ratio to expand the canvas');
  if (w * h > artifactLimits.imagePixels) throw new Error('The expanded image exceeds 64 megapixels');
  const left = Math.floor((w - original.width) / 2),
    top = Math.floor((h - original.height) / 2);
  const bytes = await sharp(base)
    .extend({ left, top, right: w - left - original.width, bottom: h - top - original.height, background: '#00000000' })
    .png()
    .toBuffer();
  const inner = await sharp({
    create: { width: original.width, height: original.height, channels: 3, background: '#000000' },
  })
    .png()
    .toBuffer();
  const mask = await sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
    .composite([{ input: inner, left, top }])
    .greyscale()
    .png()
    .toBuffer();
  return { bytes, mask, sourceBounds: { left, top, width: original.width, height: original.height } };
}

export const deliveryPresets = {
  icons: [
    [32, 32],
    [128, 128],
    [512, 512],
  ],
  documentation: [
    [640, 360],
    [1280, 720],
  ],
  slides: [
    [1280, 720],
    [1920, 1080],
  ],
};
const deliveryOptions = z.object({
  items: refs,
  preset: z.enum(['icons', 'documentation', 'slides']),
  fit: z.enum(['contain', 'cover']),
  manifest: z.boolean().default(true),
  sheet: z.boolean().default(true),
  originals: z.boolean().default(false),
  prefix: z.string().max(80).default(''),
});
export async function deliverySample(store: ArtifactStore, sessionId: string, input: unknown) {
  const options = deliveryOptions.parse(input);
  const { width, height } = z.object({ width: z.int(), height: z.int() }).parse(input);
  if (options.items.length !== 1 || !deliveryPresets[options.preset].some((s) => s[0] === width && s[1] === height))
    throw new Error('Choose an export preview');
  const item = options.items[0],
    { data } = await store.bytes(sessionId, item.artifactId, item.versionId);
  const png = await readImage(data)
    .resize(width, height, { fit: options.fit, position: 'centre', background: '#00000000' })
    .png()
    .toBuffer();
  return { image: 'data:image/png;base64,' + png.toString('base64') };
}
export async function deliver(
  store: ArtifactStore,
  sessionId: string,
  input: unknown,
  preview: boolean,
  portableRecipe?: (id: string) => Promise<string>,
) {
  const options = deliveryOptions.parse(input),
    sizes = deliveryPresets[options.preset];
  const entries: { name: string; data: Buffer }[] = [],
    samples: { bytes: Buffer; label: string }[] = [];
  const outputs: {
    name: string;
    width: number;
    height: number;
    thumbnail?: string;
    warnings: string[];
    source: ImageRef;
  }[] = [];
  const sources: object[] = [];
  let total = 0;
  function add(name: string, data: Buffer) {
    total += data.length;
    if (total > artifactLimits.bytes)
      throw new Error('Export exceeds 100 MiB. Choose fewer sources or omit originals.');
    entries.push({ name, data });
  }
  let index = 0;
  for (const item of options.items) {
    const { version, data } = await store.bytes(sessionId, item.artifactId, item.versionId);
    const facts = await inspect(data);
    const stem = safeName(options.prefix.trim() || version.name.replace(/\.[^.]+$/, ''), 'image').replace(/[:]/g, '-');
    const prefix = options.items.length === 1 ? stem : index + 1 + '-' + stem;
    index++;
    let recipeFile, recipeNote;
    const recipe = version.provenance.recipe;
    if (
      !preview &&
      options.manifest &&
      portableRecipe &&
      typeof recipe === 'object' &&
      recipe &&
      'recipeId' in recipe &&
      typeof recipe.recipeId === 'string'
    ) {
      let portable: string | undefined;
      try {
        portable = await portableRecipe(recipe.recipeId);
      } catch (error) {
        recipeNote = error instanceof Error ? error.message : 'Source recipe unavailable';
      }
      if (portable !== undefined) {
        recipeFile = 'recipes/' + index + '.pal-image.json';
        add(recipeFile, Buffer.from(portable));
      }
    }
    sources.push({
      recipeFile,
      recipeNote,
      ...item,
      name: version.name,
      sha256: version.sha256,
      parents: version.parents,
      provenance: version.provenance,
    });
    if (options.originals && !preview)
      add('originals/' + index + '-' + safeName(version.name).replace(/:/g, '-'), data);
    let boxes: { left: number; top: number; width: number; height: number }[] = [];
    const row = store.store.db.prepare('SELECT boxes FROM image_analysis WHERE version_id=?').get(item.versionId);
    if (row?.boxes) boxes = JSON.parse(String(row.boxes));
    for (const [width, height] of sizes) {
      const name = prefix + '-' + width + (width === height ? '' : 'x' + height) + '.png';
      const bytes = await readImage(data)
        .resize(width, height, { fit: options.fit, position: 'centre', background: '#00000000' })
        .png()
        .toBuffer();
      const warnings: string[] = [];
      if (
        options.preset === 'icons' &&
        !version.image?.transparent &&
        (options.fit === 'cover' || facts.width === facts.height)
      )
        warnings.push('Opaque background');
      if (options.fit === 'cover' && Math.abs(facts.width / facts.height - width / height) > 0.001) {
        const scale = Math.max(width / facts.width, height / facts.height),
          dx = (facts.width - width / scale) / 2,
          dy = (facts.height - height / scale) / 2;
        warnings.push(
          boxes.some(
            (b) =>
              b.left < dx || b.top < dy || b.left + b.width > facts.width - dx || b.top + b.height > facts.height - dy,
          )
            ? 'Crop clips recognized text'
            : 'Center crop removes edges',
        );
      }
      const ratios = [width / facts.width, height / facts.height];
      if ((options.fit === 'cover' ? Math.max(...ratios) : Math.min(...ratios)) > 1)
        warnings.push('Enlarged from source');
      const thumbnail = preview
        ? 'data:image/png;base64,' +
          (await sharp(bytes).resize(144, 96, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()).toString(
            'base64',
          )
        : undefined;
      outputs.push({ name, width, height, thumbnail, warnings, source: item });
      if (!preview) {
        add(name, bytes);
        if (sizes[0][0] === width && options.sheet) samples.push({ bytes, label: prefix });
      }
    }
  }
  if (preview) return { outputs };
  if (options.sheet) add('contact-sheet.png', await contactSheet(samples));
  if (options.manifest)
    add(
      'manifest.json',
      Buffer.from(JSON.stringify({ schema: 1, preset: options.preset, fit: options.fit, sources, outputs }, null, 2)),
    );
  const version = await store.install({
    sessionId,
    name: safeName(options.prefix || options.preset) + '-kit.zip',
    bytes: await zipFilesAsync(entries),
    mime: 'application/zip',
    source: 'derived',
    policy: store.inherit(sessionId, options.items),
    parents: options.items.map((x) => ({ ...x, relation: 'delivery' })),
    provenance: { kind: 'image-delivery', preset: options.preset },
  });
  return { artifactId: version.artifactId, versionId: version.versionId, name: version.name, outputs };
}

/** Use a private working copy with a format suffix. Local inspection must not fetch remote manifests or trust material. */
export async function credentials(bytes: Buffer, format: string) {
  const dir = await mkdtemp(join(tmpdir(), 'pal-credentials-'));
  try {
    const file = join(dir, 'input.' + (/^(png|jpeg|webp|gif|tiff|avif)$/.test(format) ? format : 'bin'));
    await writeFile(file, bytes, { mode: 0o600 });
    const settings = join(dir, 'settings.toml');
    await writeFile(settings, '[verify]\nremote_manifest_fetch = false\nocsp_fetch = false\n');
    const { stdout } = await promisify(execFile)('c2patool', [file, '--settings', settings], {
      cwd: dir,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(stdout),
      active = report.manifests?.[report.active_manifest];
    if (!active) return { status: 'No embedded manifest' };
    return {
      status: 'Embedded manifest',
      issuer: active.signature_info?.issuer || '',
      title: active.title || '',
      validation: report.validation_state || 'See validation details',
      issues: report.validation_status || [],
    };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { status: 'Install c2patool to inspect signed Content Credentials' };
    if (/no .*manifest|manifest.*not found|no claim/i.test(e.stderr || '')) return { status: 'No embedded manifest' };
    throw new Error('Content Credentials could not be read: ' + String(e.stderr || e.message).slice(0, 350));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Both drawn sheets and articulated sprites feed the same native surface player.
import sharp from 'sharp';
import { rename, writeFile } from 'node:fs/promises';

const motions = {
  wave: 'wave',
  greeting: 'wave',
  goodbye: 'wave',
  thinking: 'thinking',
  ponder: 'thinking',
  curious: 'thinking',
  skeptical: 'thinking',
  explainOpen: 'present',
  explainSweep: 'present',
  speaking: 'present',
  listen: 'present',
  approval: 'present',
  celebrate: 'celebrate',
  success: 'celebrate',
  fistPump: 'celebrate',
  shy: 'shy',
  blush: 'shy',
  hoverBlush: 'shy',
  clickBlush: 'shy',
  dragging: 'carry',
};

export async function packSurfaceAtlas({ id, open, closed, fullW, fullH, W, H, rect, frames }) {
  const columns = 16;
  const cellCount = frames.length + frames.filter((frame) => frame.closed).length;
  const width = W * columns,
    height = fullH + Math.ceil(cellCount / columns) * H;
  const atlas = Buffer.alloc(width * height * 4);
  function blit(data, w, h, left, top) {
    for (let y = 0; y < h; y++) data.copy(atlas, ((top + y) * width + left) * 4, y * w * 4, (y + 1) * w * 4);
  }
  blit(open, fullW, fullH, 0, 0);
  blit(closed, fullW, fullH, fullW, 0);
  let cell = 0;
  function putFrame(data) {
    const x = (cell % columns) * W,
      y = fullH + Math.floor(cell / columns) * H;
    cell++;
    blit(data, W, H, x, y);
    return [x, y, W, H];
  }
  const surfaceFrames = [],
    routes = {};
  for (const frame of frames) {
    const entry = { sourceRect: putFrame(frame.data) };
    if (frame.closed) entry.blinkSourceRect = putFrame(frame.closed);
    surfaceFrames.push(entry);
    const route = (routes[frame.name] ??= {
      frames: [0],
      frameMs: 1000 / 60,
      holdMs: frame.name === 'shy' ? 1400 : 850,
    });
    route.frames.push(surfaceFrames.length);
  }
  routes.carry.loopMode = 'pingPong';
  routes.carry.loopStart = 15;
  const texture = id + '-surface.png';
  const rig = {
    texture,
    presentation: 'reference',
    parts: [
      {
        name: 'reference',
        bone: 'root',
        sourceRect: [0, 0, fullW, fullH],
        blinkSourceRect: [fullW, 0, fullW, fullH],
        rect,
        surfaceMotion: true,
        z: 0,
        surfaceFrames,
      },
    ],
    surfaceSequences: { routes, motions },
  };
  const path = 'assets/' + texture;
  await sharp(atlas, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(path + '.tmp');
  await rename(path + '.tmp', path);
  await writeFile('assets/' + id + '-surface-rig.json', JSON.stringify(rig, null, 2) + '\n');
  return rig;
}

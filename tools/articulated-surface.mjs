// Bake mechanical joints from a registered transparent front view. Runtime playback uses
// the same connected surface frames, hit mask and reduced-motion path as drawn sheets.
import sharp from 'sharp';
import { readFile, rename } from 'node:fs/promises';
import { basename } from 'node:path';
import { avatarRoutes } from '../broker/avatars.ts';
import { packSurfaceAtlas } from './avatar-surface-atlas.mjs';

const sideNames = ['left', 'right'];
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);
const jointName = (side, joint) => side + capitalize(joint);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
function smooth(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}
function svg(width, height, body) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}">${body}</svg>`,
  );
}

// Cubic Hermite interpolation keeps angular velocity continuous through a multi-key gesture.
function sample(keys, time, t) {
  if (t <= 0) return keys[0];
  if (t >= 1) return keys.at(-1);
  const b = time.findIndex((value) => value >= t),
    a = b - 1;
  const span = time[b] - time[a],
    u = (t - time[a]) / span;
  const slope = (i) =>
    i === 0 || i === time.length - 1 ? 0 : (keys[i + 1] - keys[i - 1]) / (time[i + 1] - time[i - 1]);
  const blend = u * u * (3 - 2 * u);
  return keys[a] * (1 - blend) + keys[b] * blend + span * u * (1 - u) * (slope(a) * (1 - u) - slope(b) * u);
}

// The emissive display is painted into the reference image. Separate its local light
// from the reflected visor, then reshape that same light for gaze, blinks and expressions.
function makeDisplay(image, eyes) {
  const {
    data,
    info: { width },
  } = image;
  const rx = 58,
    ry = 76,
    top = Math.min(...eyes.map((p) => p[1])) - ry;
  const left = Math.min(...eyes.map((p) => p[0])) - rx,
    right = Math.max(...eyes.map((p) => p[0])) + rx;
  const w = right - left + 1,
    h = Math.max(...eyes.map((p) => p[1])) + ry - top + 1;
  const neutral = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    data.copy(neutral, y * w * 4, ((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4);
  const at = (x, y, c) => data[(y * width + x) * 4 + c];
  function patch(pose, amount, shut) {
    const pixels = Buffer.from(neutral);
    const sx = 1 + ((pose?.width ?? 1) - 1) * amount,
      sy = shut ? 0.12 : 1 + ((pose?.height ?? 1) - 1) * amount;
    for (const [cx, cy] of eyes) {
      const visor = (x, y, c) =>
        at(cx - rx, y, c) + ((at(cx + rx, y, c) - at(cx - rx, y, c)) * (x - cx + rx)) / (2 * rx);
      const light = (x, y, c) =>
        Math.abs(x - cx) < rx && Math.abs(y - cy) < ry ? Math.max(0, at(x, y, c) - visor(x, y, c)) : 0;
      for (let y = cy - ry; y <= cy + ry; y++)
        for (let x = cx - rx; x <= cx + rx; x++) {
          const tx = (x - cx - (pose?.look[0] ?? 0) * amount) / sx;
          const bend = shut ? 0 : (pose?.curve ?? 0) * amount * Math.min(1.4, (tx / 20) ** 2);
          const ty = (y - cy - (pose?.look[1] ?? 0) * amount - bend - (shut ? 2 : 0)) / sy;
          const px = Math.floor(cx + tx),
            py = Math.floor(cy + ty),
            fx = cx + tx - px,
            fy = cy + ty - py;
          const mix = smooth((rx - Math.abs(x - cx)) / 8) * smooth((ry - Math.abs(y - cy)) / 8);
          for (let c = 0; c < 3; c++) {
            const emission =
              (1 - fy) * ((1 - fx) * light(px, py, c) + fx * light(px + 1, py, c)) +
              fy * ((1 - fx) * light(px, py + 1, c) + fx * light(px + 1, py + 1, c));
            const value = at(x, y, c) * (1 - mix) + (visor(x, y, c) + emission) * mix;
            pixels[((y - top) * w + x - left) * 4 + c] = Math.min(255, Math.round(value));
          }
        }
    }
    return pixels;
  }
  async function markup(pose, amount, shut) {
    const pixels = patch(pose, amount, shut);
    const png = await sharp(pixels, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer();
    let marks = '';
    if (pose.cheeks) {
      for (const [cx, cy] of eyes) {
        const side = cx < left + w / 2 ? -1 : 1;
        for (const offset of [34, 45]) {
          const x = cx + side * offset,
            y = cy + 38;
          marks += `<path d="M${x} ${y}l-5 8" stroke="#6eeef2" stroke-width="5" opacity="${amount * 0.73}" stroke-linecap="round"/>`;
        }
      }
    }
    return (
      `<image x="${left}" y="${top}" width="${w}" height="${h}" xlink:href="data:image/png;base64,${png.toString('base64')}"/>` +
      marks
    );
  }
  const closed = Buffer.from(data),
    blink = patch(null, 0, true);
  for (let y = 0; y < h; y++) blink.copy(closed, ((top + y) * width + left) * 4, y * w * 4, (y + 1) * w * 4);
  return { closed, markup };
}

async function makeLayers(config, image) {
  const { width, height } = image.info;
  const paths = new Map();
  for (const [region, d] of Object.entries(config.regions)) {
    if (region === 'head') {
      paths.set(region, `<path d="${d}"/>`);
      continue;
    }
    paths.set(jointName('left', region), `<path d="${d}"/>`);
    paths.set(
      jointName('right', region),
      `<path d="${d}" transform="translate(${2 * config.mirrorX} 0) scale(-1 1)"/>`,
    );
  }
  const definitions = [...paths].map(([key, path]) => `<clipPath id="i-${key}">${path}</clipPath>`).join('');
  const layers = {};
  async function cut(key, inside = [], outside = [], source = image.data) {
    let shape = '<rect width="100%" height="100%" fill="white"/>';
    for (const name of inside) shape = `<g clip-path="url(#i-${name})">${shape}</g>`;
    const holes = outside.map((name) => paths.get(name)).join('');
    // Cut each piece once. Trim its transparent margins before serializing it as a sprite.
    const mask = await sharp(
      svg(
        width,
        height,
        `<defs>${definitions}<mask id="holes"><rect width="100%" height="100%" fill="white"/><g fill="black">${holes}</g></mask></defs><g mask="url(#holes)">${shape}</g>`,
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer();
    const data = Buffer.from(source);
    let x0 = width,
      y0 = height,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4 + 3;
        data[i] = Math.round((data[i] * mask[i]) / 255);
        if (data[i]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    if (x1 < x0) throw Error('Empty articulated layer: ' + key);
    const w = x1 - x0 + 1,
      h = y1 - y0 + 1;
    const bytes = await sharp(data, { raw: image.info })
      .extract({ left: x0, top: y0, width: w, height: h })
      .png()
      .toBuffer();
    layers[key] =
      `<image x="${x0}" y="${y0}" width="${w}" height="${h}" xlink:href="data:image/png;base64,${bytes.toString('base64')}"/>`;
  }
  await cut('torso', [], ['head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']);
  await cut('head', ['head']);
  if (config.cuppedHand) {
    const { image, rect, rotation } = config.cuppedHand;
    if (basename(image) !== image) throw Error('Expected a hand artwork filename');
    const [x, y, width, height] = rect;
    const png = await sharp('reference/' + image, { density: 192 }).png().toBuffer();
    const art = `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" xlink:href="data:image/png;base64,${png.toString('base64')}"/>`;
    const [wx, wy] = config.pivots.wrist;
    for (const side of sideNames) {
      const left = side === 'left';
      const pivotX = left ? wx : 2 * config.mirrorX - wx;
      layers[jointName(side, 'cuppedHand')] =
        `<g transform="translate(${pivotX} ${wy}) scale(${left ? 1 : -1} 1) rotate(${rotation})">${art}</g>`;
    }
  }
  for (const side of sideNames) {
    const n = (key) => jointName(side, key);
    await cut(n('upper'), [n('arm')], [n('belowElbow')]);
    await cut(n('lower'), [n('arm'), n('belowElbow')], [n('belowWrist')]);
    await cut(n('hand'), [n('arm'), n('belowWrist')]);
    await cut(n('thigh'), [n('leg')], [n('belowKnee'), n('arm')]);
    await cut(n('shin'), [n('leg'), n('belowKnee')], [n('arm')]);
  }
  return layers;
}

function compose(config, layers, angles, display) {
  function pivot(side, joint) {
    const [x, y] = config.pivots[joint];
    return [side === 'right' ? 2 * config.mirrorX - x : x, y];
  }
  function rotate(part, angle, [x, y]) {
    return angle ? `<g transform="rotate(${angle} ${x} ${y})">${part}</g>` : part;
  }
  // Hidden graphite sockets occupy the back of each cut joint when its shells rotate apart.
  function socket(point, rx, ry, angle) {
    if (!angle) return '';
    return `<ellipse cx="${point[0]}" cy="${point[1]}" rx="${rx}" ry="${ry}" fill="url(#graphite)"/>`;
  }
  function arm(side) {
    const n = (key) => jointName(side, key),
      p = (key) => pivot(side, key);
    const shoulder = angles[n('shoulder')],
      elbow = angles[n('elbow')],
      wrist = angles[n('wrist')];
    const cup = clamp01(angles.handCup ?? 0);
    let fingers = layers[n('hand')];
    if (cup > 0) {
      const cupped = layers[n('cuppedHand')];
      if (!cupped) throw Error('The handCup channel requires cupped hand artwork');
      fingers = cup === 1 ? cupped : `<g opacity="${1 - cup}">${fingers}</g><g opacity="${cup}">${cupped}</g>`;
    }
    const hand = rotate(fingers, wrist, p('wrist'));
    const forearm = rotate(socket(p('wrist'), 26, 18, wrist) + layers[n('lower')] + hand, elbow, p('elbow'));
    return (
      socket(p('shoulder'), 28, 31, shoulder) +
      rotate(socket(p('elbow'), 19, 20, elbow) + layers[n('upper')] + forearm, shoulder, p('shoulder'))
    );
  }
  function leg(side) {
    const n = (key) => jointName(side, key),
      p = (key) => pivot(side, key);
    const hip = angles[n('hip')],
      knee = angles[n('knee')];
    const shin = rotate(layers[n('shin')], knee, p('knee'));
    return (
      socket(p('hip'), 24, 27, hip) +
      rotate(socket(p('knee'), 33, 32, knee) + layers[n('thigh')] + shin, hip, p('hip'))
    );
  }
  const head = rotate(layers.head + display, angles.head, config.pivots.head);
  return (
    '<defs><radialGradient id="graphite" cx=".35" cy=".25" r=".9"><stop stop-color="#515155"/><stop offset="1" stop-color="#1c1c20"/></radialGradient></defs>' +
    sideNames.map(leg).join('') +
    layers.torso +
    head +
    sideNames.map(arm).join('')
  );
}

export async function bakeArticulatedSurface(id, source, mode = 'all') {
  const config = JSON.parse(await readFile('reference/' + source, 'utf8'));
  if (basename(config.image) !== config.image) throw Error('Expected a reference image filename');
  const image = await sharp('reference/' + config.image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: fullW, height: fullH } = image.info,
    [W, H] = config.frameSize;
  const display = makeDisplay(image, config.eyes);
  const layers = await makeLayers(config, image);
  const frames = [];
  // Partial authoring commands replace only the requested cells in the already registered atlas.
  const rigPath = 'assets/' + id + '-surface-rig.json';
  const existing = mode === 'all' ? null : JSON.parse(await readFile(rigPath, 'utf8'));
  const atlasPath = existing ? 'assets/' + existing.texture : null;
  const atlas = existing ? await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }) : null;
  function replaceCell(rect, pixels, w, h) {
    if (!rect || rect[2] !== w || rect[3] !== h)
      throw Error(id + ': surface layout changed; rebuild the complete atlas');
    for (let y = 0; y < h; y++)
      pixels.copy(atlas.data, ((rect[1] + y) * atlas.info.width + rect[0]) * 4, y * w * 4, (y + 1) * w * 4);
  }
  if (mode === 'blink') replaceCell(existing.parts[0].blinkSourceRect, display.closed, fullW, fullH);
  for (const name of mode === 'carry' ? ['carry'] : avatarRoutes) {
    const { time, ...channels } = config.routes[name];
    if (
      time[0] !== 0 ||
      time.at(-1) !== 1 ||
      time.some((t, i) => i && t <= time[i - 1]) ||
      Object.values(channels).some((keys) => keys.length !== time.length)
    )
      throw Error('Invalid articulated keyframes for ' + name);
    for (let i = 1; i <= 51; i++) {
      const held = i === 51 || (name === 'shy' && i === 24);
      if (mode === 'blink' && !held) continue;
      const angles = Object.fromEntries(
        Object.entries(channels).map(([joint, keys]) => [joint, sample(keys, time, i / 51)]),
      );
      const render = async (blink) => {
        const eyes = await display.markup(config.displayPoses[name], smooth(i / 42), blink);
        const artwork = svg(fullW, fullH, compose(config, layers, angles, eyes));
        return sharp(artwork).resize(W, H).ensureAlpha().raw().toBuffer();
      };
      const data = mode === 'blink' ? null : await render(false);
      const closed = held ? await render(true) : null;
      if (existing) {
        const index = existing.surfaceSequences.routes[name].frames[i];
        const frame = existing.parts[0].surfaceFrames[index - 1];
        if (data) replaceCell(frame.sourceRect, data, W, H);
        if (closed) replaceCell(frame.blinkSourceRect, closed, W, H);
      } else frames.push({ name, data, closed });
    }
    console.log(id + '/' + name + (mode === 'blink' ? ': held blinks' : ': 51 articulated frames'));
  }
  if (atlas) {
    const temporary = atlasPath + '.' + process.pid + '.tmp';
    await sharp(atlas.data, { raw: atlas.info }).png().toFile(temporary);
    await rename(temporary, atlasPath);
    return;
  }
  return packSurfaceAtlas({
    id,
    open: image.data,
    closed: display.closed,
    fullW,
    fullH,
    W,
    H,
    rect: config.displayRect,
    frames,
  });
}

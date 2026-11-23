#!/usr/bin/env node
// Author PAL's portrait expressions from the shipped neutral portrait. PAL's
// face is an OLED, so expressions change only its cyan eye display; the exact
// shell, visor material, crop, lighting and alpha silhouette remain untouched.
import sharp from 'sharp';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cell = 256;
const expressions = [
  null, // neutral: retain the original reviewed cyan capsules exactly
  // curious: alert, asymmetric eyes, with the viewer-left eye raised
  '<path d="M101 109v25 M155 116v24"/>',
  // thinking: the small pupils look together toward the upper right
  '<path d="M108 115v15 M162 115v15"/>',
  // happy: bright closed-eye crescents
  '<path d="M89 133 Q101 117 113 133 M143 133 Q155 117 167 133"/>',
  // cheeky: a wink paired with one lively open eye
  '<path d="M89 132 Q101 119 113 132 M156 113v28"/>',
  // skeptical: one narrowed eye and one raised, open eye
  '<path d="M89 128 L113 125 M156 111v25"/>',
  // tender: soft inward-facing crescents and little digital cheek marks
  '<path d="M88 124 Q101 140 113 126 M143 126 Q155 140 168 124 M86 144l7 2 M170 144l-7 2"/>',
  // concerned: drooping eyes rise toward the center
  '<path d="M89 135 Q101 111 114 126 M142 126 Q155 111 167 135"/>',
  // surprised: unmistakable open rings
  '<circle cx="101" cy="127" r="10"/><circle cx="155" cy="127" r="10"/>',
  // focused: narrowed eyes angle down toward the center
  '<path d="M89 119 L113 132 M143 132 L167 119"/>',
  // sleepy: low, shallow half-closed eyes
  '<path d="M89 130 Q101 137 113 130 M143 130 Q155 137 167 130"/>',
  // blink: relaxed horizontal digital eyelids
  '<path d="M90 130h22 M144 130h22"/>',
];

// The tracked full-body reference supplies the reviewed cyan rather than a
// guessed palette value. The atlas neutral remains authoritative for its
// already-reviewed portrait framing and shell pixels.
async function referenceEyeColor(reference, eyes) {
  const { data, info } = await sharp(reference).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const samples = [];
  for (const [left, top, width, height] of eyes) {
    if (left < 0 || top < 0 || left + width > info.width || top + height > info.height)
      throw Error(`${reference} eye bounds exceed its ${info.width}x${info.height} canvas`);
    for (let y = top; y < top + height; y++)
      for (let x = left; x < left + width; x++) {
        const at = (y * info.width + x) * 4,
          red = data[at],
          green = data[at + 1],
          blue = data[at + 2];
        if (data[at + 3] > 220 && red < 80 && green > 210 && blue > 210) samples.push([red, green, blue]);
      }
  }
  if (samples.length < 100) throw Error(`${reference} does not contain PAL's reviewed cyan digital eyes`);
  return (
    '#' +
    [0, 1, 2]
      .map((channel) => {
        const values = samples.map((sample) => sample[channel]).sort((a, b) => a - b);
        return values[Math.floor(values.length * 0.75)].toString(16).padStart(2, '0');
      })
      .join('')
  );
}

// Reconstruct the glossy black display beneath the two neutral eye glows. The
// horizontal interpolation follows the visor's very shallow local gradient and
// is confined well inside the black display.
function eyeFreeVisor(neutral) {
  const result = Buffer.from(neutral);
  for (const [left, right] of [
    [82, 120],
    [136, 174],
  ]) {
    for (let y = 101; y <= 154; y++) {
      for (let x = left + 1; x < right; x++) {
        const weight = (x - left) / (right - left),
          at = (y * cell + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const a = neutral[(y * cell + left) * 4 + channel];
          const b = neutral[(y * cell + right) * 4 + channel];
          result[at + channel] = Math.round(a + (b - a) * weight);
        }
      }
    }
  }
  return result;
}

function eyeSvg(paths, color) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}" viewBox="0 0 ${cell} ${cell}">
    <defs><filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4.5"/></filter></defs>
    <g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">
      <g stroke-width="11" opacity=".48" filter="url(#glow)">${paths}</g>
      <g stroke-width="8">${paths}</g>
    </g>
  </svg>`);
}

export async function authorPalPortraits({
  file = 'assets/pal-portraits.png',
  reference = 'reference/pal-front.png',
  eyes = [
    [421, 210, 48, 82],
    [560, 210, 48, 82],
  ],
} = {}) {
  const [{ data: sheet, info }, color] = await Promise.all([
    sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    referenceEyeColor(reference, eyes),
  ]);
  if (info.width !== cell * 4 || info.height !== cell * 3 || info.channels !== 4)
    throw Error(`${file} must be a 1024x768 RGBA portrait atlas`);

  // Cell zero is the reviewed neutral source of truth. Reading it back makes
  // this authoring pass idempotent: output can safely be regenerated from itself.
  const neutral = Buffer.alloc(cell * cell * 4);
  for (let y = 0; y < cell; y++)
    sheet.copy(neutral, y * cell * 4, y * info.width * 4, (y * info.width + cell) * 4);
  const display = eyeFreeVisor(neutral),
    atlas = Buffer.alloc(cell * 4 * cell * 3 * 4);

  for (let index = 0; index < expressions.length; index++) {
    let pixels;
    if (!expressions[index]) pixels = Buffer.from(neutral);
    else {
      pixels = await sharp(display, { raw: { width: cell, height: cell, channels: 4 } })
        .composite([{ input: eyeSvg(expressions[index], color) }])
        .raw()
        .toBuffer();
      // SVG compositing can round premultiplied pixels even where the overlay is
      // transparent. Restore everything outside the OLED authoring rectangle and
      // preserve the reviewed alpha silhouette everywhere.
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const at = (y * cell + x) * 4;
          if (x < 76 || x > 180 || y < 93 || y > 162) neutral.copy(pixels, at, at, at + 4);
          else pixels[at + 3] = neutral[at + 3];
        }
    }
    const left = (index % 4) * cell,
      top = Math.floor(index / 4) * cell;
    for (let y = 0; y < cell; y++)
      pixels.copy(atlas, ((top + y) * cell * 4 + left) * 4, y * cell * 4, (y + 1) * cell * 4);
  }

  const temporary = `${file}.${process.pid}.tmp`;
  // Write packed RGBA directly. Compositing cells over transparency would
  // repeatedly premultiply antialiased edge pixels and cause regeneration drift.
  await sharp(atlas, { raw: { width: cell * 4, height: cell * 3, channels: 4 } })
    .png()
    .toFile(temporary);
  await rename(temporary, file);
  return { color, expressions: expressions.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await authorPalPortraits();
  console.log(
    `pal: authored ${result.expressions - 2} expressive OLED moods and blink in reviewed ${result.color}`,
  );
}

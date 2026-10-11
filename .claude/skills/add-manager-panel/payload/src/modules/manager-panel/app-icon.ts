/**
 * The icon a phone shows when the panel is saved to the home screen, and the manifest that says so.
 *
 * Drawn here (a plain "N" on the accent colour) so the skill ships no binary file and needs no image library:
 * a PNG is a few headers around zlib-compressed rows. The picture is full-bleed with its mark well inside the
 * edges, so a phone may crop it to a circle or a rounded square without cutting anything off.
 */
import zlib from 'node:zlib';

const BACKGROUND: readonly [number, number, number] = [0x1f, 0x6f, 0xeb];
const FOREGROUND: readonly [number, number, number] = [0xff, 0xff, 0xff];
const SAMPLES = 3;

export const ICON_SIZES = [180, 192, 512] as const;

export const MANIFEST = JSON.stringify({
  name: 'NanoClaw Manager',
  short_name: 'NanoClaw',
  description: 'Manage this NanoClaw install',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#12161b',
  theme_color: '#1f6feb',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});

/** Is the point (x, y), in 0..1 units of the icon, inside the letter N? */
function insideMark(x: number, y: number): boolean {
  const top = 0.3;
  const bottom = 0.7;
  const left = 0.32;
  const right = 0.68;
  const stem = 0.085;
  if (y < top || y > bottom) return false;
  if (x >= left && x <= left + stem) return true;
  if (x >= right - stem && x <= right) return true;
  // The diagonal runs from the top of the left stem to the bottom of the right one.
  const t = (y - top) / (bottom - top);
  const centre = left + stem / 2 + t * (right - stem / 2 - (left + stem / 2));
  return Math.abs(x - centre) <= stem * 0.62 && x >= left && x <= right;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A square RGB PNG of the given size. */
export function renderIcon(size: number): Buffer {
  const rowBytes = size * 3 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  for (let py = 0; py < size; py++) {
    raw[py * rowBytes] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++)
        for (let sx = 0; sx < SAMPLES; sx++)
          if (insideMark((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size)) covered += 1;
      const share = covered / (SAMPLES * SAMPLES);
      for (let channel = 0; channel < 3; channel++)
        raw[py * rowBytes + 1 + px * 3 + channel] = Math.round(
          BACKGROUND[channel]! + (FOREGROUND[channel]! - BACKGROUND[channel]!) * share,
        );
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cache = new Map<number, Buffer>();

/** The icon for one of the sizes the panel serves; made on first use, then kept. */
export function icon(size: number): Buffer | null {
  if (!(ICON_SIZES as readonly number[]).includes(size)) return null;
  let png = cache.get(size);
  if (!png) {
    png = renderIcon(size);
    cache.set(size, png);
  }
  return png;
}

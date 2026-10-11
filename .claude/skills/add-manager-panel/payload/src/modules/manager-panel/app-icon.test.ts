import zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ICON_SIZES, icon, MANIFEST, renderIcon } from './app-icon.js';

describe('home-screen icon', () => {
  it('makes a valid RGB PNG of the requested size', () => {
    const png = renderIcon(64);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(64);
    // IHDR is 25 bytes in; the IDAT chunk follows and inflates to 64 rows of 1 + 64 * 3 bytes.
    const length = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    const rows = zlib.inflateSync(png.subarray(41, 41 + length));
    expect(rows.length).toBe(64 * (64 * 3 + 1));
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });

  it('draws the mark in the middle and leaves the corner as background', () => {
    const size = 64;
    const rows = zlib.inflateSync(renderIcon(size).subarray(41, 41 + renderIcon(size).readUInt32BE(33)));
    const at = (x: number, y: number) => [
      ...rows.subarray(y * (size * 3 + 1) + 1 + x * 3, y * (size * 3 + 1) + 4 + x * 3),
    ];
    expect(at(0, 0)).toEqual([0x1f, 0x6f, 0xeb]);
    expect(at(Math.round(size * 0.35), Math.round(size * 0.5))).toEqual([0xff, 0xff, 0xff]);
  });

  it('serves only the sizes the manifest names and keeps the result', () => {
    for (const size of ICON_SIZES) expect(icon(size)).toBe(icon(size));
    expect(icon(64)).toBeNull();
    for (const entry of (JSON.parse(MANIFEST) as { icons: Array<{ sizes: string }> }).icons)
      expect(ICON_SIZES as readonly number[]).toContain(Number(entry.sizes.split('x')[0]));
  });
});

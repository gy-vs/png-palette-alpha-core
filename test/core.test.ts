import { expect, it, describe } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  paeth,
  crc32,
  readChunk,
  decodePng,
  buildIndexedPalette,
  PngError,
  type Chunk,
} from '../src/index.js';

it('predicts', () => expect(paeth(10, 20, 15)).toBe(15));

// ---------- PNG builder helpers ----------

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const payload = Uint8Array.from(data);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + payload.length);
  body.set(typeBytes, 0);
  body.set(payload, typeBytes.length);
  const out = new Uint8Array(12 + payload.length);
  out.set(u32be(payload.length), 0);
  out.set(body, 4);
  out.set(u32be(crc32(body)), 8 + payload.length);
  return out;
}

function ihdr(width: number, height: number, bitDepth: number, colorType = 3): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return chunk('IHDR', data);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Pack per-pixel indices into a row at the given indexed bit depth. */
function packRow(indices: number[], bitDepth: number): Uint8Array {
  const stride = Math.ceil((indices.length * bitDepth) / 8);
  const row = new Uint8Array(stride);
  indices.forEach((value, x) => {
    if (bitDepth === 8) {
      row[x] = value;
    } else if (bitDepth === 4) {
      row[x >> 1] |= value << (x & 1 ? 0 : 4);
    } else if (bitDepth === 2) {
      row[x >> 2] |= value << (6 - 2 * (x & 3));
    } else {
      row[x >> 3] |= value << (7 - (x & 7));
    }
  });
  return row;
}

function unfilteredRows(rows: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(rows.length + rows.reduce((n, r) => n + r.length, 0));
  let off = 0;
  for (const row of rows) {
    out[off++] = 0; // filter type none
    out.set(row, off);
    off += row.length;
  }
  return out;
}

/** RGB palette, optionally followed by a raw tRNS byte array. */
function plte(rgb: number[]): Uint8Array {
  return chunk('PLTE', rgb);
}

const IEND = chunk('IEND', []);

function makePng(parts: Uint8Array[]): Uint8Array {
  return concat([SIGNATURE, ...parts]);
}

function indexedPng(
  width: number,
  height: number,
  bitDepth: number,
  rgb: number[],
  rows: Uint8Array[],
  opts: { trns?: number[] | null; idatFilter?: number } = {},
): Uint8Array {
  const parts: Uint8Array[] = [ihdr(width, height, bitDepth), plte(rgb)];
  if (opts.trns !== undefined) parts.push(chunk('tRNS', opts.trns ?? []));
  const raw = unfilteredRows(rows);
  if (opts.idatFilter !== undefined) raw[0] = opts.idatFilter;
  parts.push(chunk('IDAT', deflateSync(raw)));
  parts.push(IEND);
  return makePng(parts);
}

function rgba(r: number, g: number, b: number, a = 255): number[] {
  return [r, g, b, a];
}

// ---------- palette building ----------

describe('buildIndexedPalette', () => {
  it('covers only the first N tRNS entries, rest opaque', () => {
    const { palette, alpha, entries } = buildIndexedPalette(
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      Uint8Array.from([0, 100]),
    );
    expect(entries).toBe(3);
    expect(Array.from(alpha)).toEqual([0, 100, 255]);
    expect(Array.from(palette)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('empty / missing transparency table -> all opaque', () => {
    const empty = buildIndexedPalette(Uint8Array.from([10, 20, 30]), new Uint8Array(0));
    expect(Array.from(empty.alpha)).toEqual([255]);
    const none = buildIndexedPalette(Uint8Array.from([10, 20, 30]), null);
    expect(Array.from(none.alpha)).toEqual([255]);
  });

  it('rejects tRNS longer than PLTE', () => {
    expect(() =>
      buildIndexedPalette(Uint8Array.from([1, 2, 3]), Uint8Array.from([0, 1])),
    ).toThrow(PngError);
  });
});

// ---------- decoding indexed depths ----------

describe('decodePng indexed depths', () => {
  const PAL = [10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42];

  it('decodes 1-bit indices', () => {
    const png = indexedPng(4, 1, 1, [10, 11, 12, 20, 21, 22], [packRow([0, 1, 1, 0], 1)]);
    const img = decodePng(png);
    expect(img.bitDepth).toBe(1);
    expect(Array.from(img.rgba)).toEqual([
      ...rgba(10, 11, 12), ...rgba(20, 21, 22), ...rgba(20, 21, 22), ...rgba(10, 11, 12),
    ]);
  });

  it('decodes 2-bit indices', () => {
    const png = indexedPng(4, 1, 2, PAL, [packRow([0, 1, 2, 3], 2)]);
    const img = decodePng(png);
    expect(Array.from(img.rgba)).toEqual([
      ...rgba(10, 11, 12), ...rgba(20, 21, 22), ...rgba(30, 31, 32), ...rgba(40, 41, 42),
    ]);
  });

  it('decodes 4-bit indices', () => {
    const png = indexedPng(4, 1, 4, PAL, [packRow([3, 0, 2, 1], 4)]);
    const img = decodePng(png);
    expect(Array.from(img.rgba)).toEqual([
      ...rgba(40, 41, 42), ...rgba(10, 11, 12), ...rgba(30, 31, 32), ...rgba(20, 21, 22),
    ]);
  });

  it('decodes 8-bit indices', () => {
    const png = indexedPng(3, 1, 8, PAL, [packRow([2, 0, 1], 8)]);
    const img = decodePng(png);
    expect(Array.from(img.rgba)).toEqual([
      ...rgba(30, 31, 32), ...rgba(10, 11, 12), ...rgba(20, 21, 22),
    ]);
  });

  it('decodes multiple rows and inter-row filtering (Up)', () => {
    const width = 4;
    const row0 = packRow([0, 1, 2, 3], 2);
    const row1 = packRow([1, 1, 1, 1], 2);
    const stride = 1;
    const raw = new Uint8Array(2 * (stride + 1));
    raw.set([0, ...row0]); // row0: None
    // row1: filter Up, delta = row1 - row0
    raw[2] = 2;
    for (let x = 0; x < stride; x++) raw[3 + x] = (row1[x] - row0[x]) & 0xff;
    const png = makePng([
      ihdr(width, 2, 2), plte(PAL), chunk('IDAT', deflateSync(raw)), IEND,
    ]);
    const img = decodePng(png);
    expect(Array.from(img.rgba.slice(0, 16))).toEqual([
      ...rgba(10, 11, 12), ...rgba(20, 21, 22), ...rgba(30, 31, 32), ...rgba(40, 41, 42),
    ]);
    expect(Array.from(img.rgba.slice(16))).toEqual([
      ...rgba(20, 21, 22), ...rgba(20, 21, 22), ...rgba(20, 21, 22), ...rgba(20, 21, 22),
    ]);
  });
});

// ---------- tRNS semantics ----------

describe('tRNS handling', () => {
  const PAL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  it('short tRNS only covers provided entries, others opaque', () => {
    const png = indexedPng(4, 1, 2, PAL, [packRow([0, 1, 2, 3], 2)], { trns: [0, 50] });
    const img = decodePng(png);
    expect(Array.from(img.alpha)).toEqual([0, 50, 255, 255]);
    expect(Array.from(img.rgba)).toEqual([
      ...rgba(1, 2, 3, 0),
      ...rgba(4, 5, 6, 50),
      ...rgba(7, 8, 9, 255),
      ...rgba(10, 11, 12, 255),
    ]);
  });

  it('zero-length tRNS is an empty transparency table', () => {
    const png = indexedPng(2, 1, 1, [1, 2, 3, 4, 5, 6], [packRow([0, 1], 1)], { trns: [] });
    const img = decodePng(png);
    expect(Array.from(img.alpha)).toEqual([255, 255]);
  });

  it('rejects tRNS longer than PLTE at the chunk stage', () => {
    const png = makePng([
      ihdr(1, 1, 1), plte([1, 2, 3]), chunk('tRNS', [0, 0]),
      chunk('IDAT', deflateSync(new Uint8Array([0, 0]))), IEND,
    ]);
    expect(() => decodePng(png)).toThrow(/tRNS/);
  });

  it('rejects tRNS before PLTE', () => {
    const png = makePng([
      ihdr(1, 1, 1), chunk('tRNS', [0]), plte([1, 2, 3]),
      chunk('IDAT', deflateSync(new Uint8Array([0, 0]))), IEND,
    ]);
    expect(() => decodePng(png)).toThrow(/after the PLTE/);
  });
});

// ---------- out-of-range indices fail the whole row ----------

describe('out-of-range palette indices', () => {
  const badFor = (bitDepth: number, entries: number, indices: number[]) => {
    const rgb = Array.from({ length: entries * 3 }, (_, i) => i + 1);
    return indexedPng(indices.length, 1, bitDepth, rgb, [packRow(indices, bitDepth)]);
  };

  it.each([
    [1, 1, [0, 1]],     // depth 1 can address 2 but palette has 1 entry
    [2, 2, [0, 2]],     // depth 2 can address 4 but palette has 2
    [4, 3, [3]],        // depth 4 can address 16 but palette has 3
    [8, 2, [0, 255]],   // 8-bit index far beyond palette
  ] as const)(
    'fails the whole row for bit depth %i when index exceeds entries',
    (bitDepth, entries, indices) => {
      const png = badFor(bitDepth, entries, [...indices]);
      expect(() => decodePng(png)).toThrow(PngError);
    },
  );

  it('never emits partial/black pixels for a bad index', () => {
    // 4 entries, valid row followed by an invalid row: decode throws, no image.
    const png = badFor(8, 4, [0, 1, 2, 3, 4]);
    let threw = false;
    try {
      decodePng(png);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(PngError);
    }
    expect(threw).toBe(true);
  });
});

// ---------- max 256 colors ----------

describe('maximum palette', () => {
  it('accepts exactly 256 entries with 8-bit indices', () => {
    const rgb: number[] = [];
    for (let i = 0; i < 256; i++) rgb.push(i, (2 * i) & 255, (3 * i) & 255);
    const indices = [0, 1, 255, 128];
    const png = indexedPng(4, 1, 8, rgb, [packRow(indices, 8)], { trns: [0, 255] });
    const img = decodePng(png);
    expect(img.palette.length).toBe(768);
    expect(img.alpha[0]).toBe(0);
    expect(img.alpha[1]).toBe(255);
    expect(img.alpha[2]).toBe(255);
    expect(img.alpha[255]).toBe(255);
    const out = Array.from(img.rgba);
    // width 4: pixel index 2 references palette entry 255
    expect(out.slice(2 * 4, 3 * 4)).toEqual([255, (2 * 255) & 255, (3 * 255) & 255, 255]);
    expect(out.slice(3 * 4, 4 * 4)).toEqual([128, 0, 128, 255]);
  });

  it('rejects more than 256 PLTE entries', () => {
    const png = makePng([
      ihdr(1, 1, 8),
      chunk('PLTE', new Uint8Array(771)), // 257 triplets
      chunk('IDAT', deflateSync(new Uint8Array([0, 0]))),
      IEND,
    ]);
    expect(() => decodePng(png)).toThrow(/PLTE/);
  });
});

// ---------- duplicate chunks / ordering / missing PLTE ----------

describe('chunk-stage validation', () => {
  const tinyIdat = () => chunk('IDAT', deflateSync(new Uint8Array([0, 0])));

  it('rejects duplicate PLTE', () => {
    const png = makePng([
      ihdr(1, 1, 1), plte([1, 2, 3]), plte([4, 5, 6]), tinyIdat(), IEND,
    ]);
    expect(() => decodePng(png)).toThrow(/duplicate PLTE/);
  });

  it('rejects duplicate tRNS', () => {
    const png = makePng([
      ihdr(1, 1, 1),
      plte([1, 2, 3]),
      chunk('tRNS', [0]),
      chunk('tRNS', [255]),
      tinyIdat(),
      IEND,
    ]);
    expect(() => decodePng(png)).toThrow(/duplicate tRNS/);
  });

  it('rejects PLTE after IDAT', () => {
    const png = makePng([ihdr(1, 1, 1), tinyIdat(), plte([1, 2, 3]), IEND]);
    expect(() => decodePng(png)).toThrow(/PLTE/);
  });

  it('rejects tRNS after IDAT', () => {
    const png = makePng([ihdr(1, 1, 1), plte([1, 2, 3]), tinyIdat(), chunk('tRNS', [0]), IEND]);
    expect(() => decodePng(png)).toThrow(/tRNS/);
  });

  it('rejects indexed PNG without PLTE', () => {
    const png = makePng([ihdr(1, 1, 8), tinyIdat(), IEND]);
    expect(() => decodePng(png)).toThrow(/PLTE/);
  });

  it('rejects PLTE for grayscale color type 0', () => {
    const png = makePng([ihdr(1, 1, 8, 0), plte([1, 2, 3]), IEND]);
    expect(() => decodePng(png)).toThrow(/PLTE/);
  });

  it('rejects bit depth unsupported by indexed color type (e.g. 16)', () => {
    const png = makePng([ihdr(1, 1, 16, 3), plte([1, 2, 3]), IEND]);
    expect(() => decodePng(png)).toThrow(/bit depth/);
  });

  it('rejects palette larger than bit depth addresses', () => {
    // depth 1 indexes 0..1; 3 entries is invalid
    const png = makePng([
      ihdr(1, 1, 1), plte([1, 2, 3, 4, 5, 6, 7, 8, 9]), IEND,
    ]);
    expect(() => decodePng(png)).toThrow(/entries/);
  });

  it('rejects missing signature', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
  });
});

// ---------- misc compatibility ----------

describe('readChunk', () => {
  it('reads type, data and computes crc', () => {
    const bytes = chunk('IHDR', [1, 2, 3]);
    const parsed: Chunk | null = readChunk(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('IHDR');
    expect(Array.from(parsed!.data)).toEqual([1, 2, 3]);
    expect(parsed!.crc).toBe(crc32(Uint8Array.from([...new TextEncoder().encode('IHDR'), 1, 2, 3])));
  });

  it('returns null for truncated input', () => {
    expect(readChunk(new Uint8Array(4))).toBeNull();
  });
});

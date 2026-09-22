import { describe, expect, it } from 'vitest';
import {
  ChunkValidator,
  PngError,
  decodeIndexedRow,
  decodeIndexedRows,
  makePalette,
  parseIhdr,
  readChunk,
  scanlineBytes,
  unpackIndices,
  type Chunk,
} from '../src/index.js';

function chunk(type: string, data: Uint8Array): Chunk {
  return { type, data, crc: 0 };
}

function ihdrChunk(colorType: number, bitDepth: number, width = 4, height = 1): Chunk {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  return chunk('IHDR', data);
}

function plteChunk(entries: Array<[number, number, number]>): Chunk {
  return chunk('PLTE', new Uint8Array(entries.flat()));
}

/** Serialize a chunk the way readChunk expects: length + type + data + crc. */
function rawChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

const RGB: Array<[number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];
const RGB_FLAT = new Uint8Array(RGB.flat());

describe('unpackIndices', () => {
  it('unpacks 8-bit indices', () => {
    expect([...unpackIndices(new Uint8Array([0, 1, 2, 255]), 4, 8)]).toEqual([0, 1, 2, 255]);
  });

  it('unpacks 4-bit indices, high nibble first', () => {
    expect([...unpackIndices(new Uint8Array([0x21, 0x10]), 4, 4)]).toEqual([2, 1, 1, 0]);
  });

  it('unpacks 2-bit indices, MSB first', () => {
    expect([...unpackIndices(new Uint8Array([0b11_10_01_00]), 4, 2)]).toEqual([3, 2, 1, 0]);
  });

  it('unpacks 1-bit indices, MSB first', () => {
    expect([...unpackIndices(new Uint8Array([0b10110010]), 8, 1)]).toEqual([
      1, 0, 1, 1, 0, 0, 1, 0,
    ]);
  });

  it('ignores padding bits when width is not byte-aligned', () => {
    expect(scanlineBytes(5, 1)).toBe(1);
    expect([...unpackIndices(new Uint8Array([0b10110_000]), 5, 1)]).toEqual([1, 0, 1, 1, 0]);
    expect(scanlineBytes(9, 1)).toBe(2);
    expect([...unpackIndices(new Uint8Array([0b10110010, 0b1000_0000]), 9, 1)]).toEqual([
      1, 0, 1, 1, 0, 0, 1, 0, 1,
    ]);
  });

  it('rejects a scanline of the wrong length', () => {
    expect(() => unpackIndices(new Uint8Array([0]), 4, 8)).toThrow(PngError);
    expect(() => unpackIndices(new Uint8Array([0, 0]), 9, 8)).toThrow(/expected 9/);
    expect(() => unpackIndices(new Uint8Array([0]), 9, 1)).toThrow(/expected 2/);
  });
});

describe('makePalette', () => {
  it('covers only the first N entries with tRNS; the rest stay opaque', () => {
    const palette = makePalette(RGB_FLAT, new Uint8Array([0, 128]));
    expect(palette.count).toBe(4);
    expect([...palette.alpha]).toEqual([0, 128, 255, 255]);
  });

  it('treats an empty tRNS as fully opaque', () => {
    const palette = makePalette(RGB_FLAT, new Uint8Array(0));
    expect([...palette.alpha]).toEqual([255, 255, 255, 255]);
  });

  it('treats a missing tRNS as fully opaque', () => {
    expect([...makePalette(RGB_FLAT).alpha]).toEqual([255, 255, 255, 255]);
    expect([...makePalette(RGB_FLAT, null).alpha]).toEqual([255, 255, 255, 255]);
  });

  it('rejects tRNS longer than PLTE', () => {
    expect(() => makePalette(RGB_FLAT, new Uint8Array(5))).toThrow(/exceeds PLTE/);
  });

  it('accepts exactly 256 entries and rejects 257', () => {
    expect(makePalette(new Uint8Array(256 * 3)).count).toBe(256);
    expect(() => makePalette(new Uint8Array(257 * 3))).toThrow(/maximum is 256/);
  });

  it('rejects a PLTE whose length is not a non-zero multiple of 3', () => {
    expect(() => makePalette(new Uint8Array(0))).toThrow(PngError);
    expect(() => makePalette(new Uint8Array(4))).toThrow(/multiple of 3/);
  });
});

describe('decodeIndexedRow', () => {
  it('maps indices to RGBA including tRNS alpha (8-bit)', () => {
    const palette = makePalette(RGB_FLAT, new Uint8Array([0, 128]));
    const rgba = decodeIndexedRow(new Uint8Array([2, 1, 0, 3]), 4, 8, palette);
    expect([...rgba]).toEqual([
      0, 0, 255, 255, // index 2: blue, opaque (past end of tRNS)
      0, 255, 0, 128, // index 1: green, alpha 128
      255, 0, 0, 0, //   index 0: red, transparent
      255, 255, 0, 255, // index 3: yellow, opaque (past end of tRNS)
    ]);
  });

  it('decodes packed sub-byte rows (1/2/4-bit)', () => {
    const palette = makePalette(RGB_FLAT);
    expect([...decodeIndexedRow(new Uint8Array([0x21, 0x10]), 4, 4, palette)]).toEqual([
      0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255,
    ]);
    expect([...decodeIndexedRow(new Uint8Array([0b11_10_01_00]), 4, 2, palette)]).toEqual([
      255, 255, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255,
    ]);
    const two = makePalette(new Uint8Array([10, 20, 30, 40, 50, 60]));
    expect([...decodeIndexedRow(new Uint8Array([0b10110_000]), 5, 1, two)]).toEqual([
      40, 50, 60, 255, 10, 20, 30, 255, 40, 50, 60, 255, 40, 50, 60, 255, 10, 20, 30, 255,
    ]);
  });

  it('decodes a full 256-entry palette including index 255', () => {
    const rgb = new Uint8Array(256 * 3);
    rgb[255 * 3] = 1;
    rgb[255 * 3 + 1] = 2;
    rgb[255 * 3 + 2] = 3;
    const palette = makePalette(rgb);
    expect([...decodeIndexedRow(new Uint8Array([255]), 1, 8, palette)]).toEqual([1, 2, 3, 255]);
  });

  it('fails the whole row on an out-of-range index and writes nothing', () => {
    const palette = makePalette(new Uint8Array([255, 0, 0, 0, 255, 0])); // 2 entries
    const out = new Uint8Array(2 * 4).fill(7);
    expect(() => decodeIndexedRow(new Uint8Array([0, 2]), 2, 8, palette, out)).toThrow(
      /index 2 out of range/,
    );
    // No partial row: the caller-supplied buffer is untouched.
    expect([...out]).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
  });

  it('rejects an index equal to the entry count (boundary)', () => {
    const palette = makePalette(new Uint8Array([255, 0, 0, 0, 255, 0]));
    expect(() => decodeIndexedRow(new Uint8Array([1]), 1, 8, palette)).not.toThrow();
    expect(() => decodeIndexedRow(new Uint8Array([2]), 1, 8, palette)).toThrow(PngError);
  });

  it('rejects sub-byte indices beyond the palette even though they fit the bit depth', () => {
    const palette = makePalette(RGB_FLAT.subarray(0, 9)); // 3 entries
    // 2-bit row whose first index is 3: valid 2-bit value, invalid palette index.
    expect(() => decodeIndexedRow(new Uint8Array([0b11_00_00_00]), 1, 2, palette)).toThrow(
      /index 3 out of range/,
    );
  });
});

describe('decodeIndexedRows', () => {
  const palette = makePalette(new Uint8Array([10, 20, 30, 40, 50, 60]));

  it('decodes all rows into one RGBA buffer', () => {
    const rows = [new Uint8Array([0, 1]), new Uint8Array([1, 0])];
    expect([...decodeIndexedRows(rows, 2, 8, palette)]).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 40, 50, 60, 255, 10, 20, 30, 255,
    ]);
  });

  it('aborts the whole image when any row is bad — no partial output', () => {
    const rows = [new Uint8Array([0, 1]), new Uint8Array([0, 3])];
    expect(() => decodeIndexedRows(rows, 2, 8, palette)).toThrow(/row 1: .*index 3 out of range/);
  });
});

describe('ChunkValidator', () => {
  it('accepts a valid indexed-colour sequence', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    v.accept(plteChunk(RGB));
    v.accept(chunk('tRNS', new Uint8Array([0, 128])));
    v.accept(chunk('IDAT', new Uint8Array([1, 2, 3])));
    v.accept(chunk('IDAT', new Uint8Array([4, 5, 6])));
    v.accept(chunk('IEND', new Uint8Array(0)));
    expect(v.ihdr?.colorType).toBe(3);
    expect(v.plte).toHaveLength(12);
    expect(v.trns).toHaveLength(2);
  });

  it('accepts an empty tRNS for colour type 3', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    v.accept(plteChunk(RGB));
    expect(() => v.accept(chunk('tRNS', new Uint8Array(0)))).not.toThrow();
  });

  it('requires IHDR first', () => {
    expect(() => new ChunkValidator().accept(plteChunk(RGB))).toThrow(/first chunk must be IHDR/);
  });

  it('rejects duplicate IHDR, PLTE and tRNS', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    expect(() => v.accept(ihdrChunk(3, 8))).toThrow(/duplicate IHDR/);
    v.accept(plteChunk(RGB));
    expect(() => v.accept(plteChunk(RGB))).toThrow(/duplicate PLTE/);
    v.accept(chunk('tRNS', new Uint8Array([0])));
    expect(() => v.accept(chunk('tRNS', new Uint8Array([1])))).toThrow(/duplicate tRNS/);
  });

  it('requires PLTE before IDAT for colour type 3', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    expect(() => v.accept(chunk('IDAT', new Uint8Array([0])))).toThrow(/requires PLTE/);
  });

  it('rejects tRNS before PLTE for colour type 3', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    expect(() => v.accept(chunk('tRNS', new Uint8Array([0])))).toThrow(/tRNS before PLTE/);
  });

  it('rejects tRNS longer than PLTE at chunk level', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    v.accept(plteChunk(RGB)); // 4 entries
    expect(() => v.accept(chunk('tRNS', new Uint8Array(5)))).toThrow(/exceeds PLTE/);
  });

  it('rejects PLTE and tRNS after IDAT', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(2, 8));
    v.accept(chunk('IDAT', new Uint8Array([0])));
    expect(() => v.accept(plteChunk(RGB))).toThrow(/PLTE after IDAT/);
    expect(() => v.accept(chunk('tRNS', new Uint8Array(6)))).toThrow(/tRNS after IDAT/);
  });

  it('rejects tRNS for colour types 4 and 6', () => {
    for (const colorType of [4, 6]) {
      const v = new ChunkValidator();
      v.accept(ihdrChunk(colorType, 8));
      expect(() => v.accept(chunk('tRNS', new Uint8Array(2)))).toThrow(
        new RegExp(`tRNS not allowed for colour type ${colorType}`),
      );
    }
  });

  it('rejects PLTE for colour types 0 and 4', () => {
    for (const colorType of [0, 4]) {
      const v = new ChunkValidator();
      v.accept(ihdrChunk(colorType, 8));
      expect(() => v.accept(plteChunk(RGB))).toThrow(
        new RegExp(`PLTE not allowed for colour type ${colorType}`),
      );
    }
  });

  it('limits PLTE entries to 2^bitDepth for colour type 3', () => {
    const ok = new ChunkValidator();
    ok.accept(ihdrChunk(3, 4));
    expect(() => ok.accept(plteChunk(Array.from({ length: 16 }, () => [0, 0, 0] as const)))).not.toThrow();

    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 4));
    expect(() => v.accept(plteChunk(Array.from({ length: 17 }, () => [0, 0, 0] as const)))).toThrow(
      /exceeds 16 allowed at bit depth 4/,
    );
  });

  it('allows up to 256 entries at bit depth 8', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(3, 8));
    expect(() =>
      v.accept(plteChunk(Array.from({ length: 256 }, () => [0, 0, 0] as const))),
    ).not.toThrow();
  });

  it('validates tRNS size for greyscale and truecolour', () => {
    const gray = new ChunkValidator();
    gray.accept(ihdrChunk(0, 8));
    expect(() => gray.accept(chunk('tRNS', new Uint8Array(3)))).toThrow(/greyscale must be 2 bytes/);
    expect(() => gray.accept(chunk('tRNS', new Uint8Array(2)))).not.toThrow();

    const rgb = new ChunkValidator();
    rgb.accept(ihdrChunk(2, 8));
    expect(() => rgb.accept(chunk('tRNS', new Uint8Array(2)))).toThrow(/truecolour must be 6 bytes/);
    expect(() => rgb.accept(chunk('tRNS', new Uint8Array(6)))).not.toThrow();
  });

  it('rejects non-consecutive IDAT and chunks after IEND', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(2, 8));
    v.accept(chunk('IDAT', new Uint8Array([0])));
    v.accept(chunk('tEXt', new Uint8Array([0])));
    expect(() => v.accept(chunk('IDAT', new Uint8Array([1])))).toThrow(/consecutive/);

    const w = new ChunkValidator();
    w.accept(ihdrChunk(2, 8));
    w.accept(chunk('IDAT', new Uint8Array([0])));
    w.accept(chunk('IEND', new Uint8Array(0)));
    expect(() => w.accept(chunk('tEXt', new Uint8Array([0])))).toThrow(/after IEND/);
  });

  it('accepts a suggested PLTE for truecolour', () => {
    const v = new ChunkValidator();
    v.accept(ihdrChunk(2, 8));
    v.accept(plteChunk(RGB));
    v.accept(chunk('IDAT', new Uint8Array([0])));
    v.accept(chunk('IEND', new Uint8Array(0)));
  });
});

describe('parseIhdr', () => {
  it('rejects invalid bit depth / colour type combinations', () => {
    expect(() => parseIhdr(ihdrChunk(3, 16).data)).toThrow(/bit depth 16 not allowed/);
    expect(() => parseIhdr(ihdrChunk(2, 4).data)).toThrow(PngError);
    expect(() => parseIhdr(ihdrChunk(9, 8).data)).toThrow(/unknown colour type 9/);
  });

  it('rejects bad length, dimensions, compression, filter and interlace', () => {
    expect(() => parseIhdr(new Uint8Array(12))).toThrow(/13 bytes/);
    expect(() => parseIhdr(ihdrChunk(3, 8, 0, 1).data)).toThrow(/non-zero/);
    const bad = (byte: number, value: number) => {
      const data = ihdrChunk(3, 8).data.slice();
      data[byte] = value;
      return parseIhdr(data);
    };
    expect(() => bad(10, 1)).toThrow(/compression/);
    expect(() => bad(11, 1)).toThrow(/filter method/);
    expect(() => bad(12, 2)).toThrow(/interlace/);
  });
});

describe('readChunk integration', () => {
  it('feeds parsed chunks through the validator', () => {
    const ihdr = ihdrChunk(3, 8).data;
    const v = new ChunkValidator();
    for (const raw of [
      rawChunk('IHDR', ihdr),
      rawChunk('PLTE', RGB_FLAT),
      rawChunk('tRNS', new Uint8Array([0])),
      rawChunk('IDAT', new Uint8Array([1, 2, 3])),
      rawChunk('IEND', new Uint8Array(0)),
    ]) {
      const parsed = readChunk(raw);
      expect(parsed).not.toBeNull();
      v.accept(parsed!);
    }
    const palette = makePalette(v.plte!, v.trns);
    expect([...palette.alpha]).toEqual([0, 255, 255, 255]);
  });
});

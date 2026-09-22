import { inflateSync } from 'node:zlib';

export type Chunk = { type: string; data: Uint8Array; crc: number };

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

export interface Ihdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compressionMethod: number;
  filterMethod: number;
  interlaceMethod: number;
}

export interface PngImage {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** PLTE RGB triplets, length = entries * 3 */
  palette: Uint8Array;
  /** One alpha per palette entry; entries beyond tRNS default to 255 */
  alpha: Uint8Array;
  /** Decoded RGBA pixels, length = width * height * 4 */
  rgba: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Allowed bit depths per PNG color type. */
const ALLOWED_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunkAt(input: Uint8Array, offset: number): { chunk: Chunk; next: number } | null {
  if (offset + 12 > input.length) return null;
  const length =
    (input[offset] << 24 | input[offset + 1] << 16 | input[offset + 2] << 8 | input[offset + 3]) >>> 0;
  const next = offset + 8 + length + 4;
  if (next > input.length) return null;
  for (let i = 0; i < 4; i++) {
    const code = input[offset + 4 + i];
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!isLetter) return null;
  }
  const type = new TextDecoder().decode(input.subarray(offset + 4, offset + 8));
  const data = input.slice(offset + 8, offset + 8 + length);
  const crc = crc32(input.subarray(offset + 4, offset + 8 + length));
  return { chunk: { type, data, crc }, next };
}

/** Read the first chunk of a buffer (kept for backward compatibility). */
export function readChunk(input: Uint8Array): Chunk | null {
  const parsed = readChunkAt(input, 0);
  return parsed ? parsed.chunk : null;
}

/** Verify the PNG signature and split the input into chunks. */
export function parseChunks(input: Uint8Array): Chunk[] {
  if (
    input.length < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((b, i) => input[i] !== b)
  ) {
    throw new PngError('invalid PNG signature');
  }
  const chunks: Chunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < input.length) {
    const parsed = readChunkAt(input, offset);
    if (!parsed) throw new PngError('truncated or malformed chunk stream');
    chunks.push(parsed.chunk);
    offset = parsed.next;
    if (parsed.chunk.type === 'IEND') break;
  }
  if (chunks.length === 0 || chunks[chunks.length - 1].type !== 'IEND') {
    throw new PngError('missing IEND chunk');
  }
  return chunks;
}

function parseIhdr(chunk: Chunk): Ihdr {
  if (chunk.type !== 'IHDR') throw new PngError('first chunk must be IHDR');
  if (chunk.data.length !== 13) throw new PngError('IHDR must be exactly 13 bytes');
  const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  const ihdr: Ihdr = {
    width: view.getUint32(0),
    height: view.getUint32(4),
    bitDepth: chunk.data[8],
    colorType: chunk.data[9],
    compressionMethod: chunk.data[10],
    filterMethod: chunk.data[11],
    interlaceMethod: chunk.data[12],
  };
  if (ihdr.width === 0 || ihdr.width > 0x7fffffff) throw new PngError('invalid IHDR width');
  if (ihdr.height === 0 || ihdr.height > 0x7fffffff) throw new PngError('invalid IHDR height');
  const depths = ALLOWED_BIT_DEPTHS[ihdr.colorType];
  if (!depths) throw new PngError(`unsupported PNG color type ${ihdr.colorType}`);
  if (!depths.includes(ihdr.bitDepth)) {
    throw new PngError(`bit depth ${ihdr.bitDepth} invalid for color type ${ihdr.colorType}`);
  }
  if (ihdr.compressionMethod !== 0) throw new PngError('unsupported compression method');
  if (ihdr.filterMethod !== 0) throw new PngError('unsupported filter method');
  if (ihdr.interlaceMethod > 1) throw new PngError('invalid interlace method');
  return ihdr;
}

/**
 * Chunk-stage validation: chunk identity/duplication, PLTE/tRNS ordering and
 * color-type constraints are all checked before any pixel data is touched.
 */
export function validateChunkStage(chunks: Chunk[]): Ihdr {
  if (chunks.length < 2 || chunks[0].type !== 'IHDR') {
    throw new PngError('PNG must start with a single IHDR chunk');
  }
  const ihdr = parseIhdr(chunks[0]);

  let plte: Chunk | null = null;
  let trns: Chunk | null = null;
  let idatStarted = false;
  let idatFinished = false;
  let seenIend = false;

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    switch (chunk.type) {
      case 'IHDR':
        throw new PngError('duplicate IHDR chunk');

      case 'PLTE': {
        if (plte) throw new PngError('duplicate PLTE chunk');
        if (idatStarted) throw new PngError('PLTE must appear before the first IDAT chunk');
        if (ihdr.colorType === 0 || ihdr.colorType === 4) {
          throw new PngError(`PLTE is not allowed for color type ${ihdr.colorType}`);
        }
        const len = chunk.data.length;
        if (len < 3 || len > 768 || len % 3 !== 0) {
          throw new PngError('PLTE must contain between 1 and 256 RGB triplets');
        }
        if (ihdr.colorType === 3 && len / 3 > 1 << ihdr.bitDepth) {
          throw new PngError('PLTE has more entries than the indexed bit depth can address');
        }
        plte = chunk;
        break;
      }

      case 'tRNS': {
        if (trns) throw new PngError('duplicate tRNS chunk');
        if (idatStarted) throw new PngError('tRNS must appear before the first IDAT chunk');
        if (ihdr.colorType === 4 || ihdr.colorType === 6) {
          throw new PngError(`tRNS is not allowed for color type ${ihdr.colorType}`);
        }
        if (![0, 2, 3].includes(ihdr.colorType)) {
          throw new PngError(`tRNS is not allowed for color type ${ihdr.colorType}`);
        }
        if (ihdr.colorType === 3) {
          if (!plte) throw new PngError('tRNS must appear after the PLTE chunk');
          // One alpha byte per palette entry; shorter is allowed, longer is not.
          if (chunk.data.length > plte.data.length) {
            throw new PngError('tRNS must not be longer than PLTE');
          }
        } else if (ihdr.colorType === 0) {
          if (chunk.data.length !== 2) throw new PngError('tRNS must be 2 bytes for grayscale');
        } else if (chunk.data.length !== 6) {
          throw new PngError('tRNS must be 6 bytes for truecolor');
        }
        trns = chunk;
        break;
      }

      case 'IDAT': {
        if (ihdr.colorType === 3 && !plte) {
          throw new PngError('indexed-color PNG requires a PLTE chunk before IDAT');
        }
        if (idatFinished) {
          throw new PngError('IDAT chunks must be consecutive');
        }
        idatStarted = true;
        break;
      }

      case 'IEND':
        if (i !== chunks.length - 1) throw new PngError('IEND must be the last chunk');
        seenIend = true;
        break;

      default:
        // Ancillary chunks are allowed, but not between IDAT chunks.
        if (idatStarted) idatFinished = true;
    }
  }

  if (!seenIend) throw new PngError('missing IEND chunk');
  if (ihdr.colorType === 3 && !plte) {
    throw new PngError('indexed-color PNG requires a PLTE chunk');
  }
  return ihdr;
}

/**
 * Build the RGBA palette. tRNS only supplies alpha for the first N entries;
 * every remaining entry is fully opaque (alpha 255). No modulo reuse.
 */
export function buildIndexedPalette(
  plte: Uint8Array,
  trns: Uint8Array | null | undefined,
): { palette: Uint8Array; alpha: Uint8Array; entries: number } {
  if (plte.length < 3 || plte.length > 768 || plte.length % 3 !== 0) {
    throw new PngError('PLTE must contain between 1 and 256 RGB triplets');
  }
  const entries = plte.length / 3;
  if (trns && trns.length > entries) {
    throw new PngError('tRNS must not be longer than PLTE');
  }
  const palette = plte.slice();
  const alpha = new Uint8Array(entries).fill(255);
  if (trns) {
    for (let i = 0; i < trns.length; i++) alpha[i] = trns[i];
  }
  return { palette, alpha, entries };
}

function concatChunks(chunks: Chunk[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.data.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  return merged;
}

function extractIndex(row: Uint8Array, x: number, bitDepth: number): number {
  if (bitDepth === 8) return row[x];
  if (bitDepth === 4) return (row[x >> 1] >>> (x & 1 ? 0 : 4)) & 0x0f;
  if (bitDepth === 2) return (row[x >> 2] >>> (6 - 2 * (x & 3))) & 3;
  return (row[x >> 3] >>> (7 - (x & 7))) & 1;
}

/** Reverse one PNG filter pass; writes reconstructed bytes into `row`. */
function unfilterRow(
  filter: number,
  row: Uint8Array,
  prior: Uint8Array,
  bpp: number,
): void {
  for (let x = 0; x < row.length; x++) {
    const left = x >= bpp ? row[x - bpp] : 0;
    const up = prior[x];
    const upLeft = x >= bpp ? prior[x - bpp] : 0;
    switch (filter) {
      case 0:
        break;
      case 1:
        row[x] = (row[x] + left) & 0xff;
        break;
      case 2:
        row[x] = (row[x] + up) & 0xff;
        break;
      case 3:
        row[x] = (row[x] + ((left + up) >> 1)) & 0xff;
        break;
      case 4:
        row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new PngError(`unsupported scanline filter type ${filter}`);
    }
  }
}

/** Decode a PNG buffer. Indexed color (color type 3), non-interlaced. */
export function decodePng(input: Uint8Array): PngImage {
  const chunks = parseChunks(input);
  const ihdr = validateChunkStage(chunks);

  if (ihdr.interlaceMethod === 1) {
    throw new PngError('Adam7 interlaced PNGs are not supported');
  }
  if (ihdr.colorType !== 3) {
    throw new PngError(`decoder supports indexed color (type 3), got color type ${ihdr.colorType}`);
  }

  const plteChunk = chunks.find((c) => c.type === 'PLTE');
  const trnsChunk = chunks.find((c) => c.type === 'tRNS');
  if (!plteChunk) throw new PngError('indexed-color PNG requires a PLTE chunk');
  const { palette, alpha, entries } = buildIndexedPalette(
    plteChunk.data,
    trnsChunk ? trnsChunk.data : null,
  );

  const idatChunks = chunks.filter((c) => c.type === 'IDAT');
  if (idatChunks.length === 0) throw new PngError('missing IDAT chunk');

  let raw: Uint8Array;
  try {
    raw = inflateSync(concatChunks(idatChunks));
  } catch {
    throw new PngError('failed to inflate IDAT data');
  }

  const { width, height, bitDepth } = ihdr;
  const stride = Math.ceil((width * bitDepth) / 8);
  const expectedSize = height * (stride + 1);
  if (raw.length !== expectedSize) {
    throw new PngError(
      `decompressed data length ${raw.length} does not match ${height} scanlines (${expectedSize})`,
    );
  }

  // Indexed pixels use one byte per "filter pixel" for every legal bit depth.
  const bpp = 1;
  const rgba = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.slice(rowStart + 1, rowStart + 1 + stride);
    unfilterRow(filter, row, prior, bpp);

    // Validate every index in the row first. A bad index fails the whole row
    // (and therefore the whole decode); no partial/wrong-color row is emitted.
    for (let x = 0; x < width; x++) {
      const index = extractIndex(row, x, bitDepth);
      if (index >= entries) {
        throw new PngError(
          `palette index ${index} at (${x}, ${y}) exceeds palette size ${entries}`,
        );
      }
    }

    const rowOut = (y * width * 4);
    for (let x = 0; x < width; x++) {
      const index = extractIndex(row, x, bitDepth);
      const out = rowOut + x * 4;
      rgba[out] = palette[index * 3];
      rgba[out + 1] = palette[index * 3 + 1];
      rgba[out + 2] = palette[index * 3 + 2];
      rgba[out + 3] = alpha[index];
    }

    prior.set(row);
  }

  return {
    width,
    height,
    bitDepth,
    colorType: ihdr.colorType,
    palette,
    alpha,
    rgba,
  };
}

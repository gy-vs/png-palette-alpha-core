export type Chunk={type:string;data:Uint8Array;crc:number};export function readChunk(input:Uint8Array):Chunk|null{if(input.length<12)return null;const length=(input[0]<<24)|(input[1]<<16)|(input[2]<<8)|input[3];if(length<0||input.length<12+length)return null;const type=new TextDecoder().decode(input.slice(4,8));return{type,data:input.slice(8,8+length),crc:0}}export function paeth(a:number,b:number,c:number){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}

// ---------------------------------------------------------------------------
// Indexed-colour (colour type 3) support: PLTE/tRNS handling and scanline
// unpacking. Structural rules (chunk order, colour-type constraints, table
// sizes) are enforced at chunk level by ChunkValidator; pixel-level rules
// (index range) are enforced per scanline by decodeIndexedRow.
// ---------------------------------------------------------------------------

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
  compression: number;
  filter: number;
  interlace: number;
}

const VALID_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function parseIhdr(data: Uint8Array): Ihdr {
  if (data.length !== 13) {
    throw new PngError(`IHDR must be 13 bytes, got ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ihdr: Ihdr = {
    width: view.getUint32(0),
    height: view.getUint32(4),
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12],
  };
  if (ihdr.width === 0 || ihdr.height === 0) {
    throw new PngError('IHDR: width and height must be non-zero');
  }
  const depths = VALID_BIT_DEPTHS[ihdr.colorType];
  if (!depths) {
    throw new PngError(`IHDR: unknown colour type ${ihdr.colorType}`);
  }
  if (!depths.includes(ihdr.bitDepth)) {
    throw new PngError(
      `IHDR: bit depth ${ihdr.bitDepth} not allowed for colour type ${ihdr.colorType}`,
    );
  }
  if (ihdr.compression !== 0) {
    throw new PngError(`IHDR: unknown compression method ${ihdr.compression}`);
  }
  if (ihdr.filter !== 0) {
    throw new PngError(`IHDR: unknown filter method ${ihdr.filter}`);
  }
  if (ihdr.interlace > 1) {
    throw new PngError(`IHDR: unknown interlace method ${ihdr.interlace}`);
  }
  return ihdr;
}

export interface Palette {
  /** Number of palette entries (1..256). */
  readonly count: number;
  /** RGB triplets, count * 3 bytes. */
  readonly rgb: Uint8Array;
  /**
   * One alpha byte per entry. A tRNS table covers only its first entries;
   * every entry past the end of tRNS is fully opaque (255) — never wrapped
   * around or reused.
   */
  readonly alpha: Uint8Array;
}

export function makePalette(plte: Uint8Array, trns?: Uint8Array | null): Palette {
  if (plte.length === 0 || plte.length % 3 !== 0) {
    throw new PngError(`PLTE length ${plte.length} is not a non-zero multiple of 3`);
  }
  const count = plte.length / 3;
  if (count > 256) {
    throw new PngError(`PLTE has ${count} entries, maximum is 256`);
  }
  const alpha = new Uint8Array(count).fill(255);
  if (trns != null) {
    if (trns.length > count) {
      throw new PngError(
        `tRNS has ${trns.length} alpha values, exceeds PLTE (${count} entries)`,
      );
    }
    // Only the first trns.length entries are covered; the rest stay opaque.
    // An empty tRNS is a no-op.
    alpha.set(trns);
  }
  return { count, rgb: plte.slice(), alpha };
}

export type IndexedBitDepth = 1 | 2 | 4 | 8;

/** Bytes per (unfiltered) scanline of `width` pixels at `bitDepth` bpp. */
export function scanlineBytes(width: number, bitDepth: IndexedBitDepth): number {
  return Math.ceil((width * bitDepth) / 8);
}

/** Unpack one scanline into one palette index per pixel (MSB first). */
export function unpackIndices(
  row: Uint8Array,
  width: number,
  bitDepth: IndexedBitDepth,
): Uint8Array {
  const expected = scanlineBytes(width, bitDepth);
  if (row.length !== expected) {
    throw new PngError(
      `scanline is ${row.length} bytes, expected ${expected} (width ${width}, ${bitDepth}-bit)`,
    );
  }
  const indices = new Uint8Array(width);
  if (bitDepth === 8) {
    indices.set(row);
    return indices;
  }
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  for (let i = 0; i < width; i++) {
    const shift = 8 - bitDepth * ((i % perByte) + 1);
    indices[i] = (row[(i / perByte) | 0] >> shift) & mask;
  }
  return indices;
}

/**
 * Decode one indexed-colour scanline to RGBA.
 *
 * Every index is validated against the palette before a single pixel is
 * written: an out-of-range index fails the whole row and no partial RGBA
 * data is emitted (a caller-supplied `out` buffer is left untouched).
 */
export function decodeIndexedRow(
  row: Uint8Array,
  width: number,
  bitDepth: IndexedBitDepth,
  palette: Palette,
  out?: Uint8Array,
): Uint8Array {
  const indices = unpackIndices(row, width, bitDepth);
  for (let i = 0; i < width; i++) {
    if (indices[i] >= palette.count) {
      throw new PngError(
        `pixel ${i}: palette index ${indices[i]} out of range, palette has ${palette.count} entries`,
      );
    }
  }
  const rgba = out ?? new Uint8Array(width * 4);
  if (rgba.length < width * 4) {
    throw new PngError(`output buffer is ${rgba.length} bytes, need ${width * 4}`);
  }
  const { rgb, alpha } = palette;
  for (let i = 0; i < width; i++) {
    const index = indices[i];
    rgba[i * 4] = rgb[index * 3];
    rgba[i * 4 + 1] = rgb[index * 3 + 1];
    rgba[i * 4 + 2] = rgb[index * 3 + 2];
    rgba[i * 4 + 3] = alpha[index];
  }
  return rgba;
}

/**
 * Decode all scanlines of an indexed-colour image to one RGBA buffer.
 * Any bad row aborts the whole image — the caller never receives partially
 * decoded output.
 */
export function decodeIndexedRows(
  rows: readonly Uint8Array[],
  width: number,
  bitDepth: IndexedBitDepth,
  palette: Palette,
): Uint8Array {
  const rgba = new Uint8Array(rows.length * width * 4);
  for (let y = 0; y < rows.length; y++) {
    try {
      decodeIndexedRow(
        rows[y],
        width,
        bitDepth,
        palette,
        rgba.subarray(y * width * 4, (y + 1) * width * 4),
      );
    } catch (err) {
      throw new PngError(`row ${y}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return rgba;
}

/**
 * Stateful chunk-sequence validator. Enforces, at chunk level:
 *  - IHDR first, no duplicate IHDR/PLTE/tRNS, nothing after IEND;
 *  - PLTE required for colour type 3, forbidden for types 0 and 4,
 *    at most 2^bitDepth entries for type 3, before IDAT;
 *  - tRNS forbidden for types 4 and 6, after PLTE (type 3), before IDAT,
 *    and never longer than the palette;
 *  - IDAT chunks consecutive.
 */
export class ChunkValidator {
  private ihdr_: Ihdr | null = null;
  private plte_: Uint8Array | null = null;
  private trns_: Uint8Array | null = null;
  private plteCount = 0;
  private sawIdat = false;
  private idatEnded = false;
  private sawIend = false;

  get ihdr(): Ihdr | null {
    return this.ihdr_;
  }
  get plte(): Uint8Array | null {
    return this.plte_;
  }
  get trns(): Uint8Array | null {
    return this.trns_;
  }

  accept(chunk: Chunk): void {
    if (this.sawIend) {
      throw new PngError(`chunk ${chunk.type} after IEND`);
    }
    if (!this.ihdr_ && chunk.type !== 'IHDR') {
      throw new PngError(`first chunk must be IHDR, got ${chunk.type}`);
    }
    switch (chunk.type) {
      case 'IHDR': {
        if (this.ihdr_) {
          throw new PngError('duplicate IHDR');
        }
        this.ihdr_ = parseIhdr(chunk.data);
        break;
      }
      case 'PLTE': {
        const ihdr = this.ihdr_!;
        if (this.plte_) {
          throw new PngError('duplicate PLTE');
        }
        if (this.sawIdat) {
          throw new PngError('PLTE after IDAT');
        }
        if (ihdr.colorType === 0 || ihdr.colorType === 4) {
          throw new PngError(`PLTE not allowed for colour type ${ihdr.colorType}`);
        }
        const palette = makePalette(chunk.data);
        if (ihdr.colorType === 3) {
          const max = 1 << ihdr.bitDepth;
          if (palette.count > max) {
            throw new PngError(
              `PLTE has ${palette.count} entries, exceeds ${max} allowed at bit depth ${ihdr.bitDepth}`,
            );
          }
        }
        this.plte_ = chunk.data;
        this.plteCount = palette.count;
        break;
      }
      case 'tRNS': {
        const ihdr = this.ihdr_!;
        if (this.trns_) {
          throw new PngError('duplicate tRNS');
        }
        if (this.sawIdat) {
          throw new PngError('tRNS after IDAT');
        }
        if (ihdr.colorType === 4 || ihdr.colorType === 6) {
          throw new PngError(`tRNS not allowed for colour type ${ihdr.colorType}`);
        }
        if (ihdr.colorType === 3) {
          if (!this.plte_) {
            throw new PngError('tRNS before PLTE');
          }
          if (chunk.data.length > this.plteCount) {
            throw new PngError(
              `tRNS has ${chunk.data.length} alpha values, exceeds PLTE (${this.plteCount} entries)`,
            );
          }
        } else if (ihdr.colorType === 0 && chunk.data.length !== 2) {
          throw new PngError(`tRNS for greyscale must be 2 bytes, got ${chunk.data.length}`);
        } else if (ihdr.colorType === 2 && chunk.data.length !== 6) {
          throw new PngError(`tRNS for truecolour must be 6 bytes, got ${chunk.data.length}`);
        }
        this.trns_ = chunk.data;
        break;
      }
      case 'IDAT': {
        const ihdr = this.ihdr_!;
        if (ihdr.colorType === 3 && !this.plte_) {
          throw new PngError('colour type 3 requires PLTE before IDAT');
        }
        if (this.idatEnded) {
          throw new PngError('IDAT chunks must be consecutive');
        }
        this.sawIdat = true;
        break;
      }
      case 'IEND': {
        this.sawIend = true;
        break;
      }
      default: {
        if (this.sawIdat) {
          this.idatEnded = true;
        }
        break;
      }
    }
  }
}

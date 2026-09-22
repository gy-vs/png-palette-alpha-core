# PNG codec core

TypeScript library for PNG chunks and scanlines.

Run `npm install`, then `npm test` and `npm run build`.

## Indexed colour (colour type 3)

- `ChunkValidator` enforces chunk-level rules: IHDR first; PLTE required for
  colour type 3 (and forbidden for 0/4), at most 2^bitDepth entries, before
  IDAT; tRNS after PLTE, before IDAT, never longer than PLTE, forbidden for
  colour types 4/6; no duplicate IHDR/PLTE/tRNS; consecutive IDATs.
- `makePalette(plte, trns?)` builds a palette where tRNS covers only its
  first N entries — all remaining entries are alpha 255 (never wrapped).
- `decodeIndexedRow` / `decodeIndexedRows` unpack 1/2/4/8-bit scanlines and
  map them to RGBA. Every index is validated before any pixel is written:
  an out-of-range index fails the whole row/image with a `PngError` and no
  partial output is produced.

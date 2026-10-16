/**
 * Content-sniffed image dimensions. The declared media type is never trusted for this —
 * the bytes themselves say what they are, and only PNG and JPEG are read at all. Anything
 * else, or a file too damaged to have a header, answers null rather than a guessed size.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** IHDR is the first chunk: 8-byte signature, 4-byte length, 'IHDR', then width and height. */
function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Start-of-frame markers, minus DHT, JPG and DAC which share the range but carry no size. */
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** Markers with no length field: TEM, RSTn, SOI and EOI. */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);

/** Walks JPEG segments to the first start-of-frame; its payload begins precision, height, width. */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00 || isStandalone(marker)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      if (length < 7) return null;
      return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    offset += length;
  }
  return null;
}

/** Width and height of a PNG or JPEG from its header — null for anything this does not read. */
export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes);
}

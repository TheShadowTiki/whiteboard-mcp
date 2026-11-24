/**
 * Image files for canvas_image: recognise the format from the file's own bytes (never trust the
 * extension alone, so a non-image file is never sent to the board) and read its pixel size.
 */

export interface ImageInfo {
  mimeType: string;
  width: number;
  height: number;
}

const ascii = (buf: Buffer, start: number, end: number): string => buf.subarray(start, end).toString('latin1');

function png(buf: Buffer): ImageInfo | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || ascii(buf, 12, 16) !== 'IHDR') return undefined;
  return { mimeType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gif(buf: Buffer): ImageInfo | undefined {
  if (buf.length < 10 || !/^GIF8[79]a$/.test(ascii(buf, 0, 6))) return undefined;
  return { mimeType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** Walks JPEG segments to the first start-of-frame marker (SOF0-SOF15 except DHT, JPG and DAC). */
function jpeg(buf: Buffer): ImageInfo | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mimeType: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return undefined;
}

function webp(buf: Buffer): ImageInfo | undefined {
  if (buf.length < 30 || ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 12) !== 'WEBP') return undefined;
  const chunk = ascii(buf, 12, 16);
  if (chunk === 'VP8 ') return { mimeType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { mimeType: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { mimeType: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return undefined;
}

/** SVG: width/height attributes in px (or unitless), else the viewBox; 300×150 (the browser default) if neither. */
function svg(buf: Buffer): ImageInfo | undefined {
  const head = buf.subarray(0, 4096).toString('utf8');
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return undefined;
  const attr = (name: string): number | undefined => {
    const v = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i').exec(tag)?.[1];
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const box = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
  const bw = box ? Number(box[1]) : undefined;
  const bh = box ? Number(box[2]) : undefined;
  let width = attr('width');
  let height = attr('height');
  if (width === undefined && height === undefined && bw && bh) [width, height] = [bw, bh];
  else if (width !== undefined && height === undefined) height = bw && bh ? (width * bh) / bw : 150;
  else if (height !== undefined && width === undefined) width = bw && bh ? (height * bw) / bh : 300;
  return { mimeType: 'image/svg+xml', width: width ?? 300, height: height ?? 150 };
}

/** The image's type and pixel size, or undefined if the bytes aren't a PNG, JPEG, GIF, WebP or SVG. */
export function imageInfo(buf: Buffer): ImageInfo | undefined {
  const info = png(buf) ?? jpeg(buf) ?? gif(buf) ?? webp(buf) ?? svg(buf);
  return info && info.width > 0 && info.height > 0 ? info : undefined;
}

/**
 * Element size from the image's own size: both given → as given; one given → the other from the
 * aspect ratio; neither → the image's size, scaled down to at most maxWidth wide.
 */
export function fitSize(info: ImageInfo, width: number | undefined, height: number | undefined, maxWidth: number): { width: number; height: number } {
  const ratio = info.height / info.width;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) return { width, height: Math.round(width * ratio) };
  if (height !== undefined) return { width: Math.round(height / ratio), height };
  const w = Math.min(info.width, maxWidth);
  return { width: w, height: Math.round(w * ratio) };
}

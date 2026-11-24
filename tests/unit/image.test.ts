import { describe, expect, it } from 'vitest';
import { buildImage } from '../../src/shared/elements.js';
import { fitSize, imageInfo } from '../../src/shared/image.js';
import type { ExElement } from '../../src/shared/protocol.js';

type El = ExElement & Record<string, any>;

/** A minimal PNG header: signature + IHDR with the given size. */
export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function gifHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const opts = { now: 1000, random: () => 0.5 };

describe('imageInfo', () => {
  it('reads the type and size of PNG, JPEG, GIF and WebP from their bytes', () => {
    expect(imageInfo(pngHeader(4479, 640))).toEqual({ mimeType: 'image/png', width: 4479, height: 640 });
    expect(imageInfo(jpegHeader(800, 600))).toEqual({ mimeType: 'image/jpeg', width: 800, height: 600 });
    expect(imageInfo(gifHeader(32, 16))).toEqual({ mimeType: 'image/gif', width: 32, height: 16 });
    expect(imageInfo(webpVp8x(1024, 768))).toEqual({ mimeType: 'image/webp', width: 1024, height: 768 });
  });

  it('reads SVG size from width/height, else the viewBox, else the browser default', () => {
    const svg = (attrs: string) => Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`);
    expect(imageInfo(svg('width="200" height="100px"'))).toMatchObject({ mimeType: 'image/svg+xml', width: 200, height: 100 });
    expect(imageInfo(svg('viewBox="0 0 640 480"'))).toMatchObject({ width: 640, height: 480 });
    expect(imageInfo(svg('width="320" viewBox="0 0 640 480"'))).toMatchObject({ width: 320, height: 240 });
    expect(imageInfo(svg(''))).toMatchObject({ width: 300, height: 150 });
  });

  it('refuses bytes that are not an image, whatever the file is called', () => {
    expect(imageInfo(Buffer.from('SECRET_KEY=abc\n'))).toBeUndefined();
    expect(imageInfo(Buffer.alloc(0))).toBeUndefined();
    expect(imageInfo(pngHeader(0, 10))).toBeUndefined();
  });
});

describe('fitSize', () => {
  const info = { mimeType: 'image/png', width: 2000, height: 500 };
  it('keeps the aspect ratio when one side is given and caps the default width', () => {
    expect(fitSize(info, 800, undefined, 1200)).toEqual({ width: 800, height: 200 });
    expect(fitSize(info, undefined, 100, 1200)).toEqual({ width: 400, height: 100 });
    expect(fitSize(info, 300, 300, 1200)).toEqual({ width: 300, height: 300 });
    expect(fitSize(info, undefined, undefined, 1200)).toEqual({ width: 1200, height: 300 });
    expect(fitSize({ ...info, width: 400, height: 100 }, undefined, undefined, 1200)).toEqual({ width: 400, height: 100 });
  });
});

describe('buildImage', () => {
  it('creates a complete Excalidraw image element pointing at the file', () => {
    const r = buildImage({ id: 'plot', x: 40, y: 60, width: 600, height: 300, fileId: 'f1' }, [], opts);
    expect(r.ids).toEqual(['plot']);
    expect(r.warnings).toEqual([]);
    const el = r.elements[0] as El;
    expect(el).toMatchObject({ id: 'plot', type: 'image', x: 40, y: 60, width: 600, height: 300, fileId: 'f1', status: 'saved', scale: [1, 1], crop: null, isDeleted: false, version: 1 });
  });

  it('generates an id when none is given', () => {
    const r = buildImage({ width: 10, height: 10, fileId: 'f1' }, [], opts);
    expect(r.ids[0]).toMatch(/^image-/);
  });

  it('swaps the picture of an existing image in place and keeps its position unless moved', () => {
    const first = buildImage({ id: 'plot', x: 40, y: 60, width: 600, height: 300, fileId: 'f1' }, [], opts).elements;
    const r = buildImage({ id: 'plot', width: 500, height: 250, fileId: 'f2' }, first, opts);
    const el = r.elements[0] as El;
    expect(el).toMatchObject({ id: 'plot', x: 40, y: 60, width: 500, height: 250, fileId: 'f2', version: 2 });
  });

  it('places the image in a frame', () => {
    const frame = { id: 'f', type: 'frame', x: 0, y: 0, width: 800, height: 600, version: 1, versionNonce: 1, isDeleted: false, updated: 1 };
    const r = buildImage({ id: 'plot', width: 100, height: 100, fileId: 'f1', frame: 'f' }, [frame], opts);
    expect((r.elements.find((e) => e.id === 'plot') as El).frameId).toBe('f');
  });

  it('refuses to turn another kind of element into an image, and bad ids', () => {
    const rect = { id: 'box', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: 1 };
    const r = buildImage({ id: 'box', width: 10, height: 10, fileId: 'f1' }, [rect], opts);
    expect(r.ids).toEqual([]);
    expect(r.elements).toEqual([]);
    expect(r.warnings[0]).toContain('is a rectangle, not an image');
    expect(buildImage({ id: 'bad id!', width: 10, height: 10, fileId: 'f1' }, [], opts).warnings[0]).toContain('invalid id');
  });
});

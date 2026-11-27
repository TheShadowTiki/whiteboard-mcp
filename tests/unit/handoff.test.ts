import { describe, expect, it } from 'vitest';
import { HandoffInputError, elementBox, idsInRegion, idsNear, parseBoards, parseHandoff, parseRegion, resolveIds } from '../../src/shared/handoff.js';
import type { ExElement } from '../../src/shared/protocol.js';

function raw(id: string, type: string, over: Record<string, unknown> = {}): ExElement {
  return { id, type, x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false, updated: 1, ...over };
}

describe('parseHandoff', () => {
  it('keeps valid fields, trims text and drops duplicate ids', () => {
    expect(parseHandoff({ ids: ['a', 'b', 'a'], point: { x: 1, y: 2 }, region: { x: 0, y: 0, width: 10, height: 5 }, text: '  move this  ' })).toEqual({
      ids: ['a', 'b'],
      point: { x: 1, y: 2 },
      region: { x: 0, y: 0, width: 10, height: 5 },
      text: 'move this',
    });
  });

  it('defaults to no ids and leaves out empty text', () => {
    expect(parseHandoff({ text: '   ' })).toEqual({ ids: [] });
  });

  it.each([
    [{ ids: 'a' }, /ids/],
    [{ ids: [1] }, /ids/],
    [{ ids: Array.from({ length: 501 }, (_, i) => `e${i}`) }, /ids/],
    [{ text: 5 }, /text must be a string/],
    [{ text: 'x'.repeat(4001) }, /exceeds/],
    [{ point: { x: 1 } }, /point/],
    [{ point: { x: Infinity, y: 0 } }, /point/],
    [{ region: { x: 0, y: 0, width: 0, height: 5 } }, /positive/],
    [{ region: { x: 0, y: 0, width: -3, height: 5 } }, /positive/],
    [{ region: { x: 0, y: 0, width: '3', height: 5 } }, /region/],
    [{ region: { x: 1e9, y: 0, width: 3, height: 5 } }, /region/],
  ])('rejects %j', (msg, error) => {
    expect(() => parseHandoff(msg as Record<string, unknown>)).toThrow(HandoffInputError);
    expect(() => parseHandoff(msg as Record<string, unknown>)).toThrow(error);
  });
});

describe('parseRegion', () => {
  it('is undefined when absent and names the field in errors', () => {
    expect(parseRegion(undefined)).toBeUndefined();
    expect(() => parseRegion({}, 'area')).toThrow(/^area/);
  });
});

describe('parseBoards', () => {
  it('keeps unique, plausible board ids only', () => {
    expect(parseBoards(['a', 'a', '', 7, 'x'.repeat(65), 'b'])).toEqual(['a', 'b']);
    expect(parseBoards('a')).toEqual([]);
  });
});

describe('elementBox', () => {
  it('uses x, y, width, height for shapes', () => {
    expect(elementBox(raw('r', 'rectangle', { x: 10, y: 20 }))).toEqual([10, 20, 110, 70]);
  });

  it('uses the points for lines and arrows', () => {
    expect(elementBox(raw('a', 'arrow', { x: 10, y: 10, points: [[0, 0], [50, -20], [80, 30]] }))).toEqual([10, -10, 90, 40]);
  });

  it('includes rotation', () => {
    const [x1, y1, x2, y2] = elementBox(raw('r', 'rectangle', { x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 }));
    expect([x1, y1, x2, y2].map((v) => Math.round(v))).toEqual([40, -40, 60, 60]);
  });
});

describe('idsInRegion', () => {
  const scene = [
    raw('inside', 'rectangle', { x: 20, y: 20, width: 30, height: 30 }),
    raw('overlap', 'rectangle', { x: 90, y: 90, width: 50, height: 50 }),
    raw('outside', 'rectangle', { x: 300, y: 300 }),
    raw('label', 'text', { x: 25, y: 25, containerId: 'inside' }),
    raw('gone', 'rectangle', { x: 20, y: 20, isDeleted: true }),
    raw('line', 'line', { x: 150, y: 0, points: [[0, 0], [-60, 60]] }),
  ];

  it('returns every live element touching the region, not labels or tombstones', () => {
    expect(idsInRegion(scene, { x: 0, y: 0, width: 100, height: 100 })).toEqual(['inside', 'overlap', 'line']);
  });

  it('returns nothing for an empty area', () => {
    expect(idsInRegion(scene, { x: 1000, y: 1000, width: 50, height: 50 })).toEqual([]);
  });

  it('keeps a free-standing text element', () => {
    expect(idsInRegion([raw('note', 'text', { x: 5, y: 5 })], { x: 0, y: 0, width: 10, height: 10 })).toEqual(['note']);
  });
});

describe('idsNear', () => {
  const scene = [
    raw('far', 'rectangle', { x: 1000, y: 1000 }),
    raw('near', 'rectangle', { x: 120, y: 0 }),
    raw('under', 'rectangle', { x: 0, y: 0 }),
  ];

  it('orders by distance and respects radius and max', () => {
    expect(idsNear(scene, { x: 50, y: 25 }, 150, 10)).toEqual(['under', 'near']);
    expect(idsNear(scene, { x: 50, y: 25 }, 150, 1)).toEqual(['under']);
    expect(idsNear(scene, { x: 50, y: 25 }, 10, 10)).toEqual(['under']);
  });
});

describe('resolveIds', () => {
  it('maps labels to their containers and drops unknown ids', () => {
    const scene = [raw('box', 'rectangle'), raw('lbl', 'text', { containerId: 'box' }), raw('t', 'text')];
    expect(resolveIds(scene, ['lbl', 'box', 'missing', 't'])).toEqual(['box', 't']);
  });
});

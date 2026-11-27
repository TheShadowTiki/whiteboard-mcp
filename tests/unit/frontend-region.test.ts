import { describe, expect, it } from 'vitest';
import { containsPoint, handoffFor, isMarkable, normalizeRect } from '../../frontend/src/region.js';

describe('marked region', () => {
  it('normalizes a box dragged up or left', () => {
    expect(normalizeRect({ x: 100, y: 50, width: -40, height: -20 })).toEqual({ x: 60, y: 30, width: 40, height: 20 });
    expect(normalizeRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('counts only boxes big enough on screen at the current zoom', () => {
    expect(isMarkable({ x: 0, y: 0, width: 10, height: 10 }, 1)).toBe(true);
    expect(isMarkable({ x: 0, y: 0, width: 10, height: 10 }, 0.5)).toBe(false);
    expect(isMarkable({ x: 0, y: 0, width: 100, height: 4 }, 1)).toBe(false);
  });

  it('includes its edges', () => {
    const r = { x: 0, y: 0, width: 10, height: 10 };
    expect(containsPoint(r, { x: 10, y: 0 })).toBe(true);
    expect(containsPoint(r, { x: 10.1, y: 5 })).toBe(false);
  });

  it('sends the region only when the right-click falls inside it', () => {
    const region = { x: 0, y: 0, width: 100, height: 100 };
    expect(handoffFor({ x: 50, y: 50 }, ['a'], region)).toEqual({ ids: ['a'], point: { x: 50, y: 50 }, region });
    expect(handoffFor({ x: 500, y: 50 }, [], region)).toEqual({ ids: [], point: { x: 500, y: 50 } });
    expect(handoffFor({ x: 5, y: 5 }, [], undefined)).toEqual({ ids: [], point: { x: 5, y: 5 } });
  });
});

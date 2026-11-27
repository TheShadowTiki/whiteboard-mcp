/** The marked region and what a right-click sends ("Send to agent"). No DOM: unit-tested on its own. */
import type { Handoff, Point, Region } from '../../src/shared/protocol';

/** A drag box smaller than this on screen is a click, not a region. */
export const MIN_REGION_PX = 8;

/** Excalidraw's drag box as a region with a positive size. */
export function normalizeRect(r: { x: number; y: number; width: number; height: number }): Region {
  return {
    x: r.width < 0 ? r.x + r.width : r.x,
    y: r.height < 0 ? r.y + r.height : r.y,
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}

export function containsPoint(r: Region, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Big enough on screen (at this zoom) to count as a region. */
export function isMarkable(r: Region, zoom: number): boolean {
  return r.width * zoom >= MIN_REGION_PX && r.height * zoom >= MIN_REGION_PX;
}

/** What a right-click sends: the marked region when the click falls in it, else the point; and the selection. */
export function handoffFor(point: Point, selectedIds: string[], region: Region | undefined): Handoff {
  const inRegion = region && containsPoint(region, point);
  return { ids: selectedIds, point, ...(inRegion ? { region } : {}) };
}

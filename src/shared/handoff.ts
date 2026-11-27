/**
 * "Send to agent": validating what a viewer sends, and finding the elements a handoff is about.
 * Dependency-free like protocol.ts: the daemon, the MCP server and the frontend all use it.
 */
import type { ExElement, Handoff, Point, Region } from './protocol.js';

export const MAX_HANDOFF_TEXT = 4000;
export const MAX_HANDOFF_IDS = 500;
/** Scene coordinates far beyond any real board; keeps nonsense out of messages and screenshots. */
const MAX_COORD = 1e7;
const MAX_BOARD_ID = 64;
export const MAX_AGENT_BOARDS = 64;

export class HandoffInputError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

export function parsePoint(v: unknown, field = 'point'): Point | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v) || !coord(v.x) || !coord(v.y)) throw new HandoffInputError(`${field} must be {x, y} with finite numbers`);
  return { x: v.x, y: v.y };
}

export function parseRegion(v: unknown, field = 'region'): Region | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v) || !coord(v.x) || !coord(v.y) || !coord(v.width) || !coord(v.height)) {
    throw new HandoffInputError(`${field} must be {x, y, width, height} with finite numbers`);
  }
  if (!(v.width > 0 && v.height > 0)) throw new HandoffInputError(`${field} width and height must be positive`);
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}

/** The handoff fields of a viewer message, validated. */
export function parseHandoff(msg: Record<string, unknown>): Handoff {
  const ids = msg.ids ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_HANDOFF_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
    throw new HandoffInputError(`ids must be an array of at most ${MAX_HANDOFF_IDS} element ids`);
  }
  let text: string | undefined;
  if (msg.text !== undefined) {
    if (typeof msg.text !== 'string') throw new HandoffInputError('text must be a string');
    text = msg.text.trim();
    if (text.length > MAX_HANDOFF_TEXT) throw new HandoffInputError(`text exceeds ${MAX_HANDOFF_TEXT} characters`);
  }
  const point = parsePoint(msg.point);
  const region = parseRegion(msg.region);
  return { ids: [...new Set(ids as string[])], ...(point ? { point } : {}), ...(region ? { region } : {}), ...(text ? { text } : {}) };
}

/** Board ids an agent session reports, deduplicated; anything malformed is dropped. */
export function parseBoards(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ok = v.filter((b): b is string => typeof b === 'string' && b.length > 0 && b.length <= MAX_BOARD_ID);
  return [...new Set(ok)].slice(0, MAX_AGENT_BOARDS);
}

type Box = [x1: number, y1: number, x2: number, y2: number];

/** The element's axis-aligned box in scene coordinates, rotation included. */
export function elementBox(el: ExElement): Box {
  const pts = Array.isArray(el.points) ? (el.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && coord(p[0]) && coord(p[1])) : [];
  let [x1, y1, x2, y2]: Box = pts.length
    ? [el.x + Math.min(...pts.map((p) => p[0])), el.y + Math.min(...pts.map((p) => p[1])), el.x + Math.max(...pts.map((p) => p[0])), el.y + Math.max(...pts.map((p) => p[1]))]
    : [el.x, el.y, el.x + el.width, el.y + el.height];
  const angle = typeof el.angle === 'number' && Number.isFinite(el.angle) ? el.angle : 0;
  if (angle % (2 * Math.PI) === 0) return [x1, y1, x2, y2];
  // Excalidraw rotates about the centre of x, y, width, height (for lines too).
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ].map(([px, py]) => [cx + (px! - cx) * cos - (py! - cy) * sin, cy + (px! - cx) * sin + (py! - cy) * cos] as const);
  x1 = Math.min(...corners.map((c) => c[0]));
  y1 = Math.min(...corners.map((c) => c[1]));
  x2 = Math.max(...corners.map((c) => c[0]));
  y2 = Math.max(...corners.map((c) => c[1]));
  return [x1, y1, x2, y2];
}

/** Live elements a handoff can name: no tombstones, and a label stands for its container. */
function targets(elements: ExElement[]): ExElement[] {
  const live = elements.filter((el) => !el.isDeleted);
  const ids = new Set(live.map((el) => el.id));
  return live.filter((el) => !(el.type === 'text' && typeof el.containerId === 'string' && ids.has(el.containerId)));
}

/** Ids of the elements touching the region (not only those fully inside it, which is what Excalidraw selects). */
export function idsInRegion(elements: ExElement[], region: Region): string[] {
  const rx2 = region.x + region.width;
  const ry2 = region.y + region.height;
  return targets(elements)
    .filter((el) => {
      const [x1, y1, x2, y2] = elementBox(el);
      return x1 <= rx2 && x2 >= region.x && y1 <= ry2 && y2 >= region.y;
    })
    .map((el) => el.id);
}

/** Ids of the elements within `radius` of the point, nearest first, at most `max`. */
export function idsNear(elements: ExElement[], point: Point, radius: number, max: number): string[] {
  return targets(elements)
    .map((el) => {
      const [x1, y1, x2, y2] = elementBox(el);
      const dx = Math.max(x1 - point.x, 0, point.x - x2);
      const dy = Math.max(y1 - point.y, 0, point.y - y2);
      return { id: el.id, d: Math.hypot(dx, dy) };
    })
    .filter((c) => c.d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((c) => c.id);
}

/** Resolves bound labels to their containers, keeping order and dropping unknown ids. */
export function resolveIds(elements: ExElement[], ids: string[]): string[] {
  const byId = new Map(elements.filter((el) => !el.isDeleted).map((el) => [el.id, el]));
  const out: string[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (!el) continue;
    const target = el.type === 'text' && typeof el.containerId === 'string' && byId.has(el.containerId) ? el.containerId : id;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

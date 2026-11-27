/** The message an agent session gets when the human sends part of a board to it ("Send to agent"). */
import { describeScene } from '../shared/describe.js';
import { idsInRegion, idsNear, resolveIds } from '../shared/handoff.js';
import type { ExElement, Region, ServerAgentMessage } from '../shared/protocol.js';

/** "Nearby" for a right-click with nothing selected, in scene px. */
export const NEAR_RADIUS = 150;
export const NEAR_MAX = 10;
const MAX_DESCRIBED = 30;
/** Ids beyond this make a tool call too long to suggest; the region works instead. */
const MAX_SUGGESTED_IDS = 40;
/** What a screenshot around a bare point shows. */
const POINT_VIEW = { width: 600, height: 400 };

const r = (n: number) => Math.round(n);
const regionJson = (g: Region) => JSON.stringify({ x: r(g.x), y: r(g.y), width: Math.max(1, r(g.width)), height: Math.max(1, r(g.height)) });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line per element, without describeScene's whole-board header. */
function describe(elements: ExElement[], ids: string[]): string[] {
  if (!ids.length) return [];
  const lines = describeScene(elements, { ids, maxElements: MAX_DESCRIBED }).split('\n').slice(1);
  return lines.map((l) => `  ${l}`);
}

export function formatHandoff(h: ServerAgentMessage, elements: ExElement[]): string {
  const name = h.title ? `"${h.title}" [${h.canvasId}]` : `[${h.canvasId}]`;
  const lines = [`Whiteboard: the human sent you part of the board ${name} with "Send to agent".`];
  if (h.text) lines.push(`Instruction: ${JSON.stringify(h.text)}`);
  const selected = resolveIds(elements, h.ids);
  let look: string;

  if (h.region) {
    const g = h.region;
    const ids = [...new Set([...selected, ...idsInRegion(elements, g)])];
    const where = `Region (${r(g.x)},${r(g.y)}) ${r(g.width)}×${r(g.height)}`;
    lines.push(ids.length ? `${where}, ${plural(ids.length, 'element')} touching it:` : `${where}, empty: nothing is drawn there yet.`);
    lines.push(...describe(elements, ids));
    look = `canvas_screenshot {"region":${regionJson(g)}}${ids.length ? ` · canvas_read {"region":${regionJson(g)}}` : ''}`;
  } else if (selected.length) {
    lines.push(`Selected: ${plural(selected.length, 'element')}:`);
    lines.push(...describe(elements, selected));
    look =
      selected.length <= MAX_SUGGESTED_IDS
        ? `canvas_screenshot {"ids":${JSON.stringify(selected)}} · canvas_read {"ids":${JSON.stringify(selected)}}`
        : 'canvas_read, then canvas_screenshot with the ids you need';
  } else if (h.point) {
    const p = h.point;
    const near = idsNear(elements, p, NEAR_RADIUS, NEAR_MAX);
    lines.push(`Right-clicked at (${r(p.x)},${r(p.y)}) with nothing selected; ${near.length ? `${plural(near.length, 'element')} within ${NEAR_RADIUS} px:` : `nothing within ${NEAR_RADIUS} px.`}`);
    lines.push(...describe(elements, near));
    const view = { x: p.x - POINT_VIEW.width / 2, y: p.y - POINT_VIEW.height / 2, ...POINT_VIEW };
    look = `canvas_screenshot {"region":${regionJson(view)}}`;
  } else {
    lines.push('Nothing selected.');
    look = 'canvas_read';
  }

  lines.push(`To see it: ${look}`);
  lines.push(`Work on this board (canvas_open {"board":"${h.canvasId}"} first if you are on another one), then tell the human in chat what you changed.`);
  return lines.join('\n');
}

import { convertToExcalidrawElements, exportToBlob, exportToCanvas, getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { idsInRegion, parseRegion } from '../../src/shared/handoff';
import type { ExElement, FocusPayload, FocusResult, MermaidPayload, MermaidResult, Region, ScreenshotPayload, ScreenshotResult, ViewerRequestType } from '../../src/shared/protocol';
import { pulseHighlight } from './highlight';

export interface RequestContext {
  api: ExcalidrawImperativeAPI;
  dark(): boolean;
  /** Appends new elements to the scene and sends them to the daemon as the agent's. */
  appendAsAgent(elements: readonly ExcalidrawElement[], files: BinaryFiles): void;
  highlight(elements: readonly ExcalidrawElement[]): void;
}

const PADDING = 24;
const MAX_SIDE = 1600;
const MAX_SCALE = 4;
const MAX_CANVAS_SIDE = 8192;
const MERMAID_GAP = 80;

const obj = <T>(payload: unknown): Partial<T> => (payload && typeof payload === 'object' ? (payload as Partial<T>) : {});

/** Live elements matching ids, plus the labels bound to them; all live elements when no ids are given. */
function pick(api: ExcalidrawImperativeAPI, ids: unknown): NonDeletedExcalidrawElement[] {
  const all = api.getSceneElements();
  if (!Array.isArray(ids) || !ids.length) {
    if (!all.length) throw new Error('canvas is empty');
    return [...all];
  }
  const wanted = new Set(ids);
  const out = all.filter((el) => wanted.has(el.id) || (el.type === 'text' && el.containerId !== null && wanted.has(el.containerId)));
  if (!out.length) throw new Error('none of the requested elements exist');
  return out;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'));
    reader.readAsDataURL(blob);
  });
}

/** Excalidraw's dark export: the light rendering, inverted. Applied to our own background too. */
const DARK_FILTER = 'invert(93%) hue-rotate(180deg)';

function canvasToBase64(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? blobToBase64(blob).then(resolve, reject) : reject(new Error('could not encode the image'))), 'image/png');
  });
}

/**
 * Exactly the region, as the human would see it there: the elements touching it are drawn, then the
 * image is cropped to the region. An empty region gives a blank image of its size ("draw here").
 */
async function regionScreenshot(ctx: RequestContext, p: Partial<ScreenshotPayload>, region: Region): Promise<ScreenshotResult> {
  const { api } = ctx;
  const all = api.getSceneElements();
  let ids = idsInRegion(all as unknown as ExElement[], region);
  if (Array.isArray(p.ids) && p.ids.length) {
    const want = new Set(p.ids);
    ids = ids.filter((id) => want.has(id));
  }
  const wanted = new Set(ids);
  const elements = all.filter((el) => wanted.has(el.id) || (el.type === 'text' && el.containerId !== null && wanted.has(el.containerId)));
  const dark = typeof p.dark === 'boolean' ? p.dark : ctx.dark();
  const background = api.getAppState().viewBackgroundColor;
  const longest = Math.max(region.width, region.height, 1);
  let scale = typeof p.scale === 'number' && p.scale > 0 ? Math.min(p.scale, MAX_SCALE) : Math.min(2, MAX_SIDE / longest);
  scale = Math.min(scale, MAX_CANVAS_SIDE / longest);

  let source: { canvas: HTMLCanvasElement; x: number; y: number } | undefined;
  if (elements.length) {
    const [x1, y1, x2, y2] = getCommonBounds(elements);
    // Elements reaching far outside the region are drawn whole before cropping; keep that canvas drawable.
    scale = Math.min(scale, MAX_CANVAS_SIDE / Math.max(x2 - x1, y2 - y1, 1));
    const canvas = await exportToCanvas({
      elements,
      files: api.getFiles(),
      exportPadding: 0,
      appState: { exportBackground: false, exportWithDarkMode: dark, viewBackgroundColor: background },
      getDimensions: (w: number, h: number) => ({ width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale }),
    });
    source = { canvas, x: x1, y: y1 };
  }

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(region.width * scale));
  out.height = Math.max(1, Math.round(region.height * scale));
  const g = out.getContext('2d');
  if (!g) throw new Error('could not draw the screenshot');
  if (dark) g.filter = DARK_FILTER;
  g.fillStyle = background;
  g.fillRect(0, 0, out.width, out.height);
  g.filter = 'none';
  if (source) g.drawImage(source.canvas, Math.round((source.x - region.x) * scale), Math.round((source.y - region.y) * scale));
  return { mimeType: 'image/png', base64: await canvasToBase64(out), width: out.width, height: out.height };
}

async function screenshot(ctx: RequestContext, payload: unknown): Promise<ScreenshotResult> {
  const p = obj<ScreenshotPayload>(payload);
  const region = parseRegion(p.region);
  if (region) return regionScreenshot(ctx, p, region);
  const { api } = ctx;
  const elements = pick(api, p.ids);
  let size = { width: 0, height: 0 };
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    exportPadding: PADDING,
    appState: {
      exportBackground: true,
      exportWithDarkMode: typeof p.dark === 'boolean' ? p.dark : ctx.dark(),
      viewBackgroundColor: api.getAppState().viewBackgroundColor,
    },
    getDimensions: (w: number, h: number) => {
      const longest = Math.max(w, h, 1);
      const cap = MAX_CANVAS_SIDE / longest;
      const scale = typeof p.scale === 'number' && p.scale > 0 ? Math.min(p.scale, MAX_SCALE, cap) : Math.min(2, MAX_SIDE / longest);
      size = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
      return { ...size, scale };
    },
  });
  return { mimeType: 'image/png', base64: await blobToBase64(blob), ...size };
}

async function mermaid(ctx: RequestContext, payload: unknown): Promise<MermaidResult> {
  const p = obj<MermaidPayload>(payload);
  if (typeof p.definition !== 'string' || !p.definition.trim()) throw new Error('definition must be a non-empty string');
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(p.definition, { themeVariables: { fontSize: '20px' } });
  const converted = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  if (!converted.length) throw new Error('the diagram produced no elements');
  const [x1, y1] = getCommonBounds(converted);
  const existing = ctx.api.getSceneElements();
  const [, ey1, ex2] = existing.length ? getCommonBounds(existing) : [0, 0, 0];
  const anchor = existing.length ? { x: ex2 + MERMAID_GAP, y: ey1 } : { x: x1, y: y1 };
  const dx = (typeof p.x === 'number' ? p.x : anchor.x) - x1;
  const dy = (typeof p.y === 'number' ? p.y : anchor.y) - y1;
  // Indices are reassigned after the existing scene so the diagram lands on top.
  const placed = converted.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy, index: null }) as unknown as ExcalidrawElement);
  ctx.appendAsAgent(placed, files ?? {});
  return { ids: placed.map((el) => el.id) };
}

function focus(ctx: RequestContext, payload: unknown): FocusResult {
  const p = obj<FocusPayload>(payload);
  const targets = pick(ctx.api, p.ids);
  const zoom = typeof p.zoom === 'number' && p.zoom > 0 ? Math.min(Math.max(p.zoom, 0.1), 30) : undefined;
  ctx.api.scrollToContent(targets, { fitToContent: true, animate: true, ...(zoom ? { minZoom: zoom, maxZoom: zoom } : { maxZoom: 1.5 }) });
  if (p.highlight) {
    const ids = new Set(targets.map((el) => el.id));
    ctx.highlight(targets.filter((el) => !(el.type === 'text' && el.containerId && ids.has(el.containerId))));
  }
  return { ok: true };
}

export async function handleRequest(ctx: RequestContext, type: ViewerRequestType, payload: unknown): Promise<unknown> {
  switch (type) {
    case 'screenshot':
      return screenshot(ctx, payload);
    case 'mermaid':
      return mermaid(ctx, payload);
    case 'focus':
      return focus(ctx, payload);
    default:
      throw new Error(`unknown request type ${JSON.stringify(type)}`);
  }
}

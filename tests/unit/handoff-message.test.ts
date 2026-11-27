import { describe, expect, it } from 'vitest';
import { formatHandoff } from '../../src/mcp/handoffMessage.js';
import { buildElements } from '../../src/shared/elements.js';
import type { ExElement, ServerAgentMessage } from '../../src/shared/protocol.js';

function seeded(seed = 1): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function scene(): ExElement[] {
  return buildElements(
    [
      { id: 'api', type: 'rectangle', x: 100, y: 100, width: 160, height: 80, label: 'API' },
      { id: 'db', type: 'rectangle', x: 400, y: 100, width: 160, height: 80, label: 'DB' },
      { id: 'far', type: 'ellipse', x: 2000, y: 2000, width: 80, height: 80, label: 'Far' },
    ],
    [],
    { now: 1, random: seeded() },
  ).elements;
}

const msg = (over: Partial<ServerAgentMessage>): ServerAgentMessage => ({ t: 'handoff', reqId: 'r', canvasId: 'board-1', title: 'Plan', at: 1, ids: [], ...over });

describe('formatHandoff', () => {
  it('describes a region with the elements touching it and how to look at it', () => {
    const text = formatHandoff(msg({ region: { x: 50, y: 50, width: 300.4, height: 200 }, text: 'make these line up' }), scene());
    expect(text).toContain('Whiteboard: the human sent you part of the board "Plan" [board-1] with "Send to agent".');
    expect(text).toContain('Instruction: "make these line up"');
    expect(text).toContain('Region (50,50) 300×200, 1 element touching it:');
    expect(text).toMatch(/\n {2}rectangle "api" \[API\]/);
    expect(text).not.toContain('"db"');
    expect(text).toContain('To see it: canvas_screenshot {"region":{"x":50,"y":50,"width":300,"height":200}} · canvas_read {"region":{"x":50,"y":50,"width":300,"height":200}}');
    expect(text).toContain('canvas_open {"board":"board-1"}');
  });

  it('includes selected elements that only partly fall in the region', () => {
    const text = formatHandoff(msg({ ids: ['far'], region: { x: 50, y: 50, width: 100, height: 100 } }), scene());
    expect(text).toContain('2 elements touching it');
    expect(text).toContain('"far"');
  });

  it('says when a region is empty, and offers only a screenshot', () => {
    const text = formatHandoff(msg({ region: { x: 900, y: 900, width: 200, height: 100 } }), scene());
    expect(text).toContain('Region (900,900) 200×100, empty: nothing is drawn there yet.');
    expect(text).toContain('To see it: canvas_screenshot {"region":{"x":900,"y":900,"width":200,"height":100}}\n');
    expect(text).not.toContain('Instruction');
  });

  it('describes a selection, resolving labels to their shapes', () => {
    const elements = scene();
    const label = elements.find((e) => e.type === 'text' && e.containerId === 'db')!;
    const text = formatHandoff(msg({ ids: [label.id, 'api', 'missing'] }), elements);
    expect(text).toContain('Selected: 2 elements:');
    expect(text).toContain('canvas_screenshot {"ids":["db","api"]} · canvas_read {"ids":["db","api"]}');
    expect(text).not.toContain('missing');
  });

  it('describes what is near a right-clicked point, with a screenshot around it', () => {
    const text = formatHandoff(msg({ point: { x: 300, y: 140 } }), scene());
    expect(text).toContain('Right-clicked at (300,140) with nothing selected; 2 elements within 150 px:');
    expect(text).toContain('canvas_screenshot {"region":{"x":0,"y":-60,"width":600,"height":400}}');
    expect(formatHandoff(msg({ point: { x: 1000, y: 1000 } }), scene())).toContain('nothing within 150 px.');
  });

  it('copes with a board without a title and an empty handoff', () => {
    const text = formatHandoff(msg({ title: '' }), []);
    expect(text).toContain('part of the board [board-1]');
    expect(text).toContain('Nothing selected.');
  });
});

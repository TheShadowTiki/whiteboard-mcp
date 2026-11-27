import type { Page } from '@playwright/test';
import WebSocket from 'ws';
import { TOKEN, api, expect, openViewer, sceneElements, shared, test, toViewport, type Rest } from './fixtures';

const PORT = 47500;

type Received = { reqId: string; canvasId: string; ids: string[]; point?: { x: number; y: number }; region?: { x: number; y: number; width: number; height: number }; text?: string };

/** A stand-in agent session on the board: records each handoff and accepts it. */
async function fakeAgent(board: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/agent?token=${TOKEN}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const got: Received[] = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(String(m));
    if (msg.t !== 'handoff') return;
    got.push(msg);
    ws.send(JSON.stringify({ t: 'delivered', reqId: msg.reqId, ok: true }));
  });
  ws.send(JSON.stringify({ t: 'hello', boards: [board] }));
  return { got, close: () => ws.close() };
}

async function seed(rest: Rest, canvasId: string, specs: unknown[]) {
  const { buildElements } = await shared();
  await rest.post(api.elements(canvasId), { elements: buildElements(specs, []).elements });
}

const box = (id: string, x: number, y: number, label: string) => ({ id, type: 'rectangle', x, y, width: 160, height: 80, label });

async function rightClick(page: Page, sceneX: number, sceneY: number) {
  const p = await toViewport(page, sceneX, sceneY);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

async function dragBox(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await toViewport(page, from.x, from.y);
  const b = await toViewport(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function ready(page: Page, rest: Rest, canvasId: string) {
  await openViewer(page, canvasId);
  // Clear of Excalidraw's UI: menu top-left, toolbar top centre, footer at the bottom (the page is 1280×720).
  await seed(rest, canvasId, [box('left', 150, 250, 'Left'), box('right', 450, 250, 'Right')]);
  await expect.poll(async () => (await sceneElements(page)).length).toBe(4);
}

test('right-clicking a shape sends it to the agent, next to Excalidraw’s own menu', async ({ page, rest, canvasId }) => {
  const agent = await fakeAgent(canvasId);
  await ready(page, rest, canvasId);
  await rightClick(page, 230, 290);
  await expect(page.locator('.context-menu')).toBeVisible();
  const menu = page.getByTestId('handoff-menu');
  await expect(menu.getByRole('button', { name: 'Send to agent' })).toBeVisible();
  await menu.getByRole('button', { name: 'Send to agent' }).click();
  await expect.poll(() => agent.got.length).toBe(1);
  expect(agent.got[0]).toMatchObject({ canvasId, ids: ['left'] });
  expect(agent.got[0]!.point!.x).toBeCloseTo(230, 0);
  expect(agent.got[0]!.point!.y).toBeCloseTo(290, 0);
  expect(agent.got[0]!.region).toBeUndefined();
  await expect(page.getByText('Sent to agent', { exact: true })).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(page.locator('.context-menu')).toBeHidden();
  agent.close();
});

test('a drag box over empty space is kept as a region and sent when right-clicked inside', async ({ page, rest, canvasId }) => {
  const agent = await fakeAgent(canvasId);
  await ready(page, rest, canvasId);
  await dragBox(page, { x: 100, y: 420 }, { x: 500, y: 560 });
  const overlay = page.getByTestId('handoff-region');
  await expect(overlay).toBeVisible();
  await rightClick(page, 300, 490);
  await page.getByTestId('handoff-menu').getByRole('button', { name: 'Send region to agent' }).click();
  await expect.poll(() => agent.got.length).toBe(1);
  const region = agent.got[0]!.region!;
  expect(agent.got[0]!.ids).toEqual([]);
  expect(region.x).toBeCloseTo(100, 0);
  expect(region.y).toBeCloseTo(420, 0);
  expect(region.width).toBeCloseTo(400, 0);
  expect(region.height).toBeCloseTo(140, 0);
  await expect(overlay).toBeHidden();
  agent.close();
});

test('a drag box over shapes sends the region and the shapes it selected; right-clicking outside it sends the point', async ({ page, rest, canvasId }) => {
  const agent = await fakeAgent(canvasId);
  await ready(page, rest, canvasId);
  await dragBox(page, { x: 100, y: 200 }, { x: 700, y: 400 });
  await rightClick(page, 530, 290);
  await page.getByTestId('handoff-menu').getByRole('button', { name: 'Send region to agent' }).click();
  await expect.poll(() => agent.got.length).toBe(1);
  expect([...agent.got[0]!.ids].sort()).toEqual(expect.arrayContaining(['left', 'right']));
  expect(agent.got[0]!.region).toBeDefined();

  // Right of the shape properties panel, which Excalidraw shows on the left while shapes are selected.
  await dragBox(page, { x: 700, y: 450 }, { x: 900, y: 550 });
  await expect(page.getByTestId('handoff-region')).toBeVisible();
  await rightClick(page, 1000, 300);
  await expect(page.getByTestId('handoff-menu').getByRole('button', { name: 'Send to agent' })).toBeVisible();
  await page.getByTestId('handoff-menu').getByRole('button', { name: 'Send to agent' }).click();
  await expect.poll(() => agent.got.length).toBe(2);
  expect(agent.got[1]!.region).toBeUndefined();
  // Not sent, so still marked.
  await expect(page.getByTestId('handoff-region')).toBeVisible();
  agent.close();
});

test('a left click or Escape clears the marked region', async ({ page, rest, canvasId }) => {
  await ready(page, rest, canvasId);
  await dragBox(page, { x: 100, y: 420 }, { x: 500, y: 560 });
  await expect(page.getByTestId('handoff-region')).toBeVisible();
  const p = await toViewport(page, 900, 500);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('handoff-region')).toBeHidden();
  await dragBox(page, { x: 100, y: 420 }, { x: 500, y: 560 });
  await expect(page.getByTestId('handoff-region')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('handoff-region')).toBeHidden();
});

test('Add instruction… sends what the human typed', async ({ page, rest, canvasId }) => {
  const agent = await fakeAgent(canvasId);
  await ready(page, rest, canvasId);
  await rightClick(page, 530, 290);
  await page.getByTestId('handoff-menu').getByRole('button', { name: 'Add instruction…' }).click();
  const field = page.getByLabel('Instruction for the agent');
  await expect(field).toBeFocused();
  // Typing must not trigger Excalidraw's tool shortcuts (r = rectangle, etc.).
  await field.fill('rename this to Storage');
  await field.press('Enter');
  await expect.poll(() => agent.got.length).toBe(1);
  expect(agent.got[0]).toMatchObject({ ids: ['right'], text: 'rename this to Storage' });
  await expect(page.getByTestId('handoff-form')).toBeHidden();
  agent.close();
});

test('with no agent session on the board, the handoff is left as a note', async ({ page, rest, canvasId }) => {
  await ready(page, rest, canvasId);
  await rightClick(page, 230, 290);
  await page.getByTestId('handoff-menu').getByRole('button', { name: 'Send to agent' }).click();
  await expect(page.getByText('No agent session is on this board; left it as a note')).toBeVisible();
  const snap = await rest.get(api.canvas(canvasId));
  expect(snap.notes.map((n: { text: string }) => n.text)).toEqual([expect.stringMatching(/^Sent to agent · point \(\d+,\d+\) · elements left$/)]);
});

test('strokes drawn just before sending reach the daemon first', async ({ page, rest, canvasId }) => {
  const agent = await fakeAgent(canvasId);
  await ready(page, rest, canvasId);
  await page.locator('label:has([data-testid="toolbar-rectangle"])').click();
  const a = await toViewport(page, 700, 450);
  const b = await toViewport(page, 800, 530);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  // Excalidraw opens no right-click menu while a drawing tool is active; back to the selection tool.
  await page.keyboard.press('v');
  // On its left edge: the inside of an unfilled shape isn't the shape.
  await rightClick(page, 700, 490);
  await page.getByTestId('handoff-menu').getByRole('button', { name: 'Send to agent' }).click();
  await expect.poll(() => agent.got.length).toBe(1);
  const [id] = agent.got[0]!.ids;
  expect(id).toBeTruthy();
  const snap = await rest.get(api.canvas(canvasId));
  expect(snap.elements.map((e: { id: string }) => e.id)).toContain(id);
  agent.close();
});

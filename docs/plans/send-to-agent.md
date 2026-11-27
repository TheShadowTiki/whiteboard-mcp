# Plan: Send to agent

Status: implemented on branch `feat/send-to-agent` (2026-11-26); real-session test pending. Delete this file before merging; what stays true is in `AGENTS.md` and `docs/tools.md`.

Found while building:
- Excalidraw opens no right-click menu while a drawing tool is active, so neither does Send to agent: press V first. Documented in `docs/tools.md`.
- The server instructions are capped at 700 characters (sent every session), so the agents' guide says nothing about handoffs; the message explains itself.
- Pre-existing, not from this work: a full `npm test` run leaves one `tests/fixtures/serve.mjs` daemon behind (seen on `main` too).

## Goal

The human right-clicks the board (on empty space, on an element, or inside a region marked with a drag box) and picks **Send to agent**. The Claude Code session working on that board starts a turn at once, already told what was sent: the board, the marked region (even if it holds nothing), the selected elements or the clicked point, and an optional instruction. If the session is idle, it wakes up. If it's busy, it reads the message between tool calls.

This removes the current loop of leaving a note, switching to the chat, and typing "check the board".

## What we know (2026-11-26)

- **Waking the session works** through Claude Code's per-session messaging socket. Claude Code gives every child process, the MCP server included, two environment variables: `CLAUDE_CODE_MESSAGING_SOCKET` (the path of a Unix socket) and `CLAUDE_CODE_MESSAGING_TOKEN`.
  - Tested from a child of a VS Code extension session (Claude Code 2.1.332). We sent two newline-terminated JSON lines: `{"type":"auth","token":"…"}`, then `{"type":"user","message":{"role":"user","content":"…"}}`. The idle session started a turn with no approval prompt.
  - The message is labelled as from "another Claude session", not as typed by the user.
  - The socket sends no reply.
  - The format is not documented; Claude Code's own help text shows it. Docs: https://code.claude.com/docs/en/cross-session-messaging.md.
- **Channels** (`notifications/claude/channel`) are the official push path. They are not documented for the VS Code extension, and during the research preview they need `--dangerously-load-development-channels` in an interactive terminal. Out of scope for now. They could be added later as a second way to deliver (see "Later").
- **Excalidraw 0.18 has no API for adding items to its right-click menu.** It does expose `appState.contextMenu` (`{ items, top, left } | null`), which says when its own menu is open and where. We place our own button next to that menu, so Excalidraw's menu keeps working unchanged.
- `canvas_read` and `canvas_screenshot` already accept `ids`, so the agent can look at exactly the selection with existing tools. Neither can look at a region yet, so this work adds that (section 3b).
- **A drag box's rectangle can be read.** While the human drags, Excalidraw keeps it in `appState.selectionElement` (`x`, `y`, `width`, `height` in scene coordinates). That's internal state, like `contextMenu`, and it's cleared on pointer up. `api.onPointerUp` and `api.onPointerDown` are public, so the viewer can record the rectangle on release.

## Design

```
viewer ──ws {t:'handoff'}──▶ daemon ──/ws/agent {t:'handoff'}──▶ whiteboard-mcp (the board's session)
   ▲                           │                                     │ writes to CLAUDE_CODE_MESSAGING_SOCKET
   └──── {t:'handoff', result} ┘◀──────── {t:'delivered', ok} ───────┘           ▼
                                                                          Claude Code starts a turn
```

### 1. Wire contract (`src/shared/protocol.ts`, first)

- New viewer message `ClientMessage`: `{ t: 'handoff'; reqId: string; ids: string[]; point?: { x: number; y: number }; region?: { x: number; y: number; width: number; height: number }; text?: string }`.
  - `ids` are the selected elements. Labels are resolved to their containers, as `humanTouched` does.
  - `point` is the clicked point in scene coordinates.
  - `region` is the marked drag rectangle in scene coordinates, sent when the right-click falls inside it. Validate it: finite numbers, positive size, and a size cap.
  - `text` is the optional instruction, with the same length cap as notes.
- New daemon reply `ServerMessage`: `{ t: 'handoff'; reqId; result: 'agent' | 'note' | 'error'; error?: string }`.
- New socket `API.agentWs = '/ws/agent'`, with token auth like `/ws/host`. One connection per MCP process that can deliver.
  - Agent to daemon: `{ t: 'hello'; boards: string[]; pid: number }`, then `{ t: 'boards'; boards: string[] }` whenever the boards its chats are on change, `{ t: 'active'; board: string }` after each tool call, and `{ t: 'delivered'; reqId; ok: boolean; error?: string }`.
  - Daemon to agent: `{ t: 'handoff'; reqId; canvasId; title; ids; point?; region?; text?; at }`.
- Add a `Region` type (`{ x; y; width; height }`) shared by the handoff message and the region parameter on the tools (3b). Add a `region` field to the viewer `screenshot` request.

### 2. Daemon (`src/canvas/daemon.ts`)

- Keep a set of agent connections, each with its boards and a `lastActive` time per board.
- On a viewer `handoff`:
  - Pick the connected agent watching that board with the most recent `lastActive`, and forward the click to it.
  - Wait up to 5 s for `delivered`.
  - On `ok`, reply `result: 'agent'`.
  - If no agent is watching, if delivery failed, or on timeout, store the click as an ordinary note (`store.addNote`, with the selection ids written into the text) and reply `result: 'note'`. Nothing the human sends is lost.
- Cleanup: remove the agent on close, clear its pending timers, and count agents in the `stats()` used by the soak test. Use the existing heartbeat.

### 3. MCP server (`src/mcp/`)

- New `src/mcp/inbox.ts`, the only code that knows Claude Code's socket format.
  - `inboxAvailable()` and `deliver(text): Promise<void>`: connect, write the two lines, end the connection, with a 2 s timeout.
  - Errors are thrown with clear messages.
- New `src/mcp/agentLink.ts`:
  - Started on `notifications/initialized` (next to `warmUp()`) only when `inboxAvailable()` is true and `WHITEBOARD_HANDOFF` isn't `off`.
  - Connects to `/ws/agent` with `daemon.json` and the token. Reconnects with backoff and re-reads `daemon.json`, as `vscode/host.js` does.
  - Reports `boards`: the board each chat in this process has used (`Session.board(chat)`). It updates on `setBoard` and on every tool call. This is the "currently has the board open" rule.
  - On `handoff`:
    - Fetch the snapshot.
    - Describe the selected elements with `describe.ts` (compact, capped at roughly 30 lines).
      - With a region, describe every element that intersects it, not only the ones fully inside, which is what Excalidraw selects. If none intersect, say the region is empty.
      - For a point with nothing selected and no region, describe the elements within about 150 px of the point, at most 10.
    - Format the message (below), call `deliver`, and reply `delivered`.
- Message Claude receives:

  ```
  Whiteboard: the human sent you part of the board "<title>" [<board id>] from the viewer.
  Instruction: "<text>"            (line left out when empty)
  Region (x,y) 640×420, 4 elements intersect it: <compact descriptions>
    or: Region (x,y) 640×420, empty
    or: Selection: 4 elements, bounds (x1,y1)-(x2,y2): <compact descriptions>
    or: Point (x,y) with nothing selected; nearby: <compact descriptions>
  To see it: canvas_screenshot {"region":{…}} and canvas_read {"region":{…}}   (with a region)
         or: canvas_read {"ids":[…]} and canvas_screenshot {"ids":[…]}
  Work on this board, then tell the human in chat what you changed.
  ```

### 3b. Region on the tools (`src/mcp/tools.ts`, viewer)

- `canvas_read` gets `region` (an object with number properties `x`, `y`, `width`, `height`; single types only, so the schema stays portable). It describes the elements that intersect the region. `ids` and `region` together mean both conditions must hold.
- `canvas_screenshot` gets the same `region`. The viewer exports the elements that intersect it, then crops the image to exactly the region, with a little padding and the board background. An empty region gives a blank image of the right size, which is still useful as "draw here".
- The tools' schema size limit (raised to 7.5 KB for `canvas_image`) is nearly reached. Keep the descriptions short, and raise the limit in `tests/unit/schemas.test.ts` only if needed.

- The MCP server never writes to stdout from this code. Logs go to stderr under `WHITEBOARD_DEBUG`, as `AGENTS.md` requires.

### 4. Viewer (`frontend/`)

- `App.tsx`: watch `appState.contextMenu` through `api.onChange`. When it opens, render a small **Send to agent** button anchored to `top`/`left`, just outside Excalidraw's menu.
  - Clicking the button opens a one-line instruction box. **Enter** sends; **Send without note** sends with no instruction.
  - Before sending, save the click position in scene coordinates (`viewportCoordsToSceneCoords`) and the current selection, because closing the menu may change both.
- New `frontend/src/region.ts`, the marked region:
  - While the selection tool drags, keep the latest `appState.selectionElement` rectangle from `onChange`. On `api.onPointerUp`, keep it as the marked region if it's larger than about 8×8 screen px. A plain click doesn't count.
  - Excalidraw removes its dashed box on release, so draw our own: a light dashed overlay in screen coordinates, recomputed from scroll and zoom on every change. The human can then see what will be sent.
  - The region is cleared on the next left pointer-down, on Escape, and after it has been sent.
  - A right-click inside the region sends `region`, along with any `ids` the box selected. A right-click outside it sends the point or selection as before.
  - The **Send to agent** button says **Send region to agent** when a region will be sent.
- `live.ts`: `sendHandoff()` first calls `throttle.flush()`, so any strokes not yet sent reach the daemon ahead of the handoff on the same socket. Then it sends the handoff and resolves on the daemon's reply.
- Toast messages:
  - "Sent to agent"
  - "No agent session on this board; left as a note"
  - "offline, not sent"
- No shortcut or toolbar button in this round (see "Later").

### 5. Tests

- Unit:
  - `inbox.ts` against a fake Unix-socket server: exact bytes, timeout, missing variables.
  - Message formatting: region (full and empty), selection, point, empty instruction, long selections.
  - Region intersection: inside, partly overlapping, outside, rotated elements, arrows, and labels resolved to their containers.
  - The new `region` schema passes the portability test.
  - Daemon routing choice: most recent `lastActive`, no agent, timeout.
  - Protocol validation of the new messages.
- Integration: a real daemon with a fake agent socket and a fake viewer socket.
  - A handoff reaches the agent and the viewer gets `agent`.
  - With no agent, it becomes a note.
  - The agent disconnects in the middle.
  - Strokes sent before a handoff are stored first.
- MCP integration: spawn the server with the two `CLAUDE_CODE_MESSAGING_*` variables pointing at a fake socket, then assert the delivered text.
- e2e (Playwright):
  - Right-click an element, click Send to agent, type an instruction, press Enter. A fake agent receives it, and the toast shows "Sent to agent".
  - Right-click empty space: Excalidraw's own menu still works.
  - Drag a box over empty space, right-click inside it, send. The fake agent gets `region` with no `ids`, and the overlay disappears afterwards. A left click clears a marked region.
  - Drag a box over two shapes and send. The agent gets both `region` and `ids`.
  - `canvas_screenshot {region}` returns an image of the region's size; `canvas_read {region}` lists exactly the intersecting elements.
- `npm run test:soak` after the daemon changes.

### 6. Docs

- `AGENTS.md`: an architecture bullet for `/ws/agent` and `inbox.ts`, and the rule that `inbox.ts` is the only place that knows Claude Code's socket format.
- `docs/configuration.md`: `WHITEBOARD_HANDOFF=off`.
- `docs/security.md`: the new socket.
  - It uses the same token.
  - It lets someone who holds the board's token wake the agent session, which is what the viewer URL already grants for drawing.
  - Messages arrive marked as not from the user, so they can't approve tool use.
- `docs/tools.md` and the guide text: tell agents what a "Whiteboard: the human sent you…" message means.
- README: one line about the feature.

## Order of work

1. Protocol types and validation, with unit tests.
2. `inbox.ts`, with unit tests against a fake socket.
3. Daemon `/ws/agent` and routing, with integration tests and a soak run.
4. `agentLink.ts`, message formatting and the server wiring, with MCP integration tests.
5. `region` on `canvas_read` and `canvas_screenshot`, with unit and e2e tests.
6. The viewer button, instruction box, marked region and toasts, with e2e tests.
7. Docs, `npm run check`, then a real test: the board on 47429, this Claude Code session, and an actual right-click.

## Risks

- **The socket format is undocumented.** A Claude Code update could change it. It's kept to `inbox.ts`, and failures fall back to a note, so the worst case is today's behaviour.
- **Messages can be held.** If the session's permission mode changes, Claude Code may hold incoming messages for approval. The fix is the user's `crossSessionInbound: "accept"` setting. Document it; don't set it.
- **Several sessions on one board.** Only the most recently active one gets the click. That's simple and predictable, and the toast could name the session later.
- **`appState.contextMenu` and `appState.selectionElement` are internal Excalidraw state.** The package is pinned at `^0.18.1`, and e2e tests catch a change. If either goes away, that part of the feature stops working: the button or the region disappears, but nothing else breaks.
- **Holding a region after release is new behaviour.** Excalidraw normally forgets the box on release. Our overlay must not get in the way of drawing: no pointer events, and it's cleared on the next click.
- **Daemons on several nodes.** An agent on another node can't connect, so the click becomes a note. That's correct behaviour.

## Decisions (agreed 2026-11-26)

1. One click sends immediately; **Add instruction…** is a second button that opens the instruction box.
2. "Nearby" means within 150 px of the clicked point, at the current zoom, at most 10 elements.
3. If no agent is connected, the click becomes a note.
4. A drag box is sent as a region, even when it selects nothing.

## Later

- Channels (`notifications/claude/channel`) as a second delivery path for terminal sessions, used when `inbox.ts` isn't available.
- A shortcut such as Ctrl/Cmd+Shift+Enter, and a toolbar button.
- Showing which session received the click.

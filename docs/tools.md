# Tools and how it works

## Tools

| Tool | What it does |
|---|---|
| `canvas_open` | Show this chat's board, give it a title, open another chat's board (this project first, then any folder), or load a saved copy |
| `canvas_draw` | Create or update shapes, text, labelled arrows bound to shapes, frames |
| `canvas_read` | Describe the board (or one area of it), plus what you changed and noted since the agent last looked |
| `canvas_focus` | Scroll your view to some elements and pulse a highlight around them |
| `canvas_screenshot` | PNG of the board, some elements, or exactly one area, so the agent can check its layout |
| `canvas_mermaid` | Turn a Mermaid diagram into hand-drawn elements |
| `canvas_image` | Put a picture from a file (PNG, JPEG, GIF, WebP, SVG: a plot, screenshot, figure) on the board |
| `canvas_delete` | Delete elements, or clear the board |
| `canvas_export` | Save the board as `.excalidraw` or `.png` in your project |
| `canvas_save` | Save a frozen copy of the board to your library, so later chats can find it |
| `canvas_search` | Find other chats' boards and saved copies, in every folder, by name or the text on them |
| `canvas_guide` | Short guide for the agent on explaining well (layout, colours, sizes) |

Every tool result also tells the agent when you've changed something since its last `canvas_read`.

## When you draw back

It's your board too. Circle something, scribble a question, move a box, or press **Note** to send a message. On its next look the agent gets a short list of exactly what you changed:

<img src="media/draw-back.png" alt="A hand-drawn red circle around Redis with the note 'single point of failure?'" width="720">

```text
Human changes since your last read:
Added (2):
  freedraw "RSPj…" hand sketch (1345,193) 254×140 stroke #e03131
  text "2CLo…" "single point of failure?" (1090,92) stroke #e03131
```

> MCP can't interrupt the agent mid-turn, so after you draw, just tell it to "look at the board", or use **Send to agent** below.

## Send to agent

Right-click the board and press **Send to agent** (or **Add instruction…** to say what you want). The agent session working on that board starts a turn at once, even if it was idle, already told what you pointed at:

- **A shape or a selection:** right-click it. The agent gets those elements.
- **An area:** drag a box with the selection tool, even over empty space. It stays marked with a dashed outline until your next click, Escape, or until you send it. Right-click inside it: the agent gets the area and every element touching it, and can look at exactly that area with `canvas_screenshot {region}` and `canvas_read {region}`.
- **A spot:** right-click empty space. The agent gets the point and what's near it.

Strokes you just drew are sent first, so the agent sees them. The message reaches the agent as one from another session, not as typed by you, so it can't approve anything on your behalf.

It works with Claude Code, which gives each session an inbox the MCP server can write to (`CLAUDE_CODE_MESSAGING_SOCKET`). The session gets clicks for a board once one of its tool calls has used that board; with several sessions on one board, the most recently active one gets them. When no session can take it (another agent app, no tool call on that board yet, `WHITEBOARD_HANDOFF=off`), what you sent is kept as a note on the board instead, and the toast says so.

Right-clicking does nothing while a drawing tool is active (Excalidraw's own behaviour): press V for the selection tool first.

## Mermaid

For sequence diagrams and quick flowcharts the agent can write Mermaid and get an editable hand-drawn diagram:

<img src="media/mermaid.png" alt="An OAuth login sequence diagram converted from Mermaid" width="480">

## How it works

```
 you ◀──── chat ────▶ coding agent
  │                        │ MCP (stdio) or CLI
  │                        ▼
  │                whiteboard-mcp ── HTTP + token ──▶ canvas daemon (127.0.0.1)
  │                                                     │  JSON files on disk
  └──── draws / watches ◀──── WebSocket ──── Excalidraw viewer
```

Each agent session runs its own small MCP server. They all talk to one shared daemon on `127.0.0.1`, which stores boards as JSON and syncs them live with the [Excalidraw](https://github.com/excalidraw/excalidraw) viewer in your browser or editor.

## Light and local

- One runtime dependency (`ws`), no native addons, nothing to compile.
- A small shared background process serves every agent session. It starts when your agent app connects and keeps running (about 60 MB, no CPU while idle), so a board you come back to hours later, or after a restart, is still live. After an update, the first session on the new version replaces it on its own; `whiteboard-mcp stop` ends it.
- Everything stays on your machine: local-only server, token-protected, fonts bundled. Details in [security.md](security.md).
- Eleven compact tools, about 7 KB of schema per turn, so it barely touches your context window.

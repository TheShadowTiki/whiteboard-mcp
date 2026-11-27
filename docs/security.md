# Security

Everything stays on your machine.

- The daemon listens on `127.0.0.1` only.
- Every API and WebSocket call needs a random per-user token (`~/.whiteboard-mcp/token`, mode 0600). The viewer URL carries it in its path (`/c/<board>/<token>/`).
- Requests with a foreign `Host` header (DNS rebinding: anything but `127.0.0.1` or `localhost`; any port, so a tunnel can map another local port to the daemon) or a WebSocket `Origin` that isn't a page on this machine (`http://127.0.0.1` or `http://localhost`, any port, so an editor's in-app browser proxy works) are rejected. There are no CORS headers, so other web pages can't talk to it.
- The MCP server never writes outside the workspace/temp, never reads your project's `.env` (`canvas_image` reads only the file you name, and only sends it to the board if its bytes are a PNG, JPEG, GIF, WebP or SVG image), and keeps stdout strictly for protocol frames.
- Fonts are bundled, so the viewer makes no requests to the internet.
- A viewer page reached on another port than the daemon's (a tunnel) gets no fallback address for the daemon: in that browser, the daemon's own port may be another machine's daemon.
- **Send to agent**: an MCP server running under Claude Code connects to the daemon (`/ws/agent`, same token) and, when the human sends something from the board, writes one message to its own session's inbox (the Unix socket and token Claude Code gives the session; they never leave the process). Anyone holding the board URL can therefore wake that session, the same people who can already draw on the board. Claude Code marks these messages as coming from another session, not from the user, so they can't approve tool use. `WHITEBOARD_HANDOFF=off` turns it off.

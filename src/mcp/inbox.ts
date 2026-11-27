/**
 * Claude Code's per-session inbox: the only code that knows its wire format.
 *
 * Claude Code gives every child process (this MCP server included) a Unix socket and a token for the
 * session it belongs to. Writing a user message there starts a turn when the session is idle, or is read
 * between tool calls when it's busy; Claude sees it as a message from another session, not from the human.
 * The format (an auth line, then a message line, newline-delimited JSON) comes from Claude Code's own help
 * text, not from its documentation: if it changes, delivery fails and the daemon keeps the handoff as a note.
 * https://code.claude.com/docs/en/cross-session-messaging.md
 */
import { createConnection } from 'node:net';

export interface Inbox {
  socket: string;
  token: string;
}

const DELIVER_TIMEOUT_MS = 2000;

/** The session's inbox, unless the agent app doesn't offer one or `WHITEBOARD_HANDOFF=off`. */
export function inboxFromEnv(env: NodeJS.ProcessEnv = process.env): Inbox | undefined {
  if ((env.WHITEBOARD_HANDOFF ?? '').trim().toLowerCase() === 'off') return undefined;
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim();
  return socket && token ? { socket, token } : undefined;
}

/** The exact bytes sent: newline-delimited JSON, auth first. */
export function inboxFrames(inbox: Inbox, text: string): string {
  return `${JSON.stringify({ type: 'auth', token: inbox.token })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

/** Writes one message to the inbox. Resolves once it's written; the inbox never answers. */
export function deliver(inbox: Inbox, text: string, timeoutMs = DELIVER_TIMEOUT_MS): Promise<void> {
  return new Promise((resolveDeliver, reject) => {
    const sock = createConnection(inbox.socket);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners('error');
      sock.on('error', () => {});
      if (err) {
        sock.destroy();
        reject(err);
      } else {
        // Half-close so the session sees the end of our frames, then let go of the socket.
        sock.end(() => sock.destroy());
        resolveDeliver();
      }
    };
    const timer = setTimeout(() => finish(new Error(`inbox did not accept the message within ${timeoutMs} ms`)), timeoutMs);
    sock.once('error', (err) => finish(new Error(`inbox unavailable: ${err.message}`)));
    sock.once('connect', () => {
      sock.write(inboxFrames(inbox, text), (err) => finish(err ? new Error(`inbox write failed: ${err.message}`) : undefined));
    });
  });
}

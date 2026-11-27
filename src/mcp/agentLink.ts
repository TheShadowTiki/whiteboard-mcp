/**
 * Lets the human wake this agent session from the board ("Send to agent"). Holds a socket to the daemon
 * (`API.agentWs`), tells it which boards this session's chats are on, and turns each handoff the daemon
 * forwards into a message in the session's inbox (inbox.ts). Only runs when the agent app offers an inbox.
 */
import WebSocket from 'ws';
import type { CanvasClient } from '../canvas/client.js';
import { API, type AgentMessage, type ServerAgentMessage } from '../shared/protocol.js';
import { parseHandoff } from '../shared/handoff.js';
import { formatHandoff } from './handoffMessage.js';
import { deliver as deliverToInbox, type Inbox } from './inbox.js';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const debug = (msg: string): void => {
  if (process.env.WHITEBOARD_DEBUG === '1') process.stderr.write(`[whiteboard-mcp] ${msg}\n`);
};

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 3000;

export interface AgentLinkOptions {
  inbox: Inbox;
  /** The daemon client; may start or find the daemon. */
  connect: () => Promise<CanvasClient>;
  /** Replaceable in tests. */
  deliver?: (inbox: Inbox, text: string) => Promise<void>;
  minRetryMs?: number;
}

export class AgentLink {
  /** The board each chat of this process is on (the last one its tool calls touched). */
  private readonly boards = new Map<string, string>();
  private ws?: WebSocket;
  private retryTimer?: NodeJS.Timeout;
  private retryMs: number;
  private stopped = false;
  private started = false;

  constructor(private readonly opts: AgentLinkOptions) {
    this.retryMs = opts.minRetryMs ?? MIN_RETRY_MS;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    ws?.removeAllListeners();
    ws?.on('error', () => {});
    ws?.terminate();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** A tool call of `chat` touched `board`: the board is now that chat's, and this session the latest on it. */
  used(chat: string, board: string): void {
    const before = this.boards.get(chat);
    this.boards.set(chat, board);
    if (before !== board) this.send({ t: 'boards', boards: this.boardList() });
    this.send({ t: 'active', board });
  }

  private boardList(): string[] {
    return [...new Set(this.boards.values())];
  }

  private send(msg: AgentMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let client: CanvasClient;
    try {
      client = await this.opts.connect();
      // Finds a daemon that restarted (maybe on another port) before we dial it.
      await client.health();
    } catch (err) {
      debug(`agent link: no daemon yet: ${err instanceof Error ? err.message : String(err)}`);
      return this.retry();
    }
    if (this.stopped) return;
    const url = `${client.baseUrl.replace(/^http/, 'ws')}${API.agentWs}?token=${encodeURIComponent(client.token)}`;
    const ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    this.ws = ws;
    ws.on('open', () => {
      this.retryMs = this.opts.minRetryMs ?? MIN_RETRY_MS;
      this.send({ t: 'hello', boards: this.boardList(), pid: process.pid });
      debug('agent link: connected');
    });
    ws.on('message', (data) => void this.onMessage(client, data.toString()));
    ws.on('error', (err) => debug(`agent link: ${err.message}`));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = undefined;
      this.retry();
    });
  }

  private retry(): void {
    if (this.stopped || this.retryTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.open();
    }, wait);
    this.retryTimer.unref();
  }

  private async onMessage(client: CanvasClient, raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(msg) || msg.t !== 'handoff' || typeof msg.reqId !== 'string' || typeof msg.canvasId !== 'string') return;
    const reqId = msg.reqId;
    try {
      const handoff: ServerAgentMessage = {
        t: 'handoff',
        reqId,
        canvasId: msg.canvasId,
        title: typeof msg.title === 'string' ? msg.title : '',
        at: typeof msg.at === 'number' ? msg.at : Date.now(),
        ...parseHandoff(msg),
      };
      const snap = await withTimeout(client.snapshot(handoff.canvasId), SNAPSHOT_TIMEOUT_MS, 'reading the board');
      await (this.opts.deliver ?? deliverToInbox)(this.opts.inbox, formatHandoff(handoff, snap.elements));
      this.send({ t: 'delivered', reqId, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      debug(`agent link: handoff not delivered: ${error}`);
      this.send({ t: 'delivered', reqId, ok: false, error });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms)))]).finally(() => clearTimeout(timer));
}

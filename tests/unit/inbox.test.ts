import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliver, inboxFrames, inboxFromEnv } from '../../src/mcp/inbox.js';

describe('inboxFromEnv', () => {
  it('needs both the socket and the token', () => {
    expect(inboxFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDE_CODE_MESSAGING_TOKEN: 't' })).toEqual({ socket: '/s', token: 't' });
    expect(inboxFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '/s' })).toBeUndefined();
    expect(inboxFromEnv({ CLAUDE_CODE_MESSAGING_TOKEN: 't' })).toBeUndefined();
    expect(inboxFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: ' ', CLAUDE_CODE_MESSAGING_TOKEN: 't' })).toBeUndefined();
  });

  it('is off with WHITEBOARD_HANDOFF=off', () => {
    expect(inboxFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDE_CODE_MESSAGING_TOKEN: 't', WHITEBOARD_HANDOFF: 'OFF' })).toBeUndefined();
  });
});

describe('inboxFrames', () => {
  it('is an auth line then a user message line', () => {
    const lines = inboxFrames({ socket: '/s', token: 'tok' }, 'hi\nthere').split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'auth', token: 'tok' });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'user', message: { role: 'user', content: 'hi\nthere' } });
    expect(lines[2]).toBe('');
  });
});

describe('deliver', () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-inbox-'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the frames to the socket', async () => {
    const path = join(dir, 'inbox.sock');
    const received = new Promise<string>((resolveReceived) => {
      server = createServer((conn) => {
        let data = '';
        conn.on('data', (chunk) => (data += chunk.toString()));
        conn.on('end', () => resolveReceived(data));
      });
    });
    await new Promise<void>((r) => server!.listen(path, () => r()));
    const inbox = { socket: path, token: 'secret' };
    await deliver(inbox, 'Whiteboard: look here');
    expect(await received).toBe(inboxFrames(inbox, 'Whiteboard: look here'));
  });

  it('fails when the socket is missing', async () => {
    await expect(deliver({ socket: join(dir, 'missing.sock'), token: 't' }, 'x')).rejects.toThrow(/inbox unavailable/);
  });

  it('fails when the path is not a socket', async () => {
    const path = join(dir, 'file');
    writeFileSync(path, '');
    await expect(deliver({ socket: path, token: 't' }, 'x')).rejects.toThrow(/inbox unavailable/);
  });
});

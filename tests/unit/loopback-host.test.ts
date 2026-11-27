import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from '../../src/canvas/daemon.js';

describe('isLoopbackHost', () => {
  it('accepts this machine on any valid port, or none', () => {
    for (const h of ['127.0.0.1:47428', 'localhost:47429', 'localhost:1', '127.0.0.1:65535', 'localhost', '127.0.0.1']) expect(isLoopbackHost(h), h).toBe(true);
  });

  it('rejects other names, lookalikes and bad ports', () => {
    for (const h of [undefined, '', 'evil.example', 'evil.example:47428', 'localhost.evil.example:47428', '127.0.0.1.evil.example', '127.0.0.2:47428', '[::1]:47428', 'localhost:0', 'localhost:65536', 'localhost:99999', 'localhost:47428x', 'LOCALHOST:47428', ' localhost:47428']) {
      expect(isLoopbackHost(h), String(h)).toBe(false);
    }
  });
});

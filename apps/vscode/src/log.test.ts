// The extension's log seam: the helpers, and protocol faults reaching the log as they are recorded.

import { describe, expect, it } from 'vitest';
import type { WebviewTransport } from './contract';
import { PanelGraphHost } from './graph-host';
import { asError, elapsed, silentLogger } from './log';

const THEME = { kind: 'dark', nodeColors: {}, defaultNodeColor: '#999999' } as const;

function hostWith(onFault: (fault: unknown) => void) {
  const page: { send: (message: unknown) => void } = { send: () => undefined };
  const transport: WebviewTransport = {
    post: () => undefined,
    onMessage: (handler) => {
      page.send = handler;
      return { dispose: () => undefined };
    },
    cspSource: 'csp',
  };
  const host = new PanelGraphHost({
    theme: THEME,
    parse: () => undefined,
    opener: { open: async () => undefined },
    onReveal: () => undefined,
    onChange: () => undefined,
    onFault,
  });
  host.attach(transport);
  return { host, send: (message: unknown) => page.send(message) };
}

describe('log helpers', () => {
  it('asError keeps an Error and wraps anything else', () => {
    const error = new Error('boom');
    expect(asError(error)).toBe(error);
    expect(asError('plain').message).toBe('plain');
    expect(asError(42)).toBeInstanceOf(Error);
  });

  it('elapsed gives milliseconds to one decimal', () => {
    expect(elapsed(performance.now())).toMatch(/^\d+\.\d$/);
  });

  it('the silent logger accepts every level and returns nothing', () => {
    const levels = ['trace', 'debug', 'info', 'warn'] as const;
    expect(levels.map((level) => silentLogger[level]('x'))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(silentLogger.error(new Error('x'))).toBeUndefined();
  });
});

describe('PanelGraphHost.onFault', () => {
  it('hears each fault as faults() records it', () => {
    const heard: unknown[] = [];
    const { host, send } = hostWith((fault) => heard.push(fault));
    send('not a message');
    expect(heard).toEqual([{ kind: 'unknown-message', received: 'not a message' }]);
    expect(host.faults()).toEqual(heard);
  });

  it('a listener that throws changes nothing in the host', () => {
    const { host, send } = hostWith(() => {
      throw new Error('log down');
    });
    send(1);
    send(2);
    expect(host.faults()).toHaveLength(2);
  });
});

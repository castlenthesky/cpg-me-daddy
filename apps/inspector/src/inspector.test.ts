// The inspector process, in-process (owner decision 9a). NDJSON InspectorInput goes in on stdin and
// the picture is served on 127.0.0.1. Stdout carries the listening line first, then each
// render-report as NDJSON. A `ws` client plays the page. Stdin's end shuts the inspector down, so it
// never outlives the pipe its parent holds. Diagnostics go to stderr, one `cpg-inspector: ` line each.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CheckResult, GraphPayload, VerifyCheckId } from '@cpg/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { runInspector, type TextSink } from './inspector';

class Buffered implements TextSink {
  text = '';
  write(text: string): boolean {
    this.text += text;
    return true;
  }
  lines(): string[] {
    return this.text.split('\n').filter((line) => line !== '');
  }
}

const P: GraphPayload = { seq: 3, nodes: [{ id: 'd', type: 'DIRECTORY' }], edges: [] };
const IDS: readonly VerifyCheckId[] = [
  'filesystem-reconciliation',
  'identity-invariants',
  'id-uniqueness',
  'render-reconciliation',
  'revision-reconciliation',
  'resolution-health',
];
const CHECKS: readonly CheckResult[] = IDS.map((id) => ({
  id,
  state: 'unavailable',
  observed: 0,
  expected: 0,
  localisedTo: [],
  asOfSeq: 3,
}));
const RENDER = {
  type: 'render-report',
  epoch: 1,
  seq: 3,
  report: {
    payloadNodeCount: 1,
    renderedNodeCount: 1,
    renderedEdgeCount: 0,
    duplicateEdges: 0,
    droppedNodeIds: [],
    frameMs: 2,
  },
};

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function isListening(value: unknown): value is { type: 'listening'; url: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'listening' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cpg-inspector-run-'));
  await writeFile(join(dir, 'graph.js'), 'void 0;\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(bundle = 'graph.js') {
  const stdin = new PassThrough();
  const stdout = new Buffered();
  const stderr = new Buffered();
  const done = runInspector({ stdin, stdout, stderr, bundlePath: join(dir, bundle) });
  // A rejection is asserted where a test expects one; this keeps it from going unhandled first.
  done.catch(() => undefined);
  await until(() => stdout.lines().length > 0, 'the listening line');
  const first: unknown = JSON.parse(stdout.lines()[0] ?? '');
  if (!isListening(first)) throw new Error(`first stdout line is not listening: ${stdout.text}`);
  return { stdin, stdout, stderr, done, url: first.url, port: Number(new URL(first.url).port) };
}

function page(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
  const received: unknown[] = [];
  // Round two (review a2): the page drops a binary frame (page-channel.ts), so one must show here.
  socket.on('message', (data: Buffer, isBinary: boolean) =>
    received.push(isBinary ? 'a binary frame' : JSON.parse(data.toString('utf8'))),
  );
  const opened = new Promise<void>((resolve) => socket.on('open', () => resolve()));
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  return { socket, received, opened, closed };
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

describe('runInspector', () => {
  it('writes {"type":"listening","url":"http://127.0.0.1:<port>/"} first, and serves that url', async () => {
    const running = await run();
    expect(running.url).toBe(`http://127.0.0.1:${running.port}/`);
    expect(running.stdout.text).toBe(line({ type: 'listening', url: running.url }));
    expect((await fetch(running.url)).status).toBe(200);
    running.stdin.end();
    await running.done;
  });

  it('serves stdin to the page with host-made protocol and epoch, and writes render-reports out', async () => {
    const running = await run();
    // A line's own protocol, epoch and seq are ignored: the host assigns them.
    running.stdin.write(line({ type: 'graph', protocol: 2, epoch: 9, seq: 8, payload: P }));
    const client = page(running.port);
    await client.opened;
    client.socket.send(JSON.stringify({ type: 'ready', protocol: 1 }));
    await until(() => client.received.length === 1, 'the graph');
    expect(client.received).toStrictEqual([
      { type: 'graph', protocol: 1, epoch: 1, seq: 3, payload: P },
    ]);

    client.socket.send(JSON.stringify(RENDER));
    await until(() => running.stdout.lines().length === 2, 'the render-report line');
    expect(running.stdout.text).toBe(line({ type: 'listening', url: running.url }) + line(RENDER));

    const report = { seq: 3, checks: CHECKS, state: 'unavailable' };
    running.stdin.write(line({ type: 'verification', report }));
    await until(() => client.received.length === 2, 'the verification');
    expect(client.received[1]).toStrictEqual({
      type: 'verification',
      protocol: 1,
      epoch: 1,
      seq: 3,
      report: { epoch: 1, ...report },
    });
    running.stdin.end();
    await running.done;
    expect(running.stderr.text).toBe('');
  });

  it('reports each bad stdin line with its 1-based number and goes on reading', async () => {
    const running = await run();
    running.stdin.write('\n');
    running.stdin.write('   \n');
    running.stdin.write('not json\n');
    running.stdin.write(line({ type: 'payload', payload: P }));
    running.stdin.write(line({ type: 'graph', payload: P }));
    running.stdin.write(
      line({ type: 'verification', report: { seq: 3, checks: [], state: 'pass' } }),
    );
    running.stdin.write('{"nope":1}');
    running.stdin.end();
    await running.done;
    expect(running.stderr.lines()).toEqual([
      'cpg-inspector: stdin line 3: not JSON',
      'cpg-inspector: stdin line 4: not a graph, graph-delta or verification message',
      'cpg-inspector: stdin line 6: not a graph, graph-delta or verification message',
      'cpg-inspector: stdin line 7: not a graph, graph-delta or verification message',
    ]);
  });

  it('reads CRLF lines, and lines split across chunks', async () => {
    const running = await run();
    // Round two (review a9): one line in three writes, and a CRLF split between \r and \n.
    const graph = JSON.stringify({ type: 'graph', payload: P });
    running.stdin.write(graph.slice(0, 10));
    running.stdin.write(graph.slice(10));
    running.stdin.write('\r');
    running.stdin.write('\nnot json\r\n');
    running.stdin.end();
    await running.done;
    expect(running.stderr.lines()).toEqual(['cpg-inspector: stdin line 2: not JSON']);
  });

  it('writes host faults and server log lines to stderr', async () => {
    const running = await run('missing.js');
    running.stdin.write(line({ type: 'graph', payload: P }));
    const gap = { seq: 7, file: 'a.ts', revision_id: 'r', producer: 'filesystem' };
    running.stdin.write(
      line({
        type: 'graph-delta',
        delta: { ...gap, addedNodes: [], addedEdges: [], removedNodeIds: [] },
      }),
    );
    // Round two (U2b.1 part 3b review c1): the missing bundle is named at startup, first.
    await until(() => running.stderr.lines().length === 2, 'the fault');
    expect((await fetch(`${running.url}graph.js`)).status).toBe(404);
    running.stdin.end();
    await running.done;
    const [missing, fault, log] = running.stderr.lines();
    expect(missing).toBe(
      `cpg-inspector: the page bundle ${join(dir, 'missing.js')} is missing; build it with bun run build:inspector`,
    );
    expect(fault).toBe('cpg-inspector: seq-gap: expected seq 4, got 7');
    expect(log).toMatch(/^cpg-inspector: .*bun run build:inspector/);
    expect(running.stderr.lines()).toHaveLength(3);
  });

  it('shuts down when stdin ends: it resolves, the page is dropped and the port is closed', async () => {
    const running = await run();
    const client = page(running.port);
    await client.opened;
    running.stdin.end();
    await running.done;
    await client.closed;
    await expect(fetch(running.url)).rejects.toThrow('fetch failed');
  });

  it('closes the server and rejects with the error when stdin fails', async () => {
    const running = await run();
    const boom = new Error('boom');
    running.stdin.destroy(boom);
    await expect(running.done).rejects.toBe(boom);
    await expect(fetch(running.url)).rejects.toThrow('fetch failed');
  });
});

// U2b.1 part 3b: `cpg index --inspect` finds a built bundle or says how to build one. The child's
// stderr is the CLI's, so the line reaches the terminal at startup, before any page asks for it.
describe('runInspector: the page bundle at startup', () => {
  it('a missing bundle: one stderr line naming its path and bun run build:inspector', async () => {
    const running = await run('missing.js');
    const want = `cpg-inspector: the page bundle ${join(dir, 'missing.js')} is missing; build it with bun run build:inspector\n`;
    await until(() => running.stderr.text.includes(want), 'the missing-bundle line');
    expect(running.stderr.text.split(want)).toHaveLength(2);
    running.stdin.end();
    await running.done;
  });

  it('a built bundle: no such line', async () => {
    const running = await run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(running.stderr.text).not.toContain('is missing');
    running.stdin.end();
    await running.done;
  });
});

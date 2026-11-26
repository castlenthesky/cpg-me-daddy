// U3.1.1 part 3, round two (review b1): the page bundle's entry (apps/inspector/src/graph-page.ts) is
// glue vitest cannot import, so this bundles it as tools/build-inspector.mjs does, with a recording
// stand-in for cosmos.gl, and runs it in a vm over a stub page. Controller decision 31: VS Code's
// channel when acquireVsCodeApi exists, else the WebSocket. Decision 32: a theme re-reads the page's
// computed colours into the live surface.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// Any other method of a Graph is a no-op, so drawing works without WebGL.
const COSMOS_STUB = `
export class Graph {
  constructor(_container, config) {
    const record = { config, partials: [] };
    globalThis.graphs.push(record);
    return new Proxy(this, {
      get: (_target, name) =>
        name === 'setConfigPartial' ? (next) => record.partials.push(next) : () => [],
    });
  }
}
`;

let dir = '';
let bundle = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'graph-page-'));
  const stub = join(dir, 'cosmos.mjs');
  writeFileSync(stub, COSMOS_STUB);
  const built = await esbuild.build({
    absWorkingDir: REPO,
    entryPoints: ['apps/inspector/src/graph-page.ts'],
    tsconfig: 'apps/inspector/tsconfig.page.json',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    alias: { '@cosmos.gl/graph': stub },
  });
  bundle = built.outputFiles[0].text;
}, 60_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

class StubElement {
  style = {};
  setAttribute() {}
  append() {}
  replaceChildren() {}
  addEventListener() {}
}
class StubDiv extends StubElement {}

/** Runs the bundle on a stub page, inside a VS Code webview or not. */
function load(inVsCode) {
  const page = {
    colours: { backgroundColor: 'rgb(1, 1, 1)', color: 'rgb(2, 2, 2)' },
    acquired: 0,
    posted: [],
    sockets: [],
    listeners: {},
    graphs: [],
  };
  const elements = { 'graph-container': new StubDiv(), 'cpg-verification': new StubDiv() };
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
      page.sockets.push(this);
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
  }
  const window = {
    console,
    performance,
    graphs: page.graphs,
    HTMLDivElement: StubDiv,
    WebSocket: StubSocket,
    location: { host: '127.0.0.1:4321' },
    document: {
      body: elements,
      getElementById: (id) => elements[id] ?? null,
      createElement: () => new StubElement(),
    },
    getComputedStyle: (element) => (element === elements ? page.colours : {}),
    addEventListener: (type, listener) => {
      page.listeners[type] = listener;
    },
  };
  window.window = window;
  if (inVsCode) {
    window.acquireVsCodeApi = () => {
      page.acquired += 1;
      return { postMessage: (message) => page.posted.push(structuredClone(message)) };
    };
  }
  vm.runInNewContext(bundle, window);
  return page;
}

const READY = { type: 'ready', protocol: 1 };
const GRAPH = {
  type: 'graph',
  protocol: 1,
  epoch: 1,
  seq: 0,
  payload: { seq: 0, nodes: [{ id: 'f', type: 'FILE' }], edges: [] },
};
const THEME = {
  type: 'theme',
  protocol: 1,
  epoch: 1,
  theme: { kind: 'light', nodeColors: {}, defaultNodeColor: '#999999' },
};
const types = (messages) => messages.map((message) => message.type);

describe('graph-page.ts in a VS Code webview', () => {
  it('talks through the VS Code API, acquired once, and opens no WebSocket', () => {
    const page = load(true);
    expect(page.posted).toEqual([READY]);
    page.listeners.message({ data: GRAPH });
    expect(types(page.posted)).toEqual(['ready', 'render-report']);
    expect(page.acquired).toBe(1);
    expect(page.sockets).toEqual([]);
  });

  it("starts in the page's computed colours and re-reads them on each theme", () => {
    const page = load(true);
    expect(page.graphs.map(({ config }) => config)).toMatchObject([
      {
        backgroundColor: 'rgb(1, 1, 1)',
        hoveredPointRingColor: 'rgb(2, 2, 2)',
        hoveredLinkColor: 'rgb(2, 2, 2)',
      },
    ]);
    page.listeners.message({ data: GRAPH });
    page.colours = { backgroundColor: 'rgb(8, 8, 8)', color: 'rgb(9, 9, 9)' };
    page.listeners.message({ data: THEME });
    expect(page.graphs.map(({ partials }) => partials)).toEqual([
      [
        {
          backgroundColor: 'rgb(8, 8, 8)',
          hoveredPointRingColor: 'rgb(9, 9, 9)',
          hoveredLinkColor: 'rgb(9, 9, 9)',
        },
      ],
    ]);
    expect(types(page.posted)).toEqual(['ready', 'render-report']);
  });
});

describe('graph-page.ts in a browser (owner decision 8a, unchanged)', () => {
  it("talks over its own host's WebSocket, and not to the window", () => {
    const page = load(false);
    const [socket] = page.sockets;
    expect(page.sockets.map(({ url }) => url)).toEqual(['ws://127.0.0.1:4321/ws']);
    expect(socket.sent).toEqual([]);
    socket.listeners.open();
    expect(socket.sent).toEqual([READY]);
    socket.listeners.message({ data: JSON.stringify(GRAPH) });
    expect(types(socket.sent)).toEqual(['ready', 'render-report']);
    expect(page.listeners).toEqual({});
    expect(page.posted).toEqual([]);
  });
});

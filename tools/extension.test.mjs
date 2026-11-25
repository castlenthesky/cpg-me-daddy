// U3.1.1 part 4 (controller decision 39): the extension VS Code loads, driven with a stand-in for the
// `vscode` module. The manifest's `main` is required as VS Code requires it, so this covers extension.ts
// and the three adapters, which vitest cannot import. Expected values: BMO-52, C-EXT, controller decisions
// 27, 31, 32, 35, 37 and 38, and the manifest.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const MAIN = join(REPO, manifest.main);
const PAGE_DIRECTORY = join(REPO, 'apps', 'inspector', 'dist', 'page');
const READY = { type: 'ready', protocol: 1 };

class Uri {
  constructor(path) {
    this.path = path;
  }
  get fsPath() {
    return this.path;
  }
  static file(path) {
    return new Uri(path);
  }
  static joinPath(base, ...parts) {
    return new Uri(posix.join(base.path, ...parts));
  }
  toString() {
    return `file://${this.path}`;
  }
}
function Position(line, character) {
  Object.assign(this, { line, character });
}
function Range(a, b, c, d) {
  const [start, end] = a instanceof Position ? [a, b] : [new Position(a, b), new Position(c, d)];
  Object.assign(this, { start, end });
}
function Diagnostic(range, message, severity) {
  Object.assign(this, { range, message, severity });
}
const disposable = (dispose = () => {}) => ({ dispose });
const at = (line, character) => ({ line, character });

/** What the extension did to the editor, and the events the editor sends it. */
function standIn(root) {
  const seen = {
    commands: new Map(),
    serializers: new Map(),
    panels: [],
    statusBars: [],
    diagnostics: new Map(),
    collections: [],
    errors: [],
    warnings: [],
    opened: [],
    framed: [],
    themeListeners: [],
    openFails: false,
  };
  const panel = (viewType, options) => {
    const made = {
      viewType,
      options,
      closed: false,
      revealed: 0,
      posted: [],
      listeners: [],
      disposeListeners: [],
      webview: {
        options: {},
        html: '',
        cspSource: 'https://csp.example',
        asWebviewUri: (uri) => new Uri(`/webview${uri.path}`),
        onDidReceiveMessage: (listener) => {
          made.listeners.push(listener);
          return disposable(() => made.listeners.splice(made.listeners.indexOf(listener), 1));
        },
        postMessage: (message) => {
          if (made.postFails) return Promise.reject(new Error('Webview is disposed'));
          made.posted.push(structuredClone(message));
          return Promise.resolve(true);
        },
      },
      onDidDispose: (listener) => {
        made.disposeListeners.push(listener);
        return disposable();
      },
      reveal: () => {
        made.revealed += 1;
      },
      dispose: () => {
        made.closed = true;
        for (const listener of made.disposeListeners.splice(0)) listener();
      },
      send: (message) => {
        for (const listener of made.listeners) listener(message);
      },
    };
    return made;
  };
  seen.panel = panel;
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  const vscode = {
    Uri,
    Position,
    Range,
    Diagnostic,
    FileType,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    commands: {
      registerCommand: (id, run) => {
        seen.commands.set(id, run);
        return disposable(() => seen.commands.delete(id));
      },
    },
    languages: {
      createDiagnosticCollection: (name) => {
        seen.collections.push(name);
        return {
          clear: () => seen.diagnostics.clear(),
          set: (first, second) => {
            const entries = Array.isArray(first) ? first : [[first, second]];
            // Documented: a call replaces what a file had, and merges one file's own tuples.
            const merged = new Map();
            for (const [uri, list] of entries) {
              merged.set(uri.path, [...(merged.get(uri.path) ?? []), ...list]);
            }
            for (const [path, list] of merged) seen.diagnostics.set(path, list);
          },
          dispose: () => seen.diagnostics.clear(),
        };
      },
    },
    window: {
      activeColorTheme: { kind: 1 },
      createStatusBarItem: (...args) => {
        const item = { args, shown: false, show: () => (item.shown = true), dispose: () => {} };
        seen.statusBars.push(item);
        return item;
      },
      createWebviewPanel: (viewType, title, showOptions, options) => {
        const made = panel(viewType, options);
        Object.assign(made, { title, showOptions });
        made.webview.options = { ...options };
        seen.panels.push(made);
        return made;
      },
      registerWebviewPanelSerializer: (viewType, serializer) => {
        seen.serializers.set(viewType, serializer);
        return disposable(() => seen.serializers.delete(viewType));
      },
      onDidChangeActiveColorTheme: (listener) => {
        seen.themeListeners.push(listener);
        return disposable(() => seen.themeListeners.splice(0));
      },
      showErrorMessage: async (text) => void seen.errors.push(text),
      showWarningMessage: async (text) => void seen.warnings.push(text),
      showTextDocument: async (uri, options) => {
        if (seen.openFails) throw new Error('cannot open');
        seen.opened.push([uri.path, options]);
        return { revealRange: (range, type) => seen.framed.push([range, type]) };
      },
    },
    workspace: {
      workspaceFolders:
        root === undefined ? undefined : [{ uri: new Uri(root), name: 'w', index: 0 }],
      fs: {
        readDirectory: async (uri) => {
          const entries = await readdir(uri.path, { withFileTypes: true });
          return Promise.all(
            entries.map(async (entry) => {
              const target = entry.isSymbolicLink()
                ? await stat(join(uri.path, entry.name))
                : entry;
              const type = target.isDirectory() ? FileType.Directory : FileType.File;
              return [entry.name, type + (entry.isSymbolicLink() ? FileType.SymbolicLink : 0)];
            }),
          );
        },
        stat: async (uri) => ({ type: FileType.File, size: (await lstat(uri.path)).size }),
        readFile: async (uri) => new Uint8Array(await readFile(uri.path)),
      },
    },
  };
  return { seen, vscode };
}

let temp = '';
let hooks;
let root = '';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  temp = mkdtempSync(join(tmpdir(), 'extension-'));
  root = join(temp, 'workspace');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.py'), 'b = 1\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'c.ts'), '');
  symlinkSync(join(root, 'a.ts'), join(root, 'link.ts'));
  const stub = join(temp, 'vscode.cjs');
  writeFileSync(stub, 'module.exports = globalThis.vscodeStandIn;\n');
  hooks = registerHooks({
    resolve: (specifier, context, next) =>
      specifier === 'vscode'
        ? { url: pathToFileURL(stub).href, format: 'commonjs', shortCircuit: true }
        : next(specifier, context),
  });
});
afterEach(() => {
  hooks.deregister();
  delete globalThis.vscodeStandIn;
  vi.useRealTimers();
  rmSync(temp, { recursive: true, force: true });
});

/** Loads the built extension afresh on the stand-in and activates it. */
function activate(folder = root) {
  const { seen, vscode } = standIn(folder ?? undefined);
  globalThis.vscodeStandIn = vscode;
  const require = createRequire(MAIN);
  const apps = join(REPO, 'apps', 'vscode', 'dist');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(apps) || key.startsWith(temp)) delete require.cache[key];
  }
  const extension = require(MAIN);
  const subscriptions = [];
  const context = {
    subscriptions,
    extension: { packageJSON: manifest },
    extensionUri: new Uri(REPO),
  };
  extension.activate(context);
  const run = (id) => seen.commands.get(id)();
  const deactivate = () => {
    extension.deactivate?.();
    for (const subscription of subscriptions) subscription.dispose();
  };
  return { seen, vscode, run, deactivate };
}

const tick = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
async function until(done) {
  const deadline = performance.now() + 5000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error('it never happened');
    await tick(); // oxlint-disable-line no-await-in-loop -- real I/O, one tick at a time
  }
}
const ofType = (panel, type) => panel.posted.filter((message) => message.type === type);
function draw(panel) {
  const { epoch, seq, payload } = ofType(panel, 'graph').at(-1);
  const count = payload.nodes.length;
  const report = {
    payloadNodeCount: count,
    renderedNodeCount: count,
    renderedEdgeCount: 0,
    duplicateEdges: 0,
    droppedNodeIds: [],
    frameMs: 1,
  };
  panel.send({ type: 'render-report', epoch, seq, report });
}
/** openGraph, then a page that has drawn the graph. */
async function opened(folder) {
  const ext = activate(folder);
  await ext.run('cpg.openGraph');
  const [panel] = ext.seen.panels;
  panel.send(READY);
  draw(panel);
  return { ...ext, panel };
}

describe('the manifest', () => {
  it('names the two commands and the restored panel, and nothing that activates on startup', () => {
    expect(manifest.contributes.commands).toEqual([
      { command: 'cpg.openGraph', title: 'CPG: Open Graph' },
      { command: 'cpg.verify', title: 'CPG: Verify' },
    ]);
    expect(manifest.activationEvents).toEqual(['onWebviewPanel:cpg.graph']);
    const { seen } = activate();
    expect(new Set(seen.commands.keys())).toEqual(new Set(['cpg.openGraph', 'cpg.verify']));
    expect([...seen.serializers.keys()]).toEqual(['cpg.graph']);
    expect(seen.panels).toEqual([]);
  });

  it('ships every package the extension loads (vsce ships only these)', () => {
    const host = JSON.parse(readFileSync(join(REPO, 'apps/vscode/package.json'), 'utf8'));
    expect(Object.keys(manifest.dependencies)).toEqual(
      expect.arrayContaining(Object.keys(host.dependencies)),
    );
  });
});

describe('cpg.openGraph', () => {
  it('makes one WebviewPanel whose only local root is the page bundle', async () => {
    const { seen, run } = activate();
    await run('cpg.openGraph');
    await run('cpg.openGraph');
    expect(seen.panels).toHaveLength(1);
    const [panel] = seen.panels;
    expect([panel.viewType, panel.options.retainContextWhenHidden]).toEqual(['cpg.graph', true]);
    expect(panel.title).not.toBe('');
    expect(panel.webview.options.enableScripts).toBe(true);
    expect(panel.webview.options.localResourceRoots.map((uri) => uri.path)).toEqual([
      PAGE_DIRECTORY,
    ]);
    // Either the shell or, when the bundle is not built, the page that says so.
    expect(panel.webview.html).toContain("default-src 'none'");
    expect(panel.revealed).toBe(1);
    expect(seen.errors).toEqual([]);
  });

  it('sends the theme, then the whole graph, when the page is ready', async () => {
    const { seen, run } = activate();
    await run('cpg.openGraph');
    const [panel] = seen.panels;
    expect(panel.posted).toEqual([]);
    panel.send(READY);
    expect(panel.posted.map(({ type }) => type)).toEqual(['theme', 'graph']);
    expect(panel.posted[0].theme.kind).toBe('light');
    const ids = panel.posted[1].payload.nodes.map(({ id }) => id);
    expect(new Set(ids)).toEqual(
      new Set(['dir:.', 'dir:sub', 'file:a.ts', 'file:b.py', 'file:sub/c.ts']),
    );
  });

  it('a panel the user closes is made again, and one that rejects a post fails nothing', async () => {
    const { seen, run, panel } = await opened();
    panel.dispose();
    await run('cpg.openGraph');
    expect(seen.panels).toHaveLength(2);
    const [, second] = seen.panels;
    second.postFails = true;
    second.send(READY);
    await tick();
    expect(seen.errors).toEqual([]);
  });

  it('with no folder: an error message and no panel', async () => {
    const { seen, run } = activate(null);
    await run('cpg.openGraph');
    expect([seen.errors, seen.panels]).toEqual([['CPG: open a folder first'], []]);
  });
});

describe('verify in the editor', () => {
  it('cpg.verify and the debounce reach the status bar, the diagnostics and the page', async () => {
    const { seen, run, panel } = await opened();
    expect(seen.statusBars).toHaveLength(1);
    const [status] = seen.statusBars;
    expect([status.shown, status.command]).toEqual([false, 'cpg.verify']);
    vi.advanceTimersByTime(500);
    await until(() => status.shown);
    expect([status.text, status.tooltip.split('\n')[0]]).toEqual([
      '$(question) CPG',
      'CPG verify at seq -1: unavailable',
    ]);
    await until(() => ofType(panel, 'verification').length === 1);
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    await run('cpg.verify');
    await until(() => status.text.startsWith('$(error)'));
    expect(status.text).toBe('$(error) CPG 1');
    expect(seen.collections).toEqual(['cpg']);
    expect([...seen.diagnostics.keys()]).toEqual([join(root, 'a.ts')]);
    const [diagnostic] = seen.diagnostics.get(join(root, 'a.ts'));
    expect(diagnostic).toMatchObject({
      severity: 0,
      source: 'cpg',
      code: 'revision-reconciliation',
      range: { start: { line: 0, character: 0 } },
    });
    expect(diagnostic.message).toMatch(/^revision-reconciliation: /);
    // A re-index and its run clear what it fixed.
    await run('cpg.openGraph');
    draw(panel);
    vi.advanceTimersByTime(500);
    await until(() => !status.text.startsWith('$(error)'));
    expect([status.text, seen.diagnostics.size]).toEqual(['$(question) CPG', 0]);
  });

  it('walks what the walker walks: the same files, through vscode.workspace.fs', async () => {
    writeFileSync(join(root, 'cpg.config.yaml'), 'version: 1\nexclude: [sub]\n');
    const { seen, run, panel } = await opened();
    await run('cpg.verify');
    await until(() => seen.statusBars[0].shown);
    const checks = ofType(panel, 'verification').at(-1).report.checks;
    expect(checks.map(({ state }) => state)).toEqual([
      'pass',
      'unavailable',
      'pass',
      'pass',
      'pass',
      'unavailable',
    ]);
    const [graph] = ofType(panel, 'graph');
    const files = graph.payload.nodes.filter(({ type }) => type === 'FILE');
    expect(files.map(({ data }) => data.path).toSorted()).toEqual([
      'a.ts',
      'b.py',
      'cpg.config.yaml',
    ]);
    expect(files.find(({ id }) => id === 'file:b.py').data.revision_id).toBe(
      createHash('sha256').update('b = 1\n').digest('hex'),
    );
  });
});

describe('click to source', () => {
  it('opens a FILE whole, as a preview, where the panel is not', async () => {
    const { seen, panel } = await opened();
    panel.send({ type: 'reveal', nodeId: 'file:sub/c.ts' });
    await until(() => seen.opened.length === 1);
    expect(seen.opened).toEqual([[join(root, 'sub', 'c.ts'), { preview: true, viewColumn: 1 }]]);
    expect(seen.framed).toEqual([]);
    expect(panel.showOptions).toBe(-2);
  });

  it('puts the selection on the request and frames the extent', async () => {
    const { seen, panel, vscode } = await opened();
    const { createSourceOpener } = createRequire(MAIN)('./adapters/source-opener.js');
    const opener = createSourceOpener((path) => vscode.Uri.file(join(root, path)));
    await opener.open({
      filePath: 'a.ts',
      selection: { startRow: 1, startColumn: 2, endRow: 3, endColumn: 4 },
      frame: { startRow: 5, startColumn: 6, endRow: 7, endColumn: 8 },
    });
    expect(seen.opened).toMatchObject([
      [join(root, 'a.ts'), { preview: true, selection: { start: at(1, 2), end: at(3, 4) } }],
    ]);
    expect(seen.framed).toMatchObject([[{ start: at(5, 6), end: at(7, 8) }, 2]]);
    seen.openFails = true;
    panel.send({ type: 'reveal', nodeId: 'file:a.ts' });
    await until(() => seen.warnings.some((text) => text.includes('cannot open a.ts')));
  });
});

describe('a panel VS Code restores', () => {
  it('gets the same webview options and HTML, is indexed, and is the one panel', async () => {
    const { seen, run } = activate();
    const restored = seen.panel('cpg.graph', { retainContextWhenHidden: true });
    await seen.serializers.get('cpg.graph').deserializeWebviewPanel(restored, undefined);
    expect(restored.webview.options.enableScripts).toBe(true);
    expect(restored.webview.options.localResourceRoots.map((uri) => uri.path)).toEqual([
      PAGE_DIRECTORY,
    ]);
    expect(restored.webview.html).toContain("default-src 'none'");
    restored.send(READY);
    await until(() => ofType(restored, 'graph').length === 1);
    await run('cpg.openGraph');
    expect([seen.panels, restored.revealed]).toEqual([[], 1]);
  });
});

describe('the theme', () => {
  it('is sent again when the editor changes it', async () => {
    const { seen, panel, vscode } = await opened();
    vscode.window.activeColorTheme = { kind: 4 };
    for (const listener of seen.themeListeners) listener({ kind: 4 });
    expect(ofType(panel, 'theme').map(({ theme }) => theme.kind)).toEqual([
      'light',
      'high-contrast-light',
    ]);
  });
});

describe('deactivation', () => {
  it('unregisters everything and leaves the panel for VS Code to restore', async () => {
    const { seen, panel, deactivate } = await opened();
    vi.advanceTimersByTime(500);
    await until(() => seen.statusBars[0].shown);
    const before = panel.posted.length;
    deactivate();
    expect([seen.commands.size, seen.serializers.size, seen.themeListeners.length]).toEqual([
      0, 0, 0,
    ]);
    expect(panel.closed).toBe(false);
    panel.send(READY);
    vi.advanceTimersByTime(5000);
    await tick();
    expect(panel.posted).toHaveLength(before);
  });
});

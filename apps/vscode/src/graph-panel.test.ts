// The one graph panel (controller decisions 31 and 38; BMO-52: a WebviewPanel with a serializer). Panels are
// fakes; what each did is one ordered log. Expected values: decision 38 and the doc comments.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebviewTransport } from './contract';
import { GraphPanel, type PanelSurface } from './graph-panel';
import { PAGE_SCRIPT } from './panel-page';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'graph-panel-'));
  writeFileSync(join(directory, PAGE_SCRIPT), '');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

class FakeSurface implements PanelSurface {
  html: string | undefined;
  readonly transport: WebviewTransport = {
    cspSource: 'https://csp.example',
    post: () => undefined,
    onMessage: () => ({ dispose: () => undefined }),
  };
  private closed: (() => void)[] = [];
  readonly name: string;
  private readonly log: string[];

  constructor(name: string, log: string[]) {
    this.name = name;
    this.log = log;
  }
  asUri(path: string): string {
    return `webview:${path}`;
  }
  setHtml(html: string): void {
    this.log.push(`html ${this.name}`);
    this.html = html;
  }
  reveal(): void {
    this.log.push(`reveal ${this.name}`);
  }
  onDidDispose(listener: () => void) {
    this.closed.push(listener);
    return { dispose: () => undefined };
  }
  /** As VS Code: the listeners are called whoever closes it, once. */
  dispose(): void {
    this.log.push(`close ${this.name}`);
    for (const listener of this.closed.splice(0)) listener();
  }
}

function setUp() {
  const log: string[] = [];
  const made: FakeSurface[] = [];
  const panel = new GraphPanel({
    host: {
      attach: (transport) => {
        const of = [...made, restored].find((surface) => surface.transport === transport);
        log.push(`attach ${of?.name ?? '?'}`);
      },
      detach: () => log.push('detach'),
    },
    create: () => {
      const surface = new FakeSurface(String(made.length + 1), log);
      log.push(`create ${surface.name}`);
      made.push(surface);
      return surface;
    },
    directory,
  });
  const restored = new FakeSurface('R', log);
  return { log, made, panel, restored };
}

describe('show', () => {
  it('makes the panel, attached before its HTML is set', async () => {
    const { log, made, panel } = setUp();
    await panel.show();
    expect(log).toEqual(['create 1', 'attach 1', 'html 1']);
    expect(made[0]?.html).toContain(`src="webview:${join(directory, PAGE_SCRIPT)}"`);
    expect(made[0]?.html).toContain('https://csp.example');
  });

  it('reveals the one panel from then on, without a second one, new HTML or a new page', async () => {
    const { log, panel } = setUp();
    await panel.show();
    await panel.show();
    expect(log).toEqual(['create 1', 'attach 1', 'html 1', 'reveal 1']);
  });

  it('while the first is still getting its HTML: one panel', async () => {
    const { log, panel } = setUp();
    await Promise.all([panel.show(), panel.show()]);
    expect(log.filter((entry) => entry.startsWith('create') || entry.startsWith('html'))).toEqual([
      'create 1',
      'html 1',
    ]);
  });

  it('a closed panel detaches the host, and the next show makes another', async () => {
    const { log, made, panel } = setUp();
    await panel.show();
    made[0]?.dispose();
    await panel.show();
    expect(log).toEqual([
      'create 1',
      'attach 1',
      'html 1',
      'close 1',
      'detach',
      'create 2',
      'attach 2',
      'html 2',
    ]);
  });

  it('a panel closed before its HTML is ready gets none', async () => {
    const { log, made, panel } = setUp();
    const shown = panel.show();
    made[0]?.dispose();
    await shown;
    expect(log).toEqual(['create 1', 'attach 1', 'close 1', 'detach']);
    expect(made[0]?.html).toBeUndefined();
  });

  it('a panel closed and replaced while its HTML was made leaves the new one its own', async () => {
    const { log, made, panel } = setUp();
    const first = panel.show();
    made[0]?.dispose();
    const second = panel.show();
    await Promise.all([first, second]);
    expect(log.filter((entry) => entry.startsWith('html'))).toEqual(['html 2']);
    expect(made[1]?.html).toBeDefined();
  });

  it('a missing bundle is a page that says so, not a failure', async () => {
    rmSync(join(directory, PAGE_SCRIPT));
    const { made, panel } = setUp();
    await panel.show();
    expect(made[0]?.html).toContain('bun run compile');
  });
});

describe('restore', () => {
  it("takes over VS Code's panel, which is then the one panel", async () => {
    const { log, panel, restored } = setUp();
    await panel.restore(restored);
    await panel.show();
    expect(log).toEqual(['attach R', 'html R', 'reveal R']);
    expect(restored.html).toContain(`src="webview:${join(directory, PAGE_SCRIPT)}"`);
    restored.dispose();
    await panel.show();
    expect(log.slice(3)).toEqual(['close R', 'detach', 'create 1', 'attach 1', 'html 1']);
  });

  it('with a panel already, closes the restored one and keeps the panel, still attached', async () => {
    const { log, panel, restored } = setUp();
    await panel.show();
    await panel.restore(restored);
    expect(log.slice(0, 3)).toEqual(['create 1', 'attach 1', 'html 1']);
    expect(log.slice(3).toSorted()).toEqual(['close R', 'reveal 1']);
    expect(restored.html).toBeUndefined();
    await panel.show();
    expect(log.slice(5)).toEqual(['reveal 1']);
  });
});

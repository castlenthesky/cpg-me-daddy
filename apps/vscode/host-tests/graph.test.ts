// The U2 gate's assertions inside VS Code (U3.1.2, BMO-56; the retirement battery's Q21). Run by
// @vscode/test-cli (`bun run test:vscode-host`) on a copy of ladder rung 07; the only thing read of the
// extension is what `cpg.verify` resolves with (controller decision 40) and what the editor shows.
// Expected values: 08-verification.md §3, C-EXT, controller decisions 35, 38 and 42, and the rung.

import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWorkspacePath, type VerificationReport, type WorkspacePath } from '@cpg/model';
import * as vscode from 'vscode';
import type { createSourceOpener } from '../src/adapters/source-opener';
import { webglRenderer } from './webgl';

// fixtures/ladder/07-package/expected.cpg, [filesystem]: three FILEs, and two DIRECTORYs besides.
const FILES = 3;
const NODES = 5;
const STALE = 'shapes/square.py';
const DRAW_MS = 30_000;
const VERIFY_STATES = {
  'filesystem-reconciliation': 'pass',
  'identity-invariants': 'unavailable', // until U6c
  'id-uniqueness': 'pass',
  'render-reconciliation': 'pass',
  'revision-reconciliation': 'pass',
  'resolution-health': 'unavailable', // until U6c
};

const extension = vscode.extensions.all.find(
  ({ packageJSON }) => packageJSON.name === 'cpg-me-daddy',
);
const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
const uri = (path: string) => vscode.Uri.file(join(root, path));
function workspacePath(text: string): WorkspacePath {
  assert.ok(isWorkspacePath(text));
  return text;
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const openGraph = () => vscode.commands.executeCommand('cpg.openGraph');
async function verify(): Promise<VerificationReport> {
  const report = await vscode.commands.executeCommand<VerificationReport | undefined>('cpg.verify');
  assert.ok(report, 'cpg.verify resolved with no report');
  return report;
}
const statesOf = ({ checks }: VerificationReport) =>
  Object.fromEntries(checks.map(({ id, state }) => [id, state]));
const check = ({ checks }: VerificationReport, id: string) => {
  const found = checks.find((candidate) => candidate.id === id);
  assert.ok(found, `no ${id}`);
  return found;
};
/** The report once the page has reported what it drew, or the last one when it does not in time. */
async function drawn(): Promise<VerificationReport> {
  const deadline = Date.now() + DRAW_MS;
  for (;;) {
    const report = await verify();
    const { state } = check(report, 'render-reconciliation');
    if (state !== 'unavailable' || Date.now() > deadline) return report;
    await delay(100);
  }
}
const graphPanels = () =>
  vscode.window.tabGroups.all
    .flatMap(({ tabs }) => tabs)
    .filter(
      ({ input }) =>
        input instanceof vscode.TabInputWebview && input.viewType.endsWith('cpg.graph'),
    );
/** Our diagnostics, as `<file> <check id>`: a message starts with its check's id. */
const cpgDiagnostics = () =>
  vscode.languages
    .getDiagnostics()
    .flatMap(([at, found]) =>
      found
        .filter(({ source }) => source === 'cpg')
        .map(
          ({ message }) =>
            `${vscode.workspace.asRelativePath(at, false)} ${message.split(':')[0] ?? ''}`,
        ),
    );

suite('the graph in VS Code', () => {
  let renderer: string | undefined;
  /** For what only a page that draws can show: skipped on the old pin when it can't (decision 42). */
  function needsWebGL(context: Mocha.Context): void {
    if (renderer === undefined && process.env['CPG_HOST_PIN'] === 'oldest') context.skip();
  }
  /** What the next test starts from, whatever the one before it left: a fresh index, drawn. */
  async function fresh(): Promise<VerificationReport> {
    await openGraph();
    return renderer === undefined ? verify() : drawn();
  }

  suiteSetup(async () => {
    // These tests write into the workspace: only ever a copy in the temporary directory.
    assert.ok(root.startsWith(tmpdir()), `refusing to run on ${root}`);
    assert.ok(extension, 'the extension is not here');
  });

  test('runs the pinned VS Code', () => {
    assert.equal(vscode.version, process.env['CPG_HOST_VSCODE']);
  });

  test('is activated by a command, and by nothing before it', async () => {
    await vscode.window.showTextDocument(uri('main.py'));
    await delay(2000); // time for an onStartupFinished to have activated it
    assert.equal(extension?.isActive, false);
    assert.deepEqual(graphPanels(), []);
    await openGraph();
    assert.equal(extension?.isActive, true);
    assert.equal(graphPanels().length, 1);
  });

  test('can draw in a webview', async function () {
    renderer = await webglRenderer();
    console.log(`VS Code ${vscode.version}: WebGL2 ${renderer ?? 'none'}`);
    needsWebGL(this);
    assert.ok(renderer);
  });

  test('passes every check of the U2 gate, on files and ids', async () => {
    const report = await fresh();
    const { 'render-reconciliation': _render, ...expected } = VERIFY_STATES;
    const { 'render-reconciliation': _state, ...states } = statesOf(report);
    assert.deepEqual(states, expected);
    const files = check(report, 'filesystem-reconciliation');
    assert.deepEqual([files.observed, files.expected, files.localisedTo], [FILES, FILES, []]);
    assert.deepEqual(
      report.checks.map(({ id }) => id),
      Object.keys(VERIFY_STATES),
    );
    assert.deepEqual(cpgDiagnostics(), []);
  });

  test('draws the whole graph in a real webview: render-reconciliation', async function () {
    needsWebGL(this);
    const report = await fresh();
    const render = check(report, 'render-reconciliation');
    assert.deepEqual([render.state, render.observed, render.expected], ['pass', NODES, NODES]);
    assert.equal(report.state, 'unavailable'); // the worst of the six, until U6c
  });

  suite('with a file changed on disk since the index (E4)', () => {
    let original: Buffer;
    suiteSetup(async () => {
      original = await readFile(join(root, STALE));
    });
    setup(async () => {
      await fresh();
      const changed = Buffer.from(original);
      changed[0] = (original[0] ?? 0) ^ 1; // one bit: the same names and sizes
      await writeFile(join(root, STALE), changed);
    });
    teardown(async () => {
      await writeFile(join(root, STALE), original);
      await openGraph();
    });

    test('revision-reconciliation fails alone, with one diagnostic, on that file', async () => {
      const before = await verify();
      assert.deepEqual(cpgDiagnostics(), [`${STALE} revision-reconciliation`]);
      const failing = before.checks.filter(({ state }) => state === 'fail');
      assert.deepEqual(
        failing.map(({ id, localisedTo }) => [id, localisedTo]),
        [['revision-reconciliation', [STALE]]],
      );
      assert.equal(before.state, 'fail');
      const { 'render-reconciliation': _render, ...expected } = VERIFY_STATES;
      const { 'render-reconciliation': render, ...states } = statesOf(before);
      assert.deepEqual(states, { ...expected, 'revision-reconciliation': 'fail' });
      if (renderer !== undefined) assert.equal(render, 'pass');
    });

    test('a second cpg.openGraph clears it, in the one panel', async () => {
      const failed = await verify();
      assert.equal(check(failed, 'revision-reconciliation').state, 'fail');
      await openGraph();
      const report = renderer === undefined ? await verify() : await drawn();
      assert.equal(check(report, 'revision-reconciliation').state, 'pass');
      assert.deepEqual(cpgDiagnostics(), []);
      assert.equal(graphPanels().length, 1);
      assert.equal(report.epoch, failed.epoch + 1); // C-EXT I-13
      if (renderer !== undefined) {
        assert.equal(check(report, 'render-reconciliation').state, 'pass');
      }
    });

    // The host verifies 500 ms after a render-report it accepts (decision 36), and each run sets the
    // diagnostics again; nothing else asks for one here. So the event says the reloaded page was sent the
    // graph and drew it.
    test('a webview that is reloaded is sent the graph again', async function () {
      needsWebGL(this);
      await verify();
      await delay(1500); // no run is pending
      const verified = new Promise<void>((resolve) => {
        const subscription = vscode.languages.onDidChangeDiagnostics(({ uris }) => {
          if (!uris.some((changed) => changed.fsPath === uri(STALE).fsPath)) return;
          subscription.dispose();
          resolve();
        });
      });
      await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      const outcome = await Promise.race([
        verified.then(() => 'verified'),
        delay(DRAW_MS).then(() => 'nothing happened'),
      ]);
      assert.equal(outcome, 'verified');
      assert.equal(check(await verify(), 'render-reconciliation').state, 'pass');
    });
  });

  suite('the opener (click to source)', () => {
    let opener: ReturnType<typeof createSourceOpener>;
    suiteSetup(async () => {
      // The extension's own module: this file is built into apps/vscode/dist/host-tests.
      const adapter: { createSourceOpener: typeof createSourceOpener } = await import(
        join(__dirname, '..', 'adapters', 'source-opener.js')
      );
      opener = adapter.createSourceOpener(uri);
    });

    test('opens the file, as a preview, in the first column', async () => {
      await opener.open({ filePath: workspacePath(STALE) });
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor?.document.uri.fsPath, uri(STALE).fsPath);
      assert.equal(editor?.viewColumn, vscode.ViewColumn.One);
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview, true);
    });

    test('lands on the selection', async () => {
      await opener.open({
        filePath: workspacePath(STALE),
        selection: { startRow: 1, startColumn: 4, endRow: 1, endColumn: 10 },
        frame: { startRow: 0, startColumn: 0, endRow: 1, endColumn: 22 },
      });
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor?.document.uri.fsPath, uri(STALE).fsPath);
      assert.equal(editor?.document.getText(editor.selection), 'return');
    });

    test('rejects for a file that is not there', async () => {
      await assert.rejects(opener.open({ filePath: workspacePath('gone.py') }));
    });
  });
});

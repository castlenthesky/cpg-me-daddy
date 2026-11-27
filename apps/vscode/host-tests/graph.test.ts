// The U2 gate's assertions inside VS Code (U3.1.2, BMO-56; the retirement battery's Q21). Run by
// @vscode/test-cli (`bun run test:vscode-host`) on a copy of ladder rung 07; the only thing read of the
// extension is what `cpg.verify` resolves with (controller decision 40) and what the editor shows.
// Expected values: 08-verification.md §3, C-EXT, controller decisions 35, 38, 42, 70, 72 and 75, and the
// rung.
//
// A `pass` of render-reconciliation here proves that the bundle loaded in a real webview and that its page
// reported the graph. It does NOT prove that a picture was drawn: the report counts the page's own buffers,
// and a page with no WebGL at all reports the same (stop-list 124). So the suite says whether there is
// WebGL2, and no test here claims a drawing.

import { strict as assert } from 'node:assert';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWorkspacePath, type VerificationReport, type WorkspacePath } from '@cpg/model';
import * as vscode from 'vscode';
import type { createSourceOpener } from '../src/adapters/source-opener';
import { webglRenderer } from './webgl';

// fixtures/ladder/07-package/expected.cpg, [filesystem]: three FILEs, and two DIRECTORYs besides.
const FILES = 3;
// U6a.3-3 (decision 110 reversed): the watch runs the code tier. At U6a each python file brings the
// rung's MODULE line and that MODULE's module SYMBOL (controller decision 90): two nodes per FILE.
const NODES = 5 + 2 * FILES;
const STALE = 'shapes/square.py';
/** A file the tests add: one more FILE node in a directory that is already there. */
const ADDED = 'shapes/live.py';
/** What ADDED brings to the graph: its FILE, its MODULE and its module SYMBOL. */
const ADDED_NODES = 3;
const REPORT_MS = 20_000;
/** How long the watch may take to bring a change on disk into the graph (decision 75). */
const FOLLOW_MS = 10_000;
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
/**
 * The verdict once the page has reported on the graph held, or the last one when it does not in time.
 * Round two (R5): under a live watch a new graph seq keeps the page's last report, which is `stale`
 * until the page draws it (sprint 26: a delta, not a catch-up graph).
 */
async function reported(): Promise<VerificationReport> {
  const deadline = Date.now() + REPORT_MS;
  for (;;) {
    const report = await verify();
    const { state } = check(report, 'render-reconciliation');
    if ((state !== 'unavailable' && state !== 'stale') || Date.now() > deadline) return report;
    await delay(100);
  }
}
/** The first verdict that `done` accepts, polling cpg.verify, or the last one when none does in time. */
async function verdict(
  done: (report: VerificationReport) => boolean,
  ms = FOLLOW_MS,
): Promise<VerificationReport> {
  const deadline = Date.now() + ms;
  for (;;) {
    const report = await verify();
    if (done(report) || Date.now() > deadline) return report;
    await delay(200);
  }
}
/**
 * The graph's FILE nodes through filesystem-reconciliation (the U3.1.2 seam, decision 40): `observed`
 * counts them, and `pass` says they are the files on disk, directory by directory.
 */
const fileCount = (report: VerificationReport) => {
  const { state, observed, expected } = check(report, 'filesystem-reconciliation');
  return `${state} ${String(observed)}/${String(expected)}`;
};
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
  /** For what needs a page to report: skipped on the old pin when it has no WebGL2 (decision 42). */
  function needsWebGL(context: Mocha.Context): void {
    if (renderer === undefined && process.env['CPG_HOST_PIN'] === 'oldest') context.skip();
  }
  /** What the E4 tests start from, whatever the one before left: a fresh index, reported by the page. */
  async function fresh(): Promise<void> {
    await openGraph();
    if (renderer === undefined) return;
    assert.equal(check(await reported(), 'render-reconciliation').state, 'pass', 'no report');
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

  test('has WebGL2 in a webview', async function () {
    renderer = await webglRenderer();
    console.log(`VS Code ${vscode.version}: WebGL2 ${renderer ?? 'none'}`);
    needsWebGL(this);
    assert.ok(renderer);
  });

  test('passes every check of the U2 gate, on files and ids', async () => {
    await openGraph();
    const report = await verify();
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

  test('the bundle loads in a real webview and its page reports every node (no proof of a drawing)', async function () {
    needsWebGL(this);
    await openGraph();
    const report = await reported();
    const render = check(report, 'render-reconciliation');
    assert.deepEqual([render.state, render.observed, render.expected], ['pass', NODES, NODES]);
    assert.equal(report.state, 'unavailable'); // the worst of the six, until U6c
  });

  // U4.2.2 (BMO-132; decisions 70, 72 and 75): one watch keeps the graph current, so a change on disk is in
  // the graph within its debounce window, and nothing here can wait for a stale verdict. E4 (one stale
  // revision fails revision-reconciliation alone) is proven in plain node, where the batch is scripted
  // (graph-session.test.ts) or held behind faked timers (tools/extension.test.mjs).
  suite('the graph follows the disk (U4.2.2)', () => {
    let original: Buffer;
    suiteSetup(async () => {
      original = await readFile(join(root, STALE));
    });
    setup(fresh);
    teardown(async () => {
      await rm(join(root, ADDED), { force: true });
      await writeFile(join(root, STALE), original);
      const settled = await verdict(
        (report) =>
          fileCount(report) === `pass ${String(FILES)}/${String(FILES)}` &&
          check(report, 'revision-reconciliation').state === 'pass',
      );
      assert.equal(
        fileCount(settled),
        `pass ${String(FILES)}/${String(FILES)}`,
        'the fixture is back',
      );
    });

    test('cpg.openGraph while the watch is live starts nothing: the epoch is kept', async () => {
      const before = await verify();
      await openGraph();
      const after = await verify();
      assert.equal(after.epoch, before.epoch); // no new initial snapshot (C-EXT I-13)
      assert.equal(graphPanels().length, 1);
    });

    test('a file written on disk joins the graph, and leaves it when deleted, in one epoch', async () => {
      const before = await verify();
      await writeFile(join(root, ADDED), 'side = 4\n');
      const more = `pass ${String(FILES + 1)}/${String(FILES + 1)}`;
      const added = await verdict((report) => fileCount(report) === more);
      assert.equal(fileCount(added), more, 'the new file never joined the graph');
      assert.equal(added.epoch, before.epoch); // the file's delta keeps the epoch (C-EXT I-13)
      assert.ok(added.seq > before.seq, `seq ${String(added.seq)} after ${String(before.seq)}`);
      await rm(join(root, ADDED));
      const fewer = `pass ${String(FILES)}/${String(FILES)}`;
      const removed = await verdict((report) => fileCount(report) === fewer);
      assert.equal(fileCount(removed), fewer, 'the deleted file never left the graph');
      assert.equal(removed.epoch, before.epoch);
      assert.ok(removed.seq > added.seq, `seq ${String(removed.seq)} after ${String(added.seq)}`);
      assert.deepEqual(cpgDiagnostics(), []);
    });

    test('one bit of one file on disk: the graph follows it, in the one panel', async () => {
      const before = await verify();
      const changed = Buffer.from(original);
      changed[0] = (original[0] ?? 0) ^ 1; // one bit: the same names and sizes
      await writeFile(join(root, STALE), changed);
      const followed = await verdict(
        (report) =>
          report.seq > before.seq && check(report, 'revision-reconciliation').state === 'pass',
      );
      assert.ok(followed.seq > before.seq, 'the change never reached the graph');
      assert.equal(check(followed, 'revision-reconciliation').state, 'pass');
      assert.equal(followed.epoch, before.epoch);
      assert.deepEqual(cpgDiagnostics(), []);
      assert.equal(graphPanels().length, 1);
    });

    // A reloaded page draws the graph it is then sent. The file is written after the reload, so a
    // render-report of the graph that holds it can only come from the page that came back.
    test('a webview that is reloaded is kept in step with the graph', async function () {
      needsWebGL(this);
      await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      await delay(1000);
      await writeFile(join(root, ADDED), 'side = 4\n');
      const report = await verdict((candidate) => {
        const render = check(candidate, 'render-reconciliation');
        return render.state === 'pass' && render.expected === NODES + ADDED_NODES;
      }, REPORT_MS);
      const render = check(report, 'render-reconciliation');
      assert.deepEqual(
        [render.state, render.observed, render.expected],
        ['pass', NODES + ADDED_NODES, NODES + ADDED_NODES],
      );
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

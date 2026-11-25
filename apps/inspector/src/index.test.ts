// @cpg/inspector's front door (controller decision 30): import-light, pure modules only, so the VS Code
// host can load it. "Not the server, ws, cosmos or the renderer" is checked on the built module graph:
// a child node requires the package with Module._load recording every request. tsc -b has written
// dist before vitest runs in `bun run check`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as frontDoor from './index';
import { parseWebviewMessage } from './messages';
import { REGISTRY_NODE_COLORS } from './node-types';
import { graphShellHtml } from './shell';
import { verificationText } from './banner';

const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const PROBE = `
const Module = require('node:module');
const requests = [];
const load = Module._load;
Module._load = function (request, ...rest) {
  requests.push(request);
  return load.call(this, request, ...rest);
};
let failure = null;
try { require(process.argv[1]); } catch (error) { failure = String(error); }
process.stdout.write(JSON.stringify({ requests, files: Object.keys(require.cache), failure }));
`;

interface Loaded {
  readonly requests: readonly string[];
  readonly files: readonly string[];
  readonly failure: string | null;
}

function isLoaded(value: unknown): value is Loaded {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requests' in value &&
    Array.isArray(value.requests) &&
    'files' in value &&
    Array.isArray(value.files) &&
    'failure' in value
  );
}

/** Everything requiring `entry` loads, and what it threw. */
function loadedBy(entry: string): Loaded {
  const run = spawnSync(process.execPath, ['-e', PROBE, entry], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const parsed: unknown = JSON.parse(run.stdout === '' ? 'null' : run.stdout);
  if (!isLoaded(parsed)) throw new Error(`the probe printed nothing usable: ${run.stderr}`);
  return parsed;
}

// The front door and the modules it re-exports from: shell (the page), messages (the parser), banner
// (the verdict's text) and node-types (the palette).
const PURE = new Set(['index.js', 'shell.js', 'messages.js', 'banner.js', 'node-types.js']);

/** What `entry` loads that the front door may not: other inspector modules, and any bare request but @cpg/model. */
function problems(entry: string): string[] {
  const { requests, files } = loadedBy(entry);
  const own = files.filter((file) => file.startsWith(DIST) && !PURE.has(basename(file)));
  const bare = requests.filter((request) => !/^[./]/.test(request) && request !== '@cpg/model');
  return [...own.map((file) => basename(file)), ...bare];
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A module that loads the built front door and then `request`. */
function planted(request: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'inspector-front-door-'));
  temporary.push(dir);
  const file = join(dir, 'plant.cjs');
  writeFileSync(file, `require(${JSON.stringify(ROOT)});\nrequire(${JSON.stringify(request)});\n`);
  return file;
}

describe('the front door', () => {
  it('exports the shell, the parser, the banner text and the palette, and nothing else', () => {
    expect(Object.keys(frontDoor).toSorted()).toEqual([
      'GRAPH_CONTAINER_ID',
      'REGISTRY_NODE_COLORS',
      'VERIFICATION_ID',
      'graphShellHtml',
      'parseWebviewMessage',
      'verificationText',
    ]);
    expect(frontDoor).toMatchObject({
      GRAPH_CONTAINER_ID: 'graph-container',
      VERIFICATION_ID: 'cpg-verification',
      REGISTRY_NODE_COLORS,
      graphShellHtml,
      parseWebviewMessage,
      verificationText,
    });
  });

  // A spawned node process can take seconds to start on a busy macOS runner.
  it('loads, as the package, only its pure modules and @cpg/model', { timeout: 20_000 }, () => {
    const { files, failure } = loadedBy(ROOT);
    expect(failure).toBeNull();
    expect(files.filter((file) => file.startsWith(DIST)).map((file) => basename(file))).toEqual(
      expect.arrayContaining([...PURE]),
    );
    expect(problems(ROOT)).toEqual([]);
  });

  it.each([
    'ws',
    'node:http',
    'http',
    '@cosmos.gl/graph',
    join(DIST, 'server.js'),
    join(DIST, 'visualizer.js'),
  ])('anti-vacuity: reports a front door that loads %s', { timeout: 20_000 }, (request) => {
    const want = request.startsWith(DIST) ? basename(request) : request;
    expect(problems(planted(request))).toContain(want);
  });

  it('anti-vacuity: the server really loads ws and node:http', { timeout: 20_000 }, () => {
    expect(problems(join(DIST, 'server.js'))).toEqual(
      expect.arrayContaining(['server.js', 'ws', 'node:http']),
    );
  });
});

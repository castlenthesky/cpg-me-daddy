#!/usr/bin/env node
// The language-server oracle for fixtures/ladder (bun run ladder:oracle [rung...]).
//
// Every CALL and IMPORT in a rung's [structural] section is a question: "where is this name
// defined?". basedpyright (.py) and tsserver (.ts) answer it over stdio through @cpg/resolve's LSP
// transport. The answer is mapped back to the declaration it lands in, then to the SYMBOL that
// declaration DEFINES, and compared with the rung's hand-written [resolution] line.
//
//   agree        the server names the target the line names
//   DISAGREE     the server names another target (a wrong line, or a server bug: a human decides)
//   unanswered   the line has a target and the server gave none
//   missing      the server names a target and the rung has no line for it (a recall gap in the file)
//   silent       no line and no answer
//
// Exit 1 on any DISAGREE or missing. Out of band by design (C-RESOLVE harness, U6c.3): it spawns two
// language servers, so `bun run check` does not run it.

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LADDER = join(ROOT, 'fixtures/ladder');
const require = createRequire(import.meta.url);

/** A cold tsserver names the local import binding before its project loads (M-RESOLVE-lsp-readiness). */
const RETRY_MS = 250;
const READY_BUDGET_MS = 4000;

const SERVERS = {
  py: {
    languageId: 'python',
    command: process.execPath,
    args: [
      join(dirname(require.resolve('basedpyright/package.json')), 'langserver.index.js'),
      '--stdio',
    ],
    initializationOptions: {},
  },
  ts: {
    languageId: 'typescript',
    command: process.execPath,
    args: [
      join(dirname(require.resolve('typescript-language-server/package.json')), 'lib/cli.mjs'),
      '--stdio',
    ],
    initializationOptions: {
      tsserver: { path: dirname(require.resolve('typescript/lib/tsserver.js')) },
    },
  },
};

function readRung(rung) {
  const facts = { nodes: new Map(), defines: new Map(), resolution: new Map() };
  let section = '';
  for (const raw of readFileSync(join(LADDER, rung, 'expected.cpg'), 'utf8').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('[')) {
      section = line;
      continue;
    }
    const words = line.split(/\s+/);
    if (words.includes('->')) {
      if (words[0] === 'DEFINES') facts.defines.set(words[1], words[3]);
      if (words[0] === 'CALLS' || words[0] === 'IMPORTS') facts.resolution.set(words[1], words[3]);
    } else if (section === '[structural]') {
      const props = Object.fromEntries(words.slice(2).map((w) => w.split(/=(.*)/s).slice(0, 2)));
      facts.nodes.set(words[1], {
        label: words[0],
        id: words[1],
        file: words[1].split(':')[1],
        props,
      });
    }
  }
  return facts;
}

/** `startLine:startCol-endLine:endCol`, 1-based lines, to 0-based LSP positions. */
function parseRange(range) {
  const m = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(range ?? '');
  return (
    m && {
      start: { line: +m[1] - 1, character: +m[2] },
      end: { line: +m[3] - 1, character: +m[4] },
    }
  );
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
const contains = (r, p) => r && before(r.start, p) && before(p, r.end);

/** The token to ask about (C-EXTRACT I20): the last segment of a callee, the imported name of an import. */
function questionsFor(node, lines) {
  const range = parseRange(node.props.range);
  if (!range) return [];
  const text = lines[range.start.line].slice(range.start.character);
  const at = (offset) => ({ line: range.start.line, character: range.start.character + offset });
  if (node.label === 'CALL') {
    const offset = text.lastIndexOf(node.props.callee_name, text.indexOf('('));
    return offset < 0 ? [] : [at(offset)];
  }
  const names = (node.props.imported_names ?? '[]').slice(1, -1).split(',').filter(Boolean);
  return names.map((name) =>
    at(text.search(new RegExp(`\\b${name}\\b(?![\\s\\S]*\\b${name}\\b)`))),
  );
}

/** The innermost declaration in `file` whose range holds `pos`, or whose name sits at `pos`. */
function declarationAt(facts, file, pos, lines) {
  const word = /^\w+/.exec(lines[pos.line]?.slice(pos.character) ?? '')?.[0];
  const candidates = [...facts.nodes.values()].filter(
    (n) =>
      n.file === file &&
      ['MODULE', 'TYPE_DECL', 'METHOD', 'MEMBER', 'PARAM', 'IMPORT'].includes(n.label),
  );
  const holding = candidates.filter(
    (n) => contains(parseRange(n.props.range), pos) && n.label !== 'MODULE',
  );
  const named = candidates.filter((n) => n.props.name === word && !n.props.range);
  return [...holding, ...named].toSorted((a, b) => b.id.length - a.id.length)[0];
}

async function openServer(kind, root, files) {
  const { createLspConnection } = require(join(ROOT, 'packages/resolve'));
  const spec = SERVERS[kind];
  const proc = spawn(spec.command, spec.args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  const lsp = createLspConnection({
    write: (chunk) => proc.stdin.write(chunk),
    onStdout: (listener) => proc.stdout.on('data', (d) => listener(new Uint8Array(d))),
    onExit: (listener) => proc.on('exit', listener),
    kill: () => proc.kill(),
  });
  const rootUri = pathToFileURL(root).href;
  const init = await lsp.request('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: 'ladder' }],
    capabilities: { textDocument: { definition: { linkSupport: true } } },
    initializationOptions: spec.initializationOptions,
  });
  if (!init.ok) throw new Error(`${kind} initialize failed: ${init.message}`);
  lsp.notify('initialized', {});
  for (const file of files) {
    lsp.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(join(root, file)).href,
        languageId: spec.languageId,
        version: 1,
        text: readFileSync(join(root, file), 'utf8'),
      },
    });
  }
  return {
    lsp,
    rootUri,
    close: async () => {
      await lsp.request('shutdown');
      lsp.notify('exit');
      lsp.close();
    },
  };
}

async function definition(server, root, file, pos, isImportBinding) {
  const deadline = Date.now() + READY_BUDGET_MS;
  for (;;) {
    const res = await server.lsp.request('textDocument/definition', {
      textDocument: { uri: pathToFileURL(join(root, file)).href },
      position: pos,
    });
    const loc = res.ok ? [res.result].flat().find(Boolean) : undefined;
    const uri = loc?.targetUri ?? loc?.uri;
    const answer = uri?.startsWith(`${server.rootUri}/`) && {
      file: decodeURIComponent(uri.slice(server.rootUri.length + 1)),
      pos: (loc.targetSelectionRange ?? loc.range).start,
    };
    if (answer && isImportBinding(answer) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RETRY_MS));
      continue;
    }
    return answer || undefined;
  }
}

const rungs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(LADDER).filter((r) => /^\d\d-/.test(r));
const build = spawnSync('bun', ['run', '--silent', 'tsc', '-b', 'packages/resolve'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (build.status !== 0) {
  console.error(`ladder-oracle: building @cpg/resolve failed\n${build.stdout}${build.stderr}`);
  process.exit(1);
}

const rows = [];
for (const rung of rungs) {
  const facts = readRung(rung);
  const sites = [...facts.nodes.values()].filter((n) => n.label === 'CALL' || n.label === 'IMPORT');
  const root = join(LADDER, rung, 'ws');
  for (const kind of ['py', 'ts']) {
    const mine = sites.filter((n) =>
      kind === 'py' ? n.file.endsWith('.py') : /\.tsx?$/.test(n.file),
    );
    if (mine.length === 0) continue;
    const files = [...new Set([...facts.nodes.values()].map((n) => n.file))].filter(
      (f) => mine.some((s) => s.file === f) || f.endsWith(kind === 'py' ? '.py' : '.ts'),
    );
    const lines = (f) => readFileSync(join(root, f), 'utf8').split('\n');
    const server = await openServer(kind, root, files);
    for (const site of mine) {
      for (const pos of questionsFor(site, lines(site.file))) {
        const isImportBinding = (a) =>
          a.file === site.file &&
          declarationAt(facts, a.file, a.pos, lines(a.file))?.label === 'IMPORT';
        const answer = await definition(server, root, site.file, pos, isImportBinding);
        const decl = answer && declarationAt(facts, answer.file, answer.pos, lines(answer.file));
        const got = decl
          ? (facts.defines.get(decl.id) ?? `(undefined symbol of ${decl.id})`)
          : answer
            ? `${answer.file}@${answer.pos.line}:${answer.pos.character}`
            : undefined;
        const want = facts.resolution.get(site.id);
        const verdict =
          want && got
            ? want === got
              ? 'agree'
              : 'DISAGREE'
            : want
              ? 'unanswered'
              : got
                ? 'missing'
                : 'silent';
        rows.push({ rung, site: site.id, want: want ?? '-', got: got ?? '-', verdict });
      }
    }
    await server.close();
  }
}

for (const r of rows)
  console.log(
    `${r.verdict.padEnd(10)} ${r.rung.padEnd(20)} ${r.site}\n${''.padEnd(11)}want ${r.want}\n${''.padEnd(11)}got  ${r.got}`,
  );
const counts = Object.groupBy(rows, (r) => r.verdict);
console.log(
  `\n${Object.entries(counts)
    .map(([k, v]) => `${k} ${v.length}`)
    .join(', ')}`,
);
process.exit(counts.DISAGREE || counts.missing ? 1 : 0);

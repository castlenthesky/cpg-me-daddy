#!/usr/bin/env node
// The shebang wrapper: the one file that reads process.argv/env/stdio, and it assigns
// process.exitCode and nothing else (never process.exit, so stdout always drains; I-3, I-4).
// Exercised by tools/check-cli-bin.mjs, which spawns the built dist/main.js.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createEngine } from '@cpg/engine';
import { resolveInspectorBin, spawnInspector } from './inspector-process';
import type { Io, Manifest } from './io';
import { run } from './run';

const pkg: { version?: unknown; bin?: Record<string, unknown> } = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
);
const bin = Object.keys(pkg.bin ?? {})[0];
if (typeof pkg.version !== 'string' || bin === undefined)
  throw new Error('@cpg/cli package.json has no version or bin');
const manifest: Manifest = { bin, version: pkg.version };

const io: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  status: (line) => {
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line}`);
  },
  env: process.env,
  stdin: {
    isTty: process.stdin.isTTY === true,
    readText: async () => {
      let text = '';
      for await (const chunk of process.stdin) text += String(chunk);
      return text;
    },
  },
  isTty: { out: process.stdout.isTTY === true, err: process.stderr.isTTY === true },
  now: () => Date.now(),
};

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

const rawGrammarDir = process.env['CPG_GRAMMAR_DIR'];
const grammarDir =
  rawGrammarDir !== undefined && rawGrammarDir !== ''
    ? resolve(process.cwd(), rawGrammarDir)
    : undefined;

// Composition root (03-architecture §2 rule 3): run() calls createEngine once the config has
// resolved, and the engine builds its own sinks from the consumer switches (owner decision 5a).
void run(process.argv.slice(2), io, {
  manifest,
  createEngine: (config) =>
    createEngine(grammarDir === undefined ? config : { ...config, grammarDir }),
  startInspector: (handlers) =>
    resolveInspectorBin().then((inspectorBin) =>
      spawnInspector(inspectorBin, { ...handlers, log: (line) => io.err(line) }),
    ),
  cwd: process.cwd(),
  signal: controller.signal,
  // SIGHUP is heard only while a watch is subscribed (decision 79).
  rescan: {
    subscribe(listener) {
      process.on('SIGHUP', listener);
      return () => {
        process.off('SIGHUP', listener);
      };
    },
  },
}).then((code) => {
  process.exitCode = code;
});

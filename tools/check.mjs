#!/usr/bin/env node
// THE one gate command (`npm run check`): every fast gate through turbo, so repeat runs are cached.
// A wrapper rather than an inline npm script only so telemetry can be disabled cross-platform:
// this repo's privacy principle is no telemetry from tooling.

import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const GATES = ['format:check', 'lint', 'knip', 'check:deps', 'typecheck', 'test:coverage'];

const r = spawnSync(
  'npx',
  [
    '--no-install',
    'turbo',
    'run',
    ...GATES.map((g) => `//#${g}`),
    // Same plain, grouped output in a terminal, hook, CI and agent logs.
    '--ui=stream',
    '--log-order=grouped',
    // Report every failing gate in one run instead of stopping at the first.
    '--continue=always',
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
  },
);
process.exit(r.status ?? 1);

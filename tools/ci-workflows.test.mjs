// Loop 7 (owner): a pull request runs only `check`, on ubuntu and macOS. The `gates` and
// `vscode-host` jobs stay in ci.yml and run when CI is dispatched by hand with `full`, and the weekly
// Mutation workflow runs every prove-gates case, so each gate is still seen to fail somewhere.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (name) => parse(readFileSync(join(REPO, '.github/workflows', name), 'utf8'));
const ci = workflow('ci.yml');
const mutation = workflow('mutation.yml');
const BY_HAND = "${{ github.event_name == 'workflow_dispatch' && inputs.full }}";
const runs = (job) => job.steps.map((step) => step.run).filter(Boolean);

describe('ci.yml', () => {
  it('runs check on every event, and gates and vscode-host, as before, only by hand with full', () => {
    const conditions = Object.fromEntries(Object.entries(ci.jobs).map(([id, job]) => [id, job.if]));
    expect(conditions).toEqual({ check: undefined, gates: BY_HAND, 'vscode-host': BY_HAND });
    expect(ci.on.workflow_dispatch.inputs.full).toMatchObject({ type: 'boolean', default: false });
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    // The jobs themselves are unchanged from before loop 7.
    expect(ci.jobs.check.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(runs(ci.jobs.check)).toContain('bun run check');
    const gates = ci.jobs.gates.steps.find((step) => step.run === 'bun run check:gates');
    expect(gates?.env).toEqual({ PROVE_GATES_SKIP_SLOW: '1' });
    expect(ci.jobs['vscode-host'].strategy.matrix.pin).toEqual(['current', 'oldest']);
    expect(runs(ci.jobs['vscode-host'])).toContain(
      'xvfb-run -a bun run test:vscode-host --label ${{ matrix.pin }}',
    );
  });
});

describe('mutation.yml', () => {
  it('runs every prove-gates case weekly, over the full history, whatever Stryker does', () => {
    expect(mutation.on.schedule).toHaveLength(1);
    const [id, ...others] = Object.keys(mutation.jobs).filter((key) =>
      runs(mutation.jobs[key]).some((run) => run.startsWith('bun run check:gates')),
    );
    expect(others).toEqual([]);
    const job = mutation.jobs[id];
    // Nothing before it but the install, so a red Stryker run (stop-list 78) cannot skip it.
    expect(job.needs).toBeUndefined();
    expect(runs(job)).toEqual(['bun install --frozen-lockfile', 'bun run check:gates']);
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with).toMatchObject({ 'fetch-depth': 0 });
    // No PROVE_GATES_SKIP_SLOW at any level: the slow cases run too.
    expect([mutation.env, job.env, ...job.steps.map((step) => step.env)]).not.toContainEqual(
      expect.objectContaining({ PROVE_GATES_SKIP_SLOW: expect.anything() }),
    );
  });
});

// REAL (U3.1.2, BMO-56): what the spikes measure, written as it comes to CPG_SPIKE_SAMPLES, so a crash
// keeps the series before it. tools/spike-report.mjs reads the file.

import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, loadavg, platform, release } from 'node:os';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { webglRenderer } from '../webgl';

export interface Series {
  readonly name: string;
  readonly samples: readonly number[];
  /** The cold sample, kept out of the statistics. */
  readonly first: number | undefined;
  /** What one message's JSON weighs, in UTF-8 bytes. */
  readonly bytes?: number | undefined;
  /** Why the series ends early. */
  readonly failed?: string | undefined;
}

const recorded: Series[] = [];
let conditions: Readonly<Record<string, string>> = {};

// A root hook: before any spike opens a panel of its own, which this one's could hide.
suiteSetup(async () => {
  conditions = await readConditions();
});

async function readConditions(): Promise<Readonly<Record<string, string>>> {
  return {
    date: new Date().toISOString(),
    vscode: vscode.version,
    electron: process.versions['electron'] ?? 'unknown',
    node: process.versions.node,
    webgl: (await webglRenderer()) ?? 'none',
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpus()[0]?.model.trim() ?? 'unknown'} x${String(cpus().length)}`,
    display: process.env['DISPLAY'] === undefined ? 'headless' : 'display',
    load: loadavg()
      .map((average) => average.toFixed(2))
      .join(' '),
  };
}

export async function record(series: Series): Promise<void> {
  const path = process.env['CPG_SPIKE_SAMPLES'];
  if (path === undefined) throw new Error('CPG_SPIKE_SAMPLES is not set');
  recorded.push(series);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ conditions, series: recorded }, undefined, 2)}\n`);
}

/** `answer`, or a rejection saying `what` did not come in `ms`. */
export function within<T>(ms: number, answer: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${what} in ${String(ms)} ms`)), ms);
    answer.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Records one cold sample and `count` more, with what was measured even when one of them fails. */
export async function measure(
  series: Pick<Series, 'name' | 'bytes'>,
  count: number,
  sample: () => Promise<number>,
): Promise<void> {
  const samples: number[] = [];
  let first: number | undefined;
  let failed: string | undefined;
  try {
    first = await sample();
    while (samples.length < count) samples.push(await sample()); // oxlint-disable-line no-await-in-loop -- one at a time is what is measured
  } catch (thrown) {
    failed = String(thrown);
    throw thrown;
  } finally {
    await record({ ...series, samples, first, failed });
  }
}

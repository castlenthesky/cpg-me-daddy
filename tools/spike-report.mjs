#!/usr/bin/env node
// REAL (U3.1.2, BMO-56): what the spikes measured, as rows to copy into docs/outline/06-measurements.yaml.
//
// Usage: node tools/spike-report.mjs [samples.json]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPIKE_SAMPLES } from './vscode-host.mjs';

/**
 * The nearest-rank percentile of `samples`: the smallest sample that at least `percent` of them are at or
 * below. undefined for no samples. `samples` is left as it is.
 *
 * @param {readonly number[]} samples
 * @param {number} percent in (0, 100]
 * @returns {number | undefined}
 */
export function percentile(samples, percent) {
  // Multiplied first: 0.07 * 100 is 7.000000000000001, and its rank would be one too high.
  const rank = Math.ceil((percent * samples.length) / 100);
  return samples.toSorted((a, b) => a - b)[rank - 1];
}

const ms = (time) => `${time.toFixed(2)} ms`;

/**
 * One line per series, in order, then one per failure:
 * `<name>: p50 <ms> ms, p95 <ms> ms, max <ms> ms, n=<count>` with `, first <ms> ms` when the series has a
 * cold sample, kept out of the statistics, and `, <bytes> bytes of JSON` when it has a size. A series that
 * failed is `<name>: not measured: <why>`, with what was measured before that, if anything, still reported
 * first. Times have two decimals. Nothing is estimated (decision 34).
 *
 * @param {{ conditions: Record<string, string>, series: readonly { name: string, samples: readonly number[],
 *   first?: number, bytes?: number, failed?: string }[] }} measured
 * @returns {string[]}
 */
export function reportLines({ conditions, series }) {
  const lines = [
    Object.entries(conditions)
      .map(([name, value]) => `${name}: ${value}`)
      .join('; '),
  ];
  for (const { name, samples, first, bytes, failed } of series) {
    if (samples.length > 0) {
      const [p50, p95, max] = [50, 95, 100].map((percent) => ms(percentile(samples, percent)));
      const cold = first === undefined ? '' : `, first ${ms(first)}`;
      const size = bytes === undefined ? '' : `, ${bytes} bytes of JSON`;
      lines.push(`${name}: p50 ${p50}, p95 ${p95}, max ${max}, n=${samples.length}${cold}${size}`);
    }
    const why = failed ?? (samples.length === 0 ? 'no samples' : undefined);
    if (why !== undefined) lines.push(`${name}: not measured: ${why}`);
  }
  return lines;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? SPIKE_SAMPLES;
  try {
    const measured = JSON.parse(readFileSync(path, 'utf8'));
    if (measured.series.length === 0) throw new Error('no series');
    console.log(reportLines(measured).join('\n'));
  } catch (thrown) {
    console.error(`spike-report: ${path}: ${thrown.message}`);
    process.exitCode = 1;
  }
}

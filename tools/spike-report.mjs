#!/usr/bin/env node
// SEAT (U3.1.2, BMO-56): what the spikes measured, as rows to copy into docs/outline/06-measurements.yaml.
//
// Usage: node tools/spike-report.mjs [samples.json]

/**
 * The nearest-rank percentile of `samples`: the smallest sample that at least `percent` of them are at or
 * below. undefined for no samples. `samples` is left as it is.
 *
 * @param {readonly number[]} samples
 * @param {number} percent in (0, 100]
 * @returns {number | undefined}
 */
export function percentile(_samples, _percent) {
  throw new Error('SEAT: not built yet: percentile (U3.1.2)');
}

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
export function reportLines(_measured) {
  throw new Error('SEAT: not built yet: reportLines (U3.1.2)');
}

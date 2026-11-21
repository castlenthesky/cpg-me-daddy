// Mutation testing: measures whether the tests catch behaviour changes, not just execute lines.
// Slow, so deliberately NOT part of `npm run check`; CI runs it on a schedule / manual dispatch.
// .mjs rather than .json so choices can carry comments.
export default {
  testRunner: 'vitest',
  // Type-checks every mutant; mutants that do not compile are discarded instead of
  // counted as survivors, so the score is not diluted by impossible mutants.
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  // Only shipped source of the one real package; tests are the oracle, never mutated.
  mutate: ['packages/model/src/**/*.ts', '!**/*.test.ts', '!**/*.test-d.ts'],
  // Re-tests only mutants whose code or tests changed. The file lives in reports/ (gitignored);
  // CI should cache it between runs.
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  thresholds: {
    high: 80,
    low: 60,
    // Ratchet: measured 77.78 on day one, rounded down to the nearest 10. Only raise it,
    // never lower it to make a change pass.
    break: 70,
  },
};

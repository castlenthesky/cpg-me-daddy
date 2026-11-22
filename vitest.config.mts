import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Explicit (it is also the default): a glob that matches nothing must FAIL,
    // so a moved/renamed test dir can never turn the suite silently green.
    passWithNoTests: false,
    // Type-level tests (*.test-d.ts) and type errors in *.test.ts are checked by
    // `bun run typecheck:tests` (tsc), so vitest's typecheck mode is
    // left off (its default; it would check the same files twice). *.test-d.ts is not in `include`, so
    // it is never collected as a runtime test.
    coverage: {
      provider: 'v8',
      // Only shipped source; `all` behaviour means an untested new file counts as 0%.
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.test-d.ts'],
      reporter: ['text-summary', 'lcov', 'json-summary'],
      // Thresholds ONLY RATCHET UP. Set to measured coverage rounded down to the
      // nearest 5 (lines/statements 95.65, branches 96.42, functions 100).
      // Raise them when coverage rises; never lower them to make a change pass.
      thresholds: { lines: 95, functions: 100, branches: 95, statements: 95 },
    },
  },
});

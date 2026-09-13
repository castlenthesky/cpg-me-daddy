/**
 * The engine's own semantic version — pulled out of `src/index.ts` so
 * `store/bootstrap.ts` (M0.4a, which stamps it onto `META_DATA.engine_version`)
 * can read it without importing the package's own barrel and creating a
 * cycle (`src/index.ts` -> `store/index.ts` -> `bootstrap.ts` -> `src/index.ts`).
 * One source of truth either way: `src/index.ts` re-exports this constant
 * rather than declaring a second copy.
 */
export const ENGINE_VERSION = "0.0.1";

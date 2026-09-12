/**
 * Shared enum value sets for the v1 CPG schema.
 *
 * Declared once, referenced by identity from `nodes.ts`/`edges.ts` — never
 * recreated as a fresh literal array at the call site. `schema.test.ts`
 * asserts that `CALLS.status` and `IMPORTS.status` point at the exact same
 * `RESOLUTION_STATUS` array object, which is what makes "one shared
 * vocabulary, not two parallel enums" (R6) a structural fact rather than a
 * comment that can rot.
 */

/**
 * Resolution status, shared unmodified by `CALLS.status` and `IMPORTS.status`
 * (R6 "ID rule and status enum"). Normative, cross-language-binding
 * definitions:
 *
 * - `resolved`   — target found and unambiguous.
 * - `ambiguous`  — multiple statically-plausible candidates exist (overload
 *                  sets, duplicate/star imports, unresolved re-export fan-out).
 * - `external`   — target resolves to a dependency outside the indexed workspace.
 * - `unresolved` — no static candidate found.
 * - `dynamic`    — target determined by a runtime dispatch mechanism the
 *                  frontend cannot follow statically (`eval`,
 *                  `getattr`/`__getattr__`/`__call__` overrides, `Function()`,
 *                  computed member access `obj[key]()`, computed
 *                  `require`/dynamic `import`).
 */
export const RESOLUTION_STATUS = [
  "resolved",
  "ambiguous",
  "external",
  "unresolved",
  "dynamic",
] as const;

/** Node lifecycle status on every `:CPG` node and on `FILE` (D21/PR8). */
export const NODE_STATUS = ["ready", "indexing", "stale", "error"] as const;

/** `INHERITS_FROM.relation` (R6 Next Steps #1 / DL6, merging EXTENDS+IMPLEMENTS). */
export const INHERITS_RELATION = ["extends", "implements"] as const;

export const TYPE_DECL_KIND = [
  "class",
  "interface",
  "enum",
  "type_alias",
  "protocol",
  "dataclass",
] as const;

export const METHOD_KIND = [
  "function",
  "method",
  "constructor",
  "getter",
  "setter",
  "lambda_named",
] as const;

export const CALL_KIND = ["call", "new", "decorator", "await"] as const;

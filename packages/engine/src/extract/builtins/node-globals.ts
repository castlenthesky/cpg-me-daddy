/**
 * The frozen set of TypeScript/JavaScript global identifiers this slice
 * attributes to the `node` package when a call's callee (or its receiver)
 * matches one, minting an EXTERNAL `SYMBOL` (`site:node\`...`). Deliberately
 * small and hand-picked, not sourced from `lib.dom.d.ts`/Node's own type
 * definitions — a global this list misses simply mints no SYMBOL at all
 * (README rule 2: no bare-name SYMBOLs for anything this table doesn't
 * attribute).
 */
export const NODE_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "console",
  "Math",
  "JSON",
  "process",
  "Promise",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "Symbol",
  "Error",
  "TypeError",
  "RangeError",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "fetch",
  "structuredClone",
  "globalThis",
  "Buffer",
  "require",
]);

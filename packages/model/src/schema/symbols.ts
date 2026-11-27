/**
 * `SYMBOL.fqn`: the single implementation of the owner-prefixed SCIP descriptor grammar (04-schema.yaml
 * SYMBOL.fqn; controller decision 89, ported from archive f18ee71:packages/engine/src/identity/symbol-id.ts).
 *
 *   local    := "`" esc(path) "`" "/" descriptor*            e.g. `main.py`/Greeter#greet().
 *   external := scheme ":" package "`" descriptor*           e.g. site:node`console.log().
 *   descriptor := name suffix, suffix "/" namespace | "#" type | "." term | "()." method
 *   name     := a simple identifier [A-Za-z0-9_+$-]+, else "`" esc(name) "`"   (SCIP's escaped identifier)
 *   esc(s)   := s with every "`" doubled
 *
 * - A workspace-local owner is its file's path, so it is unique already. An external owner keeps its
 *   `scheme:package` prefix INSIDE the fqn: fqn is UNIQUE, and two packages exporting `Foo#bar().` must not
 *   merge onto one node.
 * - A MODULE's symbol is its owner alone (`` `main.py`/ ``, controller decision 90). PARAM mints none in v1
 *   (decision 91), so there is no parameter descriptor.
 * - The rendering is injective: distinct parts give distinct fqns (a SYMBOL is merged on its fqn).
 * - Throws `Error('invalid symbol fqn parts: <reason>')` on invalid parts (a producer bug, L-08): a local
 *   path that is not a WorkspacePath or is `'.'`; an empty scheme or one holding `:` or `` ` ``; an empty
 *   package or one holding `` ` ``; an empty descriptor name or an unknown descriptor kind; U+0000 anywhere.
 */
import { isWorkspacePath, type WorkspacePath } from '../paths';

/** SCIP's descriptor kinds that v1 mints. */
export type SymbolDescriptorKind = 'namespace' | 'type' | 'term' | 'method';

/** One link of the lexical chain, outermost first: `Greeter#` then `greet().`. */
export interface SymbolDescriptor {
  readonly kind: SymbolDescriptorKind;
  /** Non-empty, no U+0000. Escaped on rendering when it is not a simple identifier. */
  readonly name: string;
}

/** The parts of a `SYMBOL.fqn`. `form` is the discriminant; it is not `SymbolElement.origin`. */
export type SymbolFqnParts =
  | {
      readonly form: 'local';
      /** The defining file; never `'.'`. */
      readonly path: WorkspacePath;
      readonly descriptors: readonly SymbolDescriptor[];
    }
  | {
      readonly form: 'external';
      /** SCIP scheme, e.g. `site` or `python`. Non-empty; no `:` or `` ` ``. */
      readonly scheme: string;
      /** SCIP package, e.g. `node` or `@types/node`. Non-empty; no `` ` ``. */
      readonly package: string;
      readonly descriptors: readonly SymbolDescriptor[];
    };

const SUFFIX: Readonly<Record<SymbolDescriptorKind, string>> = {
  namespace: '/',
  type: '#',
  term: '.',
  method: '().',
};
const SIMPLE = /^[A-Za-z0-9_+$-]+$/;
const NUL = '\u0000';

function escape(value: string): string {
  return value.replaceAll('`', '``');
}

function fail(reason: string): never {
  throw new Error(`invalid symbol fqn parts: ${reason}`);
}

function isDescriptorKind(value: unknown): value is SymbolDescriptorKind {
  return typeof value === 'string' && Object.hasOwn(SUFFIX, value);
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Renders `parts` per the grammar above. Pure; throws on invalid parts. */
export function makeSymbolFqn(parts: SymbolFqnParts): string {
  // REAL
  if (parts === null || typeof parts !== 'object') {
    fail('parts is not an object');
  }
  let owner: string;
  const rawForm: unknown = parts.form;
  if (parts.form === 'local') {
    const { path } = parts;
    if (typeof path !== 'string' || !isWorkspacePath(path) || path === '.') {
      fail(`path is not a file WorkspacePath: ${JSON.stringify(path)}`);
    }
    owner = `\`${escape(path)}\`/`;
  } else if (parts.form === 'external') {
    const { scheme, package: pkg } = parts;
    if (
      typeof scheme !== 'string' ||
      scheme.length === 0 ||
      scheme.includes(':') ||
      scheme.includes('`') ||
      scheme.includes(NUL)
    ) {
      fail(`bad scheme ${JSON.stringify(scheme)}`);
    }
    if (typeof pkg !== 'string' || pkg.length === 0 || pkg.includes('`') || pkg.includes(NUL)) {
      fail(`bad package ${JSON.stringify(pkg)}`);
    }
    owner = `${scheme}:${pkg}\``;
  } else {
    fail(`unknown form ${JSON.stringify(rawForm)}`);
  }

  if (!isArray(parts.descriptors)) {
    fail('descriptors is not an array');
  }
  const rendered: string[] = [];
  for (const descriptor of parts.descriptors) {
    if (descriptor === null || typeof descriptor !== 'object') {
      fail('descriptor is not an object');
    }
    const { kind, name } = descriptor;
    if (!isDescriptorKind(kind)) {
      fail(`unknown descriptor kind ${JSON.stringify(kind)}`);
    }
    if (typeof name !== 'string' || name.length === 0 || name.includes(NUL)) {
      fail(`bad descriptor name ${JSON.stringify(name)}`);
    }
    const segment = SIMPLE.test(name) ? name : `\`${escape(name)}\``;
    rendered.push(segment + SUFFIX[kind]);
  }
  return owner + rendered.join('');
}

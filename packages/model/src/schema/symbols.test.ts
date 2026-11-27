/**
 * Controller decision 89: makeSymbolFqn. Expected strings come from 04-schema.yaml SYMBOL.fqn (its two
 * examples), the ladder's hand-written DEFINES targets (fixtures/ladder), and SCIP's descriptor grammar
 * (suffixes `/ # . ().`; an identifier outside [A-Za-z0-9_+$-] is backtick-escaped with `` ` `` doubled),
 * never from running the code.
 */
import { describe, expect, it } from 'vitest';

import type { WorkspacePath } from '../paths';
import { makeSymbolFqn, type SymbolDescriptor, type SymbolFqnParts } from './symbols';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only brand forge.
const wp = (s: string): WorkspacePath => s as WorkspacePath;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only: forge invalid parts to prove the runtime guard.
const forge = (p: unknown): SymbolFqnParts => p as SymbolFqnParts;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only: forge an invalid descriptor.
const forgeD = (d: unknown): SymbolDescriptor => d as SymbolDescriptor;
const ns = (name: string): SymbolDescriptor => ({ kind: 'namespace', name });
const ty = (name: string): SymbolDescriptor => ({ kind: 'type', name });
const term = (name: string): SymbolDescriptor => ({ kind: 'term', name });
const meth = (name: string): SymbolDescriptor => ({ kind: 'method', name });
const local = (path: string, ...descriptors: SymbolDescriptor[]): SymbolFqnParts => ({
  form: 'local',
  path: wp(path),
  descriptors,
});
const ext = (scheme: string, pkg: string, ...descriptors: SymbolDescriptor[]): SymbolFqnParts => ({
  form: 'external',
  scheme,
  package: pkg,
  descriptors,
});

describe('makeSymbolFqn: the descriptor table', () => {
  const rows: [string, SymbolFqnParts, string][] = [
    ['MODULE (decision 90)', local('main.py'), '`main.py`/'],
    ['MODULE in a package', local('shapes/__init__.py'), '`shapes/__init__.py`/'],
    ['TYPE_DECL', local('main.py', ty('Greeter')), '`main.py`/Greeter#'],
    [
      'METHOD in a type',
      local('main.py', ty('Greeter'), meth('greet')),
      '`main.py`/Greeter#greet().',
    ],
    ['MEMBER', local('main.py', ty('Greeter'), term('greeting')), '`main.py`/Greeter#greeting.'],
    ['a free function', local('main.py', meth('greet')), '`main.py`/greet().'],
    [
      '04-schema local example',
      local('src/users.ts', ty('UserService'), meth('findById')),
      '`src/users.ts`/UserService#findById().',
    ],
    ['a namespace', local('src/a.ts', ns('ns'), ty('T')), '`src/a.ts`/ns/T#'],
    [
      '04-schema external example',
      ext('site', 'node', term('console'), meth('log')),
      'site:node`console.log().',
    ],
    ['a scoped package', ext('npm', '@types/node', ty('Buffer')), 'npm:@types/node`Buffer#'],
    ['an external owner alone', ext('python', 'stdlib'), 'python:stdlib`'],
    [
      'dunder and digits stay bare',
      local('m.py', meth('__init__'), term('x2')),
      '`m.py`/__init__().x2.',
    ],
    ["SCIP's other identifier characters", local('m.ts', term('$a+b-c_')), '`m.ts`/$a+b-c_.'],
  ];
  it.each(rows)('%s', (_name, parts, want) => {
    expect(makeSymbolFqn(parts)).toBe(want);
  });
});

describe('makeSymbolFqn: hostile names are escaped, so the rendering is injective', () => {
  const rows: [string, SymbolFqnParts, string][] = [
    ['a dot in a name', local('m.ts', ty('a.b')), '`m.ts`/`a.b`#'],
    ['a hash in a name', local('m.ts', term('a#b')), '`m.ts`/`a#b`.'],
    ['a slash in a name', local('m.ts', meth('a/b')), '`m.ts`/`a/b`().'],
    ['parentheses in a name', local('m.ts', term('f()')), '`m.ts`/`f()`.'],
    ['a backtick in a name is doubled', local('m.ts', ty('a`b')), '`m.ts`/`a``b`#'],
    ['a space in a name', local('m.ts', meth('my name')), '`m.ts`/`my name`().'],
    ['a non-ASCII identifier', local('m.py', term('café')), '`m.py`/`café`.'],
    ['a backtick in the path is doubled', local('we`ird.py', ty('T')), '`we``ird.py`/T#'],
    ['a path ending in a backtick', local('a`', ty('T')), '`a```/T#'],
  ];
  it.each(rows)('%s', (_name, parts, want) => {
    expect(makeSymbolFqn(parts)).toBe(want);
  });

  const pairs: [string, SymbolFqnParts, SymbolFqnParts][] = [
    ['one type `a#b` vs types a, b', local('m.ts', ty('a#b')), local('m.ts', ty('a'), ty('b'))],
    [
      'one term `a.b` vs terms a, b',
      local('m.ts', term('a.b')),
      local('m.ts', term('a'), term('b')),
    ],
    [
      'one method `a().b` vs methods a, b',
      local('m.ts', meth('a().b')),
      local('m.ts', meth('a'), meth('b')),
    ],
    [
      'type `a/T` vs namespace a, type T',
      local('x.ts', ty('a/T')),
      local('x.ts', ns('a'), ty('T')),
    ],
    ['a backtick-slash path vs a namespace', local('x`/y'), local('x', ns('y`'))],
    ['term x vs method x', local('m.ts', term('x')), local('m.ts', meth('x'))],
    [
      'external type `a.b` vs terms a, b',
      ext('s', 'p', ty('a.b')),
      ext('s', 'p', term('a'), ty('b')),
    ],
    ['local vs external', local('site:node'), ext('site', 'node')],
    ['two paths', local('a/b.py', ty('T')), local('a', ns('b.py'), ty('T'))],
  ];
  it.each(pairs)('%s', (_name, a, b) => {
    expect(makeSymbolFqn(a)).not.toBe(makeSymbolFqn(b));
  });
});

describe('makeSymbolFqn: invalid parts throw (a producer bug)', () => {
  const bad: [string, SymbolFqnParts][] = [
    ["a local path of '.'", local('.')],
    ['an absolute local path', local('/abs/m.py')],
    ['an empty local path', local('')],
    ["a './' local path", local('./m.py')],
    ['NUL in the path', local('a\u0000.py')],
    ['an empty scheme', ext('', 'node', term('x'))],
    ['a colon in the scheme', ext('a:b', 'node', term('x'))],
    ['a backtick in the scheme', ext('a`b', 'node', term('x'))],
    ['NUL in the scheme', ext('si\u0000te', 'node', term('x'))],
    ['an empty package', ext('site', '', term('x'))],
    ['a backtick in the package', ext('site', 'no`de', term('x'))],
    ['NUL in the package', ext('site', 'no\u0000de', term('x'))],
    ['an empty descriptor name', local('m.py', ty(''))],
    ['NUL in a descriptor name', local('m.py', ty('a\u0000b'))],
    [
      'an unknown descriptor kind (PARAM mints none, decision 91)',
      local('m.py', meth('f'), forgeD({ kind: 'parameter', name: 'x' })),
    ],
    ['an unknown form', forge({ form: 'builtin', path: 'm.py', descriptors: [] })],
  ];
  it.each(bad)('%s', (_name, parts) => {
    expect(() => makeSymbolFqn(parts)).toThrow(/^invalid symbol fqn parts: /);
  });

  it('rejects a descriptor that is not an object with a string name', () => {
    const parts = local('m.py', forgeD({ kind: 'type' }));
    expect(() => makeSymbolFqn(parts)).toThrow(/^invalid symbol fqn parts: /);
  });
});

describe('makeSymbolFqn is pure (C-MODEL I-11)', () => {
  it('reads frozen parts without changing them and answers the same twice', () => {
    const descriptors = [Object.freeze(ty('Greeter')), Object.freeze(meth('greet'))];
    const parts = Object.freeze({
      form: 'local' as const,
      path: wp('main.py'),
      descriptors: Object.freeze(descriptors),
    });
    const before = JSON.stringify(parts);
    expect(makeSymbolFqn(parts)).toBe('`main.py`/Greeter#greet().');
    expect(makeSymbolFqn(parts)).toBe('`main.py`/Greeter#greet().');
    expect(JSON.stringify(parts)).toBe(before);
  });
});

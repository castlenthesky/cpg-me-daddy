import { describe, expect, it } from 'vitest';
import { wsPath } from '../test/chain-contract';
import { declares, defines, extracted, node, seal } from '../test/files';
import type { DefinitionLookup } from './contract';
import { createDefinitionLookup } from './lookup';

// pkg/shapes.py, 0-based rows:
//  0 import os
//  1 class Square:
//  2     side = 1
//  3     def area(self):
//  4         return self.side ** 2
//  5 def area(x):
//  6     return x
//  7 LIMIT = 3
//  8 if True:
//  9     def late(): pass
// 10 def LIMIT(): pass
const SHAPES = wsPath('pkg/shapes.py');
const id = (rest: string) => `file:pkg/shapes.py:${rest}`;
const fqn = (rest: string) => `\`pkg/shapes.py\`/${rest}`;
const MODULE = id('MODULE:$root');

const shapes = extracted(SHAPES, {
  nodes: [
    node('MODULE', MODULE, SHAPES, [0, 0, 11, 0], { name: 'pkg.shapes', status: 'ready' }),
    node('IMPORT', id('IMPORT:$root:0'), SHAPES, [0, 0, 0, 9], {
      source_text: 'os',
      status: 'ready',
    }),
    node('TYPE_DECL', id('TYPE_DECL:Square'), SHAPES, [1, 0, 4, 29], { name: 'Square' }),
    node('MEMBER', id('MEMBER:Square.side'), SHAPES, [2, 4, 2, 12], { name: 'side' }),
    node(
      'METHOD',
      id('METHOD:Square.area'),
      SHAPES,
      [3, 4, 4, 29],
      { name: 'area' },
      [3, 8, 3, 12],
    ),
    node('METHOD', id('METHOD:area'), SHAPES, [5, 0, 6, 12], { name: 'area' }, [5, 4, 5, 8]),
    node('MEMBER', id('MEMBER:LIMIT'), SHAPES, [7, 0, 7, 9], { name: 'LIMIT' }),
    node('METHOD', id('METHOD:late'), SHAPES, [9, 4, 9, 20], { name: 'late' }, [9, 8, 9, 12]),
    node('METHOD', id('METHOD:LIMIT'), SHAPES, [10, 0, 10, 17], { name: 'LIMIT' }, [10, 4, 10, 9]),
  ],
  symbols: [
    fqn(''),
    fqn('Square#'),
    fqn('Square#side.'),
    fqn('Square#area().'),
    fqn('area().'),
    fqn('LIMIT.'),
    fqn('late().'),
    fqn('LIMIT().'),
  ],
  edges: [
    defines('MODULE', MODULE, fqn('')),
    declares('MODULE', MODULE, 'IMPORT', id('IMPORT:$root:0')),
    declares('MODULE', MODULE, 'TYPE_DECL', id('TYPE_DECL:Square')),
    defines('TYPE_DECL', id('TYPE_DECL:Square'), fqn('Square#')),
    declares('TYPE_DECL', id('TYPE_DECL:Square'), 'MEMBER', id('MEMBER:Square.side')),
    defines('MEMBER', id('MEMBER:Square.side'), fqn('Square#side.')),
    declares('TYPE_DECL', id('TYPE_DECL:Square'), 'METHOD', id('METHOD:Square.area')),
    defines('METHOD', id('METHOD:Square.area'), fqn('Square#area().')),
    declares('MODULE', MODULE, 'METHOD', id('METHOD:area')),
    defines('METHOD', id('METHOD:area'), fqn('area().')),
    declares('MODULE', MODULE, 'MEMBER', id('MEMBER:LIMIT')),
    defines('MEMBER', id('MEMBER:LIMIT'), fqn('LIMIT.')),
    declares('MODULE', MODULE, 'METHOD', id('METHOD:late')),
    defines('METHOD', id('METHOD:late'), fqn('late().')),
    declares('MODULE', MODULE, 'METHOD', id('METHOD:LIMIT')),
    defines('METHOD', id('METHOD:LIMIT'), fqn('LIMIT().')),
  ],
});

// util.py: 0 def helper():  1     pass
const UTIL = wsPath('util.py');
const PRINT = 'site:python-stdlib`print().';
const util = extracted(UTIL, {
  nodes: [
    node('MODULE', 'file:util.py:MODULE:$root', UTIL, [0, 0, 2, 0], { name: 'util' }),
    node(
      'METHOD',
      'file:util.py:METHOD:helper',
      UTIL,
      [0, 0, 1, 8],
      { name: 'helper' },
      [0, 4, 0, 10],
    ),
  ],
  symbols: ['`util.py`/', '`util.py`/helper().'],
  builtins: [PRINT],
  edges: [
    defines('MODULE', 'file:util.py:MODULE:$root', '`util.py`/'),
    declares('MODULE', 'file:util.py:MODULE:$root', 'METHOD', 'file:util.py:METHOD:helper'),
    defines('METHOD', 'file:util.py:METHOD:helper', '`util.py`/helper().'),
  ],
});

// odd.py: shapes the extractor does not produce, legal by type, for the rules' edges. f's name token
// sits inside m's tighter range; g and h tie; k has a name token and a name but defines nothing.
const ODD = wsPath('odd.py');
const odd = extracted(ODD, {
  nodes: [
    node('MODULE', 'file:odd.py:MODULE:$root', ODD, [0, 0, 10, 0], { name: 'odd' }),
    node('METHOD', 'file:odd.py:METHOD:f', ODD, [0, 0, 3, 0], { name: 'f' }, [1, 2, 1, 3]),
    node('MEMBER', 'file:odd.py:MEMBER:m', ODD, [1, 0, 1, 8], { name: 'm' }),
    node('METHOD', 'file:odd.py:METHOD:g', ODD, [5, 0, 6, 0], { name: 'g' }, [5, 4, 5, 5]),
    node('METHOD', 'file:odd.py:METHOD:h', ODD, [5, 0, 6, 0], { name: 'h' }, [5, 4, 5, 5]),
    node('METHOD', 'file:odd.py:METHOD:k', ODD, [8, 0, 9, 0], { name: 'k' }, [8, 4, 8, 5]),
  ],
  symbols: ['`odd.py`/', '`odd.py`/f().', '`odd.py`/m.', '`odd.py`/g().'],
  edges: [
    defines('MODULE', 'file:odd.py:MODULE:$root', '`odd.py`/'),
    defines('METHOD', 'file:odd.py:METHOD:f', '`odd.py`/f().'),
    defines('MEMBER', 'file:odd.py:MEMBER:m', '`odd.py`/m.'),
    defines('METHOD', 'file:odd.py:METHOD:g', '`odd.py`/g().'),
    defines('METHOD', 'file:odd.py:METHOD:h', '`odd.py`/h().'),
    declares('MODULE', 'file:odd.py:MODULE:$root', 'METHOD', 'file:odd.py:METHOD:k'),
  ],
});

const SET = seal(util, shapes, odd);
let built: DefinitionLookup | undefined;
/** Built on first use, so a failure lands in each test rather than at file load. */
function lookup(): DefinitionLookup {
  built ??= createDefinitionLookup(SET);
  return built;
}

describe('createDefinitionLookup: symbolAt', () => {
  it.each([
    ['a METHOD name token', 3, 8, fqn('Square#area().')],
    ['inside a method body: the METHOD, not its class', 4, 15, fqn('Square#area().')],
    ['a MEMBER range start (inclusive; no name token)', 2, 4, fqn('Square#side.')],
    ['a class name: the TYPE_DECL that encloses it', 1, 6, fqn('Square#')],
    ['an import statement: only the MODULE encloses it', 0, 7, fqn('')],
    ['a range start is inside', 5, 0, fqn('area().')],
    ['the last column before the end', 6, 11, fqn('area().')],
    ['a range end is outside (exclusive)', 6, 12, fqn('')],
    ['the end row past the end column is outside: rows, then columns', 4, 30, fqn('')],
    ['the start row before the start column is outside', 3, 2, fqn('Square#')],
    ['a def inside a module-level if', 9, 8, fqn('late().')],
  ] as const)('pkg/shapes.py: %s', (_name, row, column, expected) => {
    expect(lookup().symbolAt(SHAPES, row, column)).toBe(expected);
  });

  it('past every range of the file, and in an unindexed file: undefined', () => {
    expect(lookup().symbolAt(SHAPES, 11, 0)).toBeUndefined();
    expect(lookup().symbolAt(wsPath('nope.py'), 0, 0)).toBeUndefined();
  });

  it('answers from the file asked, never another at the same position', () => {
    expect(lookup().symbolAt(UTIL, 0, 4)).toBe('`util.py`/helper().');
    expect(lookup().symbolAt(SHAPES, 0, 4)).toBe(fqn(''));
  });

  it('a name token starting here wins over a tighter range', () => {
    expect(lookup().symbolAt(ODD, 1, 2)).toBe('`odd.py`/f().');
    expect(lookup().symbolAt(ODD, 1, 5)).toBe('`odd.py`/m.');
  });

  it('equal candidates: the first in node order, for a name token and for a range', () => {
    expect(lookup().symbolAt(ODD, 5, 4)).toBe('`odd.py`/g().');
    expect(lookup().symbolAt(ODD, 5, 1)).toBe('`odd.py`/g().');
  });

  it('a node that defines nothing is no candidate, even at its name token', () => {
    expect(lookup().symbolAt(ODD, 8, 4)).toBe('`odd.py`/');
  });
});

describe('createDefinitionLookup: symbolNamed', () => {
  it.each([
    ['a module-level def, not the class method of that name', 'area', fqn('area().')],
    ['a class', 'Square', fqn('Square#')],
    ['a def inside a module-level if', 'late', fqn('late().')],
    ['a later module-level binding replaces an earlier one', 'LIMIT', fqn('LIMIT().')],
  ] as const)('pkg/shapes.py: %s', (_name, name, expected) => {
    expect(lookup().symbolNamed(SHAPES, name)).toBe(expected);
  });

  it.each([
    ['a class member is not module-level', SHAPES, 'side'],
    ['an import binding mints no symbol', SHAPES, 'os'],
    ['an unknown name', SHAPES, 'missing'],
    ['a name defined in another file', UTIL, 'area'],
    ['a module-level declaration that defines nothing', ODD, 'k'],
    ['an unindexed file', wsPath('nope.py'), 'helper'],
  ] as const)('undefined: %s', (_name, path, name) => {
    expect(lookup().symbolNamed(path, name)).toBeUndefined();
  });

  it('finds a name in its own file', () => {
    expect(lookup().symbolNamed(UTIL, 'helper')).toBe('`util.py`/helper().');
  });
});

describe('createDefinitionLookup: hasSymbol and isIndexed', () => {
  it('hasSymbol reads every file symbols channel, builtins included', () => {
    expect(lookup().hasSymbol(fqn('area().'))).toBe(true);
    expect(lookup().hasSymbol('`util.py`/helper().')).toBe(true);
    expect(lookup().hasSymbol(PRINT)).toBe(true);
  });

  it('hasSymbol: a DEFINES target alone is no symbol, and an invented fqn is none', () => {
    expect(lookup().hasSymbol('`odd.py`/h().')).toBe(false);
    expect(lookup().hasSymbol(fqn('ghost().'))).toBe(false);
  });

  it('isIndexed: exactly the paths of the set', () => {
    expect([SHAPES, UTIL, ODD].map((p) => lookup().isIndexed(p))).toEqual([true, true, true]);
    const others = ['pkg', 'pkg/shapes', 'other.py', 'pkg/util.py'].map(wsPath);
    expect(others.map((p) => lookup().isIndexed(p))).toEqual([false, false, false, false]);
  });
});

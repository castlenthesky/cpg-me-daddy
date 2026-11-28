// The chain half of C-RESOLVE's suite (verifyChainContract), written from INV-1, INV-4, INV-9 and
// INV-10. Each case returns its problems, so the same cases can be run against a deliberately broken
// chain and be seen to fail (BMO-46). Expected values come from the invariants' text and
// shared_vocabulary.status_rank (unresolved 0, dynamic 1, external 2, ambiguous 3, resolved 4).
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import type {
  DefinitionLookup,
  RefSite,
  Resolution,
  ResolutionReason,
  ResolutionStatus,
  Resolver,
  ResolverCapabilities,
  ResolverWorkspace,
} from '../src/contract';
import {
  FixtureResolver,
  type FixtureAnswer,
  type FixtureOptions,
  type FixtureRow,
} from './fixture-resolver';

export type MakeChain = (links: readonly Resolver[]) => Resolver;

export interface ChainCase {
  readonly id: string;
  readonly text: string;
  readonly run: (make: MakeChain) => Promise<readonly string[]>;
}

export function wsPath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

export const FILE = wsPath('m.py');
const DEF_FILE = wsPath('d.py');

/** A call site of m.py on its own row, so every site has a distinct position. */
export function callSite(id: string, row: number): RefSite {
  return {
    id,
    nodeId: `file:m.py:CALL:$root:${String(row)}`,
    filePath: FILE,
    kind: 'call',
    position: { row, column: 4 },
    nameParts: [id],
  };
}

/** An answer of this status; resolved and ambiguous carry a definition, as the contract requires. */
export function ans(status: ResolutionStatus, reason?: ResolutionReason): FixtureAnswer {
  const why = reason === undefined ? {} : { reason };
  if (status === 'resolved' || status === 'ambiguous') {
    const row = status === 'resolved' ? 7 : 8;
    const confidence = status === 'resolved' ? 1 : 0.5;
    return {
      status,
      definition: { filePath: DEF_FILE, position: { row, column: 4 } },
      confidence,
      ...why,
    };
  }
  return { status, confidence: status === 'external' ? 1 : 0, ...why };
}

export function at(site: RefSite, answer: FixtureAnswer): FixtureRow {
  const { row, column } = site.position;
  return { kind: site.kind, from: site.filePath, row, column, answer };
}

export function link(
  id: string,
  rows: readonly FixtureRow[],
  options: FixtureOptions = {},
): FixtureResolver {
  return new FixtureResolver(rows, { ...options, id });
}

export function caps(
  host: ResolverCapabilities['host'],
  kinds: ResolverCapabilities['kinds'],
): FixtureOptions {
  return { capabilities: { host, kinds } };
}

export const NO_DEFINITIONS: DefinitionLookup = {
  symbolAt: () => undefined,
  symbolNamed: () => undefined,
  hasSymbol: () => false,
  isIndexed: () => false,
};

export const WORKSPACE: ResolverWorkspace = { rootPath: '/ws', definitions: NO_DEFINITIONS };

const A = callSite('a', 0);
const B = callSite('b', 1);
const C = callSite('c', 2);
const D = callSite('d', 3);

/** `refId status resolvedBy reason`, with the chain's own id written `<chain>`. */
function summary(chain: Resolver, r: Resolution): string {
  const by = r.resolvedBy === chain.id ? '<chain>' : r.resolvedBy;
  return `${r.refId} ${r.status} ${by} ${r.reason ?? '-'}`;
}

async function answers(
  make: MakeChain,
  links: readonly Resolver[],
  refs: readonly RefSite[],
): Promise<readonly string[]> {
  const chain = make(links);
  await chain.open(WORKSPACE);
  const { resolutions } = await chain.resolve(FILE, refs);
  return resolutions.map((r) => summary(chain, r));
}

function differ(id: string, what: string, expected: unknown, got: unknown): readonly string[] {
  const e = JSON.stringify(expected);
  const g = JSON.stringify(got);
  return e === g ? [] : [`${id} ${what}: expected ${e}, got ${g}`];
}

function asked(f: FixtureResolver): readonly (readonly string[])[] {
  return f.calls.map((c) => c.refIds);
}

function throwsParity(id: string, make: MakeChain, links: readonly Resolver[]): readonly string[] {
  try {
    make(links);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith('capability-parity:') ? [] : [`${id}: threw ${message}`];
  }
  return [`${id}: constructed [${links.map((l) => l.id).join(', ')}] without capability-parity`];
}

function constructs(id: string, make: MakeChain, links: readonly Resolver[]): readonly string[] {
  try {
    make(links);
    return [];
  } catch (error) {
    return [`${id}: threw ${error instanceof Error ? error.message : String(error)}`];
  }
}

const HOST = 'host-accelerator';

export const CHAIN_CASES: readonly ChainCase[] = [
  {
    id: 'INV-1',
    text: 'one answer per ref, in ref order, whatever a link drops, reorders, repeats or invents',
    async run(make) {
      const extra: Resolution = {
        refId: 'zz',
        status: 'resolved',
        resolvedBy: 'l1',
        confidence: 1,
      };
      const early: Resolution = {
        refId: 'a',
        status: 'unresolved',
        resolvedBy: 'l1',
        confidence: 0,
      };
      const l1 = link(
        'l1',
        [at(A, ans('resolved')), at(B, ans('unresolved')), at(C, ans('dynamic'))],
        {
          mangle: ([a, , c]) => (a && c ? [extra, c, early, a] : []),
        },
      );
      const l2 = link('l2', [at(B, ans('ambiguous')), at(C, ans('resolved'))], {
        mangle: (rs) => rs.filter((r) => r.refId !== 'd'),
      });
      const got = await answers(make, [l1, l2], [A, B, C, D]);
      return [
        ...differ(
          'INV-1',
          'answers',
          [
            'a resolved l1 -',
            'b ambiguous l2 -',
            'c resolved l2 -',
            'd unresolved <chain> no-resolver',
          ],
          got,
        ),
        ...differ('INV-1', 'l2 asked', [['b', 'c', 'd']], asked(l2)),
      ];
    },
  },
  {
    id: 'INV-4a',
    text: 'a host-accelerator kind no headless link declares throws capability-parity',
    run: async (make) =>
      throwsParity('INV-4a', make, [
        link('host', [], caps(HOST, ['call'])),
        link('py', [], caps('headless', ['import'])),
      ]),
  },
  {
    id: 'INV-4b',
    text: 'every kind of every host link needs a headless declarer; a host link never counts',
    run: async (make) =>
      throwsParity('INV-4b', make, [
        link('host1', [], caps(HOST, ['call', 'receiver-type'])),
        link('host2', [], caps(HOST, ['receiver-type'])),
        link('py', [], caps('headless', ['call'])),
      ]),
  },
  {
    id: 'INV-4c',
    text: 'parity holds whatever the headless link position, and a host link declaring nothing needs none',
    run: async (make) => [
      ...constructs('INV-4c', make, [
        link('py', [], caps('headless', ['call', 'receiver-type'])),
        link('host', [], caps(HOST, ['receiver-type', 'call'])),
      ]),
      ...constructs('INV-4c', make, [
        link('host', [], caps(HOST, ['call'])),
        link('py', [], caps('headless', ['import', 'call'])),
      ]),
      ...constructs('INV-4c', make, [link('host', [], caps(HOST, []))]),
    ],
  },
  {
    id: 'INV-9a',
    text: 'resolved, ambiguous and external stop a site: no later link is asked',
    async run(make) {
      const l1 = link('l1', [
        at(A, ans('resolved')),
        at(B, ans('ambiguous')),
        at(C, ans('external', 'builtin')),
      ]);
      const l2 = link('l2', [
        at(A, ans('unresolved')),
        at(B, ans('resolved')),
        at(C, ans('resolved')),
      ]);
      const got = await answers(make, [l1, l2], [A, B, C]);
      return [
        ...differ(
          'INV-9a',
          'answers',
          ['a resolved l1 -', 'b ambiguous l1 -', 'c external l1 builtin'],
          got,
        ),
        ...differ('INV-9a', 'l2 asked', [], asked(l2)),
      ];
    },
  },
  {
    id: 'INV-9b',
    text: 'unresolved and dynamic fall through to the next link',
    async run(make) {
      const l1 = link('l1', [at(A, ans('unresolved', 'no-definition')), at(B, ans('dynamic'))]);
      const l2 = link('l2', [at(A, ans('resolved')), at(B, ans('external', 'builtin'))]);
      const got = await answers(make, [l1, l2], [A, B]);
      return [
        ...differ('INV-9b', 'answers', ['a resolved l2 -', 'b external l2 builtin'], got),
        ...differ('INV-9b', 'l2 asked', [['a', 'b']], asked(l2)),
      ];
    },
  },
  {
    id: 'INV-9c',
    text: 'among equal-rank open answers the last wins, so an exhausted chain still says why',
    async run(make) {
      const l1 = link('l1', [at(A, ans('unresolved', 'no-definition')), at(B, ans('dynamic'))]);
      const l2 = link('l2', [at(A, ans('unresolved', 'module-not-found')), at(B, ans('dynamic'))]);
      const l3 = link('l3', [at(A, ans('unresolved', 'name-not-exported')), at(B, ans('dynamic'))]);
      const got = await answers(make, [l1, l2, l3], [A, B]);
      return differ(
        'INV-9c',
        'answers',
        ['a unresolved l3 name-not-exported', 'b dynamic l3 -'],
        got,
      );
    },
  },
  {
    id: 'INV-10a',
    text: 'a weaker link may upgrade: unresolved -> dynamic -> resolved, dynamic -> ambiguous',
    async run(make) {
      const l1 = link('l1', [at(A, ans('unresolved', 'no-definition')), at(B, ans('dynamic'))]);
      const l2 = link('l2', [at(A, ans('dynamic')), at(B, ans('ambiguous'))]);
      const l3 = link('l3', [at(A, ans('resolved')), at(B, ans('resolved'))]);
      const got = await answers(make, [l1, l2, l3], [A, B]);
      return [
        ...differ('INV-10a', 'answers', ['a resolved l3 -', 'b ambiguous l2 -'], got),
        ...differ('INV-10a', 'l3 asked', [['a']], asked(l3)),
      ];
    },
  },
  {
    id: 'INV-10b',
    text: 'a link that drops an open site lowers nothing: the kept answer stands',
    async run(make) {
      const l1 = link('l1', [at(A, ans('dynamic'))]);
      const l2 = link('l2', [], { mangle: () => [] });
      const got = await answers(make, [l1, l2], [A]);
      return [
        ...differ('INV-10b', 'answers', ['a dynamic l1 -'], got),
        ...differ('INV-10b', 'l2 asked', [['a']], asked(l2)),
      ];
    },
  },
  {
    id: 'INV-10c',
    text: 'no downgrade: dynamic is never lowered to unresolved by later links',
    async run(make) {
      const l1 = link('l1', [at(A, ans('dynamic'))]);
      const l2 = link('l2', [at(A, ans('unresolved', 'no-definition'))]);
      const l3 = link('l3', [at(A, ans('unresolved', 'timeout'))]);
      const got = await answers(make, [l1, l2, l3], [A]);
      return [
        ...differ('INV-10c', 'answers', ['a dynamic l1 -'], got),
        ...differ('INV-10c', 'later links asked', [[['a']], [['a']]], [asked(l2), asked(l3)]),
      ];
    },
  },
];

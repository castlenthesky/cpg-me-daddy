// contracts-agree (U1.3.2): compile-time agreement between the seam contracts. Each `@ts-expect-error`
// is its own anti-vacuity proof: if the line stops being an error, tsc reports the directive as unused.
// Pairs that land later with their second side: GraphDelta model<->sink (U2a), NormalizedChange
// watch<->cli (U4), CheckResult cli<->ext (U3), RefSite extract<->resolve (U6a).
import { assertType, describe, expectTypeOf, it } from 'vitest';
import type {
  AbsolutePath,
  EdgeResolution,
  EVAL_TYPE_RELATION,
  GraphDelta,
  NodeLocation,
  RESOLUTION_STATUS,
  WorkspacePath,
} from '@cpg/model';
import type {
  DefinitionLookup,
  DefinitionSite,
  ExtractedFileSet,
  RefKind,
  RefSite,
  ResolveDiagnostics,
  Resolution,
  ResolutionReason,
  ResolveBatch,
  ResolveContext,
  Resolver,
  ResolverStatus,
  ResolverWorkspace,
  ExtractedFileRefs,
} from '@cpg/resolve';
import type { ChangeBatch, NormalizedChange, RawWatchEvent, WatchBackend } from '@cpg/watch';

declare const resolution: Resolution;
declare const edgeResolution: EdgeResolution;
declare const change: NormalizedChange;
declare const abs: AbsolutePath;
declare const wp: WorkspacePath;
declare const projected: Pick<Resolution, 'status' | 'resolvedBy' | 'confidence' | 'reason'>;

describe('model <-> resolve', () => {
  it('Resolution.status is exactly model RESOLUTION_STATUS (SEAM-4)', () => {
    expectTypeOf<Resolution['status']>().toEqualTypeOf<(typeof RESOLUTION_STATUS)[number]>();
    // @ts-expect-error a misspelt status is not in the shared vocabulary
    assertType<Resolution['status']>('resolvd');
  });

  it('Resolution projects onto EdgeResolution, never the reverse (SEAM-5)', () => {
    assertType<EdgeResolution>(projected);
    // @ts-expect-error the transport is deliberately looser: a free-form string status is not a ResolutionStatus
    assertType<Pick<Resolution, 'status'>>(edgeResolution);
  });

  it("'receiver-type' (EVAL_TYPE_RELATION) is a RefKind (SEAM-8)", () => {
    expectTypeOf<(typeof EVAL_TYPE_RELATION)[number]>().toExtend<RefKind>();
  });
});

describe('WorkspacePath on every resolve and watch path (SEAM-3)', () => {
  it('resolve paths are WorkspacePath', () => {
    expectTypeOf<RefSite['filePath']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<DefinitionSite['filePath']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<
      NonNullable<NonNullable<Resolution['target']>['filePath']>
    >().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<ResolveDiagnostics['filePath']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<Parameters<Resolver['resolve']>[0]>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<Parameters<DefinitionLookup['symbolAt']>[0]>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<Parameters<DefinitionLookup['symbolNamed']>[0]>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<Parameters<DefinitionLookup['isIndexed']>[0]>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<Parameters<Resolver['fileChanged']>[0]>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<ExtractedFileRefs['path']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<
      ExtractedFileSet['files'] extends ReadonlyMap<infer K, unknown> ? K : never
    >().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<ExtractedFileSet['refSites']>().toEqualTypeOf<readonly RefSite[]>();
  });

  it('watch paths are WorkspacePath; raw events carry absolute strings', () => {
    expectTypeOf<NormalizedChange['path']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<NonNullable<NormalizedChange['fromPath']>>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<RawWatchEvent['path']>().toEqualTypeOf<string>();
    expectTypeOf<RawWatchEvent['path']>().not.toEqualTypeOf<WorkspacePath>();
    // D10: roots and raw paths stay plain string
    expectTypeOf<NonNullable<RawWatchEvent['fromPath']>>().toEqualTypeOf<string>();
    expectTypeOf<ResolverWorkspace['rootPath']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<WatchBackend['subscribe']>[0]>().toEqualTypeOf<string>();
  });

  it('rejects a plain string or an AbsolutePath where a WorkspacePath is required', () => {
    // @ts-expect-error a plain string is not a WorkspacePath
    assertType<DefinitionSite['filePath']>('src/a.ts');
    // @ts-expect-error an AbsolutePath is not a WorkspacePath
    assertType<NormalizedChange['path']>(abs);
  });
});

describe('watch -> resolve -> model flow', () => {
  it('a change path feeds Resolver.fileChanged (SEAM-6)', () => {
    expectTypeOf<NormalizedChange['path']>().toEqualTypeOf<
      Parameters<Resolver['fileChanged']>[0]
    >();
    expectTypeOf<DefinitionSite['filePath']>().toEqualTypeOf<NodeLocation['filePath']>();
  });

  it('a minted revision_id is carried by GraphDelta (SEAM-7)', () => {
    expectTypeOf<NonNullable<NormalizedChange['revision_id']>>().toExtend<
      GraphDelta['revision_id']
    >();
  });
});

describe('C-RESOLVE amendments (U1.3.1)', () => {
  it('resolve is async and returns a ResolveBatch, with an optional ResolveContext', () => {
    expectTypeOf<ReturnType<Resolver['resolve']>>().toEqualTypeOf<Promise<ResolveBatch>>();
    expectTypeOf<Parameters<Resolver['resolve']>[2]>().toEqualTypeOf<ResolveContext | undefined>();
  });

  it('status() returns ResolverStatus and capabilities is declared', () => {
    expectTypeOf<ReturnType<Resolver['status']>>().toEqualTypeOf<ResolverStatus>();
    expectTypeOf<Resolver['capabilities']['host']>().toEqualTypeOf<
      'headless' | 'host-accelerator'
    >();
  });

  it('carries the five new reason codes', () => {
    expectTypeOf<
      Extract<
        ResolutionReason,
        | 'timeout'
        | 'cancelled'
        | 'backend-unavailable'
        | 'unsupported-language'
        | 'unsupported-kind'
      >
    >().toEqualTypeOf<
      'timeout' | 'cancelled' | 'backend-unavailable' | 'unsupported-language' | 'unsupported-kind'
    >();
  });
});

describe('ExtractedFileSet is unforgeable (D7)', () => {
  it('cannot be built from an object literal before U6a seals it', () => {
    const literal = { files: new Map<WorkspacePath, ExtractedFileRefs>(), refSites: [] };
    // the SEALED symbol key is not exported, so no literal can satisfy it
    expectTypeOf(literal).not.toExtend<ExtractedFileSet>();
    // @ts-expect-error the same, as a direct assignment
    assertType<ExtractedFileSet>(literal);
  });
});

describe('seam types are readonly on every field (SEAM-9)', () => {
  it('Resolution, NormalizedChange, RefSite, ResolveBatch and ChangeBatch have no mutable field', () => {
    // @ts-expect-error Resolution is readonly
    resolution.status = 'resolved';
    // @ts-expect-error NormalizedChange is readonly
    change.path = wp;
    expectTypeOf<Resolution>().toEqualTypeOf<Readonly<Resolution>>();
    expectTypeOf<NormalizedChange>().toEqualTypeOf<Readonly<NormalizedChange>>();
    expectTypeOf<RefSite>().toEqualTypeOf<Readonly<RefSite>>();
    expectTypeOf<ResolveBatch>().toEqualTypeOf<Readonly<ResolveBatch>>();
    expectTypeOf<ChangeBatch>().toEqualTypeOf<Readonly<ChangeBatch>>();
    // shallow Readonly<T> misses arrays and nested objects, so pin those too
    expectTypeOf<ResolveBatch['resolutions']>().toEqualTypeOf<readonly Resolution[]>();
    expectTypeOf<ChangeBatch['changes']>().toEqualTypeOf<readonly NormalizedChange[]>();
    expectTypeOf<ChangeBatch['clock']>().toEqualTypeOf<Readonly<ChangeBatch['clock']>>();
    expectTypeOf<NonNullable<Resolution['target']>>().toEqualTypeOf<
      Readonly<NonNullable<Resolution['target']>>
    >();
  });
});

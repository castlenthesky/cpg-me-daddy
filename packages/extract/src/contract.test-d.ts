// C-EXTRACT's compile-time invariants (class C in 05-contracts.yaml), and the sealed set (controller
// decision 88). Expected types are the contract's text. Each `@ts-expect-error` is its own anti-vacuity
// proof: if the line stops being an error, tsc reports the directive as unused.
import { assertType, describe, expectTypeOf, it } from 'vitest';
import type {
  CALL_KIND,
  EdgeType,
  METHOD_KIND,
  NodeLabel,
  SourceRange,
  SymbolDescriptor,
  TYPE_DECL_KIND,
  WorkspacePath,
} from '@cpg/model';
import type {
  BuiltinTarget,
  CallInfo,
  ContainerKind,
  CoverageManifest,
  DeclarationInfo,
  Disposition,
  EdgeElement,
  EndpointRef,
  ExtractedFile,
  ExtractedFileSet,
  ExpressionVerdict,
  ExtractErrorCode,
  ExtractOutcome,
  ExtractRequest,
  Extractor,
  FileOwnedLabel,
  LanguageAdapter,
  NodeElement,
  PropertyValue,
  RefKind,
  RefSite,
  ResolutionReason,
  ResolvePassEntry,
  SealExtractedFiles,
  SealOutcome,
  SymbolElement,
  SyntaxNode,
  Tier,
} from './index';

declare const node: NodeElement;
declare const file: ExtractedFile;

describe('I8: no SYMBOL/FILE/DIRECTORY/COMMUNITY/TAG/META_DATA in nodes', () => {
  it('FileOwnedLabel is exactly the eight file-owned labels', () => {
    expectTypeOf<FileOwnedLabel>().toEqualTypeOf<
      'MODULE' | 'TYPE_DECL' | 'METHOD' | 'PARAM' | 'MEMBER' | 'CALL' | 'IMPORT' | 'UNKNOWN'
    >();
    expectTypeOf<NodeElement['label']>().toEqualTypeOf<FileOwnedLabel>();
  });

  it('a node element naming another label does not compile', () => {
    // @ts-expect-error SYMBOL lives in its own channel
    assertType<NodeElement['label']>('SYMBOL');
    // @ts-expect-error FILE is the filesystem tier's
    assertType<NodeElement['label']>('FILE');
  });

  it('an fqn endpoint is a SYMBOL, an id endpoint a file-owned node', () => {
    // @ts-expect-error by:'fqn' names only a SYMBOL
    assertType<EndpointRef>({ by: 'fqn', label: 'METHOD', key: 'x' });
    // @ts-expect-error by:'id' never names a SYMBOL
    assertType<EndpointRef>({ by: 'id', label: 'SYMBOL', key: 'x' });
    assertType<EndpointRef>({ by: 'fqn', label: 'SYMBOL', key: '`a.py`/f().' });
  });
});

describe('I13: the CoverageManifest is total over 14 labels and 15 edge types', () => {
  it('its records are keyed by every label and every edge type', () => {
    expectTypeOf<keyof CoverageManifest['nodes']>().toEqualTypeOf<NodeLabel>();
    expectTypeOf<keyof CoverageManifest['edges']>().toEqualTypeOf<EdgeType>();
  });

  it('a manifest that leaves one out does not compile', () => {
    expectTypeOf<Partial<Record<NodeLabel, Disposition>>>().not.toExtend<
      CoverageManifest['nodes']
    >();
    expectTypeOf<Partial<Record<EdgeType, Disposition>>>().not.toExtend<
      CoverageManifest['edges']
    >();
  });

  it('a disposition is one of three states, with the contract owners', () => {
    expectTypeOf<Disposition['state']>().toEqualTypeOf<
      'emits' | 'not-mine' | 'declared-not-emitted'
    >();
    expectTypeOf<Extract<Disposition, { state: 'not-mine' }>['owner']>().toEqualTypeOf<
      'filesystem-tier' | 'resolve-pass' | 'analysis-pass' | 'meta'
    >();
    // @ts-expect-error a declared-not-emitted row needs its tracking id
    assertType<Disposition>({ state: 'declared-not-emitted', reason: 'gap' });
  });
});

describe('the extractor and its outcomes', () => {
  it('extract is synchronous and returns an outcome (I4: never throws, failures are outcomes)', () => {
    expectTypeOf<ReturnType<Extractor['extract']>>().toEqualTypeOf<ExtractOutcome>();
    expectTypeOf<Parameters<Extractor['extract']>[0]>().toEqualTypeOf<ExtractRequest>();
    expectTypeOf<ExtractOutcome['kind']>().toEqualTypeOf<'ok' | 'truncated' | 'failed'>();
  });

  it('carries the seven failure codes', () => {
    expectTypeOf<ExtractErrorCode>().toEqualTypeOf<
      | 'root-type-mismatch'
      | 'grammar-unsupported'
      | 'tier-disabled'
      | 'budget-invalid'
      | 'path-not-relative'
      | 'adapter-missing'
      | 'internal'
    >();
    expectTypeOf<
      Extract<ExtractOutcome, { kind: 'failed' }>['error']['code']
    >().toEqualTypeOf<ExtractErrorCode>();
  });

  it('paths are WorkspacePath, ranges SourceRange, properties the model property types', () => {
    expectTypeOf<ExtractRequest['path']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<NodeElement['file']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<ExtractedFile['path']>().toEqualTypeOf<WorkspacePath>();
    expectTypeOf<NodeElement['range']>().toEqualTypeOf<SourceRange>();
    expectTypeOf<PropertyValue>().toEqualTypeOf<string | number | boolean | readonly string[]>();
    expectTypeOf<SymbolElement['origin']>().toEqualTypeOf<'local' | 'external' | 'builtin'>();
  });

  it('the expression tier is opt-in and the budget has no required limit (I16, I17)', () => {
    expectTypeOf<NonNullable<ExtractRequest['tiers']>['expression']>().toEqualTypeOf<
      boolean | undefined
    >();
    assertType<ExtractRequest['budget']>({});
    assertType<ExtractRequest['budget']>(undefined);
    assertType<ExtractRequest['tiers']>({});
    assertType<ExtractRequest['tiers']>(undefined);
  });

  it('elements carry their tier, endpoints and the file-level digests', () => {
    expectTypeOf<NodeElement['tier']>().toEqualTypeOf<Tier>();
    expectTypeOf<Tier>().toEqualTypeOf<'structural' | 'expression'>();
    expectTypeOf<ExtractedFile['edges']>().toEqualTypeOf<readonly EdgeElement[]>();
    expectTypeOf<EdgeElement['type']>().toEqualTypeOf<EdgeType>();
    expectTypeOf<EdgeElement['from']>().toEqualTypeOf<EndpointRef>();
    expectTypeOf<
      Pick<ExtractedFile, 'revision_id' | 'elementDigest' | 'interfaceHash'>
    >().toEqualTypeOf<{
      readonly revision_id: string;
      readonly elementDigest: string;
      readonly interfaceHash: string;
    }>();
    expectTypeOf<keyof ExtractedFile['stats']>().toEqualTypeOf<
      'astNodesVisited' | 'structuralNodes' | 'expressionNodes' | 'lineCount'
    >();
  });

  it('a budget hit is truncated with a report (I17), and coverage is per grammar', () => {
    expectTypeOf<Extract<ExtractOutcome, { kind: 'truncated' }>['truncation']>().toEqualTypeOf<{
      readonly limit: 'maxNodes' | 'maxDepth';
      readonly limitValue: number;
      readonly droppedAtNodeType: string;
      readonly droppedRange: SourceRange;
    }>();
    expectTypeOf<
      Extract<ExtractOutcome, { kind: 'truncated' }>['file']
    >().toEqualTypeOf<ExtractedFile>();
    expectTypeOf<Extractor['coverage']>().toEqualTypeOf<(grammarId: string) => CoverageManifest>();
  });

  it('every element is readonly', () => {
    // @ts-expect-error NodeElement is readonly
    node.id = 'x';
    // @ts-expect-error ExtractedFile.nodes is a readonly array
    file.nodes.push(node);
    expectTypeOf<ExtractedFile['refSites']>().toEqualTypeOf<readonly RefSite[]>();
    expectTypeOf<ExtractedFile['symbols']>().toEqualTypeOf<readonly SymbolElement[]>();
  });
});

describe('the language adapter', () => {
  it('has the contract members, the expression half optional', () => {
    expectTypeOf<LanguageAdapter['moduleName']>().toEqualTypeOf<(path: WorkspacePath) => string>();
    expectTypeOf<LanguageAdapter['coverage']>().toEqualTypeOf<() => CoverageManifest>();
    expectTypeOf<LanguageAdapter['classifyExpression']>().toEqualTypeOf<
      ((node: SyntaxNode) => ExpressionVerdict | undefined) | undefined
    >();
    expectTypeOf<LanguageAdapter['localBindings']>().toEqualTypeOf<
      ((regionRoot: SyntaxNode) => readonly string[] | undefined) | undefined
    >();
    // stop-list 196: what stands in for a compound statement; decision 117: a class header's ERRORs
    expectTypeOf<LanguageAdapter['compoundChildren']>().toEqualTypeOf<
      ((node: SyntaxNode) => readonly SyntaxNode[] | undefined) | undefined
    >();
    expectTypeOf<
      Extract<DeclarationInfo, { declares: 'TYPE_DECL' }>['headerErrors']
    >().toEqualTypeOf<readonly SyntaxNode[] | undefined>();
    expectTypeOf<Exclude<ExpressionVerdict, CallInfo>>().toEqualTypeOf<
      | { readonly emits: 'none'; readonly descend: 'transparent' }
      | { readonly emits: 'none'; readonly descend: 'stop' }
    >();
  });

  it('classifies the direct children of a MODULE or a TYPE_DECL into the three declarations', () => {
    expectTypeOf<Parameters<LanguageAdapter['classify']>[1]>().toEqualTypeOf<ContainerKind>();
    expectTypeOf<ContainerKind>().toEqualTypeOf<'MODULE' | 'TYPE_DECL'>();
    expectTypeOf<DeclarationInfo['declares']>().toEqualTypeOf<'TYPE_DECL' | 'METHOD' | 'MEMBER'>();
  });

  it("uses the schema's own kind enums", () => {
    expectTypeOf<Extract<DeclarationInfo, { declares: 'TYPE_DECL' }>['kind']>().toEqualTypeOf<
      (typeof TYPE_DECL_KIND)[number]
    >();
    expectTypeOf<Extract<DeclarationInfo, { declares: 'METHOD' }>['kind']>().toEqualTypeOf<
      (typeof METHOD_KIND)[number]
    >();
    expectTypeOf<CallInfo['kind']>().toEqualTypeOf<(typeof CALL_KIND)[number]>();
  });

  it("a call's builtin is the external fqn's parts (U6a.2-4a, I11)", () => {
    expectTypeOf<CallInfo['builtin']>().toEqualTypeOf<BuiltinTarget | undefined>();
    expectTypeOf<BuiltinTarget>().toEqualTypeOf<{
      readonly scheme: string;
      readonly package: string;
      readonly descriptors: readonly SymbolDescriptor[];
    }>();
  });
});

describe('ref sites speak the shared vocabulary', () => {
  it('RefKind and ResolutionReason are the 05-contracts shared_vocabulary lists', () => {
    expectTypeOf<RefKind>().toEqualTypeOf<'call' | 'import' | 'receiver' | 'receiver-type'>();
    expectTypeOf<ResolutionReason>().toEqualTypeOf<
      | 'no-definition'
      | 'receiver-unknown'
      | 'name-not-exported'
      | 'module-not-found'
      | 'reexport-depth'
      | 'module-binding'
      | 'wildcard'
      | 'truncated-subgraph'
      | 'provider-error'
      | 'builtin'
      | 'self'
      | 'not-warm'
      | 'no-resolver'
      | 'timeout'
      | 'cancelled'
      | 'backend-unavailable'
      | 'unsupported-language'
      | 'unsupported-kind'
    >();
  });
});

describe('the sealed set (L-44; moved from @cpg/resolve, decision 88)', () => {
  it('cannot be built from an object literal: only sealExtractedFiles mints one', () => {
    const literal = { files: new Map<WorkspacePath, ExtractedFile>(), refSites: [] };
    expectTypeOf(literal).not.toExtend<ExtractedFileSet>();
    // @ts-expect-error the SEALED key is not exported, so no literal satisfies it
    assertType<ExtractedFileSet>(literal);
  });

  it('holds whole ExtractedFiles keyed by WorkspacePath', () => {
    expectTypeOf<
      ExtractedFileSet['files'] extends ReadonlyMap<infer K, infer V> ? [K, V] : never
    >().toEqualTypeOf<[WorkspacePath, ExtractedFile]>();
    expectTypeOf<ExtractedFileSet['refSites']>().toEqualTypeOf<ExtractedFile['refSites']>();
  });

  it('a resolve pass takes only a sealed set: "resolve while still walking" does not typecheck', () => {
    expectTypeOf<Parameters<ResolvePassEntry>[0]>().toEqualTypeOf<ExtractedFileSet>();
    expectTypeOf<readonly ExtractedFile[]>().not.toExtend<Parameters<ResolvePassEntry>[0]>();
  });

  it('sealing answers a set or the duplicate paths', () => {
    expectTypeOf<ReturnType<SealExtractedFiles>>().toEqualTypeOf<SealOutcome>();
    expectTypeOf<Parameters<SealExtractedFiles>[0]>().toEqualTypeOf<Iterable<ExtractedFile>>();
    expectTypeOf<Extract<SealOutcome, { kind: 'failed' }>['duplicatePaths']>().toEqualTypeOf<
      readonly string[]
    >();
  });
});

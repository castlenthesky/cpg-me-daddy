// Test double, ported from archive 21754b4:src/dev/fakeResolver.ts: a Resolver backed by a written
// table instead of a language server. It answers with what a row says, at the row's (kind, file,
// position), so everything downstream of a resolver runs for real against a known input. Paths are
// WorkspacePaths (DQ-02), so the archive's join(rootPath, ...) is gone. It imports nothing at runtime
// from src/, so a bug there can never make the double agree with it.
import type { WorkspacePath } from '@cpg/model';
import type {
  RefKind,
  RefSite,
  Resolution,
  ResolveBatch,
  ResolveContext,
  ResolveDiagnostics,
  Resolver,
  ResolverCapabilities,
  ResolverStatus,
  ResolverWorkspace,
} from '../src/contract';

/** What a row answers: a Resolution minus `refId` and `resolvedBy`, which the fixture fills. */
export type FixtureAnswer = Omit<Resolution, 'refId' | 'resolvedBy'>;

/** One row: the site it answers (kind defaults to `call`, a receiver and its type share a position). */
export interface FixtureRow {
  readonly kind?: RefKind;
  readonly from: WorkspacePath;
  readonly row: number;
  readonly column: number;
  readonly answer: FixtureAnswer;
}

export interface FixtureOptions {
  readonly id?: string;
  readonly precision?: Resolver['precision'];
  readonly capabilities?: Partial<ResolverCapabilities>;
  readonly diagnostics?: Partial<Omit<ResolveDiagnostics, 'resolverId' | 'filePath' | 'siteCount'>>;
  readonly status?: Partial<Omit<ResolverStatus, 'resolverId'>>;
  /** Rewrites the answers before they are returned: a link that drops, reorders or invents. */
  readonly mangle?: (answers: readonly Resolution[]) => readonly Resolution[];
  /** Runs inside `resolve` before it answers (a token cancelled mid-chain). */
  readonly during?: () => void;
  /** Shared across fixtures to record lifecycle order: `<id> open`, `<id> opened`, ... */
  readonly log?: string[];
}

export interface FixtureCall {
  readonly filePath: WorkspacePath;
  readonly refIds: readonly string[];
  readonly ctx: ResolveContext | undefined;
}

const ALL_KINDS: readonly RefKind[] = ['call', 'import', 'receiver', 'receiver-type'];

function rowKey(kind: RefKind, file: string, row: number, column: number): string {
  return `${kind}\0${file}\0${String(row)}:${String(column)}`;
}

/** Unlisted sites come back `unresolved` / `no-definition`, one per ref in order. */
export class FixtureResolver implements Resolver {
  readonly id: string;
  readonly precision: Resolver['precision'];
  readonly capabilities: ResolverCapabilities;
  readonly calls: FixtureCall[] = [];
  /** The workspace each `open` received. */
  readonly workspaces: ResolverWorkspace[] = [];
  private readonly byKey = new Map<string, FixtureRow>();
  private readonly matched = new Set<FixtureRow>();

  constructor(
    private readonly rows: readonly FixtureRow[],
    private readonly options: FixtureOptions = {},
  ) {
    this.id = options.id ?? 'fixture';
    this.precision = options.precision ?? 'index';
    this.capabilities = {
      extensions: ['.py'],
      kinds: ALL_KINDS,
      host: 'headless',
      maxConcurrentFiles: 1,
      ...options.capabilities,
    };
    for (const r of rows) this.byKey.set(rowKey(r.kind ?? 'call', r.from, r.row, r.column), r);
  }

  private record(event: string): void {
    this.options.log?.push(`${this.id} ${event}`);
  }

  async open(workspace: ResolverWorkspace): Promise<void> {
    this.record('open');
    this.workspaces.push(workspace);
    await Promise.resolve();
    this.record('opened');
  }

  async fileChanged(filePath: WorkspacePath, text: string | null): Promise<void> {
    this.record(`fileChanged ${filePath} ${text ?? 'null'}`);
    await Promise.resolve();
    this.record('fileChanged done');
  }

  async resolve(
    filePath: WorkspacePath,
    refs: readonly RefSite[],
    ctx?: ResolveContext,
  ): Promise<ResolveBatch> {
    this.calls.push({ filePath, refIds: refs.map((r) => r.id), ctx });
    await Promise.resolve();
    this.options.during?.();
    const answers = refs.map((ref): Resolution => {
      const key = rowKey(ref.kind, ref.filePath, ref.position.row, ref.position.column);
      const r = this.byKey.get(key);
      if (r === undefined) {
        return {
          refId: ref.id,
          status: 'unresolved',
          resolvedBy: this.id,
          confidence: 0,
          reason: 'no-definition',
        };
      }
      this.matched.add(r);
      return { ...r.answer, refId: ref.id, resolvedBy: this.id };
    });
    return {
      resolutions: this.options.mangle?.(answers) ?? answers,
      diagnostics: {
        resolverId: this.id,
        filePath,
        siteCount: refs.length,
        backend: 'ready',
        degraded: false,
        elapsedMs: 0,
        timedOutSites: 0,
        ...this.options.diagnostics,
      },
    };
  }

  status(): ResolverStatus {
    return { resolverId: this.id, state: 'ready', restarts: 0, ...this.options.status };
  }

  async close(): Promise<void> {
    this.record('close');
    await Promise.resolve();
    this.record('closed');
  }

  /** Rows no site ever matched: a table that drifted from its source is worse than no table. */
  unmatched(): readonly FixtureRow[] {
    return this.rows.filter((r) => !this.matched.has(r));
  }
}

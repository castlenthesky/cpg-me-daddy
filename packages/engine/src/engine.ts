// createEngine: the engine's one constructor. Only a front door (apps/*) calls it (03-architecture §2
// rule 3, check-deps rule engine-call-site); this package defines it and never calls it.

import type { ProcessHost, Resolver } from '@cpg/resolve';
import type { GraphSink } from '@cpg/sink';
import type { GraphStore } from '@cpg/store';
import type { CpgEngine } from './port';

export interface EngineConfig {
  /** identity.version: the front door's manifest version, never a literal (C-CLI I-13). */
  readonly version: string;
}

/** A durable store sink: MemoryStore now, FalkorStore at U5. */
export type EngineSink = GraphSink & GraphStore;

export interface EngineDeps {
  readonly sinks: readonly EngineSink[];
  /** SEAT: accepted and unused until the resolver chain (U6c). */
  readonly resolvers?: readonly Resolver[];
  /** SEAT: accepted and unused until the LSP driver (U8). */
  readonly processHost?: ProcessHost;
}

export function createEngine(_config: EngineConfig, _deps: EngineDeps): CpgEngine {
  // SEAT
  throw new Error('SEAT: createEngine');
}

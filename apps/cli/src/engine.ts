// The slice of C-CLI's CpgEngine port this skeleton consumes. The real port moves to @cpg/engine's
// public surface in U2a.2 (C-CLI Q1); until then the CLI owns this type and tests drive a fake.
// The CLI never constructs a store, parser or Cypher (I-2): it sees only this port.

export interface StoreTarget {
  readonly host: string;
  readonly port: number;
  readonly graph: string;
}

interface EngineSession {
  close(): Promise<void>;
}

export interface CpgEngine {
  readonly identity: { readonly name: string; readonly version: string };
  connect(target: StoreTarget, opts: { readOnly: boolean }): Promise<EngineSession>;
}

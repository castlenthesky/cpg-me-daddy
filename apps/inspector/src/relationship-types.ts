// SEAT (U2b.1 part 1, BMO-35): the relationship (edge-type) legend registry, ported from
// 21754b4:packages/graph-visualizer/src/relationshipTypes.ts. Not built yet: every export is a
// placeholder.

export interface RelationshipTypeDescriptor {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

const seat = (what: string): Error =>
  new Error(`SEAT: ${what} is not built yet (U2b.1 part 1, BMO-35)`);

// SEAT
export const RELATIONSHIP_TYPES: readonly RelationshipTypeDescriptor[] = [];

// SEAT
export const UNTYPED_RELATIONSHIP_KEY: string = '\u0000SEAT';

// SEAT
export const DEFAULT_RELATIONSHIP_COLOR: string = '';

// SEAT
export function relationshipKey(_type: string | undefined): string {
  throw seat('relationshipKey');
}

// SEAT
export function relationshipLabel(_key: string): string {
  throw seat('relationshipLabel');
}

// SEAT
export function relationshipColor(_key: string): string {
  throw seat('relationshipColor');
}

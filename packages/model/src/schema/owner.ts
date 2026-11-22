/**
 * `ownedBy(owner, props)`: declares a group of properties as written by one tier. Internal to the
 * schema module (not re-exported from `schema/index.ts`). Declaring ownership per group keeps
 * nodes.ts/edges.ts readable; FILE's two groups show ownership is per property, not per label.
 */
import type { PropertyOwner, PropertySpec } from './types';

/**
 * A property as written inline in nodes.ts/edges.ts: everything but `owner`, which `ownedBy` stamps.
 * `doc` is optional here only so the helper is generic; the `properties: readonly PropertySpec[]`
 * slot that receives the result still requires it.
 */
export type UnownedPropertySpec = Omit<PropertySpec, 'owner' | 'doc'> & {
  readonly doc?: string;
  readonly owner?: never;
};

// REAL: pure data plumbing (stamps `owner` onto each spec, alters nothing else). The overloads state
// the contract (specs in, complete PropertySpecs out); the implementation signature is the loose form.
export function ownedBy(
  owner: PropertyOwner,
  properties: readonly UnownedPropertySpec[],
): readonly PropertySpec[];
export function ownedBy(
  owner: PropertyOwner,
  properties: readonly UnownedPropertySpec[],
): readonly unknown[] {
  return properties.map((property) => ({ ...property, owner }));
}

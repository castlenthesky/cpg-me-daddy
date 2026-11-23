import { describe, expectTypeOf, it } from 'vitest';
import {
  isWorkspacePath,
  toAbsolutePath,
  toWorkspacePath,
  WORKSPACE_ROOT,
  type AbsolutePath,
  type PathSeparator,
  type WorkspacePath,
} from './index';

declare const abs: AbsolutePath;

describe('path brands (P-10)', () => {
  it('a plain string is not a WorkspacePath or AbsolutePath', () => {
    expectTypeOf<string>().not.toMatchTypeOf<WorkspacePath>();
    expectTypeOf<string>().not.toMatchTypeOf<AbsolutePath>();
    // @ts-expect-error a string literal is not a WorkspacePath
    const w: WorkspacePath = 'a';
    // @ts-expect-error a string literal is not an AbsolutePath
    const a: AbsolutePath = '/a';
    expectTypeOf(w).toEqualTypeOf<WorkspacePath>();
    expectTypeOf(a).toEqualTypeOf<AbsolutePath>();
  });

  it('the two brands are mutually unassignable', () => {
    expectTypeOf<WorkspacePath>().not.toMatchTypeOf<AbsolutePath>();
    expectTypeOf<AbsolutePath>().not.toMatchTypeOf<WorkspacePath>();
  });

  it('both brands are assignable to string', () => {
    expectTypeOf<WorkspacePath>().toMatchTypeOf<string>();
    expectTypeOf<AbsolutePath>().toMatchTypeOf<string>();
  });

  it('signatures', () => {
    expectTypeOf(toWorkspacePath).returns.toEqualTypeOf<WorkspacePath>();
    expectTypeOf(toWorkspacePath).parameters.toEqualTypeOf<
      [root: string, absolute: string, sep?: PathSeparator]
    >();
    expectTypeOf(toAbsolutePath).returns.toEqualTypeOf<AbsolutePath>();
    expectTypeOf(toAbsolutePath).parameters.toEqualTypeOf<
      [root: string, path: WorkspacePath, sep?: PathSeparator]
    >();
    expectTypeOf(WORKSPACE_ROOT).toEqualTypeOf<WorkspacePath>();
    expectTypeOf<PathSeparator>().toEqualTypeOf<'/' | '\\'>();
  });

  it('toAbsolutePath refuses a plain string or an AbsolutePath as its path', () => {
    // @ts-expect-error path must be a WorkspacePath
    toAbsolutePath('/ws', 'a');
    // @ts-expect-error path must be a WorkspacePath, not an AbsolutePath
    toAbsolutePath('/ws', abs);
    expectTypeOf(abs).toEqualTypeOf<AbsolutePath>();
  });

  it('isWorkspacePath narrows a string', () => {
    expectTypeOf(isWorkspacePath).guards.toEqualTypeOf<WorkspacePath>();
  });
});

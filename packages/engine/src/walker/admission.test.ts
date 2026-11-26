// The walker's admission rule as one predicate (U4.2.1, controller decision 61). Expected values come
// from glob.ts's dialect (`**`, dir-only trailing `/`, anchored leading `/`) and walker.ts's order:
// a symlink is never followed, a directory is refused by `exclude` only, a file by `exclude` or a
// missing `include`, then by size; an excluded directory is never entered.

import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { createAdmission, type AdmissionEntry, type AdmissionVerdict } from './admission';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}

const defaults = createAdmission({});
const MIB2 = 2 * 1024 * 1024;

describe('check: the verdict for one entry the walk reached', () => {
  it.each<[string, AdmissionEntry, number | undefined, AdmissionVerdict]>([
    ['src/a.ts', 'symlink', undefined, 'symlink'],
    ['node_modules', 'symlink', undefined, 'symlink'],
    ['src', 'directory', undefined, 'admitted'],
    ['node_modules', 'directory', undefined, 'excluded'],
    ['a/node_modules', 'directory', undefined, 'excluded'],
    ['dist', 'directory', undefined, 'excluded'],
    ['distribution', 'directory', undefined, 'admitted'],
    ['src', 'directory', 10 * MIB2, 'admitted'],
    ['src/a.ts', 'file', undefined, 'admitted'],
    ['node_modules/x.ts', 'file', undefined, 'excluded'],
    ['src/types.d.ts', 'file', undefined, 'excluded'],
    ['lib/app.min.js', 'file', undefined, 'excluded'],
    ['src/a.ts', 'file', MIB2, 'admitted'],
    ['src/a.ts', 'file', MIB2 + 1, 'too-large'],
    ['src/types.d.ts', 'file', MIB2 + 1, 'excluded'],
  ])('defaults: %s as %s (%s bytes) is %s', (path, entry, size, verdict) => {
    expect(defaults.check(wp(path), entry, size)).toBe(verdict);
  });

  it('include applies to files only, and a given exclude replaces the defaults', () => {
    const admission = createAdmission({ include: ['src/**'], exclude: ['*.log'] });
    const verdicts = [
      admission.check(wp('src/a.ts'), 'file'),
      admission.check(wp('lib/a.ts'), 'file'),
      admission.check(wp('lib'), 'directory'),
      admission.check(wp('src/debug.log'), 'file'),
      admission.check(wp('src/node_modules/x.ts'), 'file'),
      admission.check(wp('node_modules'), 'directory'),
    ];
    expect(verdicts).toEqual([
      'admitted',
      'excluded',
      'admitted',
      'excluded',
      'admitted',
      'admitted',
    ]);
  });

  it('maxFileSizeBytes is inclusive and never refuses a directory', () => {
    const admission = createAdmission({ maxFileSizeBytes: 10 });
    const verdicts = [
      admission.check(wp('a.ts'), 'file', 10),
      admission.check(wp('a.ts'), 'file', 11),
      admission.check(wp('a.ts'), 'file'),
      admission.check(wp('src'), 'directory', 4096),
    ];
    expect(verdicts).toEqual(['admitted', 'too-large', 'admitted', 'admitted']);
  });

  it('a dir-only pattern refuses the directory, not a file of that name, and not what is under it', () => {
    const admission = createAdmission({ exclude: ['build/'] });
    const verdicts = [
      admission.check(wp('build'), 'directory'),
      admission.check(wp('a/build'), 'directory'),
      admission.check(wp('build'), 'file'),
      admission.check(wp('build/out.ts'), 'file'),
    ];
    expect(verdicts).toEqual(['excluded', 'excluded', 'admitted', 'admitted']);
  });
});

describe('admits: check, plus an excluded directory is never entered', () => {
  it.each<[readonly string[], string, AdmissionEntry, number | undefined, boolean]>([
    [['build/'], 'build/out.ts', 'file', undefined, false],
    [['build/'], 'build/deep/out.ts', 'file', 3, false],
    [['build/'], 'build/deep', 'directory', undefined, false],
    [['build/'], 'src/build/out.ts', 'file', undefined, false],
    [['build/'], 'src/out.ts', 'file', undefined, true],
    [['/gen/'], 'gen/a.ts', 'file', undefined, false],
    [['/gen/'], 'src/gen/a.ts', 'file', undefined, true],
    [['build/'], 'build', 'file', undefined, true],
    [['build/'], 'src/a.ts', 'symlink', undefined, false],
    [['*.log'], 'src/a.log', 'file', undefined, false],
  ])('exclude %j: %s as %s (%s bytes) is %s', (exclude, path, entry, size, admitted) => {
    expect(createAdmission({ exclude }).admits(wp(path), entry, size)).toBe(admitted);
  });

  it('refuses what check refuses: too large, excluded by default, a symlink', () => {
    const admission = createAdmission({ maxFileSizeBytes: 4 });
    const verdicts = [
      admission.admits(wp('src/a.ts'), 'file', 4),
      admission.admits(wp('src/a.ts'), 'file', 5),
      admission.admits(wp('node_modules/pkg/index.js'), 'file'),
      admission.admits(wp('src/node_modules/pkg'), 'directory'),
      admission.admits(wp('src/link.ts'), 'symlink'),
      admission.admits(wp('src'), 'directory', 4096),
    ];
    expect(verdicts).toEqual([true, false, false, false, false, true]);
  });
});

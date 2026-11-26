// The engine's node:fs WatchProbe (U4.2.1, controller decision 61; C-WATCH WatchProbe, decisions 47
// and 53). Expected values are lstat semantics, the sha256 of the bytes (INV-26), and the walker's
// rules: no symlink followed, an unreadable entry dropped, a FIFO never emitted.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isWorkspacePath, WORKSPACE_ROOT, type WorkspacePath } from '@cpg/model';
import type { ListedEntry } from '@cpg/watch';
import { afterEach, describe, expect, it } from 'vitest';
import { createWatchProbe } from './watch-probe';

const roots: string[] = [];
const locked: string[] = [];
afterEach(async () => {
  await Promise.all(locked.splice(0).map((p) => chmod(p, 0o755)));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tree(spec: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-probe-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(spec)) {
    const abs = join(root, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  return root;
}

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** `file a.ts 3` / `directory src`: directory sizes are whatever lstat says, so left out. */
const shape = (entries: readonly ListedEntry[]): string[] =>
  entries
    .map((e) => (e.entry === 'file' ? `file ${e.path} ${e.sizeBytes}` : `directory ${e.path}`))
    .toSorted((a, b) => (a < b ? -1 : 1));
const asRoot = process.getuid?.() === 0;

describe('stat: lstat semantics', () => {
  it('a file with its size, a directory, the root, and undefined for a missing path', async () => {
    const root = await tree({ 'a.ts': 'abc', 'src/b.ts': 'hello world' });
    const probe = createWatchProbe(root);
    expect(await probe.stat(wp('a.ts'))).toEqual({ entry: 'file', sizeBytes: 3 });
    expect(await probe.stat(wp('src/b.ts'))).toEqual({ entry: 'file', sizeBytes: 11 });
    expect((await probe.stat(wp('src')))?.entry).toBe('directory');
    expect((await probe.stat(WORKSPACE_ROOT))?.entry).toBe('directory');
    expect(await probe.stat(wp('missing.ts'))).toBeUndefined();
    expect(await probe.stat(wp('a.ts/below'))).toBeUndefined();
  });

  it('a symlink is a file of its own size, never followed, and isSymlink says so until it changes', async () => {
    const root = await tree({ 'real/a.ts': 'twelve bytes' });
    const fileTarget = join(root, 'real', 'a.ts');
    const dirTarget = join(root, 'real');
    await symlink(fileTarget, join(root, 'link.ts'));
    await symlink(dirTarget, join(root, 'linked-dir'));
    await symlink(join(root, 'nowhere'), join(root, 'dangling'));
    const probe = createWatchProbe(root);

    expect(await probe.stat(wp('link.ts'))).toEqual({
      entry: 'file',
      sizeBytes: Buffer.byteLength(fileTarget),
    });
    expect(await probe.stat(wp('linked-dir'))).toEqual({
      entry: 'file',
      sizeBytes: Buffer.byteLength(dirTarget),
    });
    expect((await probe.stat(wp('dangling')))?.entry).toBe('file');
    expect([
      probe.isSymlink(wp('link.ts')),
      probe.isSymlink(wp('linked-dir')),
      probe.isSymlink(wp('dangling')),
      probe.isSymlink(wp('real/a.ts')),
      probe.isSymlink(wp('never-seen.ts')),
    ]).toEqual([true, true, true, false, false]);

    await unlink(join(root, 'link.ts'));
    await writeFile(join(root, 'link.ts'), 'now a file');
    expect(await probe.stat(wp('link.ts'))).toEqual({ entry: 'file', sizeBytes: 10 });
    expect(probe.isSymlink(wp('link.ts'))).toBe(false);
    await unlink(join(root, 'dangling'));
    expect(await probe.stat(wp('dangling'))).toBeUndefined();
    expect(probe.isSymlink(wp('dangling'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a FIFO is not reported', async () => {
    const root = await tree({ 'a.ts': 'a' });
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const probe = createWatchProbe(root);
    expect(await probe.stat(wp('pipe'))).toBeUndefined();
    expect(shape(await probe.list(WORKSPACE_ROOT))).toEqual(['file a.ts 1']);
  });
});

describe('list: every entry strictly under dir, recursively', () => {
  it("'.' lists the whole tree with no ./ prefix; a subdirectory lists under its own path", async () => {
    const root = await tree({
      'a.ts': 'abc',
      'src/b.ts': 'bb',
      'src/deep/c.py': 'c',
      'e/.keep': '',
    });
    const probe = createWatchProbe(root);
    expect(shape(await probe.list(WORKSPACE_ROOT))).toEqual([
      'directory e',
      'directory src',
      'directory src/deep',
      'file a.ts 3',
      'file e/.keep 0',
      'file src/b.ts 2',
      'file src/deep/c.py 1',
    ]);
    expect(shape(await probe.list(wp('src')))).toEqual([
      'directory src/deep',
      'file src/b.ts 2',
      'file src/deep/c.py 1',
    ]);
  });

  it('yields [] for a missing directory and for a file', async () => {
    const root = await tree({ 'a.ts': 'abc' });
    const probe = createWatchProbe(root);
    expect(await probe.list(wp('gone'))).toEqual([]);
    expect(await probe.list(wp('a.ts'))).toEqual([]);
  });

  it('never follows a symlink: a linked directory is a file, its contents unlisted, isSymlink true', async () => {
    const root = await tree({ 'real/a.ts': 'abc' });
    await symlink(join(root, 'real'), join(root, 'linked-dir'));
    await symlink(join(root, 'real', 'a.ts'), join(root, 'real', 'link.ts'));
    const probe = createWatchProbe(root);
    expect(shape(await probe.list(WORKSPACE_ROOT))).toEqual(
      [
        'directory real',
        'file real/a.ts 3',
        `file real/link.ts ${Buffer.byteLength(join(root, 'real', 'a.ts'))}`,
        `file linked-dir ${Buffer.byteLength(join(root, 'real'))}`,
      ].toSorted((a, b) => (a < b ? -1 : 1)),
    );
    expect([
      probe.isSymlink(wp('linked-dir')),
      probe.isSymlink(wp('real/link.ts')),
      probe.isSymlink(wp('real/a.ts')),
    ]).toEqual([true, true, false]);
    // Round two (R15): listing the link itself does not follow it.
    expect(await probe.list(wp('linked-dir'))).toEqual([]);

    // Round two (R16): a later list that finds a real directory there clears isSymlink.
    await unlink(join(root, 'linked-dir'));
    await mkdir(join(root, 'linked-dir'));
    await probe.list(WORKSPACE_ROOT);
    expect(probe.isSymlink(wp('linked-dir'))).toBe(false);
  });

  it('a directory enters refuses is listed but not entered; enters sees every directory found', async () => {
    const root = await tree({
      'a.ts': 'a',
      'node_modules/pkg/index.js': 'x',
      'src/b.ts': 'b',
      'src/node_modules/y.js': 'y',
    });
    const asked: string[] = [];
    const probe = createWatchProbe(root, {
      enters: (dir) => {
        asked.push(dir);
        return !dir.endsWith('node_modules');
      },
    });
    expect(shape(await probe.list(WORKSPACE_ROOT))).toEqual([
      'directory node_modules',
      'directory src',
      'directory src/node_modules',
      'file a.ts 1',
      'file src/b.ts 1',
    ]);
    expect(asked.toSorted((a, b) => (a < b ? -1 : 1))).toEqual([
      'node_modules',
      'src',
      'src/node_modules',
    ]);
  });

  it.skipIf(asRoot)('an unreadable directory is listed, with nothing under it', async () => {
    const root = await tree({ 'a.ts': 'a', 'locked/secret.ts': 's', 'open/b.ts': 'b' });
    await chmod(join(root, 'locked'), 0o000);
    locked.push(join(root, 'locked'));
    const probe = createWatchProbe(root);
    expect(shape(await probe.list(WORKSPACE_ROOT))).toEqual([
      'directory locked',
      'directory open',
      'file a.ts 1',
      'file open/b.ts 1',
    ]);
    expect(await probe.list(wp('locked'))).toEqual([]);
    // Round two (R17): a path that cannot be reached (EACCES, not ENOENT) is not reported either.
    expect(await probe.stat(wp('locked/secret.ts'))).toBeUndefined();
    expect(await probe.digest(wp('locked/secret.ts'))).toBeUndefined();
  });
});

describe('digest: sha256 of the bytes', () => {
  it('is the lowercase hex sha256 of the raw bytes, CRLF and non-UTF-8 included', async () => {
    const root = await tree({ 'lf.ts': 'a\nb\n', 'crlf.ts': 'a\r\nb\r\n' });
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    await writeFile(join(root, 'bin.dat'), bytes);
    const probe = createWatchProbe(root);
    expect(await probe.digest(wp('lf.ts'))).toBe(sha256('a\nb\n'));
    expect(await probe.digest(wp('crlf.ts'))).toBe(sha256('a\r\nb\r\n'));
    expect(await probe.digest(wp('bin.dat'))).toBe(sha256(bytes));
    expect(await probe.digest(wp('lf.ts'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is undefined for a missing path and for a directory', async () => {
    const root = await tree({ 'src/a.ts': 'a' });
    const probe = createWatchProbe(root);
    expect(await probe.digest(wp('gone.ts'))).toBeUndefined();
    expect(await probe.digest(wp('src'))).toBeUndefined();
  });

  it.skipIf(asRoot)('is undefined for a file that cannot be read', async () => {
    const root = await tree({ 'secret.ts': 's' });
    await chmod(join(root, 'secret.ts'), 0o000);
    locked.push(join(root, 'secret.ts'));
    expect(await createWatchProbe(root).digest(wp('secret.ts'))).toBeUndefined();
  });
});

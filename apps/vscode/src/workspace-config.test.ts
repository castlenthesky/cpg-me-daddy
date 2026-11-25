// cpg.config.yaml for the extension (controller decision 38): found and read as the CLI does, with the
// extension's own two consumer switches. Expected values: 03-architecture §9 and §11, BMO-38, decision 38.

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_FILE_NAME, ConfigError, DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from '@cpg/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceConfig } from './workspace-config';

let base = '';
/** A temporary directory tree; `.git` ends any search here, whatever is above the temp directory. */
async function tree(spec: Readonly<Record<string, string>>, git = true): Promise<string> {
  base = await realpath(await mkdtemp(join(tmpdir(), 'cpg-config-')));
  if (git) await mkdir(join(base, '.git'));
  for (const [at, text] of Object.entries(spec)) {
    const file = join(base, at);
    // oxlint-disable-next-line no-await-in-loop -- a few small files
    await mkdir(dirname(file), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- a few small files
    if (!at.endsWith('/.keep')) await writeFile(file, text);
  }
  return base;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  if (base !== '') await rm(base, { recursive: true, force: true });
  base = '';
});

const CONSUMERS = { inspect: false, store: 'memory', vscode: true };
const include = (glob: string): string => `version: 1\ninclude: [${glob}]\n`;

async function configError(root: string): Promise<ConfigError> {
  const thrown: unknown = await loadWorkspaceConfig(root).catch((error: unknown) => error);
  if (!(thrown instanceof ConfigError))
    throw new Error(`expected a ConfigError, got ${String(thrown)}`);
  return thrown;
}

describe('with no file', () => {
  it('is the built-in defaults on the folder, with the vscode consumer on', async () => {
    const root = await tree({ 'sub/.keep': '' });
    const { config, warnings } = await loadWorkspaceConfig(root);
    expect(config).toMatchObject({
      root,
      include: DEFAULT_INCLUDES,
      exclude: DEFAULT_EXCLUDES,
      maxFileSizeBytes: 2 * 1024 * 1024,
      consumers: CONSUMERS,
    });
    expect(warnings).toEqual([]);
  });

  it("is the same whatever is in the editor's environment", async () => {
    vi.stubEnv('CPG_WORKSPACE', '/elsewhere');
    vi.stubEnv('CPG_HOST', 'elsewhere');
    const root = await tree({});
    const { config } = await loadWorkspaceConfig(root);
    expect([config.root, config.store.host]).toEqual([root, '127.0.0.1']);
  });
});

describe('the file', () => {
  it('sets what is indexed', async () => {
    const root = await tree({
      [CONFIG_FILE_NAME]:
        'version: 1\ninclude: [/src/**]\nexclude: ["**/gen/**"]\nmax_file_size_bytes: 9\n',
    });
    const { config, warnings } = await loadWorkspaceConfig(root);
    expect(config).toMatchObject({ root, include: ['/src/**'], exclude: ['**/gen/**'] });
    expect(config.maxFileSizeBytes).toBe(9);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['vscode off', 'vscode: false', CONSUMERS],
    ['vscode auto', 'vscode: auto', CONSUMERS],
    ['inspect on', 'inspect: true', CONSUMERS],
    ['both', 'inspect: true, vscode: false', CONSUMERS],
    ['another store, which the engine refuses', 'store: falkor', { ...CONSUMERS, store: 'falkor' }],
  ])("the extension's switches win over %s", async (_what, switches, expected) => {
    const root = await tree({ [CONFIG_FILE_NAME]: `version: 1\nconsumers: { ${switches} }\n` });
    expect((await loadWorkspaceConfig(root)).config.consumers).toEqual(expected);
  });

  it("passes on the loader's warnings", async () => {
    const root = await tree({ [CONFIG_FILE_NAME]: 'version: 1\nlanguages: { python: true }\n' });
    const { warnings } = await loadWorkspaceConfig(root);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'languages' is parsed but not applied");
  });
});

describe('which file', () => {
  it('is the nearest one upwards, and the root stays the folder', async () => {
    const root = await tree({
      [CONFIG_FILE_NAME]: include('/top'),
      [`a/${CONFIG_FILE_NAME}`]: include('/a'),
      'a/b/c/.keep': '',
    });
    const { config } = await loadWorkspaceConfig(join(root, 'a', 'b', 'c'));
    expect([config.root, config.include]).toEqual([join(root, 'a', 'b', 'c'), ['/a']]);
  });

  it('is never above the directory that holds .git, which is itself searched', async () => {
    const root = await tree({
      [CONFIG_FILE_NAME]: include('/top'),
      'repo/.git/.keep': '',
      'repo/x/.keep': '',
    });
    expect((await loadWorkspaceConfig(join(root, 'repo'))).config.include).toEqual(
      DEFAULT_INCLUDES,
    );
    expect((await loadWorkspaceConfig(join(root, 'repo', 'x'))).config.include).toEqual(
      DEFAULT_INCLUDES,
    );
    await writeFile(join(root, 'repo', CONFIG_FILE_NAME), include('/repo'));
    expect((await loadWorkspaceConfig(join(root, 'repo', 'x'))).config.include).toEqual(['/repo']);
  });

  it('a .git file (a worktree) ends the search too', async () => {
    const root = await tree({ [CONFIG_FILE_NAME]: include('/top'), 'tree/.git': 'gitdir: /x\n' });
    expect((await loadWorkspaceConfig(join(root, 'tree'))).config.include).toEqual(
      DEFAULT_INCLUDES,
    );
  });

  // Round two (review b2): the search ends at the file system's root when no directory holds .git.
  it('ends at the root of the file system', async () => {
    const root = await tree({ 'a/b/.keep': '' }, false);
    const { config } = await loadWorkspaceConfig(join(root, 'a', 'b'));
    expect(config.include).toEqual(DEFAULT_INCLUDES);
  });

  it('a directory of that name is not one', async () => {
    const root = await tree({
      [CONFIG_FILE_NAME]: include('/top'),
      [`a/${CONFIG_FILE_NAME}/.keep`]: '',
    });
    expect((await loadWorkspaceConfig(join(root, 'a'))).config.include).toEqual(['/top']);
  });
});

describe('a bad file is a ConfigError naming it', () => {
  it.each([
    ['not YAML', 'version: 1\ninclude: [src\n', ''],
    ['a key the schema lacks', 'version: 1\nincludes: [src]\n', 'includes'],
    ['a wrong value', 'version: 2\n', 'version'],
  ])('%s', async (_what, text, key) => {
    const root = await tree({ [CONFIG_FILE_NAME]: text });
    const error = await configError(root);
    expect([error.key, error.layer, error.source]).toEqual([
      key,
      'file',
      join(root, CONFIG_FILE_NAME),
    ]);
    expect(error.message).toContain(join(root, CONFIG_FILE_NAME));
  });

  it('one that cannot be read', async () => {
    const root = await tree({ [CONFIG_FILE_NAME]: include('/x') });
    await chmod(join(root, CONFIG_FILE_NAME), 0o000);
    if (process.getuid?.() === 0) return;
    const error = await configError(root);
    expect(error.message).toContain(`${join(root, CONFIG_FILE_NAME)}: cannot read config file: `);
    expect(error.source).toBe(join(root, CONFIG_FILE_NAME));
  });
});

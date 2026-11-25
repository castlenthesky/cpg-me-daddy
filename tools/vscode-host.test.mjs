// How the host tests start VS Code (U3.1.2; controller decisions 33, 34, 41 and 42). VS Code is never
// started here. Expected values: those decisions, the manifest's engines.vscode and ladder rung 07.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISPLAY_OPT_IN,
  displayPolicy,
  hostConfigurations,
  PINS,
  SOFTWARE_GL,
  SPIKE_SAMPLES,
  spikeConfiguration,
} from './vscode-host.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TOOLS, '..');
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const LADDER = join(REPO, 'fixtures', 'ladder');
const HEADLESS = '--ozone-platform=headless';

const desktop = { DISPLAY: ':1', WAYLAND_DISPLAY: 'wayland-0', HOME: '/home/someone' };
const linux = { platform: 'linux', env: desktop };
const onDisplay = { platform: 'linux', env: { ...desktop, CPG_HOST_DISPLAY: '1' } };

let scratch = '';
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'vscode-host-')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

/** Every file under `dir`, with its bytes. */
const contents = (dir) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name))
      .map((path) => [relative(dir, path), readFileSync(path, 'latin1')]),
  );
/** The value of the one `--name=value` among a configuration's launch arguments. */
function argument({ launchArgs }, name) {
  const values = launchArgs.filter((arg) => arg.startsWith(`--${name}=`));
  expect(values).toHaveLength(1);
  return values[0].slice(name.length + 3);
}
const isUnder = (dir, path) => isAbsolute(path) && path.startsWith(`${dir}/`);

describe('the pins', () => {
  it('are exact, and the oldest is what engines.vscode promises', () => {
    expect(Object.keys(PINS)).toEqual(['current', 'oldest']);
    expect(`^${PINS.oldest}`).toBe(manifest.engines.vscode);
    expect(PINS.current).toMatch(/^1\.\d+\.\d+$/);
    expect(Number(PINS.current.split('.')[1])).toBeGreaterThan(Number(PINS.oldest.split('.')[1]));
  });
});

describe('displayPolicy', () => {
  it('on Linux: headless, and no display for a wrong flag to find', () => {
    const { headless, launchArgs, env } = displayPolicy(linux);
    expect([headless, launchArgs]).toEqual([true, [HEADLESS]]);
    // As @vscode/test-electron merges it, and as spawn reads it: an undefined value is left out.
    expect({ ...desktop, ...env }).toEqual({
      HOME: '/home/someone',
      DISPLAY: undefined,
      WAYLAND_DISPLAY: undefined,
    });
    expect(Object.keys(env).toSorted()).toEqual(['DISPLAY', 'WAYLAND_DISPLAY']);
  });

  it.each(['0', '', 'true', '11', undefined])('CPG_HOST_DISPLAY=%j does not opt in', (value) => {
    const env = { ...desktop, [DISPLAY_OPT_IN]: value };
    expect(displayPolicy({ platform: 'linux', env }).headless).toBe(true);
    expect(() => displayPolicy({ platform: 'darwin', env })).toThrow(/CPG_HOST_DISPLAY=1/);
  });

  it.each(['linux', 'darwin', 'win32'])('CPG_HOST_DISPLAY=1 on %s: on the display', (platform) => {
    expect(displayPolicy({ platform, env: onDisplay.env })).toEqual({
      headless: false,
      launchArgs: [],
      env: {},
    });
  });

  it.each(['darwin', 'win32'])('refuses %s without it: there is no headless mode', (platform) => {
    expect(() => displayPolicy({ platform, env: desktop })).toThrow(/CPG_HOST_DISPLAY=1/);
  });

  it('reads this process by default', () => {
    vi.stubEnv('CPG_HOST_DISPLAY', '1');
    expect(displayPolicy().headless).toBe(false);
    vi.stubEnv('CPG_HOST_DISPLAY', '0');
    expect(displayPolicy({ platform: 'linux' }).headless).toBe(true);
  });
});

describe('hostConfigurations', () => {
  it('runs the current pin headless, and both on a display', () => {
    const headless = hostConfigurations(join(scratch, 'a'), linux);
    expect(headless.map(({ label, version }) => [label, version])).toEqual([
      ['current', PINS.current],
    ]);
    const shown = hostConfigurations(join(scratch, 'b'), onDisplay);
    expect(shown.map(({ label, version }) => [label, version])).toEqual([
      ['current', PINS.current],
      ['oldest', PINS.oldest],
    ]);
  });

  it('applies the display policy, refusal included', () => {
    const [headless] = hostConfigurations(join(scratch, 'a'), linux);
    expect(headless.launchArgs).toContain(HEADLESS);
    expect({ ...desktop, ...headless.env }).toMatchObject({ DISPLAY: undefined });
    for (const configuration of hostConfigurations(join(scratch, 'b'), onDisplay)) {
      expect(configuration.launchArgs.filter((arg) => arg.startsWith('--ozone'))).toEqual([]);
      expect(Object.keys(configuration.env)).not.toContain('DISPLAY');
    }
    expect(() => hostConfigurations(scratch, { platform: 'darwin', env: desktop })).toThrow(
      /CPG_HOST_DISPLAY=1/,
    );
  });

  it('gives each run its own copy of rung 07, and its own profile', () => {
    const configurations = hostConfigurations(scratch, onDisplay);
    const directories = configurations.flatMap((configuration) => [
      configuration.workspaceFolder,
      argument(configuration, 'user-data-dir'),
      argument(configuration, 'extensions-dir'),
    ]);
    expect(directories.filter((directory) => !isUnder(scratch, directory))).toEqual([]);
    expect(new Set(directories).size).toBe(6);
    for (const { workspaceFolder } of configurations) {
      expect(contents(workspaceFolder)).toEqual(contents(join(LADDER, '07-package', 'ws')));
      // Ends the search for cpg.config.yaml; the walker's default excludes keep it out of the graph.
      expect(lstatSync(join(workspaceFolder, '.git')).isDirectory()).toBe(true);
    }
    const [{ workspaceFolder }] = configurations;
    writeFileSync(join(workspaceFolder, 'main.py'), 'changed\n');
    expect(readFileSync(join(LADDER, '07-package', 'ws', 'main.py'), 'utf8')).not.toBe('changed\n');
  });

  it('downloads a VS Code and loads this extension in it', () => {
    for (const configuration of hostConfigurations(scratch, onDisplay)) {
      expect(configuration.useInstallation).toBeUndefined();
      expect(configuration.extensionDevelopmentPath).toBe(REPO);
      // What test-cli does with it first.
      expect(structuredClone(configuration)).toEqual(configuration);
    }
  });

  it('runs the built host tests, and none of the spikes', () => {
    for (const { files } of hostConfigurations(scratch, onDisplay)) {
      // test-cli reads an absolute path literally, and a relative one as a glob from its file's directory.
      expect(isAbsolute(files)).toBe(false);
      expect(resolve(TOOLS, files)).toBe(join(REPO, 'apps/vscode/dist/host-tests/*.test.js'));
    }
  });

  it('gives every test a timeout, and fails a run of none or an .only', () => {
    for (const { mocha } of hostConfigurations(scratch, onDisplay)) {
      expect(mocha).toMatchObject({ failZero: true, forbidOnly: true, timeout: 60_000 });
      expect(mocha.bail ?? false).toBe(false);
    }
  });

  it('tells the tests their pin and version', () => {
    const told = hostConfigurations(scratch, onDisplay).map(({ env }) => [
      env.CPG_HOST_PIN,
      env.CPG_HOST_VSCODE,
    ]);
    expect(told).toEqual([
      ['current', PINS.current],
      ['oldest', PINS.oldest],
    ]);
  });

  it('draws in software, and sends no telemetry', () => {
    expect(SOFTWARE_GL).toContain('--use-angle=swiftshader');
    for (const configuration of hostConfigurations(scratch, onDisplay)) {
      expect(configuration.launchArgs).toEqual(expect.arrayContaining(SOFTWARE_GL));
      expect(configuration.launchArgs).toContain('--disable-telemetry');
      const profile = join(argument(configuration, 'user-data-dir'), 'User', 'settings.json');
      expect(JSON.parse(readFileSync(profile, 'utf8'))).toMatchObject({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
      });
    }
  });
});

describe('spikeConfiguration', () => {
  it('is the current pin on the whole ladder, for an hour', () => {
    const spikes = spikeConfiguration(scratch, linux);
    expect([spikes.label, spikes.version]).toEqual(['spikes', PINS.current]);
    expect(resolve(TOOLS, spikes.files)).toBe(
      join(REPO, 'apps/vscode/dist/host-tests/spikes/*.spike.js'),
    );
    expect(isUnder(scratch, spikes.workspaceFolder)).toBe(true);
    expect(contents(spikes.workspaceFolder)).toEqual(contents(LADDER));
    expect(isUnder(scratch, argument(spikes, 'user-data-dir'))).toBe(true);
    expect(isUnder(scratch, argument(spikes, 'extensions-dir'))).toBe(true);
    expect(spikes.mocha).toMatchObject({ failZero: true, timeout: 3_600_000 });
    expect(spikes.extensionDevelopmentPath).toBe(REPO);
  });

  it('writes its samples outside the profile, where git ignores them', () => {
    const { env } = spikeConfiguration(scratch, linux);
    expect(SPIKE_SAMPLES).toBe(join(REPO, '.vscode-test', 'spikes.json'));
    expect([env.CPG_SPIKE_SAMPLES, env.CPG_HOST_VSCODE]).toEqual([SPIKE_SAMPLES, PINS.current]);
  });

  it('is headless and software-drawn by default, and uses the GPU on a display', () => {
    const headless = spikeConfiguration(join(scratch, 'a'), linux);
    expect(headless.launchArgs).toEqual(expect.arrayContaining([HEADLESS, ...SOFTWARE_GL]));
    expect({ ...desktop, ...headless.env }).toMatchObject({ DISPLAY: undefined });
    const shown = spikeConfiguration(join(scratch, 'b'), onDisplay);
    expect(shown.launchArgs.filter((arg) => [HEADLESS, ...SOFTWARE_GL].includes(arg))).toEqual([]);
    expect(() =>
      spikeConfiguration(join(scratch, 'c'), { platform: 'darwin', env: desktop }),
    ).toThrow(/CPG_HOST_DISPLAY=1/);
  });
});

describe('scratchDirectory', () => {
  // test-cli ends with process.exit, passing or failing.
  it.each([0, 1])('is under the temporary directory and gone after exit %i', (code) => {
    const module = JSON.stringify(join(TOOLS, 'vscode-host.mjs'));
    const script = `
      const { writeFileSync } = await import('node:fs');
      const { scratchDirectory } = await import(${module});
      const made = [scratchDirectory(), scratchDirectory()];
      for (const dir of made) writeFileSync(dir + '/kept.txt', 'x');
      console.log(JSON.stringify(made));
      process.exit(${String(code)});`;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: scratch },
    });
    expect([ran.status, ran.stderr]).toEqual([code, '']);
    const made = JSON.parse(ran.stdout);
    expect(new Set(made).size).toBe(2);
    expect(made.filter((dir) => !isUnder(scratch, dir))).toEqual([]);
    expect(made.filter((dir) => existsSync(dir))).toEqual([]);
  });
});

describe('the package scripts', () => {
  it('build first, run the configurations, and stay out of bun run check', () => {
    const { scripts } = manifest;
    expect(scripts['test:vscode-host']).toBe(
      'bun run compile && vscode-test --config tools/vscode-host.config.mjs',
    );
    expect(scripts['spike:vscode-host']).toBe(
      'bun run compile && vscode-test --config tools/vscode-spikes.config.mjs && node tools/spike-report.mjs',
    );
    expect(readFileSync(join(TOOLS, 'check.mjs'), 'utf8')).not.toContain('vscode-host');
    expect(manifest.devDependencies).toMatchObject({
      '@vscode/test-cli': expect.stringMatching(/^\d/),
      '@vscode/test-electron': expect.stringMatching(/^\d/),
      '@types/mocha': expect.stringMatching(/^\d/),
    });
  });
});

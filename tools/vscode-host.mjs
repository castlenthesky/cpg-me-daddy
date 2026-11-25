// REAL (U3.1.2, BMO-56): how the host tests and the spikes start VS Code (controller decisions 33, 34, 41
// and 42). Nothing here opens a window on anybody's desktop unless CPG_HOST_DISPLAY=1 asks for it.
// tools/vscode-host.config.mjs and tools/vscode-spikes.config.mjs are the @vscode/test-cli configurations.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LADDER = join(REPO, 'fixtures', 'ladder');
const BUILT = '../apps/vscode/dist/host-tests';

/**
 * The VS Code versions the host tests run on: a current one, and the oldest that engines.vscode promises.
 * Exact, never `stable`: a VS Code release must not turn CI red (decision 42).
 */
export const PINS = { current: '1.148.0', oldest: '1.90.0' };

/** The opt-in to a real display: xvfb in CI, or a person who wants to watch (and the GPU, for the spikes). */
export const DISPLAY_OPT_IN = 'CPG_HOST_DISPLAY';

/** Software WebGL, so a webview gets the same renderer on every machine. */
export const SOFTWARE_GL = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

/**
 * How VS Code may be started here.
 * - Linux, by default: headless. `--ozone-platform=headless`, and DISPLAY and WAYLAND_DISPLAY are unset in
 *   its environment, so even a wrong flag can't open a window.
 * - With CPG_HOST_DISPLAY=1 (exactly), anywhere: on the display the environment names.
 * - Elsewhere VS Code has no headless mode, so this throws, naming CPG_HOST_DISPLAY.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [where]
 * @returns {{ headless: boolean, launchArgs: string[], env: Record<string, string | undefined> }}
 */
export function displayPolicy(where = {}) {
  const platform = where.platform ?? process.platform;
  const env = where.env ?? process.env;
  if (env[DISPLAY_OPT_IN] === '1') {
    return { headless: false, launchArgs: [], env: {} };
  }
  if (platform === 'linux') {
    return {
      headless: true,
      launchArgs: ['--ozone-platform=headless'],
      env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    };
  }
  throw new Error(
    `VS Code has no headless mode on ${platform}; set ${DISPLAY_OPT_IN}=1 to run on a display`,
  );
}

/**
 * A new directory under the system's temporary directory, removed when this process exits.
 *
 * @returns {string}
 */
export function scratchDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'cpg-'));
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Failed removal must not change the process exit code.
    }
  });
  return dir;
}

/** Telemetry, updates and everything else that reaches out on its own, off. */
const QUIET_ARGS = ['--disable-telemetry', '--disable-crash-reporter', '--disable-experiments'];
const QUIET_SETTINGS = {
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'workbench.enableExperiments': false,
  'chat.disableAIFeatures': true,
};

/**
 * One @vscode/test-cli configuration, its workspace (a copy of `fixture`) and profile made in `directory`.
 * Short names: VS Code makes a Unix socket in the profile, whose path may not pass about 107 characters.
 */
function configuration(directory, { pin, fixture, launchArgs, env, timeout, ...rest }) {
  const workspaceFolder = join(directory, 'w');
  cpSync(fixture, workspaceFolder, { recursive: true });
  const profile = join(directory, 'u');
  mkdirSync(join(profile, 'User'), { recursive: true });
  writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify(QUIET_SETTINGS));
  return {
    ...rest,
    version: PINS[pin],
    extensionDevelopmentPath: REPO,
    workspaceFolder,
    launchArgs: [
      ...launchArgs,
      ...QUIET_ARGS,
      `--user-data-dir=${profile}`,
      `--extensions-dir=${join(directory, 'e')}`,
    ],
    env: { ...env, CPG_HOST_PIN: pin, CPG_HOST_VSCODE: PINS[pin] },
    mocha: { failZero: true, forbidOnly: true, timeout },
  };
}

/**
 * The @vscode/test-cli configurations of the host tests, labelled `current` and `oldest` in that order.
 * 1.90.0 crashes (SIGSEGV) when it starts headless, so `oldest` is there only on a display. Each runs in its
 * own copy of ladder rung 07, with a `.git` directory added, under its own directory of `scratch`, with its
 * own --user-data-dir and --extensions-dir, telemetry off and SOFTWARE_GL. Its tests know their pin and its
 * version as CPG_HOST_PIN and CPG_HOST_VSCODE. A `.only`, and a run of no tests, fail.
 *
 * @param {string} scratch a scratchDirectory()
 * @param {Parameters<typeof displayPolicy>[0]} [where]
 */
export function hostConfigurations(scratch, where) {
  const { headless, launchArgs, env } = displayPolicy(where);
  return (headless ? ['current'] : ['current', 'oldest']).map((pin) => {
    const made = configuration(join(scratch, pin), {
      label: pin,
      pin,
      fixture: join(LADDER, '07-package', 'ws'),
      files: `${BUILT}/*.test.js`,
      launchArgs: [...launchArgs, ...SOFTWARE_GL],
      env,
      timeout: 60_000,
    });
    mkdirSync(join(made.workspaceFolder, '.git'));
    return made;
  });
}

/** Where the spikes write what they measured; git ignores the directory. */
export const SPIKE_SAMPLES = join(REPO, '.vscode-test', 'spikes.json');

/**
 * The configuration of the spikes, labelled `spikes`: hostConfigurations' `current` except that they run on
 * a copy of the whole ladder, get an hour, write to SPIKE_SAMPLES (as CPG_SPIKE_SAMPLES), and on a display
 * use whatever GL it has (decision 34).
 *
 * @param {string} scratch a scratchDirectory()
 * @param {Parameters<typeof displayPolicy>[0]} [where]
 */
export function spikeConfiguration(scratch, where) {
  const { headless, launchArgs, env } = displayPolicy(where);
  return configuration(join(scratch, 'spikes'), {
    label: 'spikes',
    pin: 'current',
    fixture: LADDER,
    files: `${BUILT}/spikes/*.spike.js`,
    launchArgs: headless ? [...launchArgs, ...SOFTWARE_GL] : launchArgs,
    env: { ...env, CPG_SPIKE_SAMPLES: SPIKE_SAMPLES },
    timeout: 3_600_000,
  });
}

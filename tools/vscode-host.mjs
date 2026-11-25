// SEAT (U3.1.2, BMO-56): how the host tests and the spikes start VS Code (controller decisions 33, 34, 41
// and 42). Nothing here opens a window on anybody's desktop unless CPG_HOST_DISPLAY=1 asks for it.
// tools/vscode-host.config.mjs and tools/vscode-spikes.config.mjs are the @vscode/test-cli configurations.

/**
 * The VS Code versions the host tests run on: a current one, and the oldest that engines.vscode promises.
 * Exact, never `stable`: a VS Code release must not turn CI red (decision 42).
 */
export const PINS = { current: '', oldest: '' };

/** The opt-in to a real display: xvfb in CI, or a person who wants to watch (and the GPU, for the spikes). */
export const DISPLAY_OPT_IN = 'CPG_HOST_DISPLAY';

/** Software WebGL, so a run draws the same picture on every machine. */
export const SOFTWARE_GL = [];

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
export function displayPolicy(_where) {
  throw new Error('SEAT: not built yet: displayPolicy (U3.1.2)');
}

/**
 * A new directory under the system's temporary directory, removed when this process exits.
 *
 * @returns {string}
 */
export function scratchDirectory() {
  throw new Error('SEAT: not built yet: scratchDirectory (U3.1.2)');
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
export function hostConfigurations(_scratch, _where) {
  throw new Error('SEAT: not built yet: hostConfigurations (U3.1.2)');
}

/** Where the spikes write what they measured; git ignores the directory. */
export const SPIKE_SAMPLES = '';

/**
 * The configuration of the spikes, labelled `spikes`: hostConfigurations' `current` except that they run on
 * a copy of the whole ladder, get an hour, write to SPIKE_SAMPLES (as CPG_SPIKE_SAMPLES), and on a display
 * use whatever GL it has (decision 34).
 *
 * @param {string} scratch a scratchDirectory()
 * @param {Parameters<typeof displayPolicy>[0]} [where]
 */
export function spikeConfiguration(_scratch, _where) {
  throw new Error('SEAT: not built yet: spikeConfiguration (U3.1.2)');
}

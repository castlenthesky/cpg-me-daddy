/**
 * A resolved config for unit tests.
 *
 * Every test that touches the acquisition pipeline or a server manager needs a
 * `FalkorConfig`, and none of them want to inherit the developer's real
 * environment. `testConfig()` starts from an empty env and a temporary home,
 * so a test's result cannot depend on whether the machine running it happens
 * to have `FALKORDB_CACHE_DIR` set.
 */

import { defineFalkorConfig, type FalkorConfig, type FalkorConfigInput } from "../../src/config.ts";

export function testConfig(input: FalkorConfigInput = {}): FalkorConfig {
  return defineFalkorConfig({
    env: {},
    home: "/nonexistent-test-home",
    ...input,
  });
}

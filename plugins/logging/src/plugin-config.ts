import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { consolePath } from './console-path';

// The plugin asset route, not the proxy route the journal API uses: this is
// read before any flag is set, and console only ever issues a bare GET here,
// which is all a static config document needs.
const CONFIG_URL = '/api/plugins/logging-console-plugin/config.json';

export interface PluginConfig {
  nodeLogsEnabled?: boolean;
  podLogsEnabled?: boolean;
  /**
   * Color scheme name per console theme (see logs/color-schemes.ts);
   * `background: 'console'` puts console's content color behind it.
   */
  colorScheme?: { light?: string; dark?: string; background?: string };
}

let config: Promise<PluginConfig> | undefined;

/**
 * This plugin's backend config (api/config.go), fetched once per page load
 * and shared by the console.flag handler and the log viewers. A failed fetch
 * is not cached, so the next caller retries.
 */
export const loadPluginConfig = (): Promise<PluginConfig> => {
  // Inside a .then() so that even a synchronous throw ends up as a rejection.
  config ??= Promise.resolve()
    .then(
      () => consoleFetchJSON(consolePath(CONFIG_URL)) as Promise<PluginConfig>,
    )
    .catch((e: unknown) => {
      config = undefined;
      throw e;
    });
  return config;
};

/** For tests only. */
export const resetPluginConfig = (): void => {
  config = undefined;
};

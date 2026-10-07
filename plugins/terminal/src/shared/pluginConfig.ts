import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { consolePath } from './consolePath';

const CONFIG_URL = '/api/plugins/terminal-console-plugin/config.json';

export type PluginConfig = {
  podTerminalEnabled: boolean;
  nodeTerminalEnabled: boolean;
  /** Color scheme name per console theme (see colorSchemes.ts); empty for the default. */
  colorScheme?: { light?: string; dark?: string };
};

let config: Promise<PluginConfig> | undefined;

/**
 * This plugin's backend config (api/config.go), fetched once per page load and shared by the
 * console.flag handler and the terminals. A failed fetch is not cached, so the next caller retries.
 */
export const loadPluginConfig = (): Promise<PluginConfig> => {
  if (!config) {
    config = (consoleFetchJSON(consolePath(CONFIG_URL)) as Promise<PluginConfig>).catch((e) => {
      config = undefined;
      throw e;
    });
  }
  return config;
};

/** For tests only. */
export const resetPluginConfig = (): void => {
  config = undefined;
};

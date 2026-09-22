import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { consolePath } from './consolePath';

/**
 * Read from the plugin *asset* route, which is the only one available before
 * a feature flag is set and which console reaches with a plain GET.
 */
const CONFIG_URL = '/api/plugins/filesystem-console-plugin/config.json';

export type PluginConfig = {
  podFileBrowserEnabled: boolean;
  uploadChunkBytes: number;
  viewMaxBytes: number;
  defaultArchiveFormat: string;
};

export const DEFAULT_CONFIG: PluginConfig = {
  podFileBrowserEnabled: true,
  uploadChunkBytes: 4 * 1024 * 1024,
  viewMaxBytes: 2 * 1024 * 1024,
  defaultArchiveFormat: 'tar.gz',
};

/**
 * Fetched once per page load and shared by the flag handler and the tab, so
 * opening the tab does not repeat the request the flag handler already made.
 *
 * A failure is *not* swallowed into DEFAULT_CONFIG here, because the two
 * callers want opposite things from one: the flag handler must leave the tab
 * off (no backend means nothing the tab could talk to), while the tab itself,
 * already open, is better off with the defaults than with nothing. A failed
 * attempt is also not memoized, so a backend that was still starting up is
 * picked up on the next call.
 */
let pending: Promise<PluginConfig> | null = null;

export const loadPluginConfig = (): Promise<PluginConfig> => {
  if (!pending) {
    pending = consoleFetchJSON(consolePath(CONFIG_URL))
      .then((config: Partial<PluginConfig>) => ({ ...DEFAULT_CONFIG, ...config }))
      .catch((error: unknown) => {
        pending = null;
        throw error;
      });
  }
  return pending;
};

/** Test seam: drops the memoized fetch. */
export const resetPluginConfig = (): void => {
  pending = null;
};

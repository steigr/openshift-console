import type { SetFeatureFlag } from '@openshift-console/dynamic-plugin-sdk';

import { loadPluginConfig } from '../shared/config';

// Must match the name in console-extensions.json's `flags.required` block.
//
// Unlike the terminal and logging plugins' flags, this one gates nothing in
// console core - core has no file browser to hand back to. It exists so an
// operator can deploy the plugin's frontend on a cluster where the agent
// DaemonSet is not (or not yet) rolled out and get no tab at all, rather than
// a tab that fails on every click.
export const POD_BROWSER_FLAG = 'FILESYSTEM_PLUGIN_POD_BROWSER_ENABLED';

/**
 * console.flag handler: reads this plugin's own backend config once and sets
 * the tab's flag from it, so POD_FILE_BROWSER_ENABLED on the Deployment
 * switches the tab on and off without rebuilding the frontend. On fetch
 * failure the flag stays false, which is the safe answer: no backend means
 * nothing the tab could talk to.
 */
export const setFilesystemPluginFlags = (setFeatureFlag: SetFeatureFlag): void => {
  loadPluginConfig()
    .then((config) => setFeatureFlag(POD_BROWSER_FLAG, !!config.podFileBrowserEnabled))
    .catch(() => setFeatureFlag(POD_BROWSER_FLAG, false));
};

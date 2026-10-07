import type { SetFeatureFlag } from '@openshift-console/dynamic-plugin-sdk';

import { loadPluginConfig } from '../shared/pluginConfig';

// Must match the flag names hardcoded in console-extensions.json's
// `flags.required` blocks, and the flag console core's patch
// 0020-node-terminal-flag-gate.patch checks for the Node tab.
export const POD_TERMINAL_FLAG = 'TERMINAL_PLUGIN_POD_TERMINAL_ENABLED';
export const NODE_TERMINAL_FLAG = 'TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED';

/**
 * console.flag handler: fetches this plugin's own backend config once and
 * sets both terminal flags from it, so a cluster admin can flip either
 * POD_TERMINAL_ENABLED/NODE_TERMINAL_ENABLED env var on the plugin's
 * Deployment to hand a tab back to console core without touching the
 * frontend build. On fetch failure both flags stay unset (i.e. core's
 * built-in terminals are used, and this plugin's extensions stay inactive).
 */
export const setTerminalPluginFlags = (setFeatureFlag: SetFeatureFlag): void => {
  loadPluginConfig()
    .then((config) => {
      setFeatureFlag(POD_TERMINAL_FLAG, !!config.podTerminalEnabled);
      setFeatureFlag(NODE_TERMINAL_FLAG, !!config.nodeTerminalEnabled);
    })
    .catch(() => {
      setFeatureFlag(POD_TERMINAL_FLAG, false);
      setFeatureFlag(NODE_TERMINAL_FLAG, false);
    });
};

import type { SetFeatureFlag } from '@openshift-console/dynamic-plugin-sdk';

import { loadPluginConfig } from './plugin-config';

// Must match the flags console core's own patches check:
// patches/0024-node-logs-flag-gate.patch (NodeDetailsPage.tsx) and
// patches/0025-pod-logs-flag-gate.patch (pod.tsx). While a flag is set, core
// drops its own Logs tab from that details page, leaving the tab to this
// plugin.
export const NODE_LOGS_FLAG = 'LOGGING_PLUGIN_NODE_LOGS_ENABLED';
export const POD_LOGS_FLAG = 'LOGGING_PLUGIN_POD_LOGS_ENABLED';

/**
 * console.flag handler: fetches this plugin's own backend config once and
 * sets both logs flags from it, so a cluster admin can flip either
 * NODE_LOGS_ENABLED/POD_LOGS_ENABLED env var on the plugin's Deployment to
 * hand a tab back to console core without touching the frontend build. Both
 * are off in the backend by default, and on fetch failure both flags stay
 * unset -- either way core keeps serving its own Logs tabs.
 */
export const setLoggingPluginFlags = (setFeatureFlag: SetFeatureFlag): void => {
  loadPluginConfig()
    .then((config) => {
      setFeatureFlag(NODE_LOGS_FLAG, !!config.nodeLogsEnabled);
      setFeatureFlag(POD_LOGS_FLAG, !!config.podLogsEnabled);
    })
    .catch(() => {
      setFeatureFlag(NODE_LOGS_FLAG, false);
      setFeatureFlag(POD_LOGS_FLAG, false);
    });
};

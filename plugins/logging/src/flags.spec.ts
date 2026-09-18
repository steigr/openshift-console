import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { NODE_LOGS_FLAG, POD_LOGS_FLAG, setLoggingPluginFlags } from './flags';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(),
}));

const fetchJSON = consoleFetchJSON as unknown as jest.Mock;

// Lets the handler's own .then()/.catch() run before the assertions.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('setLoggingPluginFlags', () => {
  let setFeatureFlag: jest.Mock;

  beforeEach(() => {
    fetchJSON.mockReset();
    setFeatureFlag = jest.fn();
    delete window.SERVER_FLAGS;
  });

  it('reads the config from the plugin asset route', async () => {
    fetchJSON.mockResolvedValue({});
    setLoggingPluginFlags(setFeatureFlag);
    await flush();

    expect(fetchJSON).toHaveBeenCalledWith(
      '/api/plugins/logging-console-plugin/config.json',
    );
  });

  it('reads it under the base path console is served at', async () => {
    window.SERVER_FLAGS = { basePath: '/console/' };
    fetchJSON.mockResolvedValue({});
    setLoggingPluginFlags(setFeatureFlag);
    await flush();

    expect(fetchJSON).toHaveBeenCalledWith(
      '/console/api/plugins/logging-console-plugin/config.json',
    );
  });

  it('sets both flags from the config', async () => {
    fetchJSON.mockResolvedValue({
      nodeLogsEnabled: true,
      podLogsEnabled: true,
    });
    setLoggingPluginFlags(setFeatureFlag);
    await flush();

    expect(setFeatureFlag).toHaveBeenCalledWith(NODE_LOGS_FLAG, true);
    expect(setFeatureFlag).toHaveBeenCalledWith(POD_LOGS_FLAG, true);
  });

  it('leaves a tab to console core when its flag is off or missing', async () => {
    fetchJSON.mockResolvedValue({ nodeLogsEnabled: true });
    setLoggingPluginFlags(setFeatureFlag);
    await flush();

    expect(setFeatureFlag).toHaveBeenCalledWith(NODE_LOGS_FLAG, true);
    expect(setFeatureFlag).toHaveBeenCalledWith(POD_LOGS_FLAG, false);
  });

  it('leaves both tabs to console core when the config cannot be read', async () => {
    fetchJSON.mockRejectedValue(new Error('404'));
    setLoggingPluginFlags(setFeatureFlag);
    await flush();

    expect(setFeatureFlag).toHaveBeenCalledWith(NODE_LOGS_FLAG, false);
    expect(setFeatureFlag).toHaveBeenCalledWith(POD_LOGS_FLAG, false);
  });
});

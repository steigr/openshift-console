import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { resetPluginConfig } from '../../shared/config';
import { POD_BROWSER_FLAG, setFilesystemPluginFlags } from '../filesystemFlags';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(),
}));

const mockedFetch = consoleFetchJSON as unknown as jest.Mock;

/** Lets the config fetch and the handler's own .then() both settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('setFilesystemPluginFlags', () => {
  beforeEach(() => {
    resetPluginConfig();
    mockedFetch.mockReset();
  });

  it('sets the flag from the backend config', async () => {
    mockedFetch.mockResolvedValue({ podFileBrowserEnabled: true });
    const setFeatureFlag = jest.fn();

    setFilesystemPluginFlags(setFeatureFlag);
    await flush();

    expect(setFeatureFlag).toHaveBeenCalledWith(POD_BROWSER_FLAG, true);
  });

  it('reads it from the asset route, which needs no feature flag to be set first', () => {
    mockedFetch.mockResolvedValue({});
    setFilesystemPluginFlags(jest.fn());

    expect(mockedFetch).toHaveBeenCalledWith(
      '/api/plugins/filesystem-console-plugin/config.json',
    );
  });

  // No backend means nothing the tab could talk to, so the tab does not appear
  // at all rather than appearing and failing on every click.
  it('leaves the flag off when the config cannot be fetched', async () => {
    mockedFetch.mockRejectedValue(new Error('no backend'));
    const setFeatureFlag = jest.fn();

    setFilesystemPluginFlags(setFeatureFlag);
    await flush();

    expect(setFeatureFlag).toHaveBeenCalledWith(POD_BROWSER_FLAG, false);
  });
});

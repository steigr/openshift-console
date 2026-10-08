import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { act, renderHook } from '@testing-library/react';

import { resetPluginConfig } from '../plugin-config';
import { resolveColorScheme, useColorSchemeClass } from './color-schemes';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(),
}));

const fetchJSON = consoleFetchJSON as unknown as jest.Mock;
const flush = () => act(() => Promise.resolve());

describe('useColorSchemeClass', () => {
  beforeEach(() => {
    fetchJSON.mockReset();
    resetPluginConfig();
    document.documentElement.classList.remove('pf-v6-theme-dark');
  });

  it("stays on console's own colors when nothing is configured", async () => {
    fetchJSON.mockResolvedValue({});
    const { result } = renderHook(() => useColorSchemeClass());
    await flush();

    expect(result.current).toBe('logging-color-scheme--default');
  });

  it('uses the scheme configured for the console theme and follows a switch', async () => {
    fetchJSON.mockResolvedValue({
      colorScheme: { light: 'solarized-light', dark: 'solarized-dark' },
    });
    const { result } = renderHook(() => useColorSchemeClass());
    await flush();
    expect(result.current).toBe('logging-color-scheme--solarized-light');

    document.documentElement.classList.add('pf-v6-theme-dark');
    await flush();

    expect(result.current).toBe('logging-color-scheme--solarized-dark');
  });

  it("adds console's content color behind a scheme when asked to", async () => {
    fetchJSON.mockResolvedValue({
      colorScheme: {
        light: 'solarized-light',
        dark: 'solarized-dark',
        background: 'console',
      },
    });
    const { result } = renderHook(() => useColorSchemeClass());
    await flush();

    expect(result.current).toBe(
      'logging-color-scheme--solarized-light logging-color-scheme--console-background',
    );
  });

  it('never adds it to the default scheme, which already uses console colors', async () => {
    fetchJSON.mockResolvedValue({ colorScheme: { background: 'console' } });
    const { result } = renderHook(() => useColorSchemeClass());
    await flush();

    expect(result.current).toBe('logging-color-scheme--default');
  });

  it('stays on the default when the config cannot be read', async () => {
    fetchJSON.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useColorSchemeClass());
    await flush();

    expect(result.current).toBe('logging-color-scheme--default');
  });
});

describe('resolveColorScheme', () => {
  it('falls back to the default for an unknown name', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    expect(resolveColorScheme('no-such-scheme')).toBe('default');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

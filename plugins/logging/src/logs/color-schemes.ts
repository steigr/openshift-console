import { useEffect, useState } from 'react';

import { useConsoleTheme } from '../console-theme';
import { loadPluginConfig } from '../plugin-config';

/**
 * Schemes the log panel can be drawn in, selectable by name per console theme
 * (chart `colorScheme.light`/`.dark`). Each is a CSS class on the panel that
 * sets the `--logging-log-*` variables log-viewer.css falls back from;
 * `default` sets none, which leaves the panel on console's own colors.
 */
export const COLOR_SCHEMES = [
  'default',
  'solarized-light',
  'solarized-dark',
] as const;

export type ColorSchemeName = (typeof COLOR_SCHEMES)[number];

export const resolveColorScheme = (
  name: string | undefined,
): ColorSchemeName => {
  if (!name) {
    return 'default';
  }
  if ((COLOR_SCHEMES as readonly string[]).includes(name)) {
    return name as ColorSchemeName;
  }

  console.warn(
    `logging-console-plugin: unknown color scheme "${name}", using the default`,
  );
  return 'default';
};

interface ColorSchemeConfig {
  light?: string;
  dark?: string;
  background?: string;
}

/**
 * The classes for the scheme configured for the console theme in effect,
 * plus `logging-color-scheme--console-background` when the config asks for
 * console's content color behind the scheme. The `default` scheme already
 * sits on console's colors, so it never gets the extra class.
 */
export const useColorSchemeClass = (): string => {
  const consoleTheme = useConsoleTheme();
  const [config, setConfig] = useState<ColorSchemeConfig>({});
  useEffect(() => {
    let cancelled = false;
    loadPluginConfig()
      .then((pluginConfig) => {
        if (!cancelled) {
          setConfig(pluginConfig.colorScheme ?? {});
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const scheme = resolveColorScheme(config[consoleTheme]);
  const schemeClass = `logging-color-scheme--${scheme}`;
  return config.background === 'console' && scheme !== 'default'
    ? `${schemeClass} logging-color-scheme--console-background`
    : schemeClass;
};

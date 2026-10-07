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

/** The class for the scheme configured for the console theme in effect. */
export const useColorSchemeClass = (): string => {
  const consoleTheme = useConsoleTheme();
  const [names, setNames] = useState<{ light?: string; dark?: string }>({});
  useEffect(() => {
    let cancelled = false;
    loadPluginConfig()
      .then((config) => {
        if (!cancelled) {
          setNames(config.colorScheme ?? {});
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return `logging-color-scheme--${resolveColorScheme(names[consoleTheme])}`;
};

import { useEffect, useState } from 'react';
import type { ISearchDecorationOptions } from '@xterm/addon-search';
import type { ITheme } from '@xterm/xterm';

import { useConsoleTheme } from './consoleTheme';
import { loadPluginConfig } from './pluginConfig';

export type ColorScheme = {
  theme: ITheme;
  /** Search highlights readable on this scheme's background. */
  searchDecorations: ISearchDecorationOptions;
};

const darkSearchDecorations: ColorScheme['searchDecorations'] = {
  matchBackground: '#3d3d00',
  matchBorder: '#7d7d00',
  matchOverviewRuler: '#7d7d00',
  activeMatchBackground: '#515c00',
  activeMatchBorder: '#c9c900',
  activeMatchColorOverviewRuler: '#c9c900',
};

// https://ethanschoonover.com/solarized/ -- the ANSI mapping is Solarized's own (bright
// green/yellow/blue/cyan are the base tones), which is what its terminal ports ship.
const solarized = {
  base03: '#002b36',
  base02: '#073642',
  base01: '#586e75',
  base00: '#657b83',
  base0: '#839496',
  base1: '#93a1a1',
  base2: '#eee8d5',
  base3: '#fdf6e3',
  yellow: '#b58900',
  orange: '#cb4b16',
  red: '#dc322f',
  magenta: '#d33682',
  violet: '#6c71c4',
  blue: '#268bd2',
  cyan: '#2aa198',
  green: '#859900',
};

const solarizedAnsi: ITheme = {
  black: solarized.base02,
  red: solarized.red,
  green: solarized.green,
  yellow: solarized.yellow,
  blue: solarized.blue,
  magenta: solarized.magenta,
  cyan: solarized.cyan,
  white: solarized.base2,
  brightBlack: solarized.base03,
  brightRed: solarized.orange,
  brightGreen: solarized.base01,
  brightYellow: solarized.base00,
  brightBlue: solarized.base0,
  brightMagenta: solarized.violet,
  brightCyan: solarized.base1,
  brightWhite: solarized.base3,
};

/**
 * Selectable by name from the plugin's config (chart `colorScheme.light`/`.dark`). `default` is
 * xterm.js's own palette, which is what the terminals used before schemes existed.
 */
export const colorSchemes: Record<string, ColorScheme> = {
  default: { theme: {}, searchDecorations: darkSearchDecorations },
  'solarized-dark': {
    theme: {
      ...solarizedAnsi,
      background: solarized.base03,
      foreground: solarized.base0,
      cursor: solarized.base1,
      cursorAccent: solarized.base03,
      selectionBackground: solarized.base02,
    },
    searchDecorations: {
      matchBackground: solarized.base02,
      matchBorder: solarized.yellow,
      matchOverviewRuler: solarized.yellow,
      activeMatchBackground: '#3d4a00',
      activeMatchBorder: solarized.orange,
      activeMatchColorOverviewRuler: solarized.orange,
    },
  },
  'solarized-light': {
    theme: {
      ...solarizedAnsi,
      background: solarized.base3,
      foreground: solarized.base00,
      cursor: solarized.base01,
      cursorAccent: solarized.base3,
      selectionBackground: solarized.base2,
      selectionInactiveBackground: solarized.base2,
    },
    searchDecorations: {
      matchBackground: '#f5e7b0',
      matchBorder: solarized.yellow,
      matchOverviewRuler: solarized.yellow,
      activeMatchBackground: '#f0c987',
      activeMatchBorder: solarized.orange,
      activeMatchColorOverviewRuler: solarized.orange,
    },
  },
};

export const resolveColorScheme = (name: string | undefined): ColorScheme => {
  if (!name) {
    return colorSchemes.default;
  }
  const scheme = colorSchemes[name];
  if (!scheme) {
    // eslint-disable-next-line no-console
    console.warn(`terminal-console-plugin: unknown color scheme "${name}", using the default`);
    return colorSchemes.default;
  }
  return scheme;
};

/** The color scheme configured for the console theme currently in effect. */
export const useColorScheme = (): ColorScheme => {
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
  return resolveColorScheme(names[consoleTheme]);
};

import { useEffect, useMemo, useState } from 'react';
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

// https://github.com/morhetz/gruvbox -- medium contrast, with the ANSI mapping of its own terminal
// ports: the normal colors are the neutral tones, the bright ones the faded (light) or bright
// (dark) tones.
const gruvbox = {
  dark0: '#282828',
  dark1: '#3c3836',
  dark2: '#504945',
  dark3: '#665c54',
  dark4: '#7c6f64',
  gray: '#928374',
  light0: '#fbf1c7',
  light1: '#ebdbb2',
  light2: '#d5c4a1',
  light4: '#a89984',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  purple: '#b16286',
  aqua: '#689d6a',
  orange: '#d65d0e',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightPurple: '#d3869b',
  brightAqua: '#8ec07c',
  brightOrange: '#fe8019',
  fadedRed: '#9d0006',
  fadedGreen: '#79740e',
  fadedYellow: '#b57614',
  fadedBlue: '#076678',
  fadedPurple: '#8f3f71',
  fadedAqua: '#427b58',
  fadedOrange: '#af3a03',
};

const gruvboxNeutral: ITheme = {
  red: gruvbox.red,
  green: gruvbox.green,
  yellow: gruvbox.yellow,
  blue: gruvbox.blue,
  magenta: gruvbox.purple,
  cyan: gruvbox.aqua,
  brightBlack: gruvbox.gray,
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
  'gruvbox-dark': {
    theme: {
      ...gruvboxNeutral,
      black: gruvbox.dark0,
      white: gruvbox.light4,
      brightRed: gruvbox.brightRed,
      brightGreen: gruvbox.brightGreen,
      brightYellow: gruvbox.brightYellow,
      brightBlue: gruvbox.brightBlue,
      brightMagenta: gruvbox.brightPurple,
      brightCyan: gruvbox.brightAqua,
      brightWhite: gruvbox.light1,
      background: gruvbox.dark0,
      foreground: gruvbox.light1,
      cursor: gruvbox.light1,
      cursorAccent: gruvbox.dark0,
      selectionBackground: gruvbox.dark2,
    },
    searchDecorations: {
      matchBackground: gruvbox.dark2,
      matchBorder: gruvbox.yellow,
      matchOverviewRuler: gruvbox.yellow,
      activeMatchBackground: gruvbox.dark3,
      activeMatchBorder: gruvbox.brightOrange,
      activeMatchColorOverviewRuler: gruvbox.brightOrange,
    },
  },
  'gruvbox-light': {
    theme: {
      ...gruvboxNeutral,
      black: gruvbox.light0,
      white: gruvbox.dark4,
      brightRed: gruvbox.fadedRed,
      brightGreen: gruvbox.fadedGreen,
      brightYellow: gruvbox.fadedYellow,
      brightBlue: gruvbox.fadedBlue,
      brightMagenta: gruvbox.fadedPurple,
      brightCyan: gruvbox.fadedAqua,
      brightWhite: gruvbox.dark1,
      background: gruvbox.light0,
      foreground: gruvbox.dark1,
      cursor: gruvbox.dark1,
      cursorAccent: gruvbox.light0,
      selectionBackground: gruvbox.light2,
      selectionInactiveBackground: gruvbox.light2,
    },
    searchDecorations: {
      matchBackground: '#f2dfa0',
      matchBorder: gruvbox.fadedYellow,
      matchOverviewRuler: gruvbox.fadedYellow,
      activeMatchBackground: '#f5c58c',
      activeMatchBorder: gruvbox.fadedOrange,
      activeMatchColorOverviewRuler: gruvbox.fadedOrange,
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

const CONTENT_BACKGROUND_TOKEN = '--pf-t--global--background--color--primary--default';

const parseHex = (color: string): [number, number, number] | undefined => {
  const hex = color.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as [number, number, number];
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  return undefined;
};

/** `amount` of `top` over `base`, as #rrggbb; undefined unless both are hex colors. */
export const mixHex = (base: string, top: string, amount: number): string | undefined => {
  const a = parseHex(base);
  const b = parseHex(top);
  if (!a || !b) {
    return undefined;
  }
  return `#${a
    .map((channel, i) =>
      Math.round(channel + (b[i] - channel) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};

/**
 * `scheme` with its background replaced by console's content-area color (PatternFly's primary
 * background, which console's `--theme-*-content` sets), so the terminal sits flush in the page.
 * Selection is re-derived from the scheme's own foreground, since a scheme's selection color is
 * often exactly the color now underneath it (Solarized dark: base02 for both). A scheme without
 * a foreground (`default`, white on black) is left alone -- its text color was never chosen to
 * work on console's background, light or dark.
 */
export const withConsoleBackground = (scheme: ColorScheme): ColorScheme => {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue(CONTENT_BACKGROUND_TOKEN)
    .trim();
  const { foreground } = scheme.theme;
  if (!background || !foreground) {
    return scheme;
  }
  const selection = mixHex(background, foreground, 0.25);
  return {
    ...scheme,
    theme: {
      ...scheme.theme,
      background,
      cursorAccent: background,
      ...(selection && {
        selectionBackground: selection,
        selectionInactiveBackground: selection,
      }),
    },
  };
};

type ColorSchemeConfig = { light?: string; dark?: string; background?: string };

/** The color scheme configured for the console theme currently in effect. */
export const useColorScheme = (): ColorScheme => {
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
  // Memoised on the console theme too: that is what changes the content color underneath, and a
  // fresh object on every render would make the terminal repaint on every render.
  return useMemo(
    () => (config.background === 'console' ? withConsoleBackground(scheme) : scheme),
    [scheme, config.background, consoleTheme],
  );
};

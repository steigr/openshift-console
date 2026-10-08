import { colorSchemes, mixHex, resolveColorScheme } from '../colorSchemes';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(),
}));

describe('mixHex', () => {
  it('blends top over base by the given amount', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#073642', '#839496', 0)).toBe('#073642');
    expect(mixHex('#073642', '#839496', 1)).toBe('#839496');
  });

  it('accepts short and alpha hex forms', () => {
    expect(mixHex('#000', '#fff', 0.5)).toBe('#808080');
    expect(mixHex('#000000ff', '#ffffff80', 1)).toBe('#ffffff');
  });

  it('gives up on anything that is not hex', () => {
    expect(mixHex('rgb(0, 0, 0)', '#ffffff', 0.5)).toBeUndefined();
    expect(mixHex('#000000', 'white', 0.5)).toBeUndefined();
  });
});

describe('color schemes', () => {
  it.each(['solarized-light', 'solarized-dark', 'gruvbox-light', 'gruvbox-dark'])(
    '%s is selectable and defines a full palette',
    (name) => {
      const scheme = resolveColorScheme(name);
      expect(scheme).toBe(colorSchemes[name]);
      for (const key of [
        'background',
        'foreground',
        'cursor',
        'selectionBackground',
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite',
      ]) {
        expect(scheme.theme[key as keyof typeof scheme.theme]).toMatch(/^#[0-9a-f]{6}$/);
      }
      // xterm's search addon only takes #RRGGBB backgrounds.
      expect(scheme.searchDecorations.matchBackground).toMatch(/^#[0-9a-f]{6}$/);
      expect(scheme.searchDecorations.activeMatchBackground).toMatch(/^#[0-9a-f]{6}$/);
    },
  );

  it('gives gruvbox its own backgrounds', () => {
    expect(resolveColorScheme('gruvbox-dark').theme.background).toBe('#282828');
    expect(resolveColorScheme('gruvbox-light').theme.background).toBe('#fbf1c7');
  });
});

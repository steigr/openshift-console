import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

type CustomKeyEventHandler = (event: {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}) => boolean;

const terminalInstances: MockXTerminal[] = [];
const searchInstances: MockSearchAddon[] = [];

class MockXTerminal {
  options: { disableStdin?: boolean; theme?: Record<string, string>; fontFamily?: string } = {};
  rows = 32;
  cols = 166;
  open = jest.fn();
  focus = jest.fn();
  write = jest.fn();
  dispose = jest.fn();
  loadAddon = jest.fn();
  onData = jest.fn(() => ({ dispose: jest.fn() }));
  onResize = jest.fn(() => ({ dispose: jest.fn() }));
  customKeyEventHandler: CustomKeyEventHandler | undefined;

  constructor(options: { theme?: Record<string, string>; fontFamily?: string } = {}) {
    this.options.theme = options.theme;
    this.options.fontFamily = options.fontFamily;
    terminalInstances.push(this);
  }

  attachCustomKeyEventHandler(handler: CustomKeyEventHandler) {
    this.customKeyEventHandler = handler;
  }
}

class MockFitAddon {
  fit = jest.fn();
}

class MockImageAddon {}

class MockSearchAddon {
  findNext = jest.fn();
  findPrevious = jest.fn();
  clearDecorations = jest.fn();
  onDidChangeResults = jest.fn(() => ({ dispose: jest.fn() }));

  constructor() {
    searchInstances.push(this);
  }
}

jest.mock('@xterm/xterm', () => ({ Terminal: MockXTerminal }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
jest.mock('@xterm/addon-image', () => ({ ImageAddon: MockImageAddon }));
jest.mock('@xterm/addon-search', () => ({ SearchAddon: MockSearchAddon }));

const consoleFetchJSON = jest.fn();
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: (...args: unknown[]) => consoleFetchJSON(...args),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_match, name) => String(options?.[name])),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Terminal } = require('../Terminal');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetPluginConfig } = require('../pluginConfig');

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  // ResizeObserver isn't implemented in jsdom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe = jest.fn();
    disconnect = jest.fn();
  };
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

beforeEach(() => {
  terminalInstances.length = 0;
  searchInstances.length = 0;
  jest.clearAllMocks();
  resetPluginConfig();
  consoleFetchJSON.mockResolvedValue({ podTerminalEnabled: true, nodeTerminalEnabled: true });
  document.documentElement.classList.remove('pf-v6-theme-dark');
});

const emitCtrlF = () => {
  const handler = terminalInstances[0].customKeyEventHandler!;
  const preventDefault = jest.fn();
  act(() => {
    handler({
      type: 'keydown',
      key: 'f',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      preventDefault,
    });
  });
  return preventDefault;
};

describe('Terminal search overlay', () => {
  it('registers a custom key handler that intercepts Ctrl+F', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);

    expect(terminalInstances[0].customKeyEventHandler).toBeDefined();
  });

  it('opens the search overlay on Ctrl+F and prevents the default browser find', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);

    expect(screen.queryByTestId('terminal-search')).toBeNull();

    const preventDefault = emitCtrlF();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('terminal-search')).toBeTruthy();
  });

  it('does not treat Ctrl+F combined with Alt (or other letters) as the shortcut', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);

    const handler = terminalInstances[0].customKeyEventHandler!;
    let handled: boolean;
    act(() => {
      handled = handler({
        type: 'keydown',
        key: 'f',
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        preventDefault: jest.fn(),
      });
    });

    expect(handled!).toBe(true);
    expect(screen.queryByTestId('terminal-search')).toBeNull();
  });

  it('closes the overlay and clears decorations on Escape', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    emitCtrlF();

    fireEvent.keyDown(screen.getByTestId('terminal-search-input'), { key: 'Escape' });

    expect(searchInstances[0].clearDecorations).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('terminal-search')).toBeNull();
  });

  it('finds next/previous as the user types and navigates', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    emitCtrlF();

    fireEvent.change(screen.getByTestId('terminal-search-input'), { target: { value: 'error' } });
    expect(searchInstances[0].findNext).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ incremental: true }),
    );

    fireEvent.click(screen.getByTestId('terminal-search-next'));
    fireEvent.click(screen.getByTestId('terminal-search-previous'));

    expect(searchInstances[0].findNext).toHaveBeenCalledTimes(2);
    expect(searchInstances[0].findPrevious).toHaveBeenCalledTimes(1);
  });

  it('closes the overlay when Ctrl+F is pressed again while the search input is focused', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    emitCtrlF();

    fireEvent.keyDown(screen.getByTestId('terminal-search-input'), {
      key: 'f',
      ctrlKey: true,
    });

    expect(screen.queryByTestId('terminal-search')).toBeNull();
  });
});

describe('Terminal color scheme', () => {
  const flush = () => act(() => Promise.resolve());

  it("keeps xterm's default palette when no scheme is configured", async () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();

    expect(terminalInstances[0].options.theme).toEqual({});
  });

  it('applies the scheme configured for the console theme in effect', async () => {
    consoleFetchJSON.mockResolvedValue({
      podTerminalEnabled: true,
      nodeTerminalEnabled: true,
      colorScheme: { light: 'solarized-light', dark: 'solarized-dark' },
    });
    document.documentElement.classList.add('pf-v6-theme-dark');
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();

    expect(terminalInstances[0].options.theme?.background).toBe('#002b36');
    expect(screen.getByTestId('terminal-screen').style.backgroundColor).toBe('rgb(0, 43, 54)');
  });

  it('follows a console theme switch without recreating the terminal', async () => {
    consoleFetchJSON.mockResolvedValue({
      podTerminalEnabled: true,
      nodeTerminalEnabled: true,
      colorScheme: { light: 'solarized-light', dark: 'solarized-dark' },
    });
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();
    expect(terminalInstances[0].options.theme?.background).toBe('#fdf6e3');

    document.documentElement.classList.add('pf-v6-theme-dark');
    await flush();

    expect(terminalInstances).toHaveLength(1);
    expect(terminalInstances[0].options.theme?.background).toBe('#002b36');
  });

  it('falls back to the default palette for an unknown scheme name', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleFetchJSON.mockResolvedValue({
      podTerminalEnabled: true,
      nodeTerminalEnabled: true,
      colorScheme: { light: 'no-such-scheme' },
    });
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();

    expect(terminalInstances[0].options.theme).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Terminal background from console', () => {
  const flush = () => act(() => Promise.resolve());
  const token = '--pf-t--global--background--color--primary--default';

  afterEach(() => {
    document.documentElement.style.removeProperty(token);
  });

  it("uses console's content color, with a selection that stays visible on it", async () => {
    document.documentElement.style.setProperty(token, '#073642');
    document.documentElement.classList.add('pf-v6-theme-dark');
    consoleFetchJSON.mockResolvedValue({
      podTerminalEnabled: true,
      nodeTerminalEnabled: true,
      colorScheme: { light: 'solarized-light', dark: 'solarized-dark', background: 'console' },
    });
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();

    // #073642 set off 20% toward black: a little darker than the page in dark.
    const theme = terminalInstances[0].options.theme!;
    expect(theme.background).toBe('#062b35');
    expect(theme.cursorAccent).toBe('#062b35');
    expect(theme.foreground).toBe('#839496');
    expect(theme.selectionBackground).not.toBe('#062b35');
    expect(screen.getByTestId('terminal-screen').style.backgroundColor).toBe('rgb(6, 43, 53)');
  });

  it('follows the content color across a theme switch', async () => {
    document.documentElement.style.setProperty(token, '#fdf6e3');
    consoleFetchJSON.mockResolvedValue({
      podTerminalEnabled: true,
      nodeTerminalEnabled: true,
      colorScheme: { light: 'solarized-light', dark: 'solarized-dark', background: 'console' },
    });
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();
    // #fdf6e3 set off 50% toward white: a little brighter than the page in light.
    expect(terminalInstances[0].options.theme?.background).toBe('#fefbf1');

    document.documentElement.style.setProperty(token, '#073642');
    document.documentElement.classList.add('pf-v6-theme-dark');
    await flush();

    expect(terminalInstances[0].options.theme?.background).toBe('#062b35');
  });

  it('leaves the default scheme alone, whose text color was never chosen for console', async () => {
    document.documentElement.style.setProperty(token, '#fdf6e3');
    consoleFetchJSON.mockResolvedValue({
      podTerminalEnabled: true,
      nodeTerminalEnabled: true,
      colorScheme: { background: 'console' },
    });
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await flush();

    expect(terminalInstances[0].options.theme).toEqual({});
  });
});

describe('Terminal font loading', () => {
  let resolveFonts: () => void;
  let loaded: Promise<void>;
  const fonts = {
    check: jest.fn(() => false),
    // Both weights resolve together, once the test says so.
    load: jest.fn(() => loaded),
  };

  beforeEach(() => {
    loaded = new Promise<void>((resolve) => (resolveFonts = resolve));
    fonts.check.mockReset().mockReturnValue(false);
    fonts.load.mockClear();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });
  afterEach(() => {
    delete (document as { fonts?: unknown }).fonts;
    jest.useRealTimers();
  });

  it('opens xterm only once the terminal font has loaded, so it measures the real glyphs', async () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    expect(fonts.load).toHaveBeenCalledWith("normal 16px 'VictorMono Nerd Font Propo'");
    expect(fonts.load).toHaveBeenCalledWith("bold 16px 'VictorMono Nerd Font Propo'");
    expect(terminalInstances[0].open).not.toHaveBeenCalled();

    await act(async () => resolveFonts());

    expect(terminalInstances[0].open).toHaveBeenCalledTimes(1);
  });

  it('opens on the fallback after the timeout and re-measures once the font arrives', async () => {
    jest.useFakeTimers();
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(terminalInstances[0].open).toHaveBeenCalledTimes(1);
    const familyBefore = terminalInstances[0].options.fontFamily;

    await act(async () => resolveFonts());

    expect(terminalInstances[0].open).toHaveBeenCalledTimes(1);
    expect(terminalInstances[0].options.fontFamily).not.toBe(familyBefore);
    expect(terminalInstances[0].options.fontFamily).toContain('VictorMono Nerd Font Propo');
  });

  it('opens straight away when the font is already loaded', () => {
    fonts.check.mockReturnValue(true);
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);

    expect(terminalInstances[0].open).toHaveBeenCalledTimes(1);
  });
});

describe('Terminal background strip', () => {
  it("paints the container in xterm's default black for a scheme without a background", async () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    await act(() => Promise.resolve());

    // The strip below the last whole row shows the container, not xterm's viewport.
    expect(screen.getByTestId('terminal-screen').style.backgroundColor).toBe('rgb(0, 0, 0)');
  });
});

describe('Terminal size reporting', () => {
  it('reports its size once after opening, even if fitting changed nothing', () => {
    const onResize = jest.fn();
    render(<Terminal onData={jest.fn()} onResize={onResize} />);

    expect(onResize).toHaveBeenCalledWith(32, 166);
  });
});

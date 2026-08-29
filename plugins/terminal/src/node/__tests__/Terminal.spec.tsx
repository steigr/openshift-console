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
  options: { disableStdin?: boolean } = {};
  open = jest.fn();
  focus = jest.fn();
  write = jest.fn();
  dispose = jest.fn();
  loadAddon = jest.fn();
  onData = jest.fn(() => ({ dispose: jest.fn() }));
  onResize = jest.fn(() => ({ dispose: jest.fn() }));
  customKeyEventHandler: CustomKeyEventHandler | undefined;

  constructor() {
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

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_match, name) => String(options?.[name])),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Terminal } = require('../Terminal');

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
});

const emitCtrlF = () => {
  const handler = terminalInstances[0].customKeyEventHandler!;
  const preventDefault = jest.fn();
  act(() => {
    handler({ type: 'keydown', key: 'f', ctrlKey: true, metaKey: false, altKey: false, preventDefault });
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

    expect(screen.queryByTestId('node-terminal-search')).toBeNull();

    const preventDefault = emitCtrlF();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('node-terminal-search')).toBeTruthy();
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
    expect(screen.queryByTestId('node-terminal-search')).toBeNull();
  });

  it('closes the overlay and clears decorations on Escape', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    emitCtrlF();

    fireEvent.keyDown(screen.getByTestId('node-terminal-search-input'), { key: 'Escape' });

    expect(searchInstances[0].clearDecorations).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('node-terminal-search')).toBeNull();
  });

  it('finds next/previous as the user types and navigates', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    emitCtrlF();

    fireEvent.change(screen.getByTestId('node-terminal-search-input'), { target: { value: 'error' } });
    expect(searchInstances[0].findNext).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ incremental: true }),
    );

    fireEvent.click(screen.getByTestId('node-terminal-search-next'));
    fireEvent.click(screen.getByTestId('node-terminal-search-previous'));

    expect(searchInstances[0].findNext).toHaveBeenCalledTimes(2);
    expect(searchInstances[0].findPrevious).toHaveBeenCalledTimes(1);
  });

  it('closes the overlay when Ctrl+F is pressed again while the search input is focused', () => {
    render(<Terminal onData={jest.fn()} onResize={jest.fn()} />);
    emitCtrlF();

    fireEvent.keyDown(screen.getByTestId('node-terminal-search-input'), {
      key: 'f',
      ctrlKey: true,
    });

    expect(screen.queryByTestId('node-terminal-search')).toBeNull();
  });
});

import * as React from 'react';
import type { ForwardedRef, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextInput } from '@patternfly/react-core';
import { AngleDownIcon, AngleUpIcon, TimesIcon } from '@patternfly/react-icons';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { SearchAddon } from '@xterm/addon-search';
import type { ITerminalOptions } from '@xterm/xterm';
import { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './fonts/fonts.css';

const defaultOptions: ITerminalOptions = {
  fontFamily: "'VictorMono Nerd Font Propo', 'Red Hat Mono', monospace",
  fontSize: 16,
  cursorBlink: false,
};

export type ImperativeTerminalType = {
  focus: () => void;
  onDataReceived: (data: string) => void;
  onConnectionClosed: (msg: string) => void;
};

export type TerminalProps = {
  onData: (data: string) => void;
  onResize: (rows: number, cols: number) => void;
};

/** Ctrl+F on any platform, or Cmd+F on macOS - never Ctrl+Cmd+F etc. */
const isFindShortcut = (event: KeyboardEvent | ReactKeyboardEvent): boolean =>
  event.key.toLowerCase() === 'f' &&
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !(event.ctrlKey && event.metaKey);

/**
 * A minimal xterm.js wrapper - the plugin equivalent of console core's own
 * `./terminal` (frontend/public/components/terminal.tsx), reimplemented here
 * since that component isn't part of the public dynamic-plugin-sdk. Sized by
 * its `.terminal-xterm__screen` CSS class (flex height), rather than
 * porting core's manual pixel-measurement resize logic.
 *
 * Bundles the search addon (Ctrl+F/Cmd+F toggles a small overlay, top right)
 * and the image addon (sixel + iTerm image protocol support).
 */
export const Terminal = forwardRef(
  ({ onData, onResize }: TerminalProps, ref: ForwardedRef<ImperativeTerminalType>) => {
    const { t } = useTranslation('plugin__terminal-console-plugin');
    const terminal = useRef<XTerminal>();
    const searchAddon = useRef<SearchAddon>();
    const containerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const [searchOpen, setSearchOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [resultInfo, setResultInfo] = useState<{ resultIndex: number; resultCount: number }>({
      resultIndex: -1,
      resultCount: 0,
    });

    const closeSearch = useCallback(() => {
      setSearchOpen(false);
      searchAddon.current?.clearDecorations();
      terminal.current?.focus();
    }, []);

    const openSearch = useCallback(() => {
      setSearchOpen(true);
      // Deferred: the input isn't mounted yet on the render that flips searchOpen.
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }, []);

    useEffect(() => {
      const term = new XTerminal({ ...defaultOptions });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new ImageAddon());
      terminal.current = term;
      searchAddon.current = search;

      // Ctrl+F/Cmd+F while the terminal itself is focused: open the search
      // overlay instead of sending the keystroke to the remote session, and
      // instead of the browser's own find-in-page.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && isFindShortcut(event)) {
          event.preventDefault();
          openSearch();
          return false;
        }
        return true;
      });

      let observer: ResizeObserver;
      if (containerRef.current) {
        term.open(containerRef.current);
        term.focus();
        fit.fit();
        observer = new ResizeObserver(() => {
          fit.fit();
        });
        observer.observe(containerRef.current);
      }

      const dataListener = term.onData(onData);
      const resizeListener = term.onResize(({ rows, cols }) => onResize(rows, cols));
      const resultsListener = search.onDidChangeResults((event) => setResultInfo(event));

      return () => {
        dataListener.dispose();
        resizeListener.dispose();
        resultsListener.dispose();
        observer?.disconnect();
        term.dispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => terminal.current?.focus(),
      onDataReceived: (data: string) => terminal.current?.write(data),
      onConnectionClosed: (msg: string) => {
        if (!terminal.current) {
          return;
        }
        terminal.current.write(`\x1b[31m${msg || 'disconnected'}\x1b[m\r\n`);
        terminal.current.options.disableStdin = true;
      },
    }));

    const findNext = useCallback(
      () => searchAddon.current?.findNext(searchTerm, { decorations: searchDecorations }),
      [searchTerm],
    );
    const findPrevious = useCallback(
      () => searchAddon.current?.findPrevious(searchTerm, { decorations: searchDecorations }),
      [searchTerm],
    );

    const onSearchInputChange = useCallback(
      (_event: unknown, value: string) => {
        setSearchTerm(value);
        if (value) {
          searchAddon.current?.findNext(value, {
            decorations: searchDecorations,
            incremental: true,
          });
        } else {
          searchAddon.current?.clearDecorations();
        }
      },
      [],
    );

    const onSearchKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape' || isFindShortcut(event)) {
          event.preventDefault();
          closeSearch();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) {
            findPrevious();
          } else {
            findNext();
          }
        }
      },
      [closeSearch, findNext, findPrevious],
    );

    return (
      <div className="terminal-xterm__screen-wrap">
        {searchOpen && (
          <div className="terminal-xterm__search" data-test="terminal-search">
            <TextInput
              ref={searchInputRef}
              type="text"
              value={searchTerm}
              onChange={onSearchInputChange}
              onKeyDown={onSearchKeyDown}
              aria-label={t('Find')}
              placeholder={t('Find')}
              data-test="terminal-search-input"
            />
            <span className="terminal-xterm__search-count">
              {searchTerm
                ? resultInfo.resultIndex >= 0
                  ? t('{{index}} of {{count}}', {
                      index: resultInfo.resultIndex + 1,
                      count: resultInfo.resultCount,
                    })
                  : t('No results')
                : null}
            </span>
            <Button
              variant="plain"
              aria-label={t('Previous match')}
              onClick={findPrevious}
              data-test="terminal-search-previous"
            >
              <AngleUpIcon />
            </Button>
            <Button
              variant="plain"
              aria-label={t('Next match')}
              onClick={findNext}
              data-test="terminal-search-next"
            >
              <AngleDownIcon />
            </Button>
            <Button
              variant="plain"
              aria-label={t('Close find')}
              onClick={closeSearch}
              data-test="terminal-search-close"
            >
              <TimesIcon />
            </Button>
          </div>
        )}
        <div ref={containerRef} className="terminal-xterm__screen" />
      </div>
    );
  },
);
Terminal.displayName = 'Terminal';

const searchDecorations = {
  matchBackground: '#3d3d00',
  matchBorder: '#7d7d00',
  matchOverviewRuler: '#7d7d00',
  activeMatchBackground: '#515c00',
  activeMatchBorder: '#c9c900',
  activeMatchColorOverviewRuler: '#c9c900',
};

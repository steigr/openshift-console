import * as React from 'react';
import type { ForwardedRef } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import type { ITerminalOptions } from '@xterm/xterm';
import { Terminal as XTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const defaultOptions: ITerminalOptions = {
  fontFamily: 'Red Hat Mono, monospace',
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

/**
 * A minimal xterm.js wrapper - the plugin equivalent of console core's own
 * `./terminal` (frontend/public/components/terminal.tsx), reimplemented here
 * since that component isn't part of the public dynamic-plugin-sdk. Sized by
 * its `.terminal-node-console__screen` CSS class (flex height), rather than
 * porting core's manual pixel-measurement resize logic.
 */
export const Terminal = forwardRef(
  ({ onData, onResize }: TerminalProps, ref: ForwardedRef<ImperativeTerminalType>) => {
    const terminal = useRef<XTerminal>();
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const term = new XTerminal({ ...defaultOptions });
      const fit = new FitAddon();
      term.loadAddon(fit);
      terminal.current = term;

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

      return () => {
        dataListener.dispose();
        resizeListener.dispose();
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

    return <div ref={containerRef} className="terminal-node-console__screen" />;
  },
);
Terminal.displayName = 'Terminal';

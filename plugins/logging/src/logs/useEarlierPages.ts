import { useCallback, useEffect, useRef, useState } from 'react';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

import { splitLines } from './pagination';

export interface EarlierPages {
  /** Fetches and prepends the page before what is held. */
  loadEarlier: () => void;
  /** True while a page is in flight. */
  loading: boolean;
  /** False once the beginning of the log has been reached. */
  canLoad: boolean;
  error: string | null;
}

export interface EarlierPagesOptions {
  /**
   * Fetches the page before what is currently held and returns the lines to
   * put in front of it, oldest first. An empty result means there is nothing
   * earlier, and no further page is requested.
   */
  fetchEarlier: (signal: AbortSignal) => Promise<string[]>;
  /** Adds the lines to the front of the buffer. */
  prepend: (chunk: string) => number;
  /**
   * Changes whenever the thing being read changes (a different container,
   * unit filter or node), which re-arms paging from the new tail.
   */
  resetKey: string;
  /** Paging is pointless before the first page has arrived. */
  ready: boolean;
}

/**
 * Backward paging: one page fetched per call, prepended to the buffer.
 *
 * Kept apart from useLogStream because it is a different shape of request --
 * one-shot and bounded, rather than an open stream -- and because the two run
 * concurrently: a followed log keeps appending at the tail while a page of
 * history is being fetched for the front.
 */
interface PagingState {
  /** Which log this state describes; see the note in useLogStream. */
  key: string;
  loading: boolean;
  canLoad: boolean;
  error: string | null;
}

const freshState = (key: string): PagingState => ({
  key,
  loading: false,
  canLoad: true,
  error: null,
});

export const useEarlierPages = ({
  fetchEarlier,
  prepend,
  resetKey,
  ready,
}: EarlierPagesOptions): EarlierPages => {
  // The state carries the key it was produced for, so switching container or
  // unit filter re-arms paging without an effect resetting four things and
  // cascading a render -- the same shape useLogStream uses.
  const [state, setState] = useState<PagingState>(() => freshState(resetKey));

  // Guards against a second page being requested while one is in flight --
  // the scroll handler fires on every scroll event near the top. A ref, not
  // state: it has to be accurate the instant it is read, not next render.
  const inFlight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  const loadEarlier = useCallback(() => {
    if (inFlight.current !== null) {
      return;
    }
    const key = resetKey;
    const controller = new AbortController();
    inFlight.current = controller;

    const update = (patch: Partial<Omit<PagingState, 'key'>>) => {
      setState((previous) => ({
        ...(previous.key === key ? previous : freshState(key)),
        ...patch,
      }));
    };
    update({ loading: true, error: null });

    void (async () => {
      try {
        const lines = await fetchEarlier(controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        if (lines.length === 0 || prepend(`${lines.join('\n')}\n`) === 0) {
          update({ canLoad: false });
        }
      } catch (caught) {
        if (controller.signal.aborted) {
          return;
        }
        // Do not keep hammering a failing endpoint every time the reader
        // nudges the scrollbar; Reload re-arms it.
        update({
          canLoad: false,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          update({ loading: false });
        }
      }
    })();
  }, [fetchEarlier, prepend, resetKey]);

  // State produced for a different log describes something no longer shown.
  const current = state.key === resetKey ? state : freshState(resetKey);

  return {
    loadEarlier,
    loading: current.loading,
    canLoad: current.canLoad && ready,
    error: current.error,
  };
};

/** Fetches a bounded page and splits it into lines. */
export const fetchLines = async (
  url: string,
  signal: AbortSignal,
): Promise<string[]> => {
  const response = await consoleFetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `${String(response.status)} ${response.statusText || 'request failed'}`,
    );
  }
  return splitLines(await response.text());
};

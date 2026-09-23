import { useCallback, useEffect, useState } from 'react';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

import { LogBuffer } from './buffer';

export interface LogStream {
  buffer: LogBuffer;
  /** Bumped whenever the buffer gained lines; the viewer renders off this. */
  version: number;
  loading: boolean;
  /** True while the response is still open. */
  streaming: boolean;
  error: string | null;
  reload: () => void;
}

interface StreamState {
  /** Which request this state describes; see the note in useLogStream. */
  key: string;
  version: number;
  loading: boolean;
  streaming: boolean;
  error: string | null;
}

const pendingState = (key: string): StreamState => ({
  key,
  version: 0,
  loading: true,
  streaming: false,
  error: null,
});

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** rAF is the right cadence for a live stream, but it does not exist everywhere. */
const scheduleFrame = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(callback);
    return () => {
      cancelAnimationFrame(handle);
    };
  }
  const handle = setTimeout(callback, 16);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * Streams the body of `url` into a {@link LogBuffer}. The caller builds the
 * URL, so the same machinery serves a container log off console's Kubernetes
 * proxy and a node journal off this plugin's own backend.
 *
 * Nothing is parsed here and no per-line object is created: the body is
 * decoded in whatever chunks arrive and handed to the buffer, which indexes
 * line extents and nothing more (see ./buffer.ts). Re-renders are coalesced to
 * one per animation frame, so a container logging in a tight loop costs one
 * render per frame rather than one per chunk.
 */
export const useLogStream = (url: string | null): LogStream => {
  // useState rather than useRef: the buffer is created once and never
  // reassigned, and this keeps it readable during render.
  // Sized for "load the full log": the kubelet's own default retention is a
  // few tens of MB per container, which lands well inside this. Past it the
  // oldest lines are dropped and the tab says so, rather than the tab
  // quietly growing until it takes the browser down.
  const [buffer] = useState(() => new LogBuffer({ maxLines: 500_000 }));

  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  // Identifies the request the state below belongs to. Rather than resetting
  // four pieces of state when the request changes -- which would be a
  // cascading render out of the effect below -- the state carries the key it
  // was produced for, and a mismatch reads as "this request has not reported
  // anything yet".
  const key = JSON.stringify([url, reloadToken]);

  const [state, setState] = useState<StreamState>(() => pendingState(key));

  useEffect(() => {
    if (url === null) {
      return undefined;
    }

    buffer.clear();

    const controller = new AbortController();
    let cancelActiveFrame: (() => void) | null = null;
    // The abort signal is the cancellation flag: the cleanup below aborts it,
    // and every continuation that outlives the effect checks it. Read through
    // a call, because the value flips underneath code that is suspended at an
    // await.
    const { signal } = controller;
    const aborted = () => signal.aborted;

    const update = (patch: Partial<Omit<StreamState, 'key'>>) => {
      if (aborted()) {
        return;
      }
      setState((previous_) => ({
        ...(previous_.key === key ? previous_ : pendingState(key)),
        ...patch,
      }));
    };

    /** One render per frame no matter how fast the container writes. */
    const scheduleRender = () => {
      if (cancelActiveFrame !== null) {
        return;
      }
      cancelActiveFrame = scheduleFrame(() => {
        cancelActiveFrame = null;
        if (aborted()) {
          return;
        }
        setState((previous_) =>
          previous_.key === key
            ? { ...previous_, version: previous_.version + 1 }
            : previous_,
        );
      });
    };

    const run = async () => {
      try {
        const response = await consoleFetch(url, { signal });
        if (aborted()) {
          return;
        }
        if (!response.ok) {
          throw new Error(
            `${String(response.status)} ${
              response.statusText || 'request failed'
            }`,
          );
        }
        update({ loading: false, streaming: true });

        const body = response.body;
        if (!body) {
          // No streaming body (an older browser, or a stubbed fetch): take the
          // whole response at once.
          buffer.append(await response.text());
          buffer.flushPartial();
          scheduleRender();
          return;
        }

        const reader = body.getReader();
        const decoder = new TextDecoder('utf-8');
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborted()) {
            break;
          }
          buffer.append(decoder.decode(value, { stream: true }));
          scheduleRender();
        }
        if (!aborted()) {
          buffer.append(decoder.decode());
          buffer.flushPartial();
          scheduleRender();
        }
      } catch (caught) {
        if (aborted()) {
          return;
        }
        update({ error: messageFor(caught) });
      } finally {
        update({ loading: false, streaming: false });
      }
    };

    void run();

    return () => {
      cancelActiveFrame?.();
      controller.abort();
    };
  }, [buffer, key, url]);

  // State produced for an earlier request describes a log that is no longer on
  // screen, so it reads as the new one still loading.
  const current = state.key === key ? state : pendingState(key);

  return {
    buffer,
    version: current.version,
    loading: current.loading,
    streaming: current.streaming,
    error: current.error,
    reload,
  };
};

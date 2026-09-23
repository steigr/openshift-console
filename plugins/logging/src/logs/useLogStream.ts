import { useCallback, useEffect, useState } from 'react';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

import { consolePath } from '../console-path';
import { LogBuffer } from './buffer';

export interface LogStreamParams {
  namespace: string;
  podName: string;
  container: string;
  /**
   * How many lines to ask for up front, or null for the whole log the node
   * still holds -- however many files the kubelet and container runtime have
   * not yet rotated away.
   */
  tailLines: number | null;
  /** Keep the response open and append as the container writes. */
  follow: boolean;
  /** Read the previous terminated container's log instead. */
  previous: boolean;
}

export interface LogStream {
  buffer: LogBuffer;
  /** Bumped whenever the buffer gained lines; the viewer renders off this. */
  version: number;
  loading: boolean;
  /** True while a `follow` response is still open. */
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

/** Console proxies this straight to the apiserver under the caller's own RBAC. */
const logURL = (params: LogStreamParams): string => {
  const query = new URLSearchParams({ container: params.container });
  // Omitting tailLines entirely is what makes the apiserver serve the log
  // from the beginning of what the node still has on disk.
  if (params.tailLines !== null) {
    query.set('tailLines', String(params.tailLines));
  }
  if (params.follow) {
    query.set('follow', 'true');
  }
  if (params.previous) {
    query.set('previous', 'true');
  }
  return consolePath(
    `/api/kubernetes/api/v1/namespaces/${encodeURIComponent(
      params.namespace,
    )}/pods/${encodeURIComponent(params.podName)}/log?${query.toString()}`,
  );
};

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
 * Streams a container's log into a {@link LogBuffer}.
 *
 * Nothing is parsed here and no per-line object is created: the body is
 * decoded in whatever chunks arrive and handed to the buffer, which indexes
 * line extents and nothing more (see ./buffer.ts). Re-renders are coalesced to
 * one per animation frame, so a container logging in a tight loop costs one
 * render per frame rather than one per chunk.
 */
export const useLogStream = (params: LogStreamParams | null): LogStream => {
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

  const {
    namespace = '',
    podName = '',
    container = '',
    tailLines = null,
    follow = false,
    previous = false,
  } = params ?? {};

  // Identifies the request the state below belongs to. Rather than resetting
  // four pieces of state when the request changes -- which would be a
  // cascading render out of the effect below -- the state carries the key it
  // was produced for, and a mismatch reads as "this request has not reported
  // anything yet".
  const key = JSON.stringify([
    namespace,
    podName,
    container,
    tailLines,
    follow,
    previous,
    reloadToken,
  ]);

  const [state, setState] = useState<StreamState>(() => pendingState(key));

  useEffect(() => {
    if (!namespace || !podName || !container) {
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
        const response = await consoleFetch(
          logURL({
            namespace,
            podName,
            container,
            tailLines,
            follow,
            previous,
          }),
          { signal },
        );
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
        update({ loading: false, streaming: follow });

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
  }, [buffer, key, namespace, podName, container, tailLines, follow, previous]);

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

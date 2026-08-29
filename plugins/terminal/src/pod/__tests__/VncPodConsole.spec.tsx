import * as React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';

import type { PodKind } from '../types';
import { VNC_ENABLED_LABEL, VNC_ENDPOINTS_ANNOTATION } from '../endpoints';

const rfbInstances: MockRFB[] = [];

class MockRFB {
  scaleViewport = false;
  viewOnly = true;
  focus = jest.fn();
  disconnect = jest.fn();
  sendCtrlAltDel = jest.fn();
  sendKey = jest.fn();
  sendCredentials = jest.fn();

  private listeners = new Map<string, (event: unknown) => void>();

  constructor(
    public target: HTMLElement,
    public channel: unknown,
    public options: unknown,
  ) {
    rfbInstances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, listener);
  }

  emit(type: string, event?: unknown) {
    act(() => {
      this.listeners.get(type)?.(event);
    });
  }
}

jest.mock('@novnc/novnc/lib/rfb', () => ({
  __esModule: true,
  default: jest.fn((target, channel, options) => new MockRFB(target, channel, options)),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_match, name) => String(options?.[name])),
  }),
}));

const consoleFetchJSON = jest.fn();
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: (...args: unknown[]) => consoleFetchJSON(...args),
}));

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  readyState = 0;
  binaryType = 'blob';
  protocol = '';
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  close = jest.fn();
  send = jest.fn();

  constructor(
    public url: string,
    public protocols: string[],
  ) {
    sockets.push(this);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = MockWebSocket;

// Imported after the mocks so the component picks them up.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VncPodConsole } = require('../VncPodConsole');

const pod: PodKind = {
  metadata: {
    name: 'desktop-0',
    namespace: 'lab',
    labels: { [VNC_ENABLED_LABEL]: 'true' },
    annotations: {
      [VNC_ENDPOINTS_ANNOTATION]: JSON.stringify([
        { container: 'app', port: 5901 },
        { container: 'sidecar', port: 5902 },
      ]),
    },
  },
  spec: { containers: [{ name: 'app' }, { name: 'sidecar' }, { name: 'logs' }] },
};

const podWithAppAuth = (auth: unknown): PodKind => ({
  ...pod,
  metadata: {
    ...pod.metadata,
    annotations: {
      [VNC_ENDPOINTS_ANNOTATION]: JSON.stringify([{ container: 'app', port: 5901, auth }]),
    },
  },
});

const podWithMultipleAppEndpoints: PodKind = {
  ...pod,
  metadata: {
    ...pod.metadata,
    annotations: {
      [VNC_ENDPOINTS_ANNOTATION]: JSON.stringify([
        { container: 'app', port: 5900, label: 'Guest' },
        { container: 'app', port: 5902, label: 'QEMU' },
      ]),
    },
  },
};

/** Flushes the microtask queue past resolveVncPassword()'s async chain. */
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const renderConsole = (props: Record<string, unknown> = {}) => {
  const onError = jest.fn();
  const onActionsChange = jest.fn();
  const result = render(
    <VncPodConsole
      obj={pod}
      containerName="app"
      subprotocols={[]}
      isFullscreen={false}
      onError={onError}
      onActionsChange={onActionsChange}
      {...props}
    />,
  );
  return { ...result, onError, onActionsChange };
};

/** The actions array from the most recent onActionsChange call, or []. */
const lastActions = (onActionsChange: jest.Mock) =>
  onActionsChange.mock.calls.at(-1)?.[0] ?? [];

beforeEach(() => {
  rfbInstances.length = 0;
  sockets.length = 0;
  jest.clearAllMocks();
  consoleFetchJSON.mockReset();
});

describe('VncPodConsole', () => {
  it('port-forwards to the port the annotation gave the selected container', () => {
    renderConsole();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('/namespaces/lab/pods/desktop-0/portforward?ports=5901');
  });

  it('follows the container selection', () => {
    renderConsole({ containerName: 'sidecar' });

    expect(sockets[0].url).toContain('ports=5902');
  });

  // console's k8s proxy forwards the *last* non-impersonation subprotocol to the
  // API server, so the stream protocol has to come after the impersonation ones.
  it('sends the stream subprotocol last, after any impersonation subprotocols', () => {
    renderConsole({ subprotocols: ['Impersonate-User.dGVzdA__'] });

    expect(sockets[0].protocols).toEqual(['Impersonate-User.dGVzdA__', 'v4.channel.k8s.io']);
  });

  it('hands noVNC the framing channel rather than a bare websocket', () => {
    renderConsole();

    expect(rfbInstances).toHaveLength(1);
    expect(rfbInstances[0].channel).not.toBe(sockets[0]);
    expect(rfbInstances[0].channel).toHaveProperty('readyState');
    expect(rfbInstances[0].scaleViewport).toBe(true);
    expect(rfbInstances[0].viewOnly).toBe(false);
  });

  it('renders nothing for a container that serves no VNC', () => {
    renderConsole({ containerName: 'logs' });

    expect(sockets).toHaveLength(0);
    expect(screen.queryByTestId('vnc-screen')).toBeNull();
  });

  it('reports an unclean disconnect and offers a reconnect', () => {
    const { onError } = renderConsole();

    rfbInstances[0].emit('disconnect', { detail: { clean: false } });

    expect(onError).toHaveBeenCalledWith('Lost the VNC connection to app on port 5901.');
    expect(screen.getByTestId('vnc-reconnect')).toBeTruthy();
  });

  it('stays quiet about a clean disconnect', () => {
    const { onError } = renderConsole();
    onError.mockClear();

    rfbInstances[0].emit('disconnect', { detail: { clean: true } });

    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces the reason a VNC server rejects the connection', () => {
    const { onError } = renderConsole();

    rfbInstances[0].emit('securityfailure', { detail: { reason: 'Authentication failed' } });

    expect(onError).toHaveBeenCalledWith('Authentication failed');
  });

  it('clears the error and focuses the screen once connected', () => {
    const { onError } = renderConsole();
    onError.mockClear();

    rfbInstances[0].emit('connect');

    expect(onError).toHaveBeenCalledWith(null);
    expect(rfbInstances[0].focus).toHaveBeenCalled();
  });

  it('shows a status line while connecting, and drops it once connected', () => {
    renderConsole();

    expect(screen.getByTestId('vnc-status').textContent).toBe('Connecting over VNC on port 5901...');

    rfbInstances[0].emit('connect');

    // The desktop itself is the confirmation once connected - no status line
    // needed, and dropping it gives the screen back that toolbar's height.
    expect(screen.queryByTestId('vnc-status')).toBeNull();
  });

  it('reconnects with a fresh session when asked', () => {
    renderConsole();
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });

    act(() => {
      screen.getByTestId('vnc-reconnect').click();
    });

    expect(rfbInstances[0].disconnect).toHaveBeenCalled();
    expect(rfbInstances).toHaveLength(2);
    expect(sockets).toHaveLength(2);
  });

  it('tears the session down on unmount', () => {
    const { unmount } = renderConsole();

    unmount();

    expect(rfbInstances[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('starts a new session when the container changes, tearing down the old one', () => {
    const { rerender, onError, onActionsChange } = renderConsole();

    rerender(
      <VncPodConsole
        obj={pod}
        containerName="sidecar"
        subprotocols={[]}
        isFullscreen={false}
        onError={onError}
        onActionsChange={onActionsChange}
      />,
    );

    expect(rfbInstances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('ports=5902');
  });

  it('offers no "send key" actions before the session connects', () => {
    const { onActionsChange } = renderConsole();

    expect(lastActions(onActionsChange)).toEqual([]);
  });

  it('offers Ctrl+Alt+Del and F11 once connected', () => {
    const { onActionsChange } = renderConsole();

    rfbInstances[0].emit('connect');

    expect(lastActions(onActionsChange).map((a: { id: string; label: string }) => [a.id, a.label])).toEqual([
      ['ctrl-alt-del', 'Ctrl+Alt+Del'],
      ['f11', 'F11'],
    ]);
  });

  it('sends Ctrl+Alt+Del through the RFB helper when that action is selected', () => {
    const { onActionsChange } = renderConsole();
    rfbInstances[0].emit('connect');

    lastActions(onActionsChange).find((a: { id: string }) => a.id === 'ctrl-alt-del').onSelect();

    expect(rfbInstances[0].sendCtrlAltDel).toHaveBeenCalledTimes(1);
  });

  it('sends the F11 keysym through RFB.sendKey when that action is selected', () => {
    const { onActionsChange } = renderConsole();
    rfbInstances[0].emit('connect');

    lastActions(onActionsChange).find((a: { id: string }) => a.id === 'f11').onSelect();

    expect(rfbInstances[0].sendKey).toHaveBeenCalledWith(expect.any(Number), 'F11');
  });

  it('withdraws the actions again on disconnect', () => {
    const { onActionsChange } = renderConsole();
    rfbInstances[0].emit('connect');
    expect(lastActions(onActionsChange)).toHaveLength(2);

    rfbInstances[0].emit('disconnect', { detail: { clean: true } });

    expect(lastActions(onActionsChange)).toEqual([]);
  });

  it('withdraws the actions on unmount', () => {
    const { unmount, onActionsChange } = renderConsole();
    rfbInstances[0].emit('connect');
    onActionsChange.mockClear();

    unmount();

    expect(lastActions(onActionsChange)).toEqual([]);
  });
});

describe('VNC Authentication (credentialsrequired)', () => {
  it('offers a manual password prompt when the server asks but nothing is configured', async () => {
    renderConsole();

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();

    expect(rfbInstances[0].sendCredentials).not.toHaveBeenCalled();
    expect(consoleFetchJSON).not.toHaveBeenCalled();
    expect(screen.getByTestId('vnc-password-input')).toBeTruthy();
  });

  it('sends an inline password straight through', async () => {
    renderConsole({ obj: podWithAppAuth({ password: 'secret' }) });

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();

    expect(rfbInstances[0].sendCredentials).toHaveBeenCalledWith({ password: 'secret' });
    expect(consoleFetchJSON).not.toHaveBeenCalled();
  });

  it('resolves a secretRef through console\'s own k8s API proxy, decoding the base64 value', async () => {
    consoleFetchJSON.mockResolvedValue({ data: { password: btoa('s3cr3t') } });
    renderConsole({ obj: podWithAppAuth({ secretRef: { name: 'vnc-creds' } }) });

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();

    expect(consoleFetchJSON).toHaveBeenCalledWith(
      '/api/kubernetes/api/v1/namespaces/lab/secrets/vnc-creds',
    );
    expect(rfbInstances[0].sendCredentials).toHaveBeenCalledWith({ password: 's3cr3t' });
  });

  it('reads a non-default secret key when one is given', async () => {
    consoleFetchJSON.mockResolvedValue({ data: { vncPassword: btoa('other') } });
    renderConsole({ obj: podWithAppAuth({ secretRef: { name: 'vnc-creds', key: 'vncPassword' } }) });

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();

    expect(rfbInstances[0].sendCredentials).toHaveBeenCalledWith({ password: 'other' });
  });

  it('reports an error, and never calls sendCredentials, when the secret has no such key', async () => {
    consoleFetchJSON.mockResolvedValue({ data: {} });
    const { onError } = renderConsole({ obj: podWithAppAuth({ secretRef: { name: 'vnc-creds' } }) });

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();

    expect(rfbInstances[0].sendCredentials).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Could not resolve the VNC password'),
    );
  });

  it('reports an error when the secret fetch itself fails, e.g. 403', async () => {
    consoleFetchJSON.mockRejectedValue(new Error('Forbidden'));
    const { onError } = renderConsole({ obj: podWithAppAuth({ secretRef: { name: 'vnc-creds' } }) });

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Could not resolve the VNC password'),
    );
  });

  it('does not call sendCredentials on a session that already unmounted before the secret resolved', async () => {
    let resolveSecret: (value: unknown) => void = () => {};
    consoleFetchJSON.mockReturnValue(
      new Promise((resolve) => {
        resolveSecret = resolve;
      }),
    );
    const { unmount } = renderConsole({ obj: podWithAppAuth({ secretRef: { name: 'vnc-creds' } }) });
    const rfb = rfbInstances[0];

    rfb.emit('credentialsrequired', { detail: { types: ['password'] } });
    unmount();
    resolveSecret({ data: { password: btoa('too-late') } });
    await flush();

    expect(rfb.sendCredentials).not.toHaveBeenCalled();
  });

  it('sends whatever the user types once they submit the manual prompt', () => {
    renderConsole();
    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });

    fireEvent.change(screen.getByTestId('vnc-password-input'), {
      target: { value: 'typed-in-password' },
    });
    fireEvent.click(screen.getByTestId('vnc-password-submit'));

    expect(rfbInstances[0].sendCredentials).toHaveBeenCalledWith({ password: 'typed-in-password' });
  });

  it('hides the manual prompt again once submitted', () => {
    renderConsole();
    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    fireEvent.change(screen.getByTestId('vnc-password-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('vnc-password-submit'));

    expect(screen.queryByTestId('vnc-password-input')).toBeNull();
  });

  it('falls back to the manual prompt after an auto-resolved password attempt fails', async () => {
    const { onError } = renderConsole({ obj: podWithAppAuth({ password: 'wrong' }) });

    rfbInstances[0].emit('credentialsrequired', { detail: { types: ['password'] } });
    await flush();
    expect(rfbInstances[0].sendCredentials).toHaveBeenCalledWith({ password: 'wrong' });

    // The server rejects it: securityfailure with a reason, then an unclean disconnect.
    rfbInstances[0].emit('securityfailure', { detail: { status: 1, reason: 'Authentication failure' } });
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });

    // The specific reason must win - the generic "Lost the VNC connection..."
    // disconnect message must not clobber it.
    expect(onError).toHaveBeenLastCalledWith('Authentication failure');
  });

  it('reports an unsupported credential type instead of silently hanging', () => {
    const { onError } = renderConsole();

    rfbInstances[0].emit('credentialsrequired', {
      detail: { types: ['username', 'password', 'target'] },
    });

    expect(screen.queryByTestId('vnc-password-input')).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('does not support'));
  });
});

describe('multiple endpoints per container', () => {
  // Console core's own "via" dropdown now owns target selection (see
  // patches/0019-pod-connect-transport-extension.patch's `targets` support
  // and transport.tsx's getVncTargets) - this component just connects to
  // whichever endpoint `targetId` (the endpoint's port, stringified) names.

  it('connects to the first endpoint when no targetId is given', () => {
    renderConsole({ obj: podWithMultipleAppEndpoints });

    expect(sockets[0].url).toContain('ports=5900');
  });

  it('connects to the endpoint named by targetId', () => {
    renderConsole({ obj: podWithMultipleAppEndpoints, targetId: '5902' });

    expect(sockets[0].url).toContain('ports=5902');
  });

  it('falls back to the first endpoint when targetId matches none', () => {
    renderConsole({ obj: podWithMultipleAppEndpoints, targetId: '9999' });

    expect(sockets[0].url).toContain('ports=5900');
  });

  it('reconnects to the newly selected endpoint when targetId changes', () => {
    const { rerender } = renderConsole({ obj: podWithMultipleAppEndpoints, targetId: '5900' });
    expect(sockets[0].url).toContain('ports=5900');

    rerender(
      <VncPodConsole
        obj={podWithMultipleAppEndpoints}
        containerName="app"
        targetId="5902"
        subprotocols={[]}
        isFullscreen={false}
        onError={jest.fn()}
        onActionsChange={jest.fn()}
      />,
    );

    expect(rfbInstances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('ports=5902');
  });

  it('keeps connecting to the same endpoint across a re-render with a new but equal `obj` reference', () => {
    // A watch tick (e.g. Redux refreshing the Pod) hands down a brand-new
    // `obj` object even when nothing actually changed - the endpoint lookup
    // must not depend on `obj`'s identity.
    const { rerender } = renderConsole({ obj: podWithMultipleAppEndpoints, targetId: '5902' });
    expect(sockets[0].url).toContain('ports=5902');

    rerender(
      <VncPodConsole
        obj={{ ...podWithMultipleAppEndpoints }}
        containerName="app"
        targetId="5902"
        subprotocols={[]}
        isFullscreen={false}
        onError={jest.fn()}
        onActionsChange={jest.fn()}
      />,
    );

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('ports=5902');
  });
});

describe('auto-reconnect with backoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not auto-reconnect a session that never connected', () => {
    renderConsole();

    rfbInstances[0].emit('disconnect', { detail: { clean: false } });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    expect(sockets).toHaveLength(1);
  });

  it('auto-reconnects after 0.5s once the session had connected', () => {
    renderConsole();
    rfbInstances[0].emit('connect');
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(sockets).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(sockets).toHaveLength(2);
  });

  it('doubles the backoff on each further disconnect, capped at 64s', () => {
    renderConsole();
    rfbInstances[0].emit('connect');

    const expectedDelays = [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 64000, 64000];
    expectedDelays.forEach((delay, i) => {
      rfbInstances[i].emit('disconnect', { detail: { clean: false } });
      act(() => {
        jest.advanceTimersByTime(delay - 1);
      });
      expect(sockets).toHaveLength(i + 1);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(sockets).toHaveLength(i + 2);
    });
  });

  it('resets the backoff to 0.5s once a reconnect actually succeeds', () => {
    renderConsole();
    rfbInstances[0].emit('connect');
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(sockets).toHaveLength(2);

    // This reconnect attempt itself succeeds, so the next disconnect should
    // again wait only 0.5s, not 1s.
    rfbInstances[1].emit('connect');
    rfbInstances[1].emit('disconnect', { detail: { clean: false } });
    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(sockets).toHaveLength(2);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(sockets).toHaveLength(3);
  });

  it('cancels the pending auto-reconnect and resets backoff when Reconnect is clicked manually', () => {
    renderConsole();
    rfbInstances[0].emit('connect');
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });

    act(() => {
      screen.getByTestId('vnc-reconnect').click();
    });
    expect(sockets).toHaveLength(2);

    // The auto-reconnect timer that was pending before the manual click must
    // not also fire later and open a third, redundant socket.
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(sockets).toHaveLength(2);
  });

  it('cancels any pending auto-reconnect on unmount', () => {
    const { unmount } = renderConsole();
    rfbInstances[0].emit('connect');
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });

    unmount();
    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    expect(sockets).toHaveLength(1);
  });

  it('starts the backoff over for a freshly picked, unrelated target', () => {
    const { rerender } = renderConsole({ obj: podWithMultipleAppEndpoints, targetId: '5900' });
    rfbInstances[0].emit('connect');
    rfbInstances[0].emit('disconnect', { detail: { clean: false } });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(sockets).toHaveLength(2);
    // Second attempt would now back off 1s if it disconnected again - but
    // switching target is a new session, so it must not inherit that.
    rfbInstances[1].emit('disconnect', { detail: { clean: false } });

    rerender(
      <VncPodConsole
        obj={podWithMultipleAppEndpoints}
        containerName="app"
        targetId="5902"
        subprotocols={[]}
        isFullscreen={false}
        onError={jest.fn()}
        onActionsChange={jest.fn()}
      />,
    );
    rfbInstances[2].emit('connect');
    rfbInstances[2].emit('disconnect', { detail: { clean: false } });

    act(() => {
      jest.advanceTimersByTime(499);
    });
    expect(sockets).toHaveLength(3);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(sockets).toHaveLength(4);
  });
});

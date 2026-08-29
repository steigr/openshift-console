import * as React from 'react';
import { render, screen, act } from '@testing-library/react';

import type { PodKind } from '../types';
import { VNC_ENABLED_LABEL, VNC_ENDPOINTS_ANNOTATION } from '../endpoints';

const rfbInstances: MockRFB[] = [];

class MockRFB {
  scaleViewport = false;
  viewOnly = true;
  focus = jest.fn();
  disconnect = jest.fn();
  sendCtrlAltDel = jest.fn();

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
    annotations: { [VNC_ENDPOINTS_ANNOTATION]: 'app=5901,sidecar=5902' },
  },
  spec: { containers: [{ name: 'app' }, { name: 'sidecar' }, { name: 'logs' }] },
};

const renderConsole = (props: Record<string, unknown> = {}) => {
  const onError = jest.fn();
  const result = render(
    <VncPodConsole
      obj={pod}
      containerName="app"
      subprotocols={[]}
      isFullscreen={false}
      onError={onError}
      {...props}
    />,
  );
  return { ...result, onError };
};

beforeEach(() => {
  rfbInstances.length = 0;
  sockets.length = 0;
  jest.clearAllMocks();
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
    expect(screen.getByTestId('vnc-status').textContent).toBe('Connected over VNC on port 5901');
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
    const { rerender, onError } = renderConsole();

    rerender(
      <VncPodConsole
        obj={pod}
        containerName="sidecar"
        subprotocols={[]}
        isFullscreen={false}
        onError={onError}
      />,
    );

    expect(rfbInstances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toContain('ports=5902');
  });
});

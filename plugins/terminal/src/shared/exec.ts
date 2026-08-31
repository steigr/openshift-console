/**
 * Minimal exec/attach-over-websocket client for the Kubernetes `pods/exec`
 * and `pods/attach` subresources, speaking the same `base64.channel.k8s.io`
 * protocol as console core's own pod-connect.tsx
 * (frontend/public/components/pod-connect.tsx) - reimplemented here rather
 * than imported, since `WSFactory`/`Terminal` live in console-internal
 * modules a dynamic plugin cannot depend on (see
 * plugins/terminal/src/pod/portforward.ts for the same reasoning applied to
 * the port-forward protocol). Shared by both the Node and Pod Terminal tabs.
 *
 * `attachURL` connects to a container's *existing* PID 1 - whichever
 * interactive process the pod spec already started with stdin/tty - rather
 * than exec-ing a *new* process inside the container; used for the Node
 * Terminal's debug pod (see node/debugPod.ts), where that distinction
 * matters: the privileged node-terminal shim debug image (a `FROM scratch`
 * single static binary, no `/bin/sh` at all) only works attached to, never
 * exec'd into with a shell command it doesn't have.
 *
 * `execURL` runs a *new* command inside a container instead, matching core's
 * own pod-connect.tsx convention (`sh -i -c "TERM=xterm sh"`, or `cmd` on
 * Windows) - used for the Pod Terminal's plain (non-VNC) container entries,
 * which have no dedicated singleton foreground process to attach to.
 *
 * Channel 0 is STDIN, 1 is STDOUT, 2 is STDERR, 3 is the error channel, 4 is resize.
 */

import { Base64 } from 'js-base64';

const STDIN_CHANNEL = '0';
const ERROR_CHANNEL = '3';
const RESIZE_CHANNEL = '4';

export const EXEC_SUBPROTOCOL = 'base64.channel.k8s.io';

const wsBase = (
  namespace: string,
  podName: string,
  location: { host: string; protocol: string },
): string => {
  const { host, protocol } = location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return (
    `${scheme}//${host}/api/kubernetes/api/v1/namespaces/${encodeURIComponent(namespace)}` +
    `/pods/${encodeURIComponent(podName)}`
  );
};

/**
 * URL of the attach endpoint for a pod's container, proxied by console so
 * the session runs as the logged-in user.
 */
export const attachURL = (
  namespace: string,
  podName: string,
  containerName: string,
  location: { host: string; protocol: string } = window.location,
): string => {
  const params = new URLSearchParams();
  params.set('stdout', '1');
  params.set('stdin', '1');
  params.set('stderr', '1');
  params.set('tty', '1');
  params.set('container', containerName);
  return `${wsBase(namespace, podName, location)}/attach?${params.toString()}`;
};

/**
 * URL of the exec endpoint for a pod's container running `command`,
 * proxied by console so the session runs as the logged-in user.
 */
export const execURL = (
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  location: { host: string; protocol: string } = window.location,
): string => {
  const params = new URLSearchParams();
  params.set('stdout', '1');
  params.set('stdin', '1');
  params.set('stderr', '1');
  params.set('tty', '1');
  params.set('container', containerName);
  command.forEach((c) => params.append('command', c));
  return `${wsBase(namespace, podName, location)}/exec?${params.toString()}`;
};

type ExecChannelOptions = {
  onOpen?: () => void;
  onData?: (data: string) => void;
  onStreamError?: (message: string) => void;
  onClose?: (message?: string) => void;
};

export class ExecChannel {
  private socket: WebSocket;
  private readonly options: ExecChannelOptions;

  constructor(url: string, options: ExecChannelOptions = {}) {
    this.options = options;
    this.socket = new WebSocket(url, [EXEC_SUBPROTOCOL]);
    this.socket.onopen = () => this.options.onOpen?.();
    this.socket.onmessage = (event) => this.onMessage(event.data);
    this.socket.onclose = (event) => {
      if (!event || event.wasClean === true) {
        return;
      }
      this.options.onClose?.(event.reason);
    };
    // eslint-disable-next-line no-console
    this.socket.onerror = (event) => console.error('Terminal exec/attach socket error', event);
  }

  private onMessage(raw: string): void {
    if (typeof raw !== 'string' || raw.length === 0) {
      return;
    }
    const channel = raw[0];
    const payload = Base64.decode(raw.slice(1));
    if (channel === ERROR_CHANNEL) {
      this.options.onStreamError?.(payload);
      return;
    }
    this.options.onData?.(payload);
  }

  sendInput(data: string): void {
    this.send(`${STDIN_CHANNEL}${Base64.encode(data)}`);
  }

  sendResize(rows: number, cols: number): void {
    this.send(`${RESIZE_CHANNEL}${Base64.encode(JSON.stringify({ Height: rows, Width: cols }))}`);
  }

  private send(data: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }

  destroy(): void {
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onclose = null;
    this.socket.onerror = null;
    this.socket.close();
  }
}

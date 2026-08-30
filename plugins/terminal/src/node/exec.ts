/**
 * Minimal attach-over-websocket client for the Kubernetes `pods/attach`
 * subresource, speaking the same `base64.channel.k8s.io` protocol as console
 * core's own pod-connect.tsx (frontend/public/components/pod-connect.tsx) -
 * reimplemented here rather than imported, since `WSFactory`/`Terminal` live
 * in console-internal modules a dynamic plugin cannot depend on (see
 * plugins/terminal/src/pod/portforward.ts for the same reasoning applied to
 * the port-forward protocol).
 *
 * Deliberately `attach`, not `exec`: like core's own NodeTerminal.tsx (which
 * renders `<PodConnectLoader attach />`), this connects to the debug pod's
 * own PID 1 - whichever interactive process the pod spec already started
 * with stdin/tty (see debugPod.ts) - rather than exec-ing a *new* shell
 * inside the container. That distinction matters here: the privileged
 * node-terminal shim debug image (a `FROM scratch` single static binary, no
 * `/bin/sh` at all) only works attached to, never exec'd into with a shell
 * command it doesn't have.
 *
 * Channel 0 is STDIN, 1 is STDOUT, 2 is STDERR, 3 is the error channel, 4 is resize.
 */

import { Base64 } from 'js-base64';

const STDIN_CHANNEL = '0';
const ERROR_CHANNEL = '3';
const RESIZE_CHANNEL = '4';

export const EXEC_SUBPROTOCOL = 'base64.channel.k8s.io';

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
  const { host, protocol } = location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  params.set('stdout', '1');
  params.set('stdin', '1');
  params.set('stderr', '1');
  params.set('tty', '1');
  params.set('container', containerName);
  return (
    `${scheme}//${host}/api/kubernetes/api/v1/namespaces/${encodeURIComponent(namespace)}` +
    `/pods/${encodeURIComponent(podName)}/attach?${params.toString()}`
  );
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
    this.socket.onerror = (event) => console.error('Node terminal exec socket error', event);
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

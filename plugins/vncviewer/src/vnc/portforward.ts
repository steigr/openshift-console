/**
 * Adapts a Kubernetes port-forward websocket to the raw byte channel noVNC
 * expects.
 *
 * The API server's `pods/portforward` subresource speaks the `v4.channel.k8s.io`
 * protocol: every binary frame is `[channelByte, ...payload]`, with two channels
 * per requested port - data (`2i`) and error (`2i+1`) - and the port itself sent
 * as a uint16 LE at the head of each channel. Only one port is ever requested
 * here, so the channels are fixed at 0 and 1.
 */

const DATA_CHANNEL = 0;
const ERROR_CHANNEL = 1;
const PORT_HEADER_BYTES = 2;

/** k8s streaming subprotocol; must be sent after any impersonation subprotocol. */
export const PORT_FORWARD_SUBPROTOCOL = 'v4.channel.k8s.io';

// Not using the WebSocket interface directly so tests can supply a fake.
export type SocketLike = {
  readyState: number;
  binaryType: string;
  protocol: string;
  send: (data: ArrayBufferLike | ArrayBufferView) => void;
  close: () => void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

const CONNECTING = 0;
const OPEN = 1;

/**
 * URL of the port-forward endpoint for a pod port, proxied by console so the
 * session runs as the logged-in user.
 */
export const portForwardURL = (
  namespace: string,
  podName: string,
  port: number,
  location: { host: string; protocol: string } = window.location,
): string => {
  const { host, protocol } = location;
  const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
  return (
    `${scheme}//${host}/api/kubernetes/api/v1/namespaces/${encodeURIComponent(namespace)}` +
    `/pods/${encodeURIComponent(podName)}/portforward?ports=${port}`
  );
};

type PortForwardChannelOptions = {
  /** Text the cluster wrote to the stream's error channel. */
  onStreamError?: (message: string) => void;
};

/**
 * Duck-typed channel for noVNC's `Websock.attach()`, which requires exactly
 * these properties to exist: send, close, binaryType, onerror, onmessage,
 * onopen, protocol, readyState.
 *
 * Reports itself as still connecting until the data channel's port header has
 * been consumed, so that noVNC's `open` event fires once, from `onopen`, rather
 * than synchronously during `attach()`.
 */
export class PortForwardChannel {
  // Assigned by Websock.attach(); declared as instance fields so they show up in
  // Object.keys(), which is what attach() inspects.
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  binaryType = 'arraybuffer';

  private readonly socket: SocketLike;
  private readonly onStreamError?: (message: string) => void;
  private readonly pendingHeaderBytes = new Map<number, number>([
    [DATA_CHANNEL, PORT_HEADER_BYTES],
    [ERROR_CHANNEL, PORT_HEADER_BYTES],
  ]);
  private opened = false;

  constructor(socket: SocketLike, { onStreamError }: PortForwardChannelOptions = {}) {
    this.socket = socket;
    this.onStreamError = onStreamError;
    this.socket.binaryType = 'arraybuffer';

    // Deliberately no socket.onopen handler: noVNC must not see the channel as
    // open until the port header has been consumed, see onSocketMessage.
    this.socket.onmessage = (event) => this.onSocketMessage(event);
    this.socket.onclose = (event) => this.onclose?.(event);
    this.socket.onerror = (event) => this.onerror?.(event);
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  /** CONNECTING until the stream has identified itself, then the socket's own state. */
  get readyState(): number {
    if (this.socket.readyState === OPEN && !this.opened) {
      return CONNECTING;
    }
    return this.socket.readyState;
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    const payload =
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);

    const framed = new Uint8Array(payload.byteLength + 1);
    framed[0] = DATA_CHANNEL;
    framed.set(payload, 1);
    this.socket.send(framed);
  }

  close(): void {
    this.socket.close();
  }

  private onSocketMessage(event: { data: unknown }): void {
    const frame = toUint8Array(event.data);
    if (!frame || frame.byteLength < 1) {
      return;
    }

    const channel = frame[0];
    let payload = frame.subarray(1);

    const pending = this.pendingHeaderBytes.get(channel);
    if (pending) {
      const consumed = Math.min(pending, payload.byteLength);
      this.pendingHeaderBytes.set(channel, pending - consumed);
      payload = payload.subarray(consumed);

      if (channel === DATA_CHANNEL && this.pendingHeaderBytes.get(channel) === 0) {
        this.opened = true;
        this.onopen?.();
      }
    }

    if (payload.byteLength === 0) {
      return;
    }

    if (channel === ERROR_CHANNEL) {
      const message = new TextDecoder().decode(payload);
      this.onStreamError?.(message);
      this.onerror?.(new Error(message));
      return;
    }

    if (channel === DATA_CHANNEL) {
      // Copy: noVNC keeps the buffer, and subarray would pin the whole frame.
      this.onmessage?.({ data: payload.slice().buffer });
    }
  }
}

const toUint8Array = (data: unknown): Uint8Array | undefined => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
};

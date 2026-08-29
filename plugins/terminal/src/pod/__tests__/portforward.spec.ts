import Websock from '@novnc/novnc/lib/websock';
import { PortForwardChannel, portForwardURL, type SocketLike } from '../portforward';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

const DATA = 0;
const ERROR = 1;

/** Port 5900 as the uint16 LE header the API server prefixes each channel with. */
const portHeader = [0x14, 0x17];

class FakeSocket implements SocketLike {
  readyState = CONNECTING;
  binaryType = 'blob';
  protocol = 'v4.channel.k8s.io';
  closed = false;
  sent: Uint8Array[] = [];

  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  send(data: ArrayBufferLike | ArrayBufferView) {
    this.sent.push(
      ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : new Uint8Array(data as ArrayBuffer),
    );
  }

  close() {
    this.closed = true;
    this.readyState = CLOSED;
  }

  open() {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Deliver one `[channel, ...payload]` frame, as the API server would. */
  deliver(channel: number, payload: number[]) {
    this.onmessage?.({ data: new Uint8Array([channel, ...payload]).buffer });
  }
}

const connected = () => {
  const socket = new FakeSocket();
  const onStreamError = jest.fn();
  const channel = new PortForwardChannel(socket, { onStreamError });
  socket.open();
  return { socket, channel, onStreamError };
};

describe('portForwardURL', () => {
  it('targets the console-proxied portforward subresource with the ports parameter', () => {
    expect(portForwardURL('my-ns', 'my-pod', 5900, { host: 'console.example.com', protocol: 'https:' })).toBe(
      'wss://console.example.com/api/kubernetes/api/v1/namespaces/my-ns/pods/my-pod/portforward?ports=5900',
    );
  });

  it('falls back to an insecure socket on a plain http console', () => {
    expect(portForwardURL('ns', 'pod', 5901, { host: 'localhost:9000', protocol: 'http:' })).toBe(
      'ws://localhost:9000/api/kubernetes/api/v1/namespaces/ns/pods/pod/portforward?ports=5901',
    );
  });

  it('escapes namespace and pod names', () => {
    expect(portForwardURL('a/b', 'c d', 1, { host: 'h', protocol: 'https:' })).toContain(
      '/namespaces/a%2Fb/pods/c%20d/portforward',
    );
  });
});

describe('PortForwardChannel', () => {
  it('satisfies the property contract noVNC checks in Websock.attach()', () => {
    const { channel } = connected();
    const discoverable = [
      ...Object.keys(channel),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(channel)),
    ];

    // The exact list from noVNC's websock.js rawChannelProps.
    ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen', 'protocol', 'readyState'].forEach(
      (prop) => expect(discoverable).toContain(prop),
    );
  });

  it('forces the underlying socket to deliver ArrayBuffers', () => {
    const socket = new FakeSocket();
    // eslint-disable-next-line no-new
    new PortForwardChannel(socket);
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('stays connecting until the data channel announces its port', () => {
    const { socket, channel } = connected();
    const onopen = jest.fn();
    channel.onopen = onopen;

    expect(channel.readyState).toBe(CONNECTING);
    expect(onopen).not.toHaveBeenCalled();

    socket.deliver(DATA, portHeader);

    expect(channel.readyState).toBe(OPEN);
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it('does not open on the error channel header alone', () => {
    const { socket, channel } = connected();
    const onopen = jest.fn();
    channel.onopen = onopen;

    socket.deliver(ERROR, portHeader);

    expect(onopen).not.toHaveBeenCalled();
    expect(channel.readyState).toBe(CONNECTING);
  });

  it('opens once even if the header arrives split across frames', () => {
    const { socket, channel } = connected();
    const onopen = jest.fn();
    const onmessage = jest.fn();
    channel.onopen = onopen;
    channel.onmessage = onmessage;

    socket.deliver(DATA, [portHeader[0]]);
    expect(onopen).not.toHaveBeenCalled();

    socket.deliver(DATA, [portHeader[1], 0x52, 0x46, 0x42]);

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onmessage.mock.calls[0][0].data)).toEqual(
      new Uint8Array([0x52, 0x46, 0x42]),
    );
  });

  it('delivers payload that shares a frame with the header, minus the header', () => {
    const { socket, channel } = connected();
    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    socket.deliver(DATA, [...portHeader, 1, 2, 3]);

    expect(new Uint8Array(onmessage.mock.calls[0][0].data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('strips the channel byte from subsequent data frames', () => {
    const { socket, channel } = connected();
    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    socket.deliver(DATA, portHeader);
    socket.deliver(DATA, [0xde, 0xad]);

    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onmessage.mock.calls[0][0].data)).toEqual(new Uint8Array([0xde, 0xad]));
  });

  it('ignores a header-only frame instead of delivering an empty message', () => {
    const { socket, channel } = connected();
    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    socket.deliver(DATA, portHeader);

    expect(onmessage).not.toHaveBeenCalled();
  });

  it('reports what the cluster writes to the error channel', () => {
    const { socket, channel, onStreamError } = connected();
    const onerror = jest.fn();
    channel.onerror = onerror;

    socket.deliver(ERROR, portHeader);
    socket.deliver(ERROR, [...Buffer.from('error forwarding port 5900: connection refused')]);

    expect(onStreamError).toHaveBeenCalledWith('error forwarding port 5900: connection refused');
    expect(onerror).toHaveBeenCalledTimes(1);
  });

  it('does not mistake error channel bytes for framebuffer data', () => {
    const { socket, channel } = connected();
    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    socket.deliver(ERROR, [...portHeader, 0x41]);

    expect(onmessage).not.toHaveBeenCalled();
  });

  it('ignores empty and non-binary frames', () => {
    const { socket, channel } = connected();
    const onmessage = jest.fn();
    channel.onmessage = onmessage;

    socket.onmessage?.({ data: 'not binary' });
    socket.onmessage?.({ data: new Uint8Array([]).buffer });

    expect(onmessage).not.toHaveBeenCalled();
  });

  it('prefixes everything it sends with the data channel byte', () => {
    const { socket, channel } = connected();

    channel.send(new Uint8Array([0x52, 0x46, 0x42]));

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toEqual(new Uint8Array([DATA, 0x52, 0x46, 0x42]));
  });

  it('sends only the view when handed a slice of a larger buffer', () => {
    const { socket, channel } = connected();
    const backing = new Uint8Array([9, 9, 1, 2, 9]);

    channel.send(backing.subarray(2, 4));

    expect(socket.sent[0]).toEqual(new Uint8Array([DATA, 1, 2]));
  });

  it('propagates close and error events, and closes the socket', () => {
    const { socket, channel } = connected();
    const onclose = jest.fn();
    const onerror = jest.fn();
    channel.onclose = onclose;
    channel.onerror = onerror;

    socket.onclose?.({ code: 1006 });
    socket.onerror?.({});
    channel.close();

    expect(onclose).toHaveBeenCalledWith({ code: 1006 });
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBe(true);
    expect(channel.readyState).toBe(CLOSED);
  });
});

// The shim only matters if the real noVNC accepts it, so exercise it through
// noVNC's own Websock rather than our understanding of it.
describe('against noVNC Websock', () => {
  it('attaches, opens once the header lands, and queues framebuffer bytes', () => {
    const socket = new FakeSocket();
    const channel = new PortForwardChannel(socket);
    const websock = new Websock();
    const onOpen = jest.fn();
    websock.on('open', onOpen);

    expect(() => websock.attach(channel)).not.toThrow();
    expect(websock.readyState).toBe('connecting');

    socket.open();
    socket.deliver(DATA, portHeader);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(websock.readyState).toBe('open');

    socket.deliver(DATA, [...Buffer.from('RFB 003.008\n')]);

    // rQwait returns true when it needs *more* data than is queued.
    expect(websock.rQwait('handshake', 12)).toBe(false);
    expect(websock.rQshiftStr(12)).toBe('RFB 003.008\n');
  });

  it('sends what noVNC queues, framed for the data channel', () => {
    const socket = new FakeSocket();
    const channel = new PortForwardChannel(socket);
    const websock = new Websock();
    websock.attach(channel);
    socket.open();
    socket.deliver(DATA, portHeader);

    websock.sQpushString('RFB 003.008\n');
    websock.flush();

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0][0]).toBe(DATA);
    expect(Buffer.from(socket.sent[0].subarray(1)).toString()).toBe('RFB 003.008\n');
  });
});

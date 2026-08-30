import { Base64 } from 'js-base64';
import { attachURL, ExecChannel, EXEC_SUBPROTOCOL } from '../exec';

describe('attachURL', () => {
  it('builds a wss URL against the attach subresource, with no command param', () => {
    const url = attachURL('my-ns', 'my-pod', 'container-00', {
      host: 'console.example.com',
      protocol: 'https:',
    });

    expect(url).toBe(
      'wss://console.example.com/api/kubernetes/api/v1/namespaces/my-ns' +
        '/pods/my-pod/attach?stdout=1&stdin=1&stderr=1&tty=1&container=container-00',
    );
    expect(url).not.toContain('command=');
    expect(url).not.toContain('/exec?');
  });

  it('falls back to an insecure socket on a plain http console', () => {
    expect(attachURL('ns', 'pod', 'c', { host: 'localhost:9000', protocol: 'http:' })).toBe(
      'ws://localhost:9000/api/kubernetes/api/v1/namespaces/ns/pods/pod/attach?stdout=1&stdin=1&stderr=1&tty=1&container=c',
    );
  });

  it('escapes namespace and pod names', () => {
    expect(attachURL('a/b', 'c d', 'container', { host: 'h', protocol: 'https:' })).toContain(
      '/namespaces/a%2Fb/pods/c%20d/attach',
    );
  });
});

type Listener = ((event?: unknown) => void) | null;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: Listener = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: Listener = null;
  onerror: Listener = null;

  constructor(
    public url: string,
    public protocols: string[],
  ) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(raw: string) {
    this.onmessage?.({ data: raw });
  }
}

describe('ExecChannel', () => {
  let socket: FakeWebSocket;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = jest.fn((url: string, protocols: string[]) => {
      socket = new FakeWebSocket(url, protocols);
      return socket;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.WebSocket as any).OPEN = FakeWebSocket.OPEN;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('connects with the base64.channel.k8s.io subprotocol', () => {
    // eslint-disable-next-line no-new
    new ExecChannel('wss://example/attach');

    expect(socket.protocols).toEqual([EXEC_SUBPROTOCOL]);
  });

  it('sends stdin on channel 0, base64 encoded', () => {
    const channel = new ExecChannel('wss://example/attach');
    socket.open();

    channel.sendInput('ls\n');

    expect(socket.sent).toEqual([`0${Base64.encode('ls\n')}`]);
  });

  it('sends a resize as a JSON payload on channel 4', () => {
    const channel = new ExecChannel('wss://example/attach');
    socket.open();

    channel.sendResize(40, 120);

    expect(socket.sent).toEqual([`4${Base64.encode(JSON.stringify({ Height: 40, Width: 120 }))}`]);
  });

  it('does not send before the socket is open', () => {
    const channel = new ExecChannel('wss://example/attach');

    channel.sendInput('too early');

    expect(socket.sent).toEqual([]);
  });

  it('decodes stdout/stderr data (channel 1/2) via onData', () => {
    const onData = jest.fn();
    // eslint-disable-next-line no-new
    new ExecChannel('wss://example/attach', { onData });

    socket.message(`1${Base64.encode('hello')}`);
    socket.message(`2${Base64.encode('world')}`);

    expect(onData).toHaveBeenNthCalledWith(1, 'hello');
    expect(onData).toHaveBeenNthCalledWith(2, 'world');
  });

  it('routes channel 3 to onStreamError, not onData', () => {
    const onData = jest.fn();
    const onStreamError = jest.fn();
    // eslint-disable-next-line no-new
    new ExecChannel('wss://example/attach', { onData, onStreamError });

    socket.message(`3${Base64.encode('exec: "sh": executable file not found in $PATH')}`);

    expect(onStreamError).toHaveBeenCalledWith('exec: "sh": executable file not found in $PATH');
    expect(onData).not.toHaveBeenCalled();
  });

  it('calls onOpen when the socket opens', () => {
    const onOpen = jest.fn();
    // eslint-disable-next-line no-new
    new ExecChannel('wss://example/attach', { onOpen });

    socket.open();

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('reports an unclean close via onClose, but stays quiet on a clean one', () => {
    const onClose = jest.fn();
    // eslint-disable-next-line no-new
    new ExecChannel('wss://example/attach', { onClose });

    socket.onclose?.({ wasClean: false, reason: 'boom' });
    expect(onClose).toHaveBeenCalledWith('boom');

    onClose.mockClear();
    socket.onclose?.({ wasClean: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tears down all listeners and closes the socket on destroy', () => {
    const channel = new ExecChannel('wss://example/attach', {
      onOpen: jest.fn(),
      onData: jest.fn(),
    });
    const closeSpy = jest.spyOn(socket, 'close');

    channel.destroy();

    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

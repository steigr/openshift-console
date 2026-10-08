import * as React from 'react';
import { act, render, screen } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_match, name) => String(options?.[name])),
  }),
}));

const k8sCreate = jest.fn();
const k8sDelete = jest.fn();
const useK8sWatchResource = jest.fn();

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: (...args: unknown[]) => k8sCreate(...args),
  k8sDelete: (...args: unknown[]) => k8sDelete(...args),
  useK8sWatchResource: (...args: unknown[]) => useK8sWatchResource(...args),
}));

// getDebugPod's own internals (ConfigMap lookups, image resolution) are
// exercised by debugPod.spec.ts - irrelevant noise for this component's own
// logic, so it's mocked away wholesale.
jest.mock('../debugPod', () => ({
  getDebugPod: jest.fn().mockResolvedValue({
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: { name: 'node1-debug', namespace: 'openshift-debug-abc' },
    spec: { containers: [{ name: 'node-terminal' }] },
  }),
}));

class MockExecChannel {
  static instances: MockExecChannel[] = [];
  onOpen?: () => void;
  onData?: (data: string) => void;
  destroy = jest.fn();
  sendInput = jest.fn();
  sendResize = jest.fn();

  constructor(
    public url: string,
    options: { onOpen?: () => void; onData?: (data: string) => void },
  ) {
    this.onOpen = options.onOpen;
    this.onData = options.onData;
    MockExecChannel.instances.push(this);
  }
}

jest.mock('../../shared/exec', () => ({
  execURL: (ns: string, pod: string, container: string, command: string[]) =>
    `wss://x/${ns}/${pod}/${container}?command=${command.join(',')}`,
  ExecChannel: MockExecChannel,
}));

// The size the (mock) terminal reports once open; undefined = not opened yet.
let mockTerminalSize: { rows: number; cols: number } | undefined;

jest.mock('../../shared/Terminal', () => ({
  Terminal: React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      focus: jest.fn(),
      getSize: () => mockTerminalSize,
      onDataReceived: jest.fn(),
      onConnectionClosed: jest.fn(),
    }));
    return <div data-test="mock-terminal" />;
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NodeTerminalTab } = require('../NodeTerminalTab');

const runningPod = {
  kind: 'Pod',
  apiVersion: 'v1',
  metadata: { name: 'node1-debug', namespace: 'openshift-debug-abc' },
  spec: { containers: [{ name: 'node-terminal' }] },
  status: { phase: 'Running' },
};

const node = { metadata: { name: 'node1' } };

beforeEach(() => {
  jest.useFakeTimers();
  mockTerminalSize = undefined;
  MockExecChannel.instances.length = 0;
  k8sCreate.mockReset();
  k8sDelete.mockReset();
  useK8sWatchResource.mockReset();

  k8sCreate.mockImplementation(({ model }: { model: { kind: string } }) => {
    if (model.kind === 'Namespace') {
      return Promise.resolve({ metadata: { name: 'openshift-debug-abc' } });
    }
    return Promise.resolve(runningPod);
  });
  useK8sWatchResource.mockReturnValue([runningPod, true, undefined]);
});

afterEach(() => {
  jest.useRealTimers();
});

const flush = async () => {
  // Each `await` hop in createDebugPod's chain needs its own microtask tick.
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const renderAndSettle = async () => {
  const result = render(<NodeTerminalTab obj={node} />);
  // Flush the namespace-create -> getDebugPod -> 1s wait -> pod-create chain.
  await act(async () => {
    await flush();
    jest.advanceTimersByTime(1000);
    await flush();
  });
  return result;
};

describe('NodeTerminalTab no-output hint', () => {
  it('shows no hint while data is still arriving in time', async () => {
    await renderAndSettle();
    const channel = MockExecChannel.instances[0];

    act(() => {
      channel.onOpen?.();
    });
    act(() => {
      jest.advanceTimersByTime(11_999);
    });

    expect(screen.queryByTestId('node-terminal-no-output-hint')).toBeNull();
  });

  it('shows a hint after 12s with no data since the channel opened', async () => {
    await renderAndSettle();
    const channel = MockExecChannel.instances[0];

    act(() => {
      channel.onOpen?.();
    });
    act(() => {
      jest.advanceTimersByTime(12_000);
    });

    expect(screen.getByTestId('node-terminal-no-output-hint')).toBeTruthy();
  });

  it('never shows the hint once data has arrived', async () => {
    await renderAndSettle();
    const channel = MockExecChannel.instances[0];

    act(() => {
      channel.onOpen?.();
    });
    act(() => {
      channel.onData?.('login: ');
    });
    act(() => {
      jest.advanceTimersByTime(12_000);
    });

    expect(screen.queryByTestId('node-terminal-no-output-hint')).toBeNull();
  });

  it('clears an already-shown hint once data finally arrives', async () => {
    await renderAndSettle();
    const channel = MockExecChannel.instances[0];

    act(() => {
      channel.onOpen?.();
    });
    act(() => {
      jest.advanceTimersByTime(12_000);
    });
    expect(screen.getByTestId('node-terminal-no-output-hint')).toBeTruthy();

    act(() => {
      channel.onData?.('finally!');
    });

    expect(screen.queryByTestId('node-terminal-no-output-hint')).toBeNull();
  });

  it('does not leave a stray timer running after unmount', async () => {
    const { unmount } = await renderAndSettle();
    const channel = MockExecChannel.instances[0];

    act(() => {
      channel.onOpen?.();
    });
    unmount();

    // If the timer weren't cleared, this would call setState on an
    // unmounted component and React would warn/throw.
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(12_000);
      });
    }).not.toThrow();
  });
});

describe('NodeTerminalTab terminal size', () => {
  it('tells a channel created after the terminal opened its size', async () => {
    // The terminal opens while the debug pod is still starting, so its size report finds no
    // channel; the channel created once the pod runs must be seeded with it.
    mockTerminalSize = { rows: 32, cols: 151 };
    // As on a cluster: the watch only has the pod once the tab knows its name, so the terminal is
    // mounted (podName set) before the pod is seen Running.
    useK8sWatchResource.mockImplementation((resource: unknown) =>
      resource ? [runningPod, true, undefined] : [undefined, false, undefined],
    );
    await renderAndSettle();

    expect(MockExecChannel.instances[0].sendResize).toHaveBeenCalledWith(32, 151);
  });

  it('sends nothing up front while the terminal has not opened yet', async () => {
    await renderAndSettle();

    expect(MockExecChannel.instances[0].sendResize).not.toHaveBeenCalled();
  });
});

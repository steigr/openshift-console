import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

import { PodLogsTab } from './PodLogsTab';

// A factory, not the manual mock in __mocks__: this suite drives the response
// per test, so consoleFetch has to be a jest.fn here.
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: jest.fn(),
}));

const fetchMock = consoleFetch as unknown as jest.Mock;

/** A response with no streaming body, which the hook reads in one go. */
const textResponse = (body: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: null,
    text: () => Promise.resolve(body),
  });

const pod = {
  metadata: { name: 'checkout-0', namespace: 'shop' },
  spec: { containers: [{ name: 'app' }, { name: 'sidecar' }] },
};

const renderTab = () =>
  render(
    <PodLogsTab
      obj={pod}
      // PageComponentProps carries more than this tab reads.
      {...{}}
    />,
  );

const ecs = (message: string, level = 'INFO') =>
  JSON.stringify({
    '@timestamp': '2026-09-22T20:00:00.000Z',
    'log.level': level,
    'log.logger': 'com.example.Service',
    message,
  });

describe('PodLogsTab', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
  });

  it('requests the selected container under the caller own credentials', async () => {
    fetchMock.mockImplementation(() => textResponse(''));
    renderTab();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain(
      '/api/kubernetes/api/v1/namespaces/shop/pods/checkout-0/log',
    );
    expect(url).toContain('container=app');
    expect(url).toContain('tailLines=10000');
  });

  it('pages backwards when the reader scrolls to the top', async () => {
    // First request: the tail. Second: a bigger tail, from which only the
    // lines before the ones already held are kept.
    const older = Array.from({ length: 3 }, (_v, i) =>
      ecs(`older ${String(i)}`),
    );
    const held = [ecs('held')];
    fetchMock
      .mockImplementationOnce(() => textResponse(`${held.join('\n')}\n`))
      .mockImplementationOnce(() =>
        textResponse(`${[...older, ...held].join('\n')}\n`),
      );
    renderTab();
    await screen.findByTestId('log-row');

    const viewer = screen.getByTestId('log-viewer');
    // A scroll *upwards* to the top is what arms and then triggers paging;
    // simply being at scrollTop 0 on load must not.
    fireEvent.scroll(viewer, { target: { scrollTop: 500 } });
    fireEvent.scroll(viewer, { target: { scrollTop: 0 } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const url = String((fetchMock.mock.calls[1] as unknown[])[0]);
    // A bigger tail, not an offset: the kubelet has no notion of one.
    expect(url).toContain('tailLines=20000');
    expect(url).not.toContain('follow=true');

    await waitFor(() => {
      expect(screen.getAllByTestId('log-row')).toHaveLength(4);
    });
    expect(screen.getAllByTestId('log-row')[0]).toHaveTextContent('older 0');
  });

  it('does not page on the initial load', async () => {
    fetchMock.mockImplementation(() => textResponse(`${ecs('only')}\n`));
    renderTab();
    await screen.findByTestId('log-row');

    // The view is pinned to the newest line and a short log never scrolls, so
    // scrollTop is 0 from the outset. That is not a request for history.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops asking once the beginning is reached', async () => {
    fetchMock
      .mockImplementationOnce(() => textResponse(`${ecs('held')}\n`))
      // The bigger tail returns nothing we do not already have.
      .mockImplementationOnce(() => textResponse(`${ecs('held')}\n`));
    renderTab();
    await screen.findByTestId('log-row');

    const viewer = screen.getByTestId('log-viewer');
    fireEvent.scroll(viewer, { target: { scrollTop: 500 } });
    fireEvent.scroll(viewer, { target: { scrollTop: 0 } });
    await screen.findByTestId('log-earlier-done');

    fireEvent.scroll(viewer, { target: { scrollTop: 500 } });
    fireEvent.scroll(viewer, { target: { scrollTop: 0 } });
    // Still two: the beginning has been reached, so no more requests.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('starts in ECS when the first lines look like ECS', async () => {
    fetchMock.mockImplementation(() => textResponse(`${ecs('hello')}\n`));
    renderTab();

    const row = await screen.findByTestId('log-row');
    expect(row).toHaveTextContent('com.example.Service');
    expect(row).toHaveTextContent('hello');
    // Columns, not the raw record: the ECS keys themselves are not rendered.
    expect(row).not.toHaveTextContent('@timestamp');
    expect(screen.getByTestId('log-format-select')).toHaveTextContent('ECS');
  });

  it('starts in plain when the log is not JSON', async () => {
    fetchMock.mockImplementation(() => textResponse('starting up\n'));
    renderTab();

    await screen.findByTestId('log-row');
    expect(screen.getByTestId('log-format-select')).toHaveTextContent('Plain');
  });

  it('lets the reader switch the format, and remembers the choice', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => textResponse(`${ecs('hello')}\n`));
    const { unmount } = renderTab();

    await screen.findByTestId('log-row');
    await user.click(screen.getByTestId('log-format-select'));
    await user.click(screen.getByRole('option', { name: 'Plain' }));

    expect(screen.getByTestId('log-row')).toHaveTextContent('"log.level"');
    expect(
      window.localStorage.getItem('logging-console-plugin/log-format'),
    ).toBe('plain');

    // An explicit choice outlives the pod it was made on, and is not re-sniffed.
    unmount();
    renderTab();
    await screen.findByTestId('log-row');
    expect(screen.getByTestId('log-format-select')).toHaveTextContent('Plain');
  });

  it('falls back to plain for the lines of a JSON log that do not decode', async () => {
    fetchMock.mockImplementation(() =>
      textResponse(
        `Picked up JAVA_TOOL_OPTIONS\n${ecs('ready')}\n{"truncated":\n`,
      ),
    );
    renderTab();

    const rows = await screen.findAllByTestId('log-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Picked up JAVA_TOOL_OPTIONS');
    expect(rows[1]).toHaveTextContent('ready');
    expect(rows[2]).toHaveTextContent('{"truncated":');
  });

  it('refetches when another container is selected', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => textResponse(''));
    renderTab();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await user.click(screen.getByTestId('log-container-select'));
    await user.click(screen.getByRole('option', { name: 'sidecar' }));

    await waitFor(() => {
      expect(String((fetchMock.mock.calls.at(-1) as unknown[])[0])).toContain(
        'container=sidecar',
      );
    });
  });

  it('reports a failed request instead of rendering an empty log', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        body: null,
        text: () => Promise.resolve(''),
      }),
    );
    renderTab();

    expect(await screen.findByTestId('log-error')).toHaveTextContent('403');
  });
});

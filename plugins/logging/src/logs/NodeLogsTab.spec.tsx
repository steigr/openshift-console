import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { consoleFetch } from '@openshift-console/dynamic-plugin-sdk';

import { NodeLogsTab } from './NodeLogsTab';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetch: jest.fn(),
}));

const fetchMock = consoleFetch as unknown as jest.Mock;

const textResponse = (body: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: null,
    text: () => Promise.resolve(body),
  });

const entry = (cursor: string, message: string) =>
  JSON.stringify({
    __CURSOR: cursor,
    __REALTIME_TIMESTAMP: '1790143099610648',
    _SYSTEMD_UNIT: 'kubelet.service',
    _TRANSPORT: 'stdout',
    MESSAGE: message,
  });

const renderTab = () =>
  render(<NodeLogsTab obj={{ metadata: { name: 'node-1' } }} {...{}} />);

describe('NodeLogsTab', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('asks the plugin proxy for the journal as JSON', async () => {
    fetchMock.mockImplementation(() => textResponse(`${entry('c1', 'up')}\n`));
    renderTab();

    const row = await screen.findByTestId('log-row');
    expect(row).toHaveTextContent('kubelet.service');
    expect(row).toHaveTextContent('stdout');
    expect(row).toHaveTextContent('up');

    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/nodes/node-1/journal');
    expect(url).toContain('output=json');
  });

  it('pages backwards from the oldest cursor when scrolled to the top', async () => {
    fetchMock
      .mockImplementationOnce(() => textResponse(`${entry('c5', 'newest')}\n`))
      // journalctl --cursor c5 --reverse: newest first, anchor included.
      .mockImplementationOnce(() =>
        textResponse(
          `${[entry('c5', 'newest'), entry('c4', 'older'), entry('c3', 'oldest')].join('\n')}\n`,
        ),
      );
    renderTab();
    await screen.findByTestId('log-row');

    const viewer = screen.getByTestId('log-viewer');
    fireEvent.scroll(viewer, { target: { scrollTop: 500 } });
    fireEvent.scroll(viewer, { target: { scrollTop: 0 } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    // An exact cursor, not a bigger tail: journald can do what the kubelet cannot.
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toContain(
      'beforeCursor=',
    );

    await waitFor(() => {
      expect(screen.getAllByTestId('log-row')).toHaveLength(3);
    });
    const rows = screen.getAllByTestId('log-row');
    // Reversed into reading order, with the anchor entry not duplicated.
    expect(rows[0]).toHaveTextContent('oldest');
    expect(rows[1]).toHaveTextContent('older');
    expect(rows[2]).toHaveTextContent('newest');
  });

  it('refetches from the tail when the unit filter changes', async () => {
    fetchMock.mockImplementation(() => textResponse(`${entry('c1', 'up')}\n`));
    renderTab();
    await screen.findByTestId('log-row');

    const input = screen.getByLabelText('Filter by unit');
    fireEvent.change(input, { target: { value: 'crio.service' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(String((fetchMock.mock.calls.at(-1) as unknown[])[0])).toContain(
        'unit=crio.service',
      );
    });
  });
});

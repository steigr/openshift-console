import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LogBuffer } from './buffer';
import { LogViewer } from './LogViewer';
import type { LogFormat } from './parse';

const bufferOf = (lines: string[]): LogBuffer => {
  const buffer = new LogBuffer();
  buffer.append(lines.map((line) => `${line}\n`).join(''));
  return buffer;
};

const renderViewer = (buffer: LogBuffer, format: LogFormat = 'ecs') =>
  render(
    <LogViewer buffer={buffer} version={1} format={format} follow={false} />,
  );

const ecsLine = (index: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    '@timestamp': new Date(2026, 8, 22, 20, 0, 0, index % 1000).toISOString(),
    'log.level': 'INFO',
    'log.logger': 'com.example.Service',
    message: `message ${String(index)}`,
    ...extra,
  });

describe('LogViewer', () => {
  it('renders the ECS columns rather than the raw line', () => {
    renderViewer(bufferOf([ecsLine(0)]));

    const row = screen.getByTestId('log-row');
    expect(row).toHaveTextContent('INFO');
    expect(row).toHaveTextContent('com.example.Service');
    expect(row).toHaveTextContent('message 0');
    expect(row).not.toHaveTextContent('@timestamp');
  });

  it('mounts only the visible window of a 100k-line buffer', () => {
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      lines.push(ecsLine(i));
    }
    renderViewer(bufferOf(lines));

    // The sizer is laid out for the whole stream; the rows are not.
    const rows = screen.getAllByTestId('log-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
  });

  it('shows a line that is not JSON as plain text', () => {
    renderViewer(bufferOf(['Picked up JAVA_TOOL_OPTIONS: -Xmx512m']));

    const row = screen.getByTestId('log-row');
    expect(row).toHaveTextContent('Picked up JAVA_TOOL_OPTIONS: -Xmx512m');
    expect(row.className).toContain('logging-log-viewer__row--unparsed');
  });

  it('keeps a stack trace collapsed until its row is expanded', async () => {
    const user = userEvent.setup();
    const trace = Array.from(
      { length: 200 },
      (_value, index) =>
        `\tat com.example.Frame${String(index)}.run(Frame.java:${String(index)})`,
    ).join('\n');
    renderViewer(
      bufferOf([
        ecsLine(0, {
          'log.level': 'ERROR',
          'error.type': 'java.lang.IllegalStateException',
          'error.message': 'closed',
          'error.stack_trace': `java.lang.IllegalStateException: closed\n${trace}`,
        }),
      ]),
    );

    expect(screen.queryByTestId('log-expansion')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('log-row-toggle'));
    const expansion = screen.getByTestId('log-expansion');
    expect(expansion).toHaveTextContent(
      'java.lang.IllegalStateException: closed',
    );
    expect(expansion).toHaveTextContent('com.example.Frame199');

    await user.click(screen.getByTestId('log-row-toggle'));
    expect(screen.queryByTestId('log-expansion')).not.toBeInTheDocument();
  });

  it('renders the raw line in plain format', () => {
    const raw = ecsLine(0);
    renderViewer(bufferOf([raw]), 'plain');
    expect(screen.getByTestId('log-row')).toHaveTextContent('"log.level"');
  });

  it('re-parses when the format changes', () => {
    const buffer = bufferOf([ecsLine(0)]);
    const { rerender } = render(
      <LogViewer buffer={buffer} version={1} format="ecs" follow={false} />,
    );
    expect(screen.getByTestId('log-row')).not.toHaveTextContent('@timestamp');

    rerender(
      <LogViewer buffer={buffer} version={1} format="plain" follow={false} />,
    );
    expect(screen.getByTestId('log-row')).toHaveTextContent('@timestamp');
  });
});

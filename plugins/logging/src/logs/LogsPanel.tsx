import type { FC, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Toolbar, ToolbarContent } from '@patternfly/react-core';

import { LogViewer } from './LogViewer';
import type { LogFormat } from './parse';
import type { EarlierPages } from './useEarlierPages';
import type { LogStream } from './useLogStream';
import './log-viewer.css';

export interface LogsPanelProps {
  stream: LogStream;
  format: LogFormat;
  follow: boolean;
  /** Toolbar groups, which differ between a container log and a node journal. */
  toolbar: ReactNode;
  /** Backward paging, driven by the reader scrolling to the top. */
  earlier: EarlierPages;
  errorTitle: string;
}

/**
 * The shared frame around a log: toolbar, a line count, and the viewer.
 *
 * The count sits in a bar of its own directly above the log rather than in the
 * toolbar, matching console core's own Logs tabs -- and unlike a toolbar item
 * it cannot be pushed out of sight when the toolbar wraps to a second line on
 * a narrow window.
 */
export const LogsPanel: FC<LogsPanelProps> = ({
  stream,
  format,
  follow,
  toolbar,
  earlier,
  errorTitle,
}) => {
  const { t } = useTranslation('plugin__logging-console-plugin');
  const dropped = stream.buffer.droppedLines;

  return (
    <div className="logging-pod-logs" data-test="logging-logs-panel">
      <Toolbar className="logging-pod-logs__toolbar">
        <ToolbarContent>{toolbar}</ToolbarContent>
      </Toolbar>

      {stream.error !== null && (
        <Alert
          variant="danger"
          isInline
          title={errorTitle}
          data-test="log-error"
        >
          {stream.error}
        </Alert>
      )}

      <div className="logging-pod-logs__count" data-test="log-status">
        {stream.loading
          ? t('Loading…')
          : t('{{lines}} lines', {
              lines: stream.buffer.length.toLocaleString(),
            })}
        {dropped > 0 &&
          ` · ${t('{{lines}} older lines dropped', {
            lines: dropped.toLocaleString(),
          })}`}
        {earlier.loading && (
          <span
            className="logging-pod-logs__count-note"
            data-test="log-loading-earlier"
          >
            {t('Loading earlier lines…')}
          </span>
        )}
        {!earlier.loading && !earlier.canLoad && stream.buffer.length > 0 && (
          <span
            className="logging-pod-logs__count-note"
            data-test="log-earlier-done"
          >
            {earlier.error ?? t('Beginning of the log')}
          </span>
        )}
      </div>

      <LogViewer
        buffer={stream.buffer}
        version={stream.version}
        format={format}
        follow={follow}
        emptyText={stream.loading ? t('Loading…') : undefined}
        onReachTop={earlier.loadEarlier}
        canLoadEarlier={earlier.canLoad}
        loadingEarlier={earlier.loading}
      />
    </div>
  );
};

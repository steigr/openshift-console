import type { FC } from 'react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  SearchInput,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import type { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import { LogsPanel } from './LogsPanel';
import { nodeJournalURL, parseUnits } from './log-urls';
import { useLogStream } from './useLogStream';
import './log-viewer.css';

interface NodeKind {
  metadata?: { name?: string };
}

/**
 * Entries fetched up front. The backend caps a bounded request at 10,000, and
 * the whole journal is a click away.
 */
const DEFAULT_TAIL = 10_000;

/**
 * This plugin's Node "Logs" tab, shown in place of console core's own while
 * LOGGING_PLUGIN_NODE_LOGS_ENABLED is set
 * (patches/0024-node-logs-flag-gate.patch drops core's tab from
 * NodeDetailsPage.tsx under that flag).
 *
 * Unlike the Pod tab this one does need the plugin backend: it reads the
 * journal from the node-logs-api DaemonSet, over console's plugin proxy, which
 * is what forwards the caller's credentials so the backend can check them
 * (`get nodes/proxy`, the same permission core's own tab requires).
 *
 * The journal arrives as one JSON object per line (`journalctl -o json`),
 * which is what lets the viewer render timestamp, unit and transport as
 * columns instead of re-parsing syslog text.
 */
export const NodeLogsTab: FC<PageComponentProps<NodeKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__logging-console-plugin');

  const node = obj?.metadata?.name ?? '';
  const [unitFilter, setUnitFilter] = useState('');
  // What is actually being fetched, as opposed to what is being typed.
  const [appliedUnits, setAppliedUnits] = useState<string[]>([]);
  const [loadFullJournal, setLoadFullJournal] = useState(false);

  const stream = useLogStream(
    node
      ? nodeJournalURL({
          node,
          units: appliedUnits,
          tailLines: loadFullJournal ? null : DEFAULT_TAIL,
        })
      : null,
  );

  const applyUnits = useCallback(() => {
    setAppliedUnits(parseUnits(unitFilter));
  }, [unitFilter]);

  const onDownload = useCallback(() => {
    const blob = new Blob([stream.buffer.text()], {
      type: 'application/x-ndjson;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${node}-journal.ndjson`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [stream.buffer, node]);

  return (
    <LogsPanel
      stream={stream}
      format="journald"
      // No follow: journalctl is run once per request rather than with -f, so
      // there is nothing arriving to follow. Pinning to the newest entry on
      // load is still what a reader wants.
      follow
      errorTitle={t('Could not read the node journal')}
      toolbar={
        <>
          <ToolbarGroup variant="filter-group">
            <ToolbarItem>
              <SearchInput
                aria-label={t('Filter by unit')}
                placeholder={t('Filter by unit')}
                value={unitFilter}
                onChange={(_event, value) => {
                  setUnitFilter(value);
                }}
                onSearch={applyUnits}
                onClear={() => {
                  setUnitFilter('');
                  setAppliedUnits([]);
                }}
                data-test="log-unit-filter"
              />
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="secondary"
                onClick={() => {
                  setLoadFullJournal(true);
                }}
                isDisabled={loadFullJournal}
                data-test="log-load-full"
              >
                {loadFullJournal
                  ? t('Full journal loaded')
                  : t('Load full journal')}
              </Button>
            </ToolbarItem>
          </ToolbarGroup>
          <ToolbarGroup align={{ default: 'alignEnd' }}>
            <ToolbarItem>
              <Button variant="link" onClick={stream.reload}>
                {t('Reload')}
              </Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="link"
                onClick={onDownload}
                isDisabled={stream.buffer.length === 0}
              >
                {t('Download')}
              </Button>
            </ToolbarItem>
          </ToolbarGroup>
        </>
      }
    />
  );
};

export default NodeLogsTab;

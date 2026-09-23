import type { FC, Ref } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  MenuToggle,
  Select,
  SelectList,
  SelectOption,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import type { MenuToggleElement, SelectProps } from '@patternfly/react-core';
import type { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import { LogsPanel } from './LogsPanel';
import { podLogURL } from './log-urls';
import { earlierPodLines, PAGE_LINES } from './pagination';
import { fetchLines, useEarlierPages } from './useEarlierPages';
import { isLogFormat, sniffFormat } from './parse';
import type { LogFormat } from './parse';
import { useLogStream } from './useLogStream';
import './log-viewer.css';

/** The subset of a Pod this tab reads. */
interface PodKind {
  metadata?: {
    name?: string;
    namespace?: string;
    annotations?: Record<string, string>;
  };
  spec?: {
    containers?: { name: string }[];
    initContainers?: { name: string }[];
    ephemeralContainers?: { name: string }[];
  };
}

/** Lines examined when guessing a log's format. */
const SNIFF_LINES = 5;

/**
 * Lines fetched up front, and per page when scrolling back. Enough that the
 * common case needs one request, small enough to stay a fraction of a second.
 */
const DEFAULT_TAIL = PAGE_LINES;

/**
 * The reader's explicit format choice, remembered across pods. Absent means
 * "not chosen yet", in which case the format is sniffed from the first lines
 * of each pod's log (see sniffFormat).
 */
const FORMAT_STORAGE_KEY = 'logging-console-plugin/log-format';

const readStoredFormat = (): LogFormat | null => {
  try {
    const stored = window.localStorage.getItem(FORMAT_STORAGE_KEY);
    return isLogFormat(stored) ? stored : null;
  } catch {
    // Private mode, or storage disabled by policy.
    return null;
  }
};

const storeFormat = (format: LogFormat): void => {
  try {
    window.localStorage.setItem(FORMAT_STORAGE_KEY, format);
  } catch {
    // Not being able to remember the choice is not worth failing the tab over.
  }
};

interface SimpleSelectProps {
  options: { value: string; label: string }[];
  selected: string;
  onChange: (value: string) => void;
  testId: string;
  ariaLabel: string;
}

const SimpleSelect: FC<SimpleSelectProps> = ({
  options,
  selected,
  onChange,
  testId,
  ariaLabel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const onSelect: SelectProps['onSelect'] = (_event, value) => {
    onChange(String(value));
    setIsOpen(false);
  };
  return (
    <Select
      isOpen={isOpen}
      selected={selected}
      onSelect={onSelect}
      onOpenChange={setIsOpen}
      toggle={(toggleRef: Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          onClick={() => {
            setIsOpen(!isOpen);
          }}
          isExpanded={isOpen}
          aria-label={ariaLabel}
          data-test={testId}
        >
          {options.find((o) => o.value === selected)?.label ?? selected}
        </MenuToggle>
      )}
      shouldFocusToggleOnSelect
      popperProps={{ appendTo: 'inline' }}
    >
      <SelectList>
        {options.map((option) => (
          <SelectOption key={option.value} value={option.value}>
            {option.label}
          </SelectOption>
        ))}
      </SelectList>
    </Select>
  );
};

/**
 * This plugin's Pod "Logs" tab, shown in place of console core's own while
 * LOGGING_PLUGIN_POD_LOGS_ENABLED is set (patches/0025-pod-logs-flag-gate.patch
 * drops core's tab from pod.tsx under that flag, since a plugin's
 * console.tab/horizontalNav extension can only add a tab, never replace one).
 *
 * Logs are read straight off console's Kubernetes proxy under the caller's own
 * credentials -- this tab needs nothing from the plugin backend, so it works
 * on any cluster regardless of whether the node-logs-api DaemonSet is present.
 */
export const PodLogsTab: FC<PageComponentProps<PodKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__logging-console-plugin');

  const containers = useMemo(() => {
    const spec = obj?.spec;
    return [
      ...(spec?.initContainers ?? []),
      ...(spec?.containers ?? []),
      ...(spec?.ephemeralContainers ?? []),
    ].map((container) => container.name);
  }, [obj?.spec]);

  const defaultContainer =
    obj?.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];
  const [container, setContainer] = useState<string>('');
  // The pod's own preference, then its first ordinary container, then
  // whatever it has (a pod may be nothing but init containers).
  const preferred =
    defaultContainer !== undefined && containers.includes(defaultContainer)
      ? defaultContainer
      : (obj?.spec?.containers?.[0]?.name ?? containers.at(0) ?? '');
  const activeContainer = containers.includes(container)
    ? container
    : preferred;

  // How many pages of history have been pulled in behind the live tail. Only
  // used to size the next request, since the kubelet has no notion of an
  // offset -- see ./pagination.ts.
  const pagesLoaded = useRef(1);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);

  const namespace = obj?.metadata?.namespace ?? '';
  const podName = obj?.metadata?.name ?? '';

  const stream = useLogStream(
    namespace && podName && activeContainer
      ? podLogURL({
          namespace,
          podName,
          container: activeContainer,
          tailLines: DEFAULT_TAIL,
          follow,
          previous,
        })
      : null,
  );

  // --- format -------------------------------------------------------------
  const [chosenFormat, setChosenFormat] = useState<LogFormat | null>(
    readStoredFormat,
  );

  // Sniffed during render, not in an effect and not memoised: an effect would
  // only see the lines a frame after they landed, so the view would render its
  // first screenful as plain text and then visibly re-format itself. The cost
  // is decoding at most five short lines per render -- single-digit
  // microseconds, against the 16 ms the frame has -- and the answer is stable
  // because the lines it looks at are the oldest ones the buffer still holds.
  const sample: string[] = [];
  const sampleFrom = stream.buffer.firstSeq;
  for (let i = 0; i < Math.min(SNIFF_LINES, stream.buffer.length); i++) {
    const line = stream.buffer.lineAt(sampleFrom + i);
    if (line !== null) {
      sample.push(line);
    }
  }
  const sniffedFormat = sniffFormat(sample);

  const format = chosenFormat ?? sniffedFormat;

  const onContainerChange = useCallback((value: string) => {
    setContainer(value);
    pagesLoaded.current = 1;
  }, []);

  const onFormatChange = useCallback((value: string) => {
    if (isLogFormat(value)) {
      setChosenFormat(value);
      storeFormat(value);
    }
  }, []);

  /**
   * `tailLines` counts back from the present and there is no "until", so the
   * only way to reach further back is to ask for a bigger tail and keep the
   * part we do not already have. The join is found by content, because the
   * window slides while the request is in flight.
   */
  const fetchEarlier = useCallback(
    async (signal: AbortSignal) => {
      if (!namespace || !podName || !activeContainer) {
        return [];
      }
      const held = stream.buffer.length;
      const nextPage = pagesLoaded.current + 1;
      const fetched = await fetchLines(
        podLogURL({
          namespace,
          podName,
          container: activeContainer,
          tailLines: DEFAULT_TAIL * nextPage,
          follow: false,
          previous,
        }),
        signal,
      );
      const earlier = earlierPodLines(
        fetched,
        stream.buffer.lineAt(stream.buffer.firstSeq),
        held,
      );
      if (earlier.length > 0) {
        pagesLoaded.current = nextPage;
      }
      return earlier;
    },
    [namespace, podName, activeContainer, previous, stream.buffer],
  );

  const earlier = useEarlierPages({
    fetchEarlier,
    prepend: stream.prepend,
    resetKey: `${namespace}/${podName}/${activeContainer}/${String(previous)}`,
    ready: stream.buffer.length > 0,
  });

  const onDownload = useCallback(() => {
    const blob = new Blob([stream.buffer.text()], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${podName}-${activeContainer}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [stream.buffer, podName, activeContainer]);

  if (containers.length === 0) {
    return (
      <Alert
        variant="info"
        isInline
        title={t('This pod has no containers to read logs from.')}
      />
    );
  }

  return (
    <LogsPanel
      stream={stream}
      format={format}
      follow={follow}
      earlier={earlier}
      errorTitle={t('Could not read the container log')}
      toolbar={
        <>
          <ToolbarGroup variant="filter-group">
            <ToolbarItem>
              <SimpleSelect
                testId="log-container-select"
                ariaLabel={t('Container')}
                options={containers.map((name) => ({
                  value: name,
                  label: name,
                }))}
                selected={activeContainer}
                onChange={onContainerChange}
              />
            </ToolbarItem>
            <ToolbarItem>
              <SimpleSelect
                testId="log-format-select"
                ariaLabel={t('Log format')}
                options={[
                  { value: 'plain', label: t('Plain') },
                  { value: 'json', label: t('JSON') },
                  { value: 'ecs', label: t('ECS') },
                ]}
                selected={format}
                onChange={onFormatChange}
              />
            </ToolbarItem>
          </ToolbarGroup>
          <ToolbarGroup>
            <ToolbarItem>
              <Checkbox
                id="logging-pod-logs-follow"
                label={t('Follow')}
                isChecked={follow}
                onChange={(_event, checked) => {
                  setFollow(checked);
                }}
                data-test="log-follow"
              />
            </ToolbarItem>
            <ToolbarItem>
              <Checkbox
                id="logging-pod-logs-previous"
                label={t('Previous terminated container')}
                isChecked={previous}
                onChange={(_event, checked) => {
                  setPrevious(checked);
                }}
                data-test="log-previous"
              />
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

export default PodLogsTab;

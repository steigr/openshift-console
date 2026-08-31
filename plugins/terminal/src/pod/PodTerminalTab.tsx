import * as React from 'react';
import type { FC, Ref } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  AlertActionLink,
  Button,
  Flex,
  FlexItem,
  MenuToggle,
  Select,
  SelectList,
  SelectOption,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import type { MenuToggleElement, SelectProps } from '@patternfly/react-core';
import { ExpandIcon, KeyboardIcon } from '@patternfly/react-icons';
import type { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import { listVncConnections, VncPodConsole } from './transport';
import type { PodKind, TerminalAction } from './types';
import { execURL, ExecChannel } from '../shared/exec';
import { ImperativeTerminalType, Terminal } from '../shared/Terminal';
import { useFullscreen } from '../shared/useFullscreen';
import '../shared/xterm.css';
import './pod-terminal.css';

// Matches console core's own pod-connect.tsx error-channel special case: the
// literal k8s message when a container has no shell at all to exec into.
const NO_SH =
  'starting container process caused "exec: \\"sh\\": executable file not found in $PATH"';

/**
 * Stable-sorts by `priority` ascending; items without one sort after every
 * item that has one, keeping their relative input order among themselves.
 */
const sortByPriority = <T extends { priority?: number }>(items: T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ap = a.item.priority ?? Number.POSITIVE_INFINITY;
      const bp = b.item.priority ?? Number.POSITIVE_INFINITY;
      return ap !== bp ? ap - bp : a.index - b.index;
    })
    .map(({ item }) => item);

type Entry = {
  value: string;
  label: string;
  containerName: string;
  /** Set only for a VNC entry - the id passed to VncPodConsole as connectionId. */
  connectionId?: string;
};

const ConnectionSelect: FC<{
  options: Entry[];
  selected: string;
  onChange: (value: string) => void;
}> = ({ options, selected, onChange }) => {
  const { t } = useTranslation('public');
  const [isOpen, setIsOpen] = useState(false);

  const onSelect: SelectProps['onSelect'] = (_event, value: string) => {
    onChange(value as string);
    setIsOpen(false);
  };

  return (
    <Select
      isOpen={isOpen}
      selected={selected}
      onSelect={onSelect}
      onOpenChange={(open) => setIsOpen(open)}
      toggle={(toggleRef: Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          onClick={() => setIsOpen(!isOpen)}
          isExpanded={isOpen}
          data-test="pod-terminal-connection-select"
        >
          {options.find((o) => o.value === selected)?.label ?? selected}
        </MenuToggle>
      )}
      shouldFocusToggleOnSelect
      popperProps={{ appendTo: 'inline' }}
    >
      <SelectList>
        {options.map(({ value, label }) => (
          <SelectOption key={value} value={value} data-test-dropdown-menu={value}>
            {label}
          </SelectOption>
        ))}
      </SelectList>
    </Select>
  );
  void t;
};

const ActionsMenu: FC<{ actions: TerminalAction[] }> = ({ actions }) => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  const [isOpen, setIsOpen] = useState(false);

  if (actions.length === 0) {
    return null;
  }

  const onSelect: SelectProps['onSelect'] = (_event, value: string) => {
    setIsOpen(false);
    actions.find((action) => action.id === value)?.onSelect();
  };

  return (
    <Select
      isOpen={isOpen}
      onSelect={onSelect}
      onOpenChange={(open) => setIsOpen(open)}
      toggle={(toggleRef: Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          onClick={() => setIsOpen(!isOpen)}
          isExpanded={isOpen}
          variant="plain"
          aria-label={t('Send key')}
          data-test="pod-terminal-actions"
        >
          <KeyboardIcon />
        </MenuToggle>
      )}
      popperProps={{ appendTo: 'inline', position: 'right' }}
    >
      <SelectList>
        {actions.map(({ id, label }) => (
          <SelectOption key={id} value={id} data-test-dropdown-menu={id}>
            {label}
          </SelectOption>
        ))}
      </SelectList>
    </Select>
  );
};

/**
 * Plugin-provided Pod "Terminal" tab - fully replaces console core's own
 * (frontend/public/components/pod-connect.tsx), rather than augmenting it
 * the way the retired patches/0019-pod-connect-transport-extension.patch
 * did. Registered as a `console.tab/horizontalNav` extension, gated on the
 * TERMINAL_PLUGIN_POD_TERMINAL_ENABLED flag; console core's own Pod
 * Terminal tab hides itself under that same flag (patches/0019, the new
 * flag-gate one).
 *
 * Owns a single merged "Connecting to" dropdown: VNC connections first (by
 * priority, then annotation order), then a plain exec entry per container
 * in pod-manifest order - the same rules the retired core patch used, just
 * relocated here. VNC entries render VncPodConsole (noVNC) unchanged; plain
 * entries get a real xterm.js session (../shared/Terminal.tsx: xterm 6,
 * Ctrl+F/Cmd+F search, sixel, Victor Mono Nerd Font Propo) over the k8s
 * `pods/exec` subresource.
 *
 * Known limitation: unlike core's own tab, this can't read impersonation
 * state (getImpersonate/Redux access isn't part of the public
 * dynamic-plugin-sdk) - an impersonating admin should flip the flag off to
 * get core's terminal back. Matches Node Terminal's existing exec, which
 * has the same gap.
 */
export const PodTerminalTab: FC<PageComponentProps<PodKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  const terminalRef = useRef<ImperativeTerminalType>(null);
  const execRef = useRef<ExecChannel | null>(null);
  const [fullscreenRef, toggleFullscreen, isFullscreen, canUseFullScreen] = useFullscreen();

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actions, setActions] = useState<TerminalAction[]>([]);
  const [attempt, setAttempt] = useState(0);

  const vncEntries = useMemo(
    () =>
      sortByPriority(listVncConnections(obj)).map((c) => ({
        value: `vnc:${c.id}`,
        label: c.label,
        containerName: c.containerName,
        connectionId: c.id,
      })),
    [obj],
  );

  const terminalEntries = useMemo(
    () =>
      (obj?.spec?.containers ?? []).map((c) => ({
        value: `terminal:${c.name}`,
        label: c.name,
        containerName: c.name,
      })),
    [obj?.spec?.containers],
  );

  const allEntries = useMemo<Entry[]>(
    () => [...vncEntries, ...terminalEntries],
    [vncEntries, terminalEntries],
  );

  // Same "pin to this container" signal console core's own tab honored -
  // still only steers which entry (VNC connection or Terminal) is
  // *preselected* for that container, not which container is reachable at
  // all (every container's Terminal entry is always in the dropdown).
  const preferredContainerName = obj?.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];

  // `null` means "follow the default selection"; set once the user picks one.
  const [selectedValue, setSelectedValue] = useState<string | null>(null);

  const activeEntry = useMemo(() => {
    const selected = selectedValue && allEntries.find((entry) => entry.value === selectedValue);
    if (selected) {
      return selected;
    }
    if (preferredContainerName) {
      return allEntries.find((entry) => entry.containerName === preferredContainerName) ?? allEntries[0];
    }
    return allEntries[0];
  }, [selectedValue, allEntries, preferredContainerName]);

  const activeValue = activeEntry?.value ?? '';
  const activeContainerName = activeEntry?.containerName ?? obj?.spec?.containers?.[0]?.name;
  const isVncEntry = activeEntry?.connectionId !== undefined;

  const podName = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace;
  const isWindows = obj?.spec?.os?.name === 'windows';

  // A selection switch (VNC target or container alike) invalidates the
  // previous connection's error and its "send key" actions - the incoming
  // one (if any) reports its own.
  useEffect(() => {
    setError(null);
    setActions([]);
  }, [activeValue]);

  // Plain exec connection lifecycle - a no-op while a VNC entry is active
  // (VncPodConsole manages its own connection entirely).
  useEffect(() => {
    if (isVncEntry || !namespace || !podName || !activeContainerName) {
      return undefined;
    }

    let cancelled = false;
    let lastData = '';
    setOpen(false);
    setError(null);

    const command = isWindows ? ['cmd'] : ['sh', '-i', '-c', 'TERM=xterm sh'];
    const channel = new ExecChannel(execURL(namespace, podName, activeContainerName, command), {
      onOpen: () => {
        setOpen(true);
        setError(null);
        terminalRef.current?.focus();
      },
      onData: (data) => {
        terminalRef.current?.onDataReceived(data);
        lastData = data;
      },
      onStreamError: (message) => {
        if (lastData.includes(NO_SH)) {
          const hint = t(
            "This container doesn't have a /bin/sh shell. Try specifying your command in a terminal with:\r\n\r\n oc -n {{namespace}} exec {{pod}} -ti <command>",
            { namespace, pod: podName },
          );
          terminalRef.current?.onConnectionClosed(hint);
          setError(hint);
        } else {
          setError(message);
        }
      },
      onClose: (message) => {
        if (cancelled) {
          return;
        }
        setOpen(false);
        const errorMsg = message || t('The terminal connection has closed.');
        setError(errorMsg);
        terminalRef.current?.onConnectionClosed(errorMsg);
      },
    });
    execRef.current = channel;

    return () => {
      cancelled = true;
      channel.sendInput('exit\r');
      channel.destroy();
      execRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVncEntry, namespace, podName, activeContainerName, isWindows, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  const onResize = useCallback((rows: number, cols: number) => execRef.current?.sendResize(rows, cols), []);
  const onData = useCallback((data: string) => execRef.current?.sendInput(data), []);

  const reconnectAction =
    !isVncEntry && obj?.status?.phase === 'Running' ? (
      <AlertActionLink onClick={reconnect}>{t('Reconnect')}</AlertActionLink>
    ) : null;

  let body: React.ReactNode = (
    <div className="terminal-pod-console__loading">{t('Loading...')}</div>
  );
  if (isVncEntry) {
    body = (
      <VncPodConsole
        obj={obj}
        containerName={activeContainerName}
        connectionId={activeEntry.connectionId}
        isFullscreen={isFullscreen}
        onError={setError}
        onActionsChange={setActions}
      />
    );
  } else if (open || error) {
    body = <Terminal ref={terminalRef} onData={onData} onResize={onResize} />;
  }

  return (
    <div ref={fullscreenRef} className="terminal-pod-console">
      <Toolbar className="terminal-pod-console__toolbar">
        <ToolbarContent alignItems="center">
          <Flex direction={{ default: 'column', sm: 'row' }}>
            <FlexItem>{t('Connecting to')}</FlexItem>
            <FlexItem>
              {allEntries.length > 1 ? (
                <ConnectionSelect options={allEntries} selected={activeValue} onChange={setSelectedValue} />
              ) : (
                <span data-test="pod-terminal-connection-label">{activeContainerName}</span>
              )}
            </FlexItem>
          </Flex>
          {(actions.length > 0 || (!error && canUseFullScreen)) && (
            <ToolbarGroup align={{ default: 'alignEnd' }}>
              {actions.length > 0 && (
                <ToolbarItem>
                  <ActionsMenu actions={actions} />
                </ToolbarItem>
              )}
              {!error && canUseFullScreen && (
                <ToolbarItem>
                  <Button
                    icon={<ExpandIcon className="co-icon-space-r" />}
                    variant="link"
                    onClick={toggleFullscreen}
                    data-test="pod-terminal-expand"
                  >
                    {isFullscreen ? t('Collapse') : t('Expand')}
                  </Button>
                </ToolbarItem>
              )}
            </ToolbarGroup>
          )}
        </ToolbarContent>
      </Toolbar>
      {error && !isVncEntry && (
        <Alert variant="warning" title={error} actionLinks={reconnectAction} isInline className="pf-v6-u-mb-md" />
      )}
      <div className="terminal-pod-console__body">{body}</div>
    </div>
  );
};

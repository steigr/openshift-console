import * as React from 'react';
import type { FC } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@patternfly/react-core';
import {
  k8sCreate,
  k8sDelete,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import type { K8sResourceCommon, PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import { getCurrentUsername, sanitizeUsername } from './currentUser';
import { getDebugPod } from './debugPod';
import { NamespaceModel, PodModel } from './models';
import type { NodeKind, PodKind } from './types';
import { execURL, ExecChannel } from '../shared/exec';
import { ImperativeTerminalType, Terminal } from '../shared/Terminal';
import '../shared/xterm.css';

const LoadingBox: FC = () => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  return <div className="terminal-node-console__loading">{t('Loading...')}</div>;
};

const ErrorBox: FC<{ error: string }> = ({ error }) => (
  <Alert variant="danger" isInline title={error} data-test="node-terminal-error" />
);

// A `pods/exec` running "--phase=exec-session" against a host-published
// copy of the shim binary at
// /var/lib/node-terminal-shim/node-terminal-shim-<pod uid> (not /run -
// commonly mounted noexec) - not `pods/attach` to the container's own
// primary pty - for session privacy:
// see debugPod.ts's own comment on NODE_TERMINAL_EXEC_MODE for why (in
// short, CRI-O relays whatever flows through the *primary* pty into the
// container's persistent log file, which `pods/exec` sessions don't touch
// at all). The published-copy path is needed because this `kubectl exec`
// call lands in PID 1's *current* mount/pid namespaces, which by the time
// the debug pod is Running are already the host's, not the container's own
// (see node-terminal/src/pipeline.c's publish_shim_binary() doc comment) -
// the container-local "/node-terminal-shim" path is unreachable from there.
// This does mean the debug pod's own setup (identity/home mount -
// node-terminal/src/pipeline.c) and this exec call race: the shim retries
// internally for up to 10s waiting for that setup to publish its "ready"
// marker before giving up (pipeline_run_exec_session()), so this hint's
// own timeout is set comfortably past that, to avoid firing during an
// entirely normal wait.
const NO_OUTPUT_HINT_MS = 12_000;

/**
 * Plugin-provided Node "Terminal" tab - a port of console core's own
 * NodeTerminal.tsx (see src/node/debugPod.ts for the shared debug-pod
 * convention). Registered as a `console.tab/horizontalNav` extension, gated
 * on the TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED flag; console core's own Node
 * Terminal tab hides itself under that same flag (patches/0020).
 */
export const NodeTerminalTab: FC<PageComponentProps<NodeKind>> = ({ obj: node }) => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  const terminalRef = useRef<ImperativeTerminalType>(null);
  const execRef = useRef<ExecChannel | null>(null);
  const [podName, setPodName] = useState('');
  const [podNamespace, setPodNamespace] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [noOutputHint, setNoOutputHint] = useState(false);

  const nodeName = node?.metadata?.name;

  const watchResource = useMemo(
    () =>
      podName && podNamespace
        ? { kind: 'Pod', name: podName, namespace: podNamespace, isList: false as const }
        : null,
    [podName, podNamespace],
  );
  const [pod, loaded, loadError] = useK8sWatchResource<PodKind>(watchResource);

  useEffect(() => {
    if (!nodeName) {
      return undefined;
    }
    let namespace: K8sResourceCommon | undefined;
    const deleteNamespace = async (ns: string) => {
      try {
        await k8sDelete({ model: NamespaceModel, resource: { metadata: { name: ns } } });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('Could not delete node terminal debug namespace.', e);
      }
    };
    const closeTab = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      if (namespace?.metadata?.name) {
        deleteNamespace(namespace!.metadata!.name);
      }
    };
    const createDebugPod = async () => {
      try {
        namespace = await k8sCreate<K8sResourceCommon>({
          model: NamespaceModel,
          data: {
            metadata: {
              generateName: 'openshift-debug-',
              labels: {
                'openshift.io/run-level': '0',
                'pod-security.kubernetes.io/audit': 'privileged',
                'pod-security.kubernetes.io/enforce': 'privileged',
                'pod-security.kubernetes.io/warn': 'privileged',
                'security.openshift.io/scc.podSecurityLabelSync': 'false',
              },
              annotations: { 'openshift.io/node-selector': '' },
            },
          },
        });
        const debugNamespace = namespace!.metadata!.name;
        if (!debugNamespace) {
          throw new Error('Debug namespace was created without a name.');
        }
        const name = `${nodeName.replace(/\./g, '-')}-debug`;
        const currentUsername = await getCurrentUsername();
        const requestedUsername = currentUsername ? sanitizeUsername(currentUsername) : '';
        const podToCreate = await getDebugPod(name, debugNamespace, node, requestedUsername || undefined);
        // wait for the namespace to be ready
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const debugPod = await k8sCreate({ model: PodModel, data: podToCreate });
        if (debugPod) {
          setPodName(name);
          setPodNamespace(debugNamespace);
        }
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
        if (namespace?.metadata?.name) {
          deleteNamespace(namespace!.metadata!.name);
        }
      }
    };
    createDebugPod();
    window.addEventListener('beforeunload', closeTab);
    return () => {
      execRef.current?.destroy();
      if (namespace?.metadata?.name) {
        deleteNamespace(namespace!.metadata!.name);
      }
      window.removeEventListener('beforeunload', closeTab);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeName]);

  useEffect(() => {
    if (pod?.status?.phase !== 'Running' || execRef.current) {
      return undefined;
    }
    const containerName = pod.spec.containers[0]?.name;
    setNoOutputHint(false);
    let noOutputTimer: ReturnType<typeof setTimeout> | undefined;
    const channel = new ExecChannel(
      execURL(pod.metadata.namespace, pod.metadata.name, containerName, [
        `/var/lib/node-terminal-shim/node-terminal-shim-${pod.metadata.uid}`,
        '--phase=exec-session',
      ]),
      {
        onOpen: () => {
          noOutputTimer = setTimeout(() => setNoOutputHint(true), NO_OUTPUT_HINT_MS);
        },
        onData: (data) => {
          if (noOutputTimer) {
            clearTimeout(noOutputTimer);
            noOutputTimer = undefined;
          }
          setNoOutputHint(false);
          terminalRef.current?.onDataReceived(data);
        },
        onStreamError: (message) => terminalRef.current?.onConnectionClosed(message),
        onClose: (message) =>
          terminalRef.current?.onConnectionClosed(message || t('The terminal connection has closed.')),
      },
    );
    execRef.current = channel;
    return () => {
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      channel.destroy();
      execRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pod?.status?.phase, pod?.metadata?.name, pod?.metadata?.namespace]);

  if (errorMessage) {
    return <ErrorBox error={errorMessage} />;
  }
  if (!podName) {
    return <LoadingBox />;
  }
  if (loadError) {
    return <ErrorBox error={loadError instanceof Error ? loadError.message : String(loadError)} />;
  }
  if (!loaded) {
    return <LoadingBox />;
  }
  if (!pod) {
    return <ErrorBox error={t('Debug pod not found or was deleted.')} />;
  }
  if (pod.status?.phase === 'Failed') {
    return (
      <ErrorBox
        error={
          pod.status?.containerStatuses?.[0]?.state?.terminated?.message ||
          pod.status?.message ||
          t('The debug pod failed.')
        }
      />
    );
  }
  if (pod.status?.phase !== 'Running') {
    return <LoadingBox />;
  }

  return (
    <>
      {noOutputHint && (
        <Alert
          variant="info"
          isInline
          title={t('No output received yet')}
          data-test="node-terminal-no-output-hint"
        >
          {t(
            "The terminal session hasn't sent any data yet. If it is running the privileged node-terminal shim, check that its container command includes --csi-path and that the CSI home volume it points at is actually mounted, and that the exec session actually found a completed setup - see the terminal plugin README.",
          )}
        </Alert>
      )}
      <Terminal
        ref={terminalRef}
        onData={(data) => execRef.current?.sendInput(data)}
        onResize={(rows, cols) => execRef.current?.sendResize(rows, cols)}
      />
    </>
  );
};

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

import { getDebugPod } from './debugPod';
import { NamespaceModel, PodModel } from './models';
import type { NodeKind, PodKind } from './types';
import { attachURL, ExecChannel } from '../shared/exec';
import { ImperativeTerminalType, Terminal } from '../shared/Terminal';
import '../shared/xterm.css';

const LoadingBox: FC = () => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  return <div className="terminal-node-console__loading">{t('Loading...')}</div>;
};

const ErrorBox: FC<{ error: string }> = ({ error }) => (
  <Alert variant="danger" isInline title={error} data-test="node-terminal-error" />
);

// The attach subresource connects to whichever process the debug pod's
// container already started as PID 1 - if that process never writes
// anything (e.g. the node-terminal shim idling because it wasn't given
// --csi-path, or was but its CSI home volume isn't actually mounted; see
// node-terminal/src/pipeline.c), the tab would otherwise stay blank forever
// with no indication anything is wrong. Surface a hint instead of silence.
const NO_OUTPUT_HINT_MS = 8_000;

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
        const podToCreate = await getDebugPod(name, debugNamespace, node);
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
      attachURL(pod.metadata.namespace, pod.metadata.name, containerName),
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
            'The debug pod is attached but has not sent any data. If it is running the privileged node-terminal shim, check that its container command includes --csi-path and that the CSI home volume it points at is actually mounted - see the terminal plugin README.',
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

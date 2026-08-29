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
import { ExecChannel, execURL } from './exec';
import { NamespaceModel, PodModel } from './models';
import { ImperativeTerminalType, Terminal } from './Terminal';
import type { NodeKind, PodKind } from './types';
import './node-terminal.css';

const LoadingBox: FC = () => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  return <div className="terminal-node-console__loading">{t('Loading...')}</div>;
};

const ErrorBox: FC<{ error: string }> = ({ error }) => (
  <Alert variant="danger" isInline title={error} data-test="node-terminal-error" />
);

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
    const isWindows = pod.spec.OS === 'windows';
    const command = isWindows ? ['cmd'] : ['sh', '-i', '-c', 'TERM=xterm sh'];
    const channel = new ExecChannel(
      execURL(pod.metadata.namespace, pod.metadata.name, containerName, command),
      {
        onData: (data) => terminalRef.current?.onDataReceived(data),
        onStreamError: (message) => terminalRef.current?.onConnectionClosed(message),
        onClose: (message) =>
          terminalRef.current?.onConnectionClosed(message || t('The terminal connection has closed.')),
      },
    );
    execRef.current = channel;
    return () => {
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
    <Terminal
      ref={terminalRef}
      onData={(data) => execRef.current?.sendInput(data)}
      onResize={(rows, cols) => execRef.current?.sendResize(rows, cols)}
    />
  );
};

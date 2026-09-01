import { k8sGet } from '@openshift-console/dynamic-plugin-sdk';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { load as loadYAML } from 'js-yaml';

import { ConfigMapModel, ImageStreamTagModel } from './models';
import type { NodeKind, PodKind } from './types';

// Mirrors console core's NodeTerminal.tsx (frontend/packages/console-app/src/components/nodes/NodeTerminal.tsx),
// which this Node Terminal tab is a "copy of default terminal for now" port of.
// Keep these two in step with patches/0006-node-terminal-podspec-via-configmap.patch,
// which teaches console core's own Node Terminal tab the same ConfigMap/annotation
// convention.
const SPEC_REFERENCE_ANNOTATION = 'node-terminal.netztronaut.de/spec-reference';
const DEFAULT_CONFIGMAP_NAME = 'node-terminal';
const DEFAULT_CONFIGMAP_NAMESPACE = 'openshift-console';

const safeYAMLToJS = (yaml: string, fallback: any = null): any => {
  try {
    return loadYAML(yaml);
  } catch {
    return fallback;
  }
};

const deepMergePodSpec = (target: any, source: any): any => {
  if (source === null || source === undefined) {
    return target;
  }
  if (Array.isArray(source) || typeof source !== 'object') {
    return source;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return { ...source };
  }
  const out: Record<string, any> = { ...target };
  Object.keys(source).forEach((key) => {
    out[key] = deepMergePodSpec(target[key], source[key]);
  });
  return out;
};

const getOverridePodSpecFromConfigMap = async (
  nodeName: string,
  configMapName = DEFAULT_CONFIGMAP_NAME,
): Promise<PodKind['spec'] | null> => {
  try {
    const configMap = await k8sGet<K8sResourceCommon & { data?: { spec?: string } }>({
      model: ConfigMapModel,
      name: configMapName,
      ns: DEFAULT_CONFIGMAP_NAMESPACE,
    });
    const raw = configMap?.data?.spec;
    if (!raw) {
      return null;
    }
    const parsed = safeYAMLToJS(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    parsed.nodeName = nodeName;
    return parsed;
  } catch {
    return null;
  }
};

const getDebugImage = async (): Promise<string> => {
  try {
    const istag = await k8sGet<K8sResourceCommon & { image: { dockerImageReference: string } }>({
      model: ImageStreamTagModel,
      name: 'tools:latest',
      ns: 'openshift',
    });
    return istag.image.dockerImageReference;
  } catch {
    return 'registry.redhat.io/rhel8/support-tools';
  }
};

export const getDebugPod = async (
  name: string,
  namespace: string,
  node: NodeKind,
  requestedUsername?: string,
): Promise<PodKind> => {
  const nodeName = node.metadata.name;
  const isWindows = node.status?.nodeInfo?.operatingSystem === 'windows';

  let overrideSpec = await getOverridePodSpecFromConfigMap(nodeName);

  const specReference = node.metadata?.annotations?.[SPEC_REFERENCE_ANNOTATION];
  if (specReference) {
    const nodeOverride = await getOverridePodSpecFromConfigMap(nodeName, specReference);
    if (nodeOverride) {
      overrideSpec = deepMergePodSpec(overrideSpec || {}, nodeOverride);
      overrideSpec.nodeName = nodeName;
    }
  }

  if (overrideSpec) {
    if (Array.isArray(overrideSpec.containers) && overrideSpec.containers.length > 0) {
      const c0 = overrideSpec.containers[0];
      c0.env = c0.env || [];
      if (!c0.env.some((e: { name?: string }) => e?.name === 'HAVE_SIXEL_SUPPORT')) {
        c0.env.push({ name: 'HAVE_SIXEL_SUPPORT', value: 'true' });
      }
      // Read by main.c: names the ephemeral host account after the actual
      // logged-in console user instead of the generic k8s-sess-<hex>
      // scheme, when possible - see currentUser.ts for how this is
      // determined and sanitized, and identity_valid_username()/
      // identity_resolve_username() (node-terminal/src/identity.c) for why
      // the shim still independently validates it and can still fall back
      // regardless of what's sent here.
      if (requestedUsername && !c0.env.some((e: { name?: string }) => e?.name === 'NODE_TERMINAL_REQUESTED_USER')) {
        c0.env.push({ name: 'NODE_TERMINAL_REQUESTED_USER', value: requestedUsername });
      }
      // Session privacy: makes the shim (node-terminal/src/pipeline.c)
      // never run the interactive session on this container's own primary
      // pty - the one `pods/attach` connects to, and the one CRI-O/conmon
      // relays into the container's own persistent log file (readable via
      // `kubectl logs`/any log-forwarding pipeline by anyone with pods/log
      // RBAC, not just the session's own operator). NodeTerminalTab.tsx
      // uses `pods/exec` instead, which gets its own separate, transient
      // pty that CRI-O does not persist to that log file. NODE_TERMINAL_POD_UID
      // (via the downward API, not something we can know client-side before
      // the pod actually exists) lets the shim's own exec-session process
      // (a *separate* `kubectl exec` invocation, not a child of this
      // container's PID 1) find the right marker file if more than one such
      // debug pod is ever active on the same node at once - see
      // pipeline_run's own doc comment on NODE_TERMINAL_EXEC_MODE.
      if (!c0.env.some((e: { name?: string }) => e?.name === 'NODE_TERMINAL_EXEC_MODE')) {
        c0.env.push({ name: 'NODE_TERMINAL_EXEC_MODE', value: 'true' });
      }
      if (!c0.env.some((e: { name?: string }) => e?.name === 'NODE_TERMINAL_POD_UID')) {
        c0.env.push({
          name: 'NODE_TERMINAL_POD_UID',
          valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
        });
      }
    }
    return {
      kind: 'Pod',
      apiVersion: 'v1',
      metadata: {
        name,
        namespace,
        annotations: {
          'debug.openshift.io/source-container':
            (Array.isArray(overrideSpec.containers) && overrideSpec.containers[0]?.name) ||
            'container-00',
          'debug.openshift.io/source-resource': `/v1, Resource=nodes/${nodeName}`,
          'openshift.io/scc': 'privileged',
        },
      },
      spec: overrideSpec,
    };
  }

  const image = await getDebugImage();
  const template: PodKind = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name,
      namespace,
      annotations: {
        'debug.openshift.io/source-container': 'container-00',
        'debug.openshift.io/source-resource': `/v1, Resource=nodes/${nodeName}`,
        'openshift.io/scc': 'privileged',
      },
    },
    spec: {
      containers: [
        {
          command: ['/bin/sh'],
          env: [
            { name: 'TMOUT', value: '900' },
            { name: 'HOST', value: '/host' },
          ],
          image,
          name: 'container-00',
          resources: {},
          securityContext: {
            privileged: true,
            runAsUser: 0,
          },
          stdin: true,
          stdinOnce: true,
          tty: true,
          volumeMounts: [{ name: 'host', mountPath: '/host' }],
        },
      ],
      hostIPC: true,
      hostPID: true,
      hostNetwork: true,
      nodeName,
      restartPolicy: 'Never',
      volumes: [{ name: 'host', hostPath: { path: '/', type: 'Directory' } }],
    },
  };

  if (isWindows) {
    template.spec.OS = 'windows';
    template.spec.hostPID = false;
    template.spec.hostIPC = false;
    template.spec.containers[0].securityContext = {
      windowsOptions: { runAsUserName: 'ContainerUser' },
    };
  }

  return template;
};

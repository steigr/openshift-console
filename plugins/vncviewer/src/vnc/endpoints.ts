import type { PodKind } from './types';

export const VNC_ENABLED_LABEL = 'vnc.container.kubernetes.io/enabled';
export const VNC_ENDPOINTS_ANNOTATION = 'vnc.container.kubernetes.io/endpoints';
export const DEFAULT_VNC_PORT = 5900;
export const DEFAULT_SECRET_KEY = 'password';

const MAX_PORT = 65535;

/** Reference to the key of a same-namespace Secret holding the VNC password. */
export type VncSecretRef = {
  name: string;
  /** Defaults to "password". */
  key?: string;
};

/** Exactly one of these carries the VNC (RFB "VNC Authentication") password. */
export type VncAuth = { password: string } | { secretRef: VncSecretRef };

export type VncEndpoint = {
  port: number;
  auth?: VncAuth;
  /** Shown in the target picker when a container has more than one endpoint. */
  label?: string;
};

/**
 * Container name -> the VNC endpoints it serves, in annotation order.
 *
 * A container can list more than one - e.g. a VM container exposing both the
 * hypervisor's own QEMU VNC and the guest OS's in-VM VNC agent on different
 * ports. Only the *port* has to be pod-unique (shared netns); the container
 * name does not.
 */
export type VncEndpoints = { [containerName: string]: VncEndpoint[] };

/** Whether the pod opted in to being served over VNC at all. */
export const isVncPod = (obj: PodKind): boolean =>
  obj?.metadata?.labels?.[VNC_ENABLED_LABEL] === 'true';

const parsePort = (raw: unknown): number | undefined => {
  if (raw === undefined) {
    return DEFAULT_VNC_PORT;
  }
  // Accept a JSON number, and a numeric string for hand-authored annotations,
  // but not '', '0x10', '1e3', ' 12 ', or anything float/negative.
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) {
    return undefined;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT ? port : undefined;
};

const parseAuth = (raw: unknown): VncAuth | undefined => {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { password, secretRef } = raw as { password?: unknown; secretRef?: unknown };

  if (typeof password === 'string' && password.length > 0) {
    return { password };
  }

  if (secretRef && typeof secretRef === 'object') {
    const { name, key } = secretRef as { name?: unknown; key?: unknown };
    if (typeof name === 'string' && name.length > 0) {
      return { secretRef: { name, ...(typeof key === 'string' && key.length > 0 ? { key } : {}) } };
    }
  }

  return undefined;
};

/**
 * VNC endpoints of a pod, parsed from the `vnc.container.kubernetes.io/endpoints`
 * annotation, a JSON array of:
 *
 *   {
 *     "container": "<name>",
 *     "port"?: <port>,
 *     "label"?: "<shown when a container has more than one endpoint>",
 *     "auth"?: { "password": "<plain>" } | { "secretRef": { "name": "<secret>", "key"?: "<key>" } }
 *   }
 *
 * `port` defaults to 5900. `auth` is optional; when a `secretRef` is given, the
 * secret is read from the pod's own namespace under the (VNC-side) "VNC
 * Authentication" password scheme - the browser resolves it via console's own
 * k8s API proxy, so ordinary Secret RBAC applies to the logged-in user. Prefer
 * `secretRef` over inline `password`: annotations are plain text, visible to
 * anyone who can read the pod.
 *
 * With the label set but no annotation, the pod's first container is assumed to
 * serve unauthenticated VNC on the default port.
 *
 * A container may list more than one endpoint (e.g. a VM's hypervisor-level
 * QEMU VNC alongside the guest OS's own in-VM VNC agent, on different ports).
 * Only the *port* is pod-unique - containers share one network namespace, so a
 * port can only be claimed once: an entry naming an already-claimed port, an
 * unknown container, or an invalid port is dropped, as is (since the
 * annotation is then not well-formed at all) a value that fails to parse as a
 * JSON array.
 */
export const vncEndpoints = (obj: PodKind): VncEndpoints => {
  if (!isVncPod(obj)) {
    return {};
  }

  const containerNames = (obj?.spec?.containers ?? []).map(({ name }) => name);
  const spec = obj?.metadata?.annotations?.[VNC_ENDPOINTS_ANNOTATION]?.trim();

  if (!spec) {
    return containerNames.length > 0 ? { [containerNames[0]]: [{ port: DEFAULT_VNC_PORT }] } : {};
  }

  let entries: unknown[];
  try {
    const parsed: unknown = JSON.parse(spec);
    if (!Array.isArray(parsed)) {
      return {};
    }
    entries = parsed;
  } catch {
    return {};
  }

  const endpoints: VncEndpoints = {};
  const claimedPorts = new Set<number>();

  entries.forEach((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object') {
      return;
    }
    const {
      container,
      port: rawPort,
      auth: rawAuth,
      label: rawLabel,
    } = rawEntry as { container?: unknown; port?: unknown; auth?: unknown; label?: unknown };

    if (typeof container !== 'string' || !containerNames.includes(container)) {
      return;
    }

    const port = parsePort(rawPort);
    if (port === undefined || claimedPorts.has(port)) {
      return;
    }

    const auth = parseAuth(rawAuth);
    const label = typeof rawLabel === 'string' && rawLabel.length > 0 ? rawLabel : undefined;
    const endpoint: VncEndpoint = { port, ...(auth ? { auth } : {}), ...(label ? { label } : {}) };

    (endpoints[container] ??= []).push(endpoint);
    claimedPorts.add(port);
  });

  return endpoints;
};

/** The VNC endpoints of a single container, in annotation order (possibly empty). */
export const vncEndpointsForContainer = (obj: PodKind, containerName: string): VncEndpoint[] =>
  vncEndpoints(obj)[containerName] ?? [];

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
};

/** Container name -> the VNC endpoint its container serves. */
export type VncEndpoints = { [containerName: string]: VncEndpoint };

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
 *   { "container": "<name>", "port"?: <port>, "auth"?: { "password": "<plain>" } | { "secretRef": { "name": "<secret>", "key"?: "<key>" } } }
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
 * Containers of a pod share one network namespace, so a port can only be
 * claimed once: entries naming an already claimed port - or an already listed
 * container - are ignored, as are entries naming a container the pod does not
 * have, entries whose port is invalid, and (since the annotation is then not
 * well-formed at all) a value that fails to parse as a JSON array.
 */
export const vncEndpoints = (obj: PodKind): VncEndpoints => {
  if (!isVncPod(obj)) {
    return {};
  }

  const containerNames = (obj?.spec?.containers ?? []).map(({ name }) => name);
  const spec = obj?.metadata?.annotations?.[VNC_ENDPOINTS_ANNOTATION]?.trim();

  if (!spec) {
    return containerNames.length > 0 ? { [containerNames[0]]: { port: DEFAULT_VNC_PORT } } : {};
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
    const { container, port: rawPort, auth: rawAuth } = rawEntry as {
      container?: unknown;
      port?: unknown;
      auth?: unknown;
    };

    if (typeof container !== 'string' || !containerNames.includes(container) || container in endpoints) {
      return;
    }

    const port = parsePort(rawPort);
    if (port === undefined || claimedPorts.has(port)) {
      return;
    }

    const auth = parseAuth(rawAuth);
    endpoints[container] = auth ? { port, auth } : { port };
    claimedPorts.add(port);
  });

  return endpoints;
};

/** The VNC port of a single container, or undefined if it serves no VNC. */
export const vncPort = (obj: PodKind, containerName: string): number | undefined =>
  vncEndpoints(obj)[containerName]?.port;

/** How to authenticate to a container's VNC server, if it needs it at all. */
export const vncAuth = (obj: PodKind, containerName: string): VncAuth | undefined =>
  vncEndpoints(obj)[containerName]?.auth;

import type { PodKind } from './types';

export const VNC_ENABLED_LABEL = 'vnc.container.kubernetes.io/enabled';
export const VNC_ENDPOINTS_ANNOTATION = 'vnc.container.kubernetes.io/endpoints';
export const DEFAULT_VNC_PORT = 5900;

const MAX_PORT = 65535;

/** Container name -> the pod port its VNC server listens on. */
export type VncEndpoints = { [containerName: string]: number };

/** Whether the pod opted in to being served over VNC at all. */
export const isVncPod = (obj: PodKind): boolean =>
  obj?.metadata?.labels?.[VNC_ENABLED_LABEL] === 'true';

const parsePort = (raw: string): number | undefined => {
  // Number() would happily accept '', '0x10', '1e3' and ' 12 '.
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const port = Number(raw);
  return port >= 1 && port <= MAX_PORT ? port : undefined;
};

/**
 * VNC endpoints of a pod, parsed from `vnc.container.kubernetes.io/endpoints`:
 *
 *   CONTAINER[=PORT][,CONTAINER[=PORT]]*
 *
 * With the label set but no annotation, the pod's first container is assumed to
 * serve VNC on the default port.
 *
 * Containers of a pod share one network namespace, so a port can only be
 * claimed once: entries naming an already claimed port - or an already listed
 * container - are ignored, as are entries naming a container the pod does not
 * have and entries whose port is not a valid port number.
 */
export const vncEndpoints = (obj: PodKind): VncEndpoints => {
  if (!isVncPod(obj)) {
    return {};
  }

  const containerNames = (obj?.spec?.containers ?? []).map(({ name }) => name);
  const spec = obj?.metadata?.annotations?.[VNC_ENDPOINTS_ANNOTATION]?.trim();

  if (!spec) {
    return containerNames.length > 0 ? { [containerNames[0]]: DEFAULT_VNC_PORT } : {};
  }

  const endpoints: VncEndpoints = {};
  const claimedPorts = new Set<number>();

  spec.split(',').forEach((rawEntry) => {
    const entry = rawEntry.trim();
    if (!entry) {
      return;
    }

    const parts = entry.split('=');
    if (parts.length > 2) {
      return;
    }

    const name = parts[0].trim();
    if (!containerNames.includes(name) || name in endpoints) {
      return;
    }

    const port = parts.length === 2 ? parsePort(parts[1].trim()) : DEFAULT_VNC_PORT;
    if (port === undefined || claimedPorts.has(port)) {
      return;
    }

    endpoints[name] = port;
    claimedPorts.add(port);
  });

  return endpoints;
};

/** The VNC port of a single container, or undefined if it serves no VNC. */
export const vncPort = (obj: PodKind, containerName: string): number | undefined =>
  vncEndpoints(obj)[containerName];

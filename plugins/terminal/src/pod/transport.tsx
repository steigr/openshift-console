import { vncEndpointsForContainer } from './endpoints';
import type { PodConnectTransportTarget, PodKind } from './types';

export { VncPodConsole } from './VncPodConsole';

/** Whether the VNC transport can serve `containerName` of `obj`. */
export const isVncAvailable = (obj: PodKind, containerName: string): boolean =>
  vncEndpointsForContainer(obj, containerName).length > 0;

/**
 * One target per VNC endpoint on `containerName`. Console composes each into
 * a "via" dropdown entry as "VNC (<label>)" once there's more than one -
 * `label` here is deliberately the endpoint's own bare label (or a port
 * fallback), not prefixed with "VNC" itself. `id` is the port as a string,
 * which is already unique per pod (containers share one network namespace).
 */
export const getVncTargets = (obj: PodKind, containerName: string): PodConnectTransportTarget[] =>
  vncEndpointsForContainer(obj, containerName).map((endpoint) => ({
    id: String(endpoint.port),
    label: endpoint.label ?? `port ${endpoint.port}`,
  }));

import { vncConnections } from './endpoints';
import type { PodConnectConnection, PodKind } from './types';

export { VncPodConsole } from './VncPodConsole';

/**
 * One connection per VNC endpoint across the whole pod, for console's merged
 * "Connecting to" dropdown. `label` is the endpoint's own bare label when
 * set (e.g. "Guest", "QEMU"), falling back to "VNC (<container>)" - not
 * prefixed with the endpoint's own label to avoid "VNC (Guest)" doubling up
 * when the annotation already gives it a specific name. `id` is the port as
 * a string, which is already unique per pod (containers share one network
 * namespace). `priority` passes the annotation's own `priority` straight
 * through - console does the actual sorting.
 */
export const listVncConnections = (obj: PodKind): PodConnectConnection[] =>
  vncConnections(obj).map((connection) => ({
    id: String(connection.port),
    containerName: connection.containerName,
    label: connection.label ?? `VNC (${connection.containerName})`,
    ...(connection.priority !== undefined ? { priority: connection.priority } : {}),
  }));

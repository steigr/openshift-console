import { vncConnections } from './endpoints';
import type { PodKind } from './types';

export { VncPodConsole } from './VncPodConsole';

/** One VNC entry in PodTerminalTab.tsx's merged "Connecting to" dropdown. */
export type VncConnectionOption = {
  /** The port as a string - unique per pod (containers share one network namespace). */
  id: string;
  containerName: string;
  label: string;
  priority?: number;
};

/**
 * One connection per VNC endpoint across the whole pod, for PodTerminalTab.tsx's
 * merged "Connecting to" dropdown. `label` is the endpoint's own bare label
 * when set (e.g. "Guest", "QEMU"), falling back to "VNC (<container>)" - not
 * prefixed with the endpoint's own label to avoid "VNC (Guest)" doubling up
 * when the annotation already gives it a specific name. `priority` passes
 * the annotation's own `priority` straight through - PodTerminalTab.tsx does
 * the actual sorting.
 */
export const listVncConnections = (obj: PodKind): VncConnectionOption[] =>
  vncConnections(obj).map((connection) => ({
    id: String(connection.port),
    containerName: connection.containerName,
    label: connection.label ?? `VNC (${connection.containerName})`,
    ...(connection.priority !== undefined ? { priority: connection.priority } : {}),
  }));

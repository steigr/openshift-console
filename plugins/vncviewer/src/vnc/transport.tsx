import { vncEndpointsForContainer } from './endpoints';
import type { PodKind } from './types';

export { VncPodConsole } from './VncPodConsole';

/** Whether the VNC transport can serve `containerName` of `obj`. */
export const isVncAvailable = (obj: PodKind, containerName: string): boolean =>
  vncEndpointsForContainer(obj, containerName).length > 0;

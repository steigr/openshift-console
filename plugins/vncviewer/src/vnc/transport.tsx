import { vncPort } from './endpoints';
import type { PodKind } from './types';

export { VncPodConsole } from './VncPodConsole';

/** Whether the VNC transport can serve `containerName` of `obj`. */
export const isVncAvailable = (obj: PodKind, containerName: string): boolean =>
  vncPort(obj, containerName) !== undefined;

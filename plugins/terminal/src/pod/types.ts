import type { FC } from 'react';

/**
 * Mirror of the props console core passes to a `stei.gr/pod-connect-transport`
 * extension component (see patches/0019-pod-connect-transport-extension.patch
 * in the openshift-console build repo). Declared locally on purpose: a dynamic
 * plugin must not import from console internals.
 */
/** One item in the toolbar's "send key" menu, e.g. Ctrl+Alt+Del or F11. */
export type PodConnectTransportAction = {
  id: string;
  label: string;
  onSelect: () => void;
};

export type PodConnectTransportProps = {
  obj: PodKind;
  containerName: string;
  subprotocols: string[];
  isFullscreen: boolean;
  onError: (error: string | null) => void;
  onActionsChange: (actions: PodConnectTransportAction[]) => void;
  /**
   * The target selected in the "via" dropdown, when `getTargets` (exposed as
   * `targets` in console-extensions.json) returned more than one entry for
   * this container. Undefined when it returned at most one.
   */
  targetId?: string;
};

export type PodConnectTransportComponent = FC<PodConnectTransportProps>;

/** One selectable option this transport offers within the "via" dropdown. */
export type PodConnectTransportTarget = {
  id: string;
  label: string;
};

/** The subset of a Pod this plugin actually reads. */
export type PodKind = {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: { [key: string]: string };
    annotations?: { [key: string]: string };
  };
  spec?: {
    containers?: { name: string }[];
  };
};

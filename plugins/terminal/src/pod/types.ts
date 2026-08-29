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
};

export type PodConnectTransportComponent = FC<PodConnectTransportProps>;

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

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
  /** The container the selected connection targets. */
  containerName: string;
  subprotocols: string[];
  isFullscreen: boolean;
  onError: (error: string | null) => void;
  onActionsChange: (actions: PodConnectTransportAction[]) => void;
  /** The `id` of the selected entry, from this transport's own `listConnections`. */
  connectionId: string;
};

export type PodConnectTransportComponent = FC<PodConnectTransportProps>;

/**
 * One selectable entry this transport offers in the merged "Connecting to"
 * dropdown, alongside the plain Terminal entry every container already gets.
 */
export type PodConnectConnection = {
  /** Unique among this transport's own connections for the whole pod. */
  id: string;
  /** Which container this connection targets. */
  containerName: string;
  /** Shown verbatim as the dropdown entry's label - compose it as you like. */
  label: string;
  /**
   * Sort key within this transport's connections across the whole dropdown
   * (lower sorts earlier). Connections without one sort after every
   * connection that has one, keeping their relative `listConnections` order
   * among themselves. All transport connections sort before every plain
   * Terminal entry, regardless of priority.
   */
  priority?: number;
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

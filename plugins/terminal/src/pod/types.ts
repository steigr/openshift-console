/** One item in the toolbar's "send key" menu, e.g. Ctrl+Alt+Del or F11. */
export type TerminalAction = {
  id: string;
  label: string;
  onSelect: () => void;
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
    /** PodSpec.os.name, e.g. "windows" - used to pick the right exec shell command. */
    os?: { name?: string };
  };
  status?: {
    phase?: string;
  };
};

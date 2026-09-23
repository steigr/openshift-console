import { consolePath } from '../console-path';

export interface PodLogQuery {
  namespace: string;
  podName: string;
  container: string;
  /**
   * How many lines to ask for up front, or null for the whole log the node
   * still holds -- however many files the kubelet and container runtime have
   * not yet rotated away.
   */
  tailLines: number | null;
  /** Keep the response open and append as the container writes. */
  follow: boolean;
  /** Read the previous terminated container's log instead. */
  previous: boolean;
}

/** Console proxies this straight to the apiserver under the caller's own RBAC. */
export const podLogURL = ({
  namespace,
  podName,
  container,
  tailLines,
  follow,
  previous,
}: PodLogQuery): string => {
  const query = new URLSearchParams({ container });
  // Omitting tailLines entirely is what makes the apiserver serve the log
  // from the beginning of what the node still has on disk.
  if (tailLines !== null) {
    query.set('tailLines', String(tailLines));
  }
  if (follow) {
    query.set('follow', 'true');
  }
  if (previous) {
    query.set('previous', 'true');
  }
  return consolePath(
    `/api/kubernetes/api/v1/namespaces/${encodeURIComponent(
      namespace,
    )}/pods/${encodeURIComponent(podName)}/log?${query.toString()}`,
  );
};

export interface NodeJournalQuery {
  node: string;
  /** Systemd units to restrict to; empty means the whole journal. */
  units: string[];
  /** Entries to fetch, or null for everything the journal still holds. */
  tailLines: number | null;
  /**
   * Walk backwards from this journald cursor instead of from the end, which
   * is how the tab pages into history. Entries come back newest-first.
   */
  beforeCursor?: string | null;
}

/**
 * The plugin's *proxy* route, not its asset route: this one passes the query
 * string and the caller's credentials through, which the backend needs both to
 * build the journalctl invocation and to authorize the caller (a
 * SelfSubjectAccessReview for `get nodes/proxy`, the same permission console
 * core's own Node Logs tab requires).
 */
export const nodeJournalURL = ({
  node,
  units,
  tailLines,
  beforeCursor = null,
}: NodeJournalQuery): string => {
  const query = new URLSearchParams();
  // Per-line JSON, which is what the viewer renders as columns. Console core's
  // own tab asks the same backend for text and still gets it.
  query.set('output', 'json');
  // 0 is the backend's "no -n flag at all", i.e. the whole journal; there is
  // no way to spell that by leaving the parameter out, which instead means
  // its default tail.
  query.set('tailLines', String(tailLines ?? 0));
  if (beforeCursor !== null) {
    query.set('beforeCursor', beforeCursor);
  }
  units.forEach((unit) => {
    query.append('unit', unit);
  });
  return consolePath(
    `/api/proxy/plugin/logging-console-plugin/api/v1/nodes/${encodeURIComponent(
      node,
    )}/journal?${query.toString()}`,
  );
};

/**
 * Systemd unit names, matching what the backend will accept. The leading
 * character set excludes '-' so a unit can never reach journalctl as a flag.
 */
const UNIT_RE = /^[A-Za-z0-9@:._][A-Za-z0-9@:._-]*$/;

/** Splits a free-text unit filter, dropping anything the backend would reject. */
export const parseUnits = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((unit) => unit.trim())
    .filter((unit) => unit !== '' && UNIT_RE.test(unit));

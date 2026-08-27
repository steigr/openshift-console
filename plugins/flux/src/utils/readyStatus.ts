import { Condition } from '../types';
import { getCondition, getReadyCondition } from './status';

// The semantic bucket a resource's Ready condition falls into, used to pick
// an icon/color for the Ready column. Covers every GitOps Toolkit
// controller (source/kustomize/helm/notification/image) and the
// flux-operator, which all share the same Ready/Stalled condition
// conventions from fluxcd/pkg/apis/meta plus helm-controller's
// Helm-release-specific reasons (Install/Upgrade/Rollback/Test).
export type ReadyStatusKind =
  | 'success'
  | 'rollback-recent'
  | 'failed-nonretryable'
  | 'failed-retryable'
  | 'artifact-failed-recent'
  | 'artifact-failed-stale'
  | 'dependency-not-ready';

export type ReadyStatus = {
  kind: ReadyStatusKind;
  label: string;
  message?: string;
};

const ROLLBACK_RECENT_MS = 24 * 60 * 60 * 1000;

// Fallback used when a resource has no (parsable) spec.interval to compare
// the ArtifactFailed condition's age against.
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Parses the subset of Go's time.Duration syntax Flux CRDs use for
// spec.interval (e.g. "5m", "1h30m", "45s") into milliseconds.
export const parseGoDuration = (duration?: string): number | undefined => {
  if (!duration) {
    return undefined;
  }
  const re = /(\d+(?:\.\d+)?)(h|m|s|ms)/g;
  let match: RegExpExecArray | null;
  let totalMs = 0;
  let matched = false;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(duration))) {
    matched = true;
    const value = parseFloat(match[1]);
    const factor = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }[match[2]] as number;
    totalMs += value * factor;
  }
  return matched ? totalMs : undefined;
};

type ConditionBearer = {
  spec?: Record<string, unknown>;
  status?: { conditions?: Condition[] };
};

// Resolves a resource's Ready condition into one of the semantic buckets
// above:
//   - Ready=True: "success" (green), unless the reason is RollbackSucceeded
//     and the rollback happened less than 24h ago ("rollback-recent").
//   - Ready=False, reason=ArtifactFailed: "artifact-failed-recent"/"-stale"
//     depending on whether it's been failing for less than 2x spec.interval.
//   - Ready=False, reason=DependencyNotReady: "dependency-not-ready".
//   - Ready=False otherwise: "failed-nonretryable" if a Stalled condition is
//     set (reconciliation has given up and needs intervention), else
//     "failed-retryable" (still being retried with backoff).
export const getReadyStatus = (obj?: ConditionBearer): ReadyStatus | undefined => {
  const ready = getReadyCondition(obj);
  if (!ready) {
    return undefined;
  }

  const label = ready.reason || (ready.status === 'True' ? 'Ready' : 'NotReady');
  const transitionMs = ready.lastTransitionTime ? Date.parse(ready.lastTransitionTime) : undefined;
  const now = Date.now();

  if (ready.status === 'True') {
    if (ready.reason === 'RollbackSucceeded' && transitionMs !== undefined && now - transitionMs < ROLLBACK_RECENT_MS) {
      return { kind: 'rollback-recent', label, message: ready.message };
    }
    return { kind: 'success', label, message: ready.message };
  }

  if (ready.reason === 'ArtifactFailed') {
    const interval = obj?.spec?.interval;
    const thresholdMs = (parseGoDuration(typeof interval === 'string' ? interval : undefined) ?? DEFAULT_INTERVAL_MS) * 2;
    const isRecent = transitionMs === undefined || now - transitionMs < thresholdMs;
    return { kind: isRecent ? 'artifact-failed-recent' : 'artifact-failed-stale', label, message: ready.message };
  }

  if (ready.reason === 'DependencyNotReady') {
    return { kind: 'dependency-not-ready', label, message: ready.message };
  }

  const stalled = getCondition(obj?.status?.conditions, 'Stalled');
  if (stalled?.status === 'True') {
    return { kind: 'failed-nonretryable', label, message: ready.message };
  }

  return { kind: 'failed-retryable', label, message: ready.message };
};

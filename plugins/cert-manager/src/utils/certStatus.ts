import { Condition } from '../types';

type ConditionBearer = { status?: { conditions?: Condition[] } };

export const getCondition = (
  obj: ConditionBearer,
  type: string,
): Condition | undefined => obj?.status?.conditions?.find((c) => c.type === type);

export const getReadyCondition = (obj: ConditionBearer): Condition | undefined =>
  getCondition(obj, 'Ready');

export const getSyncedCondition = (obj: ConditionBearer): Condition | undefined =>
  getCondition(obj, 'Synced');

// The most recently transitioned condition (by lastTransitionTime) - used
// to show a resource's latest status message on list pages without
// assuming which condition `type` is the "current" one.
export const getLatestCondition = (obj: ConditionBearer): Condition | undefined => {
  const conditions = obj?.status?.conditions;
  if (!conditions || conditions.length === 0) {
    return undefined;
  }
  return conditions.reduce((latest, c) => {
    if (!latest.lastTransitionTime) {
      return c;
    }
    if (!c.lastTransitionTime) {
      return latest;
    }
    return c.lastTransitionTime > latest.lastTransitionTime ? c : latest;
  });
};

// An Issuer/ClusterIssuer's spec has exactly one provider key set
// (acme/ca/vault/selfSigned/venafi) - return it, or "!" if the CRD's own
// validation somehow let more than one through (rendered defensively).
export const getIssuerType = (spec?: Record<string, unknown>): string => {
  if (!spec) {
    return '-';
  }
  const keys = Object.keys(spec).filter((k) => spec[k] !== undefined);
  if (keys.length === 0) {
    return '-';
  }
  if (keys.length > 1) {
    return '!';
  }
  return keys[0];
};

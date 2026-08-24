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

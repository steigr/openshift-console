import { Condition } from '../types';

export const getCondition = (conditions: Condition[] | undefined, type: string): Condition | undefined =>
  conditions?.find((c) => c.type === type);

export const getReadyCondition = (obj?: { status?: { conditions?: Condition[] } }): Condition | undefined =>
  getCondition(obj?.status?.conditions, 'Ready');

export const getLatestCondition = (obj?: { status?: { conditions?: Condition[] } }): Condition | undefined => {
  const conditions = obj?.status?.conditions;
  if (!conditions?.length) {
    return undefined;
  }
  return [...conditions].sort((a, b) =>
    (b.lastTransitionTime || '').localeCompare(a.lastTransitionTime || ''),
  )[0];
};

export const sourceRefLabel = (ref?: { kind?: string; name?: string }): string =>
  ref?.kind && ref?.name ? `${ref.kind}/${ref.name}` : ref?.name || '-';

export const gitRefLabel = (ref?: { branch?: string; tag?: string; semver?: string; commit?: string }): string =>
  ref?.branch || ref?.tag || ref?.semver || ref?.commit || '-';

export const suspendedLabel = (suspend?: boolean): string => (suspend ? 'Suspended' : 'Active');

import { SecretStoreKind, StoreCondition } from '../types';

export const getReadyCondition = (obj: SecretStoreKind): StoreCondition | undefined =>
  obj?.status?.conditions?.find((c) => c.type === 'Ready');

export const getProviderKey = (obj: SecretStoreKind): string => {
  const provider = obj?.spec?.provider;
  if (!provider) {
    return '-';
  }
  const keys = Object.keys(provider).filter((k) => provider[k] !== undefined);
  if (keys.length === 0) {
    return '-';
  }
  if (keys.length > 1) {
    return '!';
  }
  return keys[0];
};

import type { FC, PropsWithChildren } from 'react';

// Naive {{placeholder}} interpolation so components using i18next's
// interpolation syntax still render meaningful text under test.
const interpolate = (key: string, options?: Record<string, unknown>) =>
  options
    ? key.replace(/{{\s*(\w+)\s*}}/g, (match, name: string) =>
        name in options ? String(options[name]) : match,
      )
    : key;

export const useTranslation = () => ({
  t: (key: string, options?: Record<string, unknown>) => interpolate(key, options),
});

export const Trans: FC<PropsWithChildren> = ({ children }) => children;

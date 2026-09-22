import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'jsdom',
  testRegex: '.*\\.spec\\.(ts|tsx)$',
  moduleNameMapper: {
    '\\.(css|scss)$': '<rootDir>/__mocks__/styleMock.ts',
    // Without an i18next instance the real hook warns on every render and
    // drops interpolation, which makes assertions on rendered text useless.
    '^react-i18next$': '<rootDir>/__mocks__/react-i18next.ts',
  },
  transform: {
    '^.+\\.[jt]sx?$': [
      '@swc/jest',
      {
        module: { type: 'commonjs', noInterop: true },
        minify: false,
      },
    ],
  },
  setupFiles: ['./setup-tests.ts'],
};

export default config;

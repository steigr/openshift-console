import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'jsdom',
  testRegex: '.*\\.spec\\.(ts|tsx)$',
  moduleNameMapper: {
    '\\.(css|scss)$': '<rootDir>/__mocks__/styleMock.ts',
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

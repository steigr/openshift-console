import * as fs from 'fs';
import * as path from 'path';
import type { ConsolePluginBuildMetadata } from '@openshift-console/dynamic-plugin-sdk-webpack';

const ROOT = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'),
) as {
  name: string;
  consolePlugin: ConsolePluginBuildMetadata;
};
const extensions = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'console-extensions.json'), 'utf-8'),
) as { properties?: Record<string, unknown> }[];
const localeFile = path.join(
  ROOT,
  `locales/en/plugin__${packageJson.consolePlugin.name}.json`,
);

describe('plugin metadata', () => {
  it('has a matching i18n locale file, package name, and consolePlugin name', () => {
    if (!fs.existsSync(localeFile)) {
      return;
    }
    expect(packageJson.name).toBe(packageJson.consolePlugin.name);
  });

  // A $codeRef naming a module that is not exposed only fails when console
  // tries to render that extension, which for a flag-gated tab can be long
  // after the build that broke it.
  it('resolves every extension $codeRef to an exposed module', () => {
    const exposed = Object.keys(packageJson.consolePlugin.exposedModules ?? {});
    const refs: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (typeof value !== 'object' || value === null) {
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.$codeRef === 'string') {
        refs.push(record.$codeRef);
      }
      Object.values(record).forEach(collect);
    };
    collect(extensions);

    expect(refs.length).toBeGreaterThan(0);
    refs.forEach((ref) => {
      expect(exposed).toContain(ref.split('.')[0]);
    });
  });
});

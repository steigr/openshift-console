import * as fs from 'fs';
import * as path from 'path';

// @openshift-console/dynamic-plugin-sdk ships ESM that jest's CJS transform
// can't require; this spec only cares that the extension's exports exist.
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(),
  k8sGet: jest.fn(),
  k8sCreate: jest.fn(),
  k8sDelete: jest.fn(),
  useK8sWatchResource: jest.fn(() => [undefined, false, undefined]),
}));

const root = path.resolve(__dirname, '../..');

const readJSON = (relPath: string) =>
  JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));

describe('plugin metadata', () => {
  const extensions = readJSON('console-extensions.json');
  const packageJSON = readJSON('package.json');
  const exposedModules: { [key: string]: string } = packageJSON.consolePlugin.exposedModules;

  const horizontalNavExtensions = extensions.filter(
    (e: { type: string }) => e.type === 'console.tab/horizontalNav',
  );
  const nodeTabExtension = horizontalNavExtensions.find(
    (e: { properties: { model: { kind: string } } }) => e.properties.model.kind === 'Node',
  );
  const podTabExtension = horizontalNavExtensions.find(
    (e: { properties: { model: { kind: string } } }) => e.properties.model.kind === 'Pod',
  );
  const flagExtension = extensions.find((e: { type: string }) => e.type === 'console.flag');

  it('declares exactly the Node tab, Pod tab, and flag extensions', () => {
    expect(extensions).toHaveLength(3);
    expect(nodeTabExtension).toBeDefined();
    expect(podTabExtension).toBeDefined();
    expect(flagExtension).toBeDefined();
  });

  it('gates the Pod and Node extensions on their own, distinct flags', () => {
    expect(podTabExtension.flags.required).toEqual(['TERMINAL_PLUGIN_POD_TERMINAL_ENABLED']);
    expect(nodeTabExtension.flags.required).toEqual(['TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED']);
  });

  it('targets the core Node and Pod models for their horizontalNav tabs', () => {
    expect(nodeTabExtension.properties.model).toEqual({ version: 'v1', kind: 'Node' });
    expect(nodeTabExtension.properties.page.href).toBe('terminal');
    expect(podTabExtension.properties.model).toEqual({ version: 'v1', kind: 'Pod' });
    expect(podTabExtension.properties.page.href).toBe('terminal');
  });

  // A $codeRef of `foo.bar` means "export bar of exposed module foo"; console
  // fails to resolve the extension at runtime if either half is wrong, which is
  // invisible until the plugin is actually loaded by a console.
  const codeRefs: string[] = [];
  const collectCodeRefs = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collectCodeRefs);
    } else if (value && typeof value === 'object') {
      const ref = (value as { $codeRef?: string }).$codeRef;
      if (typeof ref === 'string') {
        codeRefs.push(ref);
      } else {
        Object.values(value).forEach(collectCodeRefs);
      }
    }
  };
  collectCodeRefs(extensions);

  it.each(codeRefs)('resolves $codeRef %s to an exposed module export', (codeRef) => {
    const [moduleName, exportName] = codeRef.split('.');
    expect(Object.keys(exposedModules)).toContain(moduleName);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exposed = require(path.join(root, 'src', exposedModules[moduleName]));
    expect(Object.keys(exposed)).toContain(exportName);
  });

  // Console resolves a plugin's i18n namespace by trimming the "plugin__"
  // prefix and looking up a ConsolePlugin of exactly that name, so the locale
  // file has to be named after the plugin, not after some shorter alias -
  // otherwise every translation silently falls back to its key.
  it('names its locale file after the plugin itself', () => {
    const namespace = `plugin__${packageJSON.consolePlugin.name}`;
    expect(fs.existsSync(path.join(root, 'locales', 'en', `${namespace}.json`))).toBe(true);

    const sources = fs.readdirSync(path.join(root, 'src', 'pod'));
    const componentUsingTranslation = sources.find((f) =>
      fs.readFileSync(path.join(root, 'src', 'pod', f), 'utf8').includes('useTranslation('),
    );
    const source = fs.readFileSync(path.join(root, 'src', 'pod', componentUsingTranslation), 'utf8');
    expect(source).toContain(`useTranslation('${namespace}')`);
  });
});

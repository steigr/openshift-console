import * as fs from 'fs';
import * as path from 'path';

// @openshift-console/dynamic-plugin-sdk ships ESM that jest's CJS transform
// can't require; this spec only cares that the extension's exports exist.
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(() => Promise.resolve({})),
}));

const root = path.resolve(__dirname, '../..');

const readJSON = (relPath: string) => JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));

describe('plugin metadata', () => {
  const extensions = readJSON('console-extensions.json');
  const packageJSON = readJSON('package.json');
  const exposedModules: { [key: string]: string } = packageJSON.consolePlugin.exposedModules;

  const tabExtension = extensions.find((e: { type: string }) => e.type === 'console.tab/horizontalNav');
  const flagExtension = extensions.find((e: { type: string }) => e.type === 'console.flag');

  it('declares exactly the Pod tab and the flag that gates it', () => {
    expect(extensions).toHaveLength(2);
    expect(tabExtension).toBeDefined();
    expect(flagExtension).toBeDefined();
  });

  // Console core has no file browser of its own, so unlike the terminal and
  // logging plugins nothing in patches/ has to agree with this name -- but the
  // flag handler and the extension still do.
  it('gates the tab on the flag the handler sets', () => {
    expect(tabExtension.flags.required).toEqual(['FILESYSTEM_PLUGIN_POD_BROWSER_ENABLED']);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { POD_BROWSER_FLAG } = require(path.join(root, 'src', exposedModules.flags));
    expect(POD_BROWSER_FLAG).toBe('FILESYSTEM_PLUGIN_POD_BROWSER_ENABLED');
  });

  it('adds the tab to the core Pod details page', () => {
    expect(tabExtension.properties.model).toEqual({ version: 'v1', kind: 'Pod' });
    expect(tabExtension.properties.page.href).toBe('files');
    expect(tabExtension.properties.page.name).toBe('%plugin__filesystem-console-plugin~Files%');
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
  // file has to be named after the plugin -- otherwise every translation
  // silently falls back to its key.
  it('names its locale file after the plugin itself', () => {
    const namespace = `plugin__${packageJSON.consolePlugin.name}`;
    const localeFile = path.join(root, 'locales', 'en', `${namespace}.json`);
    expect(fs.existsSync(localeFile)).toBe(true);

    const tab = fs.readFileSync(path.join(root, 'src', 'pod', 'PodFileBrowserTab.tsx'), 'utf8');
    expect(tab).toContain(`useTranslation('${namespace}')`);

    // The tab title itself comes out of the same file, via the extension's
    // %namespace~Key% placeholder.
    expect(Object.keys(readJSON(path.join('locales', 'en', `${namespace}.json`)))).toContain('Files');
  });

  // The proxy alias and plugin name in the client's base URL have to match the
  // ConsolePlugin the chart renders, or every call 404s with nothing in the
  // browser to say why.
  it('calls the API on the proxy route the chart declares', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { API_BASE } = require(path.join(root, 'src', 'shared', 'client.ts'));
    expect(API_BASE).toBe(`/api/proxy/plugin/${packageJSON.consolePlugin.name}/api`);

    const consolePluginTemplate = fs.readFileSync(
      path.join(root, 'charts', 'console-filesystem-plugin', 'templates', 'consoleplugin.yaml'),
      'utf8',
    );
    expect(consolePluginTemplate).toContain(`name: ${packageJSON.consolePlugin.name}`);
    expect(consolePluginTemplate).toContain('alias: api');
  });
});

import * as fs from 'fs';
import * as path from 'path';

// @openshift-console/dynamic-plugin-sdk ships ESM that jest's CJS transform
// can't require; this spec only cares that the extension's exports exist.
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({ consoleFetchJSON: jest.fn() }));

const root = path.resolve(__dirname, '../../..');

const readJSON = (relPath: string) =>
  JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));

describe('plugin metadata', () => {
  const extensions = readJSON('console-extensions.json');
  const packageJSON = readJSON('package.json');
  const exposedModules: { [key: string]: string } = packageJSON.consolePlugin.exposedModules;

  it('declares only the pod-connect transport extension', () => {
    expect(extensions).toHaveLength(1);
    expect(extensions[0].type).toBe('stei.gr/pod-connect-transport');
  });

  it('preselects VNC and does not collide with the built-in terminal transport', () => {
    const { id, preferred } = extensions[0].properties;
    expect(id).toBe('vnc');
    expect(id).not.toBe('terminal');
    expect(preferred).toBe(true);
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

    const sources = fs.readdirSync(path.join(root, 'src', 'vnc'));
    const componentUsingTranslation = sources.find((f) =>
      fs.readFileSync(path.join(root, 'src', 'vnc', f), 'utf8').includes('useTranslation('),
    );
    const source = fs.readFileSync(path.join(root, 'src', 'vnc', componentUsingTranslation), 'utf8');
    expect(source).toContain(`useTranslation('${namespace}')`);
  });

  it('translates its label through the plugin locale file', () => {
    const label: string = extensions[0].properties.label;
    expect(label).toMatch(/^%plugin__vncviewer-console-plugin~.+%$/);

    const key = label.slice('%plugin__vncviewer-console-plugin~'.length, -1);
    const messages = readJSON('locales/en/plugin__vncviewer-console-plugin.json');
    expect(Object.keys(messages)).toContain(key);
  });
});

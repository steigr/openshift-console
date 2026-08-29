import * as fs from 'fs';
import * as path from 'path';

// noVNC's rfb entrypoint pulls in a module with top-level await, which cannot be
// required from CommonJS; this spec only cares that the exports exist.
jest.mock('@novnc/novnc/lib/rfb', () => ({ __esModule: true, default: jest.fn() }));

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

  it('translates its label through the plugin locale file', () => {
    const label: string = extensions[0].properties.label;
    expect(label).toMatch(/^%plugin__vncviewer~.+%$/);

    const key = label.slice('%plugin__vncviewer~'.length, -1);
    const messages = readJSON('locales/en/plugin__vncviewer.json');
    expect(Object.keys(messages)).toContain(key);
  });
});

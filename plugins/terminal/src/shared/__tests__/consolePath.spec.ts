import { consolePath } from '../consolePath';

describe('consolePath', () => {
  afterEach(() => {
    delete window.SERVER_FLAGS;
  });

  it('leaves the path alone when console is served at /', () => {
    window.SERVER_FLAGS = { basePath: '/' };
    expect(consolePath('/api/kubernetes/api/v1/pods')).toBe('/api/kubernetes/api/v1/pods');
  });

  it('treats missing SERVER_FLAGS as /', () => {
    expect(consolePath('/api/plugins/terminal-console-plugin/config.json')).toBe(
      '/api/plugins/terminal-console-plugin/config.json',
    );
  });

  it('prefixes the base path console is served under', () => {
    window.SERVER_FLAGS = { basePath: '/openshift-console/' };
    expect(consolePath('/api/plugins/terminal-console-plugin/config.json')).toBe(
      '/openshift-console/api/plugins/terminal-console-plugin/config.json',
    );
  });
});

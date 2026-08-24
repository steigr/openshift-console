import {
  installJournalFetchPatch,
  installPathSelectGuard,
  installRawLinkRewriter,
  rewriteJournalURL,
  rewriteRawJournalURL,
  QUERY_HEADER,
} from './fetch-patch';

describe('rewriteJournalURL', () => {
  it('rewrites the relative journal proxy URL', () => {
    expect(
      rewriteJournalURL(
        '/api/kubernetes/api/v1/nodes/server-7wh3i.netztronaut.de/proxy/logs/journal?unit=kubelet&tailLines=1000',
      ),
    ).toEqual({
      url: '/api/plugins/node-logging-console-plugin/api/nodes/server-7wh3i.netztronaut.de/journal?unit=kubelet&tailLines=1000',
      query: 'unit=kubelet&tailLines=1000',
    });
  });

  it('rewrites the absolute journal proxy URL', () => {
    expect(
      rewriteJournalURL(
        'http://192.168.178.139:9000/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal?tailLines=1000',
      ),
    ).toEqual({
      url: '/api/plugins/node-logging-console-plugin/api/nodes/node-1/journal?tailLines=1000',
      query: 'tailLines=1000',
    });
  });

  it('rewrites the journal URL without a query string', () => {
    expect(
      rewriteJournalURL(
        '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal/',
      ),
    ).toEqual({
      url: '/api/plugins/node-logging-console-plugin/api/nodes/node-1/journal',
      query: '',
    });
  });

  it.each([
    '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/audit/audit.log',
    '/api/kubernetes/api/v1/nodes/node-1',
    '/api/kubernetes/api/v1/pods',
    '/api/plugins/node-logging-console-plugin/api/hello-world',
    '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal/extra',
  ])('does not rewrite %s', (url) => {
    expect(rewriteJournalURL(url)).toBeNull();
  });
});

describe('installJournalFetchPatch', () => {
  let origFetch: jest.Mock;
  let setFeatureFlag: jest.Mock;

  beforeEach(() => {
    origFetch = jest.fn().mockResolvedValue({ ok: true });
    setFeatureFlag = jest.fn();
    Object.defineProperty(window, 'fetch', {
      value: origFetch,
      writable: true,
    });
  });

  it('rewrites matching journal requests and carries the query in a header', async () => {
    installJournalFetchPatch(setFeatureFlag);
    await window.fetch(
      '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal?tailLines=1000',
    );
    const [calledUrl, calledInit] = origFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      '/api/plugins/node-logging-console-plugin/api/nodes/node-1/journal?tailLines=1000',
    );
    expect(new Headers(calledInit.headers).get(QUERY_HEADER)).toBe(
      'tailLines=1000',
    );
  });

  it('passes through non-matching requests unchanged', async () => {
    installJournalFetchPatch(setFeatureFlag);
    const init = { method: 'GET' };
    await window.fetch('/api/kubernetes/api/v1/pods', init);
    expect(origFetch).toHaveBeenCalledWith('/api/kubernetes/api/v1/pods', init);
  });

  it('sets the feature flag and installs only once', () => {
    installJournalFetchPatch(setFeatureFlag);
    const patched = window.fetch;
    installJournalFetchPatch(setFeatureFlag);
    expect(window.fetch).toBe(patched);
    expect(setFeatureFlag).toHaveBeenCalledTimes(2);
    expect(setFeatureFlag).toHaveBeenCalledWith(
      'NODE_LOGGING_JOURNAL_FETCH_PATCH',
      true,
    );
  });
});

describe('installPathSelectGuard', () => {
  let toggle: HTMLButtonElement;
  let item: HTMLButtonElement;
  let reactHandler: jest.Mock;

  const makeDOM = (togglePath: string, itemPath: string) => {
    document.body.innerHTML = '';
    toggle = document.createElement('button');
    toggle.setAttribute('data-test', 'select-path');
    toggle.textContent = togglePath;
    document.body.appendChild(toggle);

    // The menu is portaled to document.body by PatternFly's Popper.
    const menu = document.createElement('div');
    item = document.createElement('button');
    item.className = 'pf-v6-c-menu__item';
    item.textContent = itemPath;
    menu.appendChild(item);
    document.body.appendChild(menu);

    reactHandler = jest.fn();
    item.addEventListener('click', reactHandler);
  };

  beforeAll(() => {
    window.history.pushState({}, '', '/k8s/cluster/nodes/node-1/logs');
    installPathSelectGuard();
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('swallows re-selecting the active path, logs, and closes the menu', () => {
    makeDOM('journal', 'journal');
    const toggleClick = jest.fn();
    toggle.addEventListener('click', toggleClick);
    const consoleInfo = jest
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);

    item.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(reactHandler).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining('suppressed re-select'),
    );

    jest.runAllTimers();
    expect(toggleClick).toHaveBeenCalledTimes(1);
    consoleInfo.mockRestore();
  });

  it('passes through selecting a different path', () => {
    makeDOM('journal', 'openshift-apiserver');
    item.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(reactHandler).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the node logs page', () => {
    window.history.pushState({}, '', '/k8s/cluster/nodes/node-1/details');
    makeDOM('journal', 'journal');
    item.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(reactHandler).toHaveBeenCalledTimes(1);
    window.history.pushState({}, '', '/k8s/cluster/nodes/node-1/logs');
  });
});

describe('rewriteRawJournalURL', () => {
  it('rewrites the raw journal link to the plugin raw route', () => {
    expect(
      rewriteRawJournalURL(
        '/api/kubernetes/api/v1/nodes/server-7wh3i.netztronaut.de/proxy/logs/journal',
      ),
    ).toBe(
      '/api/plugins/node-logging-console-plugin/api/nodes/server-7wh3i.netztronaut.de/journal/raw',
    );
  });

  it('keeps the query string', () => {
    expect(
      rewriteRawJournalURL(
        '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal?unit=kubelet',
      ),
    ).toBe(
      '/api/plugins/node-logging-console-plugin/api/nodes/node-1/journal/raw?unit=kubelet',
    );
  });

  it('returns null for non-journal URLs', () => {
    expect(
      rewriteRawJournalURL('/api/kubernetes/api/v1/nodes/node-1'),
    ).toBeNull();
  });
});

describe('installRawLinkRewriter', () => {
  const flushObserver = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeAll(() => {
    window.history.pushState({}, '', '/k8s/cluster/nodes/node-1/logs');
    document.body.innerHTML = '';
    installRawLinkRewriter();
  });

  it('rewrites raw journal anchors added to the DOM', async () => {
    const anchor = document.createElement('a');
    anchor.setAttribute(
      'href',
      '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal',
    );
    document.body.appendChild(anchor);
    await flushObserver();
    expect(anchor.getAttribute('href')).toBe(
      '/api/plugins/node-logging-console-plugin/api/nodes/node-1/journal/raw',
    );
  });

  it('rewrites anchors whose href changes to a journal URL', async () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/some/other/page');
    document.body.appendChild(anchor);
    await flushObserver();
    expect(anchor.getAttribute('href')).toBe('/some/other/page');

    anchor.setAttribute(
      'href',
      '/api/kubernetes/api/v1/nodes/node-1/proxy/logs/journal?unit=kubelet',
    );
    await flushObserver();
    expect(anchor.getAttribute('href')).toBe(
      '/api/plugins/node-logging-console-plugin/api/nodes/node-1/journal/raw?unit=kubelet',
    );
  });

  it('leaves unrelated anchors alone', async () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/k8s/cluster/nodes/node-1/details');
    document.body.appendChild(anchor);
    await flushObserver();
    expect(anchor.getAttribute('href')).toBe(
      '/k8s/cluster/nodes/node-1/details',
    );
  });
});

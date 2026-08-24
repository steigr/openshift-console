import type { SetFeatureFlag } from '@openshift-console/dynamic-plugin-sdk';

// The URL shape core's NodeLogs component fetches for the journal path
// (assumes the console is served with basePath "/"). Matches both the
// relative form and the absolute form produced by addTailLinesToURL.
const JOURNAL_URL_RE =
  /^(?:https?:\/\/[^/]+)?\/api\/kubernetes\/api\/v1\/nodes\/([A-Za-z0-9.-]+)\/proxy\/logs\/journal\/?(?:\?(.*))?$/;

const PLUGIN_JOURNAL_API = '/api/plugins/node-logging-console-plugin/api/nodes';

// The console's plugin proxy drops query strings when forwarding to the
// plugin backend, so the journal query travels in this header as well.
export const QUERY_HEADER = 'X-Node-Logs-Query';

const PATCH_FLAG = 'NODE_LOGGING_JOURNAL_FETCH_PATCH';

type PatchedFetch = typeof window.fetch & {
  __nodeLoggingJournalPatch?: boolean;
};

export const rewriteJournalURL = (
  url: string,
): { url: string; query: string } | null => {
  const match = JOURNAL_URL_RE.exec(url);
  if (!match) {
    return null;
  }
  const [, node, query = ''] = match;
  return {
    url: `${PLUGIN_JOURNAL_API}/${node}/journal${query ? `?${query}` : ''}`,
    query,
  };
};

const withQueryHeader = (
  init: RequestInit | undefined,
  query: string,
): RequestInit | undefined => {
  if (!query) {
    return init;
  }
  if (typeof Headers !== 'undefined') {
    const headers = new Headers(init?.headers);
    headers.set(QUERY_HEADER, query);
    return { ...init, headers };
  }
  return {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string>),
      [QUERY_HEADER]: query,
    },
  };
};

const NODE_LOGS_PAGE_RE = /\/nodes\/[^/]+\/logs\/?$/;

type GuardedWindow = Window & {
  __nodeLoggingPathSelectGuard?: boolean;
  __nodeLoggingRawLinkRewriter?: boolean;
};

// Target for the "open the raw file in another window" link: the /raw
// route serves the unabridged journal (no tail limit).
export const rewriteRawJournalURL = (url: string): string | null => {
  const match = JOURNAL_URL_RE.exec(url);
  if (!match) {
    return null;
  }
  const [, node, query = ''] = match;
  return `${PLUGIN_JOURNAL_API}/${node}/journal/raw${query ? `?${query}` : ''}`;
};

// Core's "The log is abridged" alert links the raw journal via a plain
// anchor (no fetch involved), so the fetch patch cannot cover it. Rewrite
// such hrefs in the DOM as they appear.
export const installRawLinkRewriter = () => {
  if ((window as GuardedWindow).__nodeLoggingRawLinkRewriter) {
    return;
  }
  (window as GuardedWindow).__nodeLoggingRawLinkRewriter = true;

  const rewriteAnchor = (anchor: HTMLAnchorElement) => {
    const href = anchor.getAttribute('href');
    const rewritten = href ? rewriteRawJournalURL(href) : null;
    if (rewritten) {
      anchor.setAttribute('href', rewritten);
      console.info(
        `[node-logging-console-plugin] rewrote raw journal link to "${rewritten}"`,
      );
    }
  };

  const scan = (root: Element) => {
    if (root instanceof HTMLAnchorElement) {
      rewriteAnchor(root);
    }
    root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(rewriteAnchor);
  };

  const observer = new MutationObserver((records) => {
    try {
      if (!NODE_LOGS_PAGE_RE.test(window.location.pathname)) {
        return;
      }
      records.forEach((record) => {
        if (
          record.type === 'attributes' &&
          record.target instanceof HTMLAnchorElement
        ) {
          rewriteAnchor(record.target);
        }
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            scan(node);
          }
        });
      });
    } catch {
      // Never break on DOM churn (or environment teardown).
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  scan(document.body);
  console.info(
    '[node-logging-console-plugin] raw journal link rewriter installed',
  );
};

// Core's NodeLogs has a bug where re-selecting the already-active entry in
// the "Select a path" dropdown puts the page into a loading state that never
// resolves: onChangePath unconditionally sets isLoadingLog, but with no state
// actually changing, none of the effects that fetch (and clear the spinner)
// re-run. Swallow exactly that click before React sees it and close the
// menu instead — the same net behavior a fixed onChangePath would have.
// Selecting a different path is passed through untouched.
export const installPathSelectGuard = () => {
  if ((window as GuardedWindow).__nodeLoggingPathSelectGuard) {
    return;
  }
  (window as GuardedWindow).__nodeLoggingPathSelectGuard = true;

  document.addEventListener(
    'click',
    (event) => {
      try {
        if (!NODE_LOGS_PAGE_RE.test(window.location.pathname)) {
          return;
        }
        // Note: the toggle's aria-expanded is unusable as an open-state
        // check because NodeLogs never passes isExpanded to its MenuToggle.
        // Menu items only exist in the DOM while the menu is open, so
        // matching the clicked item against the toggle text is sufficient.
        const toggle = document.querySelector<HTMLButtonElement>(
          'button[data-test="select-path"]',
        );
        if (!toggle) {
          return;
        }
        const target = event.target instanceof Element ? event.target : null;
        const item = target?.closest(
          '.pf-v6-c-menu__item, .pf-v5-c-menu__item',
        );
        if (!item) {
          return;
        }
        const selectedPath = toggle.textContent.trim();
        if (!selectedPath || item.textContent.trim() !== selectedPath) {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        console.info(
          `[node-logging-console-plugin] suppressed re-select of active log path "${selectedPath}" (works around the never-resolving loading state in core NodeLogs)`,
        );
        // Close the (still open) menu through React's own toggle handler.
        window.setTimeout(() => {
          toggle.click();
        }, 0);
      } catch {
        // Never break unrelated clicks.
      }
    },
    true,
  );
  console.info('[node-logging-console-plugin] path-select guard installed');
};

// Reroutes core's kubelet journal proxy requests to this plugin's backend.
// Vanilla kubelets serve /logs/ as a plain file server over /var/log, so
// the journal path core's Node Logs tab relies on only exists on OpenShift
// kubelets; the plugin backend provides it via the node-logs-api DaemonSet.
export const installJournalFetchPatch = (setFeatureFlag: SetFeatureFlag) => {
  installPathSelectGuard();
  installRawLinkRewriter();

  if ((window.fetch as PatchedFetch).__nodeLoggingJournalPatch) {
    setFeatureFlag(PATCH_FLAG, true);
    return;
  }

  const origFetch = window.fetch.bind(window);
  const patched: PatchedFetch = (input, init) => {
    try {
      const url =
        typeof input === 'string'
          ? input
          : typeof Request !== 'undefined' && input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : null;
      const rewritten = url === null ? null : rewriteJournalURL(url);
      if (rewritten) {
        return origFetch(rewritten.url, withQueryHeader(init, rewritten.query));
      }
    } catch {
      // Never let the patch break unrelated requests.
    }
    return origFetch(input, init);
  };
  patched.__nodeLoggingJournalPatch = true;
  window.fetch = patched;
  setFeatureFlag(PATCH_FLAG, true);
};

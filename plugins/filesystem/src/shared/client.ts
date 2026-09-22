import { createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';

import { FileBrowser } from '../gen/filesystem/v1/filesystem_pb';
import { consolePath } from './consolePath';
import { csrfToken } from './csrf';

/**
 * The plugin's API is served on console's *proxy* route, not its asset route:
 * console forwards the method, query string and body there untouched, along
 * with the logged-in user's credentials, which is what makes a real RPC API
 * possible at all. The asset route only ever issues a bare GET (and is where
 * /config.json comes from, before any of this loads).
 *
 * The name in this path is the ConsolePlugin's, and the "api" segment is the
 * proxy alias declared in the chart's ConsolePlugin spec.proxy - both must
 * match or every call 404s.
 */
export const API_BASE = '/api/proxy/plugin/filesystem-console-plugin/api';

/**
 * Connect, not gRPC-Web or plain gRPC: console's plugin proxy is an HTTP/1.1
 * reverse proxy, and the Connect protocol is the one of the three that works
 * over HTTP/1.1 for both unary calls and server streams - which is why the
 * service has no client-streaming method for uploads and chunks them into
 * unary calls instead.
 */
export const createFileBrowserClient = (): Client<typeof FileBrowser> =>
  createClient(
    FileBrowser,
    createConnectTransport({
      baseUrl: consolePath(API_BASE),
      // The default. Stated explicitly because the alternative (binary) is
      // what makes a failing call impossible to read in the browser's network
      // panel, and the payloads here are small enough that it costs nothing.
      useBinaryFormat: false,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('X-CSRFToken', csrfToken());
        return fetch(input, { ...init, headers, credentials: 'include' });
      },
    }),
  );

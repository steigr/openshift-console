/**
 * Console's bridge refuses any non-GET request whose `X-CSRFToken` header
 * does not match its `csrf-token` cookie - including the ones that reach a
 * plugin through `/api/proxy/plugin/...`, which is every call this plugin
 * makes (Connect is POST-only).
 *
 * The SDK's own `consoleFetch` adds this, but it cannot be used as the
 * Connect transport's fetch: it rejects a non-2xx response by throwing its
 * own error, which would swallow the Connect error details - the code and
 * message the backend and agent go to some trouble to produce - and leave
 * the UI unable to tell "you may not exec into this pod" from "no such
 * file". So the header is added here, and everything else about the request
 * is left to Connect.
 */
export const csrfToken = (): string => {
  const match = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
};

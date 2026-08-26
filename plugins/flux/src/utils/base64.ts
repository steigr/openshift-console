// Console's bridge proxy for a dynamic plugin's backend routes (see
// api/reconcile.go's init() doc comment) only ever issues a bare GET and
// drops the original request's query string entirely, so payloads for this
// plugin's backend routes travel as a base64url-encoded JSON path segment
// instead - this mirrors the sibling cert-manager plugin's
// src/api/certLookup.ts.
export const toBase64Url = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

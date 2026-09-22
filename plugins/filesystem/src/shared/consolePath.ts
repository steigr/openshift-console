declare global {
  interface Window {
    SERVER_FLAGS?: { basePath?: string };
  }
}

/**
 * Prefixes a path relative to console's root (`/api/...`) with the base path
 * console is served under (bridge's `--base-path`, exposed as
 * `SERVER_FLAGS.basePath` and always ending in `/`), so requests still reach
 * console when it isn't served at `/`. Read on every call rather than once at
 * module load.
 */
export const consolePath = (path: string): string =>
  `${(window.SERVER_FLAGS?.basePath ?? '/').replace(/\/+$/, '')}${path}`;

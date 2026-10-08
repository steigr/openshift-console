/** The terminal's font stack; the first family is bundled (./fonts/fonts.css). */
export const TERMINAL_FONT_FAMILY = 'VictorMono Nerd Font Propo';
export const TERMINAL_FONT_STACK = `'${TERMINAL_FONT_FAMILY}', 'Red Hat Mono', monospace`;

/** How long the terminal waits for its font before opening on a fallback anyway. */
export const FONT_LOAD_TIMEOUT_MS = 3000;

/**
 * Resolves once the terminal font is usable at `fontSize`, in both weights xterm renders, or null
 * when there is nothing to wait for: already loaded, or no CSS Font Loading API (jsdom).
 *
 * xterm measures its cell size when it opens and never again when a web font arrives afterwards
 * (only on a fontFamily/fontSize option change, a resize, or a DPR change). Opening on the
 * fallback font -- `font-display: swap` shows text before Victor Mono has loaded -- left the
 * grid sized for the fallback's narrower glyphs while Victor Mono was drawn into it, so lines ran
 * past the right edge until something happened to trigger a resize.
 */
export const terminalFontsReady = (fontSize: number): Promise<void> | null => {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts || typeof fonts.load !== 'function') {
    return null;
  }
  const specs = ['normal', 'bold'].map(
    (weight) => `${weight} ${fontSize}px '${TERMINAL_FONT_FAMILY}'`,
  );
  if (typeof fonts.check === 'function' && specs.every((spec) => fonts.check(spec))) {
    return null;
  }
  return Promise.all(specs.map((spec) => fonts.load(spec))).then(
    () => undefined,
    () => undefined,
  );
};

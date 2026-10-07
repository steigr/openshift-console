import { useEffect, useState } from 'react';

export type ConsoleTheme = 'light' | 'dark';

// The class console core's ThemeProvider toggles on <html>. Not exposed by the dynamic-plugin-sdk,
// but it is PatternFly's own dark-theme switch, so it is as stable as PatternFly 6 is.
const DARK_CLASS = 'pf-v6-theme-dark';

export const currentConsoleTheme = (): ConsoleTheme =>
  document.documentElement.classList.contains(DARK_CLASS) ? 'dark' : 'light';

/**
 * The console theme in effect -- the user's preference or, for "system default", the OS one --
 * re-rendering whenever console switches it.
 */
export const useConsoleTheme = (): ConsoleTheme => {
  const [theme, setTheme] = useState<ConsoleTheme>(currentConsoleTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentConsoleTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
};

import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Sizing for the terminal and VNC consoles: as tall as the space left below them, rather than a
 * fixed `70vh` that ignored everything above (masthead, title, tabs, toolbar, any alert) and so
 * pushed the bottom rows -- the prompt, usually -- below the fold whenever that came to more than
 * 30% of the window. Ported from the logging plugin's src/logs/fill-height.ts, which has the long
 * story of why a percentage or flex height does not work under console's details pages.
 */

/** Never smaller than this, however cramped the window. */
export const MIN_FILL_HEIGHT = 240;

/** Breathing room below the console, so it does not butt against the page edge. */
export const FILL_BOTTOM_GUTTER = 16;

export type FillHeightInput = {
  /** getBoundingClientRect().top of the element being sized. */
  elementTop: number;
  /** getBoundingClientRect().top of the scrolling ancestor. */
  scrollerTop: number;
  /** The scrolling ancestor's visible height. */
  scrollerClientHeight: number;
  /** How far that ancestor is currently scrolled. */
  scrollerScrollTop: number;
};

export const computeFillHeight = ({
  elementTop,
  scrollerTop,
  scrollerClientHeight,
  scrollerScrollTop,
}: FillHeightInput): number => {
  // Distance from the scroller's content origin to the element; adding scrollTop back makes it
  // independent of how far the page is scrolled.
  const offsetWithinScroller = elementTop - scrollerTop + scrollerScrollTop;
  const available = scrollerClientHeight - offsetWithinScroller - FILL_BOTTOM_GUTTER;
  return Math.max(MIN_FILL_HEIGHT, Math.round(available));
};

/** The nearest ancestor that scrolls (`overflow-y: auto|scroll`), or null for the window. */
export const findScrollParent = (element: HTMLElement | null): HTMLElement | null => {
  for (let cursor = element?.parentElement ?? null; cursor; cursor = cursor.parentElement) {
    const { overflowY } = window.getComputedStyle(cursor);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return cursor;
    }
  }
  return null;
};

/**
 * Keeps `ref`'s element as tall as the space below it: in the page, down to the bottom of the
 * scrolling content area; in fullscreen, down to the bottom of the fullscreen element. Re-measured
 * on window resize, on entering or leaving fullscreen, and whenever an ancestor changes size --
 * which is what an alert appearing above, or the toolbar wrapping, looks like from here.
 */
export const useFillHeight = (ref: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const scroller = findScrollParent(element);

    const measure = () => {
      const fullscreen = document.fullscreenElement;
      const top = element.getBoundingClientRect().top;
      const height =
        fullscreen && fullscreen.contains(element)
          ? Math.max(MIN_FILL_HEIGHT, Math.floor(fullscreen.getBoundingClientRect().bottom - top))
          : computeFillHeight({
              elementTop: top,
              scrollerTop: scroller?.getBoundingClientRect().top ?? 0,
              scrollerClientHeight: scroller?.clientHeight ?? window.innerHeight,
              scrollerScrollTop: scroller?.scrollTop ?? window.scrollY,
            });
      const value = `${height}px`;
      if (element.style.height !== value) {
        element.style.height = value;
      }
    };

    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('fullscreenchange', measure);

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measure());
      // Every ancestor up to the scroller: any of them changing size means something above or
      // around the element moved. Setting the height again is idempotent, so the ancestors this
      // element itself resizes settle after one round.
      for (let cursor = element.parentElement; cursor; cursor = cursor.parentElement) {
        observer.observe(cursor);
        if (cursor === scroller) {
          break;
        }
      }
    }

    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
      observer?.disconnect();
    };
  }, [ref]);
};

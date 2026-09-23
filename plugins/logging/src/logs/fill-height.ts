/**
 * How tall the log viewer should be.
 *
 * It cannot simply be `height: 100%` or `flex: 1`. Console wraps a details
 * tab in its own `co-m-page__body` / `loading-box`, both `flex: 1 0 auto` --
 * grow, but *never shrink* -- so they expand to whatever their content asks
 * for and a percentage height below them resolves against an ancestor that
 * has already blown out to content size. The viewer then reports a client
 * height equal to its own scroll height, every row is "visible", and the
 * virtualiser mounts the entire log. That is not a slow path, it is the
 * absence of the fast one: 100k rows mounted is the exact failure the whole
 * design exists to avoid.
 *
 * So the height is measured against the nearest scrolling ancestor instead.
 * Offsets are taken relative to that ancestor's own scroll origin rather than
 * to the viewport, so the answer does not change when the page is scrolled.
 */

/** Never smaller than this, however cramped the window. */
export const MIN_VIEWER_HEIGHT = 240;

/** Breathing room below the viewer, so it does not butt against the edge. */
export const VIEWER_BOTTOM_GUTTER = 16;

export interface FillHeightInput {
  /** getBoundingClientRect().top of the viewer. */
  viewerTop: number;
  /** getBoundingClientRect().top of the scrolling ancestor. */
  scrollerTop: number;
  /** The scrolling ancestor's visible height. */
  scrollerClientHeight: number;
  /** How far that ancestor is currently scrolled. */
  scrollerScrollTop: number;
}

export const computeFillHeight = ({
  viewerTop,
  scrollerTop,
  scrollerClientHeight,
  scrollerScrollTop,
}: FillHeightInput): number => {
  // Distance from the scroller's content origin to the top of the viewer.
  // Both rects move together as the scroller scrolls, and adding scrollTop
  // back cancels the shift, so this is scroll-independent.
  const offsetWithinScroller = viewerTop - scrollerTop + scrollerScrollTop;
  const available =
    scrollerClientHeight - offsetWithinScroller - VIEWER_BOTTOM_GUTTER;
  return Math.max(MIN_VIEWER_HEIGHT, Math.round(available));
};

/**
 * The nearest ancestor that scrolls. Any ancestor with `overflow-y: auto`
 * counts, whether or not it is scrolling *right now* -- when the viewer is
 * still oversized it is the one absorbing the overflow, which is exactly the
 * situation being corrected. Returns null if none does, and the caller falls
 * back to the window.
 */
export const findScrollParent = (
  element: HTMLElement | null,
): HTMLElement | null => {
  for (
    let cursor = element?.parentElement ?? null;
    cursor !== null;
    cursor = cursor.parentElement
  ) {
    const { overflowY } = window.getComputedStyle(cursor);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return cursor;
    }
  }
  return null;
};

import {
  computeFillHeight,
  MIN_VIEWER_HEIGHT,
  VIEWER_BOTTOM_GUTTER,
} from './fill-height';

describe('computeFillHeight', () => {
  it('fills the scroller from the viewer down to its bottom edge', () => {
    // Viewer starts 350px into an 836px-tall scrolling section.
    expect(
      computeFillHeight({
        viewerTop: 350,
        scrollerTop: 0,
        scrollerClientHeight: 836,
        scrollerScrollTop: 0,
      }),
    ).toBe(836 - 350 - VIEWER_BOTTOM_GUTTER);
  });

  it('gives the same answer however far the page is scrolled', () => {
    // Adding scrollTop back cancels the shift. Without it, a scrolled page
    // would size the viewer taller and re-mount more of the log than fits.
    const unscrolled = computeFillHeight({
      viewerTop: 350,
      scrollerTop: 0,
      scrollerClientHeight: 836,
      scrollerScrollTop: 0,
    });
    // Scrolling by 200 moves the viewer up; the scroller's own box does not
    // move, since it is the fixed frame the content scrolls inside.
    const scrolled = computeFillHeight({
      viewerTop: 150,
      scrollerTop: 0,
      scrollerClientHeight: 836,
      scrollerScrollTop: 200,
    });
    expect(scrolled).toBe(unscrolled);
  });

  it('never returns less than the floor, however cramped the window', () => {
    expect(
      computeFillHeight({
        viewerTop: 700,
        scrollerTop: 0,
        scrollerClientHeight: 720,
        scrollerScrollTop: 0,
      }),
    ).toBe(MIN_VIEWER_HEIGHT);
  });

  it('does not go negative when the viewer starts below the fold', () => {
    expect(
      computeFillHeight({
        viewerTop: 2000,
        scrollerTop: 0,
        scrollerClientHeight: 836,
        scrollerScrollTop: 0,
      }),
    ).toBe(MIN_VIEWER_HEIGHT);
  });
});

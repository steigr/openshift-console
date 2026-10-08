import * as React from 'react';
import { useRef } from 'react';
import { render } from '@testing-library/react';

import {
  computeFillHeight,
  FILL_BOTTOM_GUTTER,
  MIN_FILL_HEIGHT,
  useFillHeight,
} from '../fillHeight';

describe('computeFillHeight', () => {
  it('fills the scroller from the element down to its bottom edge', () => {
    // The live case behind this: a terminal starting 327px down a 987px window, which a fixed
    // 70vh (691px) pushed 31px past the bottom.
    expect(
      computeFillHeight({
        elementTop: 327,
        scrollerTop: 0,
        scrollerClientHeight: 987,
        scrollerScrollTop: 0,
      }),
    ).toBe(987 - 327 - FILL_BOTTOM_GUTTER);
  });

  it('gives the same answer however far the page is scrolled', () => {
    const unscrolled = computeFillHeight({
      elementTop: 327,
      scrollerTop: 76,
      scrollerClientHeight: 900,
      scrollerScrollTop: 0,
    });
    const scrolled = computeFillHeight({
      elementTop: 127,
      scrollerTop: 76,
      scrollerClientHeight: 900,
      scrollerScrollTop: 200,
    });
    expect(scrolled).toBe(unscrolled);
  });

  it('never goes below the minimum', () => {
    expect(
      computeFillHeight({
        elementTop: 900,
        scrollerTop: 0,
        scrollerClientHeight: 987,
        scrollerScrollTop: 0,
      }),
    ).toBe(MIN_FILL_HEIGHT);
  });
});

describe('useFillHeight', () => {
  const Sized = () => {
    const ref = useRef<HTMLDivElement>(null);
    useFillHeight(ref);
    return <div ref={ref} data-test="sized" />;
  };

  const rect = (top: number, bottom: number) =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  let getRect: jest.SpyInstance;
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 987 });
    getRect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rect(327, 400));
  });
  afterEach(() => {
    getRect.mockRestore();
  });

  it('sizes the element to the window space below it and follows a resize', () => {
    const { getByTestId } = render(<Sized />);
    const element = getByTestId('sized');
    expect(element.style.height).toBe(`${987 - 327 - FILL_BOTTOM_GUTTER}px`);

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));

    expect(element.style.height).toBe(`${800 - 327 - FILL_BOTTOM_GUTTER}px`);
  });

  it('fills down to the bottom of the fullscreen element', () => {
    const { getByTestId, container } = render(<Sized />);
    const element = getByTestId('sized');
    const fullscreen = container;
    getRect.mockImplementation(function (this: HTMLElement) {
      return this === fullscreen ? rect(0, 1080) : rect(60, 100);
    });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen });
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(element.style.height).toBe(`${1080 - 60}px`);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  });
});

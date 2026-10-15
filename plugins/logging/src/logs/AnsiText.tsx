import type { CSSProperties, FC } from 'react';

import { paletteColor } from './ansi';
import type { AnsiColor, AnsiSpan, AnsiStyle } from './ansi';

/**
 * The sixteen base colours are classes, so log-viewer.css -- and through it
 * the colour scheme -- decides what they look like; everything else is the
 * exact colour asked for.
 */
const colorProps = (
  color: AnsiColor,
  layer: 'fg' | 'bg',
  classes: string[],
  style: CSSProperties,
): void => {
  if (typeof color === 'number' && color < 16) {
    classes.push(`logging-ansi-${layer}-${String(color)}`);
    return;
  }
  const value = typeof color === 'number' ? paletteColor(color) : color;
  if (layer === 'fg') {
    style.color = value;
  } else {
    style.backgroundColor = value;
  }
};

const spanProps = (
  ansi: AnsiStyle,
): { className: string; style: CSSProperties | undefined } => {
  const classes: string[] = [];
  const style: CSSProperties = {};
  // Inverse swaps the layers; a default on either side becomes the panel's own
  // text or background colour on the other.
  const fg = ansi.inverse ? ansi.bg : ansi.fg;
  const bg = ansi.inverse ? ansi.fg : ansi.bg;
  if (fg !== null) {
    colorProps(fg, 'fg', classes, style);
  } else if (ansi.inverse) {
    classes.push('logging-ansi-fg-inverse');
  }
  if (bg !== null) {
    colorProps(bg, 'bg', classes, style);
  } else if (ansi.inverse) {
    classes.push('logging-ansi-bg-inverse');
  }
  if (ansi.bold) classes.push('logging-ansi--bold');
  if (ansi.dim) classes.push('logging-ansi--dim');
  if (ansi.italic) classes.push('logging-ansi--italic');
  if (ansi.hidden) classes.push('logging-ansi--hidden');
  if (ansi.underline && ansi.strike) {
    classes.push('logging-ansi--underline-strike');
  } else if (ansi.underline) {
    classes.push('logging-ansi--underline');
  } else if (ansi.strike) {
    classes.push('logging-ansi--strike');
  }
  return {
    className: classes.join(' '),
    style: Object.keys(style).length > 0 ? style : undefined,
  };
};

/** Styled runs from ./ansi.ts; unstyled runs are bare text, not spans. */
export const AnsiText: FC<{ spans: readonly AnsiSpan[] }> = ({ spans }) => (
  <>
    {spans.map((span, i) => {
      if (span.style === null) {
        return span.text;
      }
      const { className, style } = spanProps(span.style);
      return (
        // Runs never move or reorder; the index is their identity.
        <span key={i} className={className} style={style}>
          {span.text}
        </span>
      );
    })}
  </>
);

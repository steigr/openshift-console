/**
 * ANSI escape sequences in log text. Plenty of processes colour their output
 * whether or not a terminal is attached -- a Minecraft server's chat, a Spring
 * Boot banner, anything using chalk with FORCE_COLOR -- and the container
 * runtime keeps those bytes verbatim, so a log line reads
 * `ESC[93msteigr joined the gameESC[0m`. The browser draws ESC as nothing,
 * which leaves `[93m` littered through the text.
 *
 * SGR (`ESC[...m`) is turned into styled runs. Every other escape sequence --
 * cursor movement, erase-line, OSC titles and hyperlinks, charset selection --
 * has no meaning in a list of lines and is dropped, keeping only the text
 * around it.
 */

/**
 * A colour: an index into the 256-colour palette, or `#rrggbb` for 24-bit.
 * Indices 0-15 are left to the stylesheet (see log-viewer.css), so a colour
 * scheme decides what "red" looks like; the rest are fixed.
 */
export type AnsiColor = number | string;

export interface AnsiStyle {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  hidden: boolean;
  strike: boolean;
}

export interface AnsiSpan {
  text: string;
  /** Null for text drawn in the surrounding style. */
  style: AnsiStyle | null;
}

const ESC = 0x1b;
/** The 8-bit CSI, which a UTF-8 log can carry as U+009B. */
const CSI = 0x9b;
const BEL = 0x07;

/** Cheap enough to call on every line; the common answer is no. */
export const hasAnsi = (text: string): boolean =>
  text.includes('\u001b') || text.includes('\u009b');

const plainStyle = (): AnsiStyle => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  hidden: false,
  strike: false,
});

const isPlain = (style: AnsiStyle): boolean =>
  style.fg === null &&
  style.bg === null &&
  !style.bold &&
  !style.dim &&
  !style.italic &&
  !style.underline &&
  !style.inverse &&
  !style.hidden &&
  !style.strike;

const sameStyle = (a: AnsiStyle | null, b: AnsiStyle | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strike === b.strike);

const toHex = (value: number): string =>
  Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');

const rgb = (r: number, g: number, b: number): string =>
  `#${toHex(r)}${toHex(g)}${toHex(b)}`;

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/**
 * xterm's palette above the first sixteen: a 6x6x6 colour cube, then a
 * 24-step grey ramp. Indices 0-15 never get here (see AnsiColor).
 */
export const paletteColor = (index: number): string => {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgb(level, level, level);
  }
  const cube = index - 16;
  return rgb(
    CUBE_LEVELS[Math.floor(cube / 36) % 6],
    CUBE_LEVELS[Math.floor(cube / 6) % 6],
    CUBE_LEVELS[cube % 6],
  );
};

const asByte = (value: string | undefined): number | null => {
  if (value === undefined || value === '') {
    return value === '' ? 0 : null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
};

/**
 * Reads the colour after a 38/48: `5;n` or `2;r;g;b`, either from the
 * parameters that follow (the common, semicolon form) or from the code's own
 * colon-separated sub-parameters (ITU T.416's form, which may also carry a
 * colour-space id: `38:2::r:g:b`). Returns the colour, if any, and how many
 * of the following parameters it consumed.
 */
const extendedColor = (
  sub: string[],
  rest: string[],
): { color: AnsiColor | null; consumed: number } => {
  if (sub.length > 1) {
    const mode = sub[1];
    if (mode === '5') {
      const index = asByte(sub[2]);
      return { color: index, consumed: 0 };
    }
    if (mode === '2') {
      const parts = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
      const [r, g, b] = parts.map(asByte);
      return {
        color: r == null || g == null || b == null ? null : rgb(r, g, b),
        consumed: 0,
      };
    }
    return { color: null, consumed: 0 };
  }
  const mode = rest[0];
  if (mode === '5') {
    return { color: asByte(rest[1]), consumed: 2 };
  }
  if (mode === '2') {
    const [r, g, b] = rest.slice(1, 4).map(asByte);
    return {
      color: r == null || g == null || b == null ? null : rgb(r, g, b),
      consumed: 4,
    };
  }
  // Unknown mode: skip just the mode, as xterm does.
  return { color: null, consumed: rest.length > 0 ? 1 : 0 };
};

/** Applies one SGR parameter list to a copy of the style. */
const applySgr = (style: AnsiStyle, params: string): AnsiStyle => {
  const next = { ...style };
  // `ESC[m` is a reset, the same as `ESC[0m`.
  const list = params === '' ? ['0'] : params.split(';');
  for (let i = 0; i < list.length; i++) {
    const sub = list[i].split(':');
    const code = sub[0] === '' ? 0 : Number(sub[0]);
    if (code === 0) {
      Object.assign(next, plainStyle());
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      // `4:0` is "no underline"; every other style (double, curly, ...) is drawn
      // as a plain one.
      next.underline = sub[1] !== '0';
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 8) {
      next.hidden = true;
    } else if (code === 9) {
      next.strike = true;
    } else if (code === 21) {
      next.underline = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 27) {
      next.inverse = false;
    } else if (code === 28) {
      next.hidden = false;
    } else if (code === 29) {
      next.strike = false;
    } else if (code >= 30 && code <= 37) {
      next.fg = code - 30;
    } else if (code === 39) {
      next.fg = null;
    } else if (code >= 40 && code <= 47) {
      next.bg = code - 40;
    } else if (code === 49) {
      next.bg = null;
    } else if (code >= 90 && code <= 97) {
      next.fg = code - 90 + 8;
    } else if (code >= 100 && code <= 107) {
      next.bg = code - 100 + 8;
    } else if (code === 38 || code === 48 || code === 58) {
      const { color, consumed } = extendedColor(sub, list.slice(i + 1));
      i += consumed;
      // 58 is the underline colour, which is read only to be skipped.
      if (color !== null && code !== 58) {
        next[code === 38 ? 'fg' : 'bg'] = color;
      }
    }
    // Anything else (blink, fonts, overline, ...) is ignored.
  }
  return next;
};

/**
 * Where the escape sequence starting at `start` ends (exclusive), and its SGR
 * parameters when it is one. A sequence cut off by the end of the text runs to
 * the end, so that half an escape is never shown as text.
 */
const scanEscape = (
  text: string,
  start: number,
): { end: number; sgr: string | null } => {
  let i = start;
  let csi = text.charCodeAt(i) === CSI;
  i++;
  if (!csi) {
    const kind = text.charCodeAt(i);
    if (Number.isNaN(kind)) {
      return { end: i, sgr: null };
    }
    i++;
    if (kind === 0x5b /* [ */) {
      csi = true;
    } else if (
      kind === 0x5d /* ] OSC */ ||
      kind === 0x50 /* P DCS */ ||
      kind === 0x58 /* X SOS */ ||
      kind === 0x5e /* ^ PM */ ||
      kind === 0x5f /* _ APC */
    ) {
      // A string, terminated by BEL (OSC only, but harmless elsewhere) or ST.
      for (; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === BEL) {
          return { end: i + 1, sgr: null };
        }
        if (c === ESC && text.charCodeAt(i + 1) === 0x5c /* \ */) {
          return { end: i + 2, sgr: null };
        }
      }
      return { end: i, sgr: null };
    } else {
      // nF (`ESC ( B`, charset designation): intermediates, then a final.
      let c = kind;
      while (c >= 0x20 && c <= 0x2f && i < text.length) {
        c = text.charCodeAt(i);
        i++;
      }
      return { end: i, sgr: null };
    }
  }
  const paramsStart = i;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x40 && c <= 0x7e) {
      const params = text.slice(paramsStart, i);
      // A private marker (`ESC[?25h`, `ESC[>4;2m`) is never colour.
      const sgr = c === 0x6d /* m */ && !/[<=>?]/.test(params) ? params : null;
      return { end: i + 1, sgr };
    }
    if (c < 0x20 || c > 0x3f) {
      // Not a valid parameter or intermediate byte: the sequence is broken;
      // drop what was read and resume at this character.
      return { end: i, sgr: null };
    }
  }
  return { end: i, sgr: null };
};

/**
 * Splits text into runs of one style each, with every escape sequence
 * removed. Text without any comes back as a single unstyled run.
 */
export const parseAnsi = (text: string): AnsiSpan[] => {
  if (!hasAnsi(text)) {
    return [{ text, style: null }];
  }
  const spans: AnsiSpan[] = [];
  let style = plainStyle();
  let current: AnsiStyle | null = null;
  let runStart = 0;
  let i = 0;

  const push = (end: number) => {
    if (end <= runStart) {
      return;
    }
    const chunk = text.slice(runStart, end);
    const last = spans.length > 0 ? spans[spans.length - 1] : null;
    if (last !== null && sameStyle(last.style, current)) {
      last.text += chunk;
    } else {
      spans.push({ text: chunk, style: current });
    }
  };

  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== ESC && c !== CSI) {
      i++;
      continue;
    }
    push(i);
    const { end, sgr } = scanEscape(text, i);
    if (sgr !== null) {
      style = applySgr(style, sgr);
      current = isPlain(style) ? null : style;
    }
    i = end;
    runStart = end;
  }
  push(text.length);
  return spans.length > 0 ? spans : [{ text: '', style: null }];
};

/** The text with every escape sequence removed. */
export const stripAnsi = (text: string): string =>
  hasAnsi(text)
    ? parseAnsi(text)
        .map((span) => span.text)
        .join('')
    : text;

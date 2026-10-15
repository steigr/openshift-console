import { hasAnsi, paletteColor, parseAnsi, stripAnsi } from './ansi';

const ESC = '\u001b';

describe('parseAnsi', () => {
  it('returns text without escapes as one unstyled run', () => {
    expect(parseAnsi('plain text')).toEqual([
      { text: 'plain text', style: null },
    ]);
    expect(hasAnsi('plain text')).toBe(false);
  });

  it('colours the text between an SGR and its reset', () => {
    const spans = parseAnsi(`${ESC}[93msteigr joined the game${ESC}[0m`);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('steigr joined the game');
    expect(spans[0].style?.fg).toBe(11);
  });

  it('keeps unstyled text around a coloured run', () => {
    const spans = parseAnsi(`[Server] ${ESC}[31merror${ESC}[m done`);
    expect(spans.map((s) => s.text)).toEqual(['[Server] ', 'error', ' done']);
    expect(spans.map((s) => s.style?.fg ?? null)).toEqual([null, 1, null]);
  });

  it('accumulates attributes and clears them one by one', () => {
    const spans = parseAnsi(
      `${ESC}[1;4;32ma${ESC}[22mb${ESC}[24;39mc${ESC}[44md${ESC}[49me`,
    );
    expect(spans.map((s) => s.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(spans[0].style).toMatchObject({
      fg: 2,
      bold: true,
      underline: true,
    });
    expect(spans[1].style).toMatchObject({
      fg: 2,
      bold: false,
      underline: true,
    });
    expect(spans[2].style).toBeNull();
    expect(spans[3].style).toMatchObject({ bg: 4 });
    expect(spans[4].style).toBeNull();
  });

  it('merges adjacent runs of the same style', () => {
    const spans = parseAnsi(`${ESC}[31ma${ESC}[31mb${ESC}[0m${ESC}[0mc`);
    expect(spans).toMatchObject([
      { text: 'ab', style: { fg: 1 } },
      { text: 'c', style: null },
    ]);
  });

  it('reads bright, 256-colour and 24-bit colours', () => {
    const [bright, indexed, colon, truecolor, colonTrue, bg] = parseAnsi(
      `${ESC}[97ma${ESC}[38;5;208mb${ESC}[38:5:21mc${ESC}[38;2;10;20;30md${ESC}[38:2::1:2:3me${ESC}[0;48;2;255;0;0mf`,
    );
    expect(bright.style?.fg).toBe(15);
    expect(indexed.style?.fg).toBe(208);
    expect(colon.style?.fg).toBe(21);
    expect(truecolor.style?.fg).toBe('#0a141e');
    expect(colonTrue.style?.fg).toBe('#010203');
    expect(bg.style).toMatchObject({ fg: null, bg: '#ff0000' });
  });

  it('does not read the parameters after an extended colour as codes', () => {
    // 38;2;1;4;7 is one colour, not bold + underline + inverse.
    const [span] = parseAnsi(`${ESC}[38;2;1;4;7mx`);
    expect(span.style).toMatchObject({
      fg: '#010407',
      bold: false,
      underline: false,
      inverse: false,
    });
  });

  it('drops escape sequences that are not colour', () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress${ESC}[?25h`)).toBe('progress');
    expect(stripAnsi(`${ESC}]0;title${ESC}\\after`)).toBe('after');
    expect(
      stripAnsi(`${ESC}]8;;https://example.com\u0007link${ESC}]8;;\u0007`),
    ).toBe('link');
    expect(stripAnsi(`${ESC}(Bcharset`)).toBe('charset');
    expect(stripAnsi(`\u009b31mcsi`)).toBe('csi');
  });

  it('never shows half an escape sequence', () => {
    expect(stripAnsi(`cut off${ESC}[3`)).toBe('cut off');
    expect(stripAnsi(`cut off${ESC}`)).toBe('cut off');
  });

  it('ignores a private-mode sequence ending in m', () => {
    const spans = parseAnsi(`${ESC}[>4;2mtext`);
    expect(spans).toEqual([{ text: 'text', style: null }]);
  });
});

describe('paletteColor', () => {
  it('maps the colour cube and the grey ramp', () => {
    expect(paletteColor(16)).toBe('#000000');
    expect(paletteColor(196)).toBe('#ff0000');
    expect(paletteColor(208)).toBe('#ff8700');
    expect(paletteColor(231)).toBe('#ffffff');
    expect(paletteColor(232)).toBe('#080808');
    expect(paletteColor(255)).toBe('#eeeeee');
  });
});

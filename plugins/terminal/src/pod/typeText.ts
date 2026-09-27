import KeyTable from '@novnc/novnc/lib/input/keysym';
import keysymdef from '@novnc/novnc/lib/input/keysymdef';

/** The one noVNC RFB method typing needs. */
export type KeySender = {
  sendKey: (keysym: number, code: string, down?: boolean) => void;
};

/** Pause between the individual key events making up one character (Shift down, key down, ...). */
export const KEY_EVENT_GAP_MS = 10;
/** Pause after each character, before the next one starts. */
export const CHAR_GAP_MS = 25;

/** A physical key on a US keyboard, and whether Shift has to be held for the character. */
type UsKey = { code: string; shift: boolean };

const unshifted = (code: string): UsKey => ({ code, shift: false });
const shifted = (code: string): UsKey => ({ code, shift: true });

/**
 * Printable ASCII on a US (ANSI) layout, as KeyboardEvent.code values - the
 * guest's layout can't be known from here, and US is what VNC servers and
 * QEMU assume by default.
 */
const US_LAYOUT: { [char: string]: UsKey } = {
  ' ': unshifted('Space'),
  '`': unshifted('Backquote'),
  '~': shifted('Backquote'),
  '-': unshifted('Minus'),
  _: shifted('Minus'),
  '=': unshifted('Equal'),
  '+': shifted('Equal'),
  '[': unshifted('BracketLeft'),
  '{': shifted('BracketLeft'),
  ']': unshifted('BracketRight'),
  '}': shifted('BracketRight'),
  '\\': unshifted('Backslash'),
  '|': shifted('Backslash'),
  ';': unshifted('Semicolon'),
  ':': shifted('Semicolon'),
  "'": unshifted('Quote'),
  '"': shifted('Quote'),
  ',': unshifted('Comma'),
  '<': shifted('Comma'),
  '.': unshifted('Period'),
  '>': shifted('Period'),
  '/': unshifted('Slash'),
  '?': shifted('Slash'),
  ...Object.fromEntries(
    [')', '!', '@', '#', '$', '%', '^', '&', '*', '('].flatMap((symbol, digit) => [
      [String(digit), unshifted(`Digit${digit}`)],
      [symbol, shifted(`Digit${digit}`)],
    ]),
  ),
  ...Object.fromEntries(
    'abcdefghijklmnopqrstuvwxyz'
      .split('')
      .flatMap((letter) => [
        [letter, unshifted(`Key${letter.toUpperCase()}`)],
        [letter.toUpperCase(), shifted(`Key${letter.toUpperCase()}`)],
      ]),
  ),
};

/** Keys whose keysym isn't simply the character's codepoint. */
const CONTROL_KEYS: { [char: string]: { keysym: number; code: string } } = {
  '\n': { keysym: KeyTable.XK_Return, code: 'Enter' },
  '\t': { keysym: KeyTable.XK_Tab, code: 'Tab' },
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Types `text` into a VNC session the way a person on a US keyboard would.
 *
 * Every character goes out with the physical key's code as well as its keysym,
 * and a character that needs Shift gets an explicit Left Shift press wrapped
 * around it, with a pause between each event - the same sequence noVNC itself
 * sends for a real keypress. Relying on the keysym alone is what used to turn
 * `|` into `\`, `:` into `;` and `*` into `8`: a keysym-only event carries no
 * modifier state, and a server that has to map it back onto a scancode (QEMU,
 * with or without its extended key events) picks the unshifted key. Holding
 * Shift ourselves makes the scancode path correct, and gives a keysym-matching
 * server (Xvnc, x11vnc) exactly the shift state it expects for that keysym.
 *
 * Characters a US keyboard can't produce are sent as a bare keysym, which is
 * the best a VNC client can do for them.
 */
export const typeText = async (rfb: KeySender, text: string): Promise<void> => {
  // One Return for a Windows line break, not two.
  const normalized = text.replace(/\r\n?/g, '\n');

  for (const char of normalized) {
    const control = CONTROL_KEYS[char];
    const key = US_LAYOUT[char];
    const keysym = control?.keysym ?? keysymdef.lookup(char.codePointAt(0) ?? 0);
    const code = control?.code ?? key?.code ?? '';

    if (key?.shift) {
      rfb.sendKey(KeyTable.XK_Shift_L, 'ShiftLeft', true);
      await delay(KEY_EVENT_GAP_MS);
    }
    try {
      rfb.sendKey(keysym, code, true);
      await delay(KEY_EVENT_GAP_MS);
      rfb.sendKey(keysym, code, false);
    } finally {
      if (key?.shift) {
        await delay(KEY_EVENT_GAP_MS);
        rfb.sendKey(KeyTable.XK_Shift_L, 'ShiftLeft', false);
      }
    }
    await delay(CHAR_GAP_MS);
  }
};

import { CHAR_GAP_MS, KEY_EVENT_GAP_MS, typeText } from '../typeText';

const XK_SHIFT_L = 0xffe1;
const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;

type KeyCall = [keysym: number, code: string, down: boolean];

const typeAll = async (text: string): Promise<KeyCall[]> => {
  const sendKey = jest.fn();
  const done = typeText({ sendKey }, text);
  await jest.runAllTimersAsync();
  await done;
  return sendKey.mock.calls as KeyCall[];
};

const press = (char: string, code: string): KeyCall[] => [
  [char.codePointAt(0), code, true],
  [char.codePointAt(0), code, false],
];

const shiftPress = (char: string, code: string): KeyCall[] => [
  [XK_SHIFT_L, 'ShiftLeft', true],
  ...press(char, code),
  [XK_SHIFT_L, 'ShiftLeft', false],
];

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('typeText', () => {
  it('sends unshifted characters as a plain down/up with the US key code', async () => {
    expect(await typeAll('a1\\;')).toEqual([
      ...press('a', 'KeyA'),
      ...press('1', 'Digit1'),
      ...press('\\', 'Backslash'),
      ...press(';', 'Semicolon'),
    ]);
  });

  it.each([
    ['|', 'Backslash'],
    [':', 'Semicolon'],
    ['*', 'Digit8'],
    ['A', 'KeyA'],
    ['!', 'Digit1'],
    ['@', 'Digit2'],
    ['#', 'Digit3'],
    ['$', 'Digit4'],
    ['%', 'Digit5'],
    ['^', 'Digit6'],
    ['&', 'Digit7'],
    ['(', 'Digit9'],
    [')', 'Digit0'],
    ['_', 'Minus'],
    ['+', 'Equal'],
    ['{', 'BracketLeft'],
    ['}', 'BracketRight'],
    ['"', 'Quote'],
    ['<', 'Comma'],
    ['>', 'Period'],
    ['?', 'Slash'],
    ['~', 'Backquote'],
  ])('holds Left Shift around %s on the %s key', async (char, code) => {
    expect(await typeAll(char)).toEqual(shiftPress(char, code));
  });

  it('sends Return and Tab by keysym and key code', async () => {
    expect(await typeAll('\t\n')).toEqual([
      [XK_TAB, 'Tab', true],
      [XK_TAB, 'Tab', false],
      [XK_RETURN, 'Enter', true],
      [XK_RETURN, 'Enter', false],
    ]);
  });

  it('types a single Return for a CRLF or bare CR line break', async () => {
    const calls = await typeAll('a\r\nb\rc');
    expect(calls.filter(([keysym]) => keysym === XK_RETURN)).toHaveLength(4);
  });

  it('falls back to a bare keysym for characters a US keyboard lacks', async () => {
    expect(await typeAll('ä')).toEqual([
      [0xe4, '', true],
      [0xe4, '', false],
    ]);
  });

  it('paces the key events instead of sending them all at once', async () => {
    const sendKey = jest.fn();
    const done = typeText({ sendKey }, '|x');

    expect(sendKey).toHaveBeenCalledTimes(1); // Shift down only
    await jest.advanceTimersByTimeAsync(KEY_EVENT_GAP_MS);
    expect(sendKey).toHaveBeenCalledTimes(2); // key down
    await jest.advanceTimersByTimeAsync(KEY_EVENT_GAP_MS);
    expect(sendKey).toHaveBeenCalledTimes(3); // key up
    await jest.advanceTimersByTimeAsync(KEY_EVENT_GAP_MS);
    expect(sendKey).toHaveBeenCalledTimes(4); // Shift up
    await jest.advanceTimersByTimeAsync(CHAR_GAP_MS - 1);
    expect(sendKey).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1);
    expect(sendKey).toHaveBeenCalledTimes(5); // next character

    await jest.runAllTimersAsync();
    await done;
  });

  it('releases Shift even if sending the key throws', async () => {
    const sendKey = jest.fn((keysym: number) => {
      if (keysym !== XK_SHIFT_L) {
        throw new Error('socket closed');
      }
    });
    const done = typeText({ sendKey }, '|');
    const settled = expect(done).rejects.toThrow('socket closed');
    await jest.runAllTimersAsync();
    await settled;

    expect(sendKey).toHaveBeenLastCalledWith(XK_SHIFT_L, 'ShiftLeft', false);
  });
});

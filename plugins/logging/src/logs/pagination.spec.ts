import {
  cursorOf,
  earlierJournalLines,
  earlierPodLines,
  splitLines,
} from './pagination';

const lines = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_v, i) => `line ${String(from + i)}`);

describe('earlierPodLines', () => {
  it('returns exactly the lines before the ones already held', () => {
    // Held: 100..200. Fetched a bigger tail: 0..200.
    const held = lines(100, 200);
    const fetched = lines(0, 200);
    expect(earlierPodLines(fetched, held[0], held.length)).toEqual(
      lines(0, 100),
    );
  });

  it('still joins correctly when the container logged more in between', () => {
    // The window slid: the second request ends 20 lines later than the first.
    const held = lines(100, 200);
    const fetched = lines(0, 220);
    const earlier = earlierPodLines(fetched, held[0], held.length);
    // Anchored on content, so the join lands on "line 100" regardless.
    expect(earlier).toEqual(lines(0, 100));
    expect(earlier[earlier.length - 1]).toBe('line 99');
  });

  it('joins on the anchor even when an identical line repeats far away', () => {
    const fetched = [
      'line 100',
      ...lines(1, 100),
      'line 100',
      ...lines(101, 150),
    ];
    const earlier = earlierPodLines(fetched, 'line 100', 50);
    // The occurrence nearest the expected join wins, not the first in the file.
    expect(earlier[earlier.length - 1]).toBe('line 99');
  });

  it('falls back to arithmetic when the anchor line is gone', () => {
    // The log rotated: nothing we hold appears in what came back.
    const fetched = lines(500, 600);
    expect(earlierPodLines(fetched, 'line 100', 40)).toEqual(lines(500, 560));
  });

  it('returns nothing when the tail did not reach any further back', () => {
    const held = lines(0, 100);
    expect(earlierPodLines(held, held[0], held.length)).toEqual([]);
  });

  it('copes with no anchor at all', () => {
    expect(earlierPodLines(lines(0, 10), null, 4)).toEqual(lines(0, 6));
  });
});

describe('earlierJournalLines', () => {
  const entry = (cursor: string, message: string) =>
    JSON.stringify({ __CURSOR: cursor, MESSAGE: message });

  it('reverses the page and drops the anchor entry', () => {
    // journalctl --cursor C --reverse walks backwards and includes C itself.
    const fetched = [
      entry('c3', 'third'),
      entry('c2', 'second'),
      entry('c1', 'first'),
    ];
    const earlier = earlierJournalLines(fetched, 'c3');
    const messages = earlier.map(
      (line) => (JSON.parse(line) as { MESSAGE: string }).MESSAGE,
    );
    expect(messages).toEqual(['first', 'second']);
  });

  it('keeps everything when there is no anchor yet', () => {
    const fetched = [entry('c2', 'second'), entry('c1', 'first')];
    expect(earlierJournalLines(fetched, null)).toHaveLength(2);
  });

  it('drops blank lines from the stream tail', () => {
    expect(earlierJournalLines([entry('c1', 'x'), ''], null)).toHaveLength(1);
  });
});

describe('cursorOf', () => {
  it('reads __CURSOR', () => {
    expect(cursorOf('{"__CURSOR":"s=abc;i=1","MESSAGE":"x"}')).toBe(
      's=abc;i=1',
    );
  });

  it('is null for a line that is not a journald record', () => {
    expect(cursorOf('-- Journal begins --')).toBeNull();
    expect(cursorOf('{"MESSAGE":"x"}')).toBeNull();
  });
});

describe('splitLines', () => {
  it('drops the trailing blank a newline-terminated body leaves', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('keeps an unterminated last line', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });
});

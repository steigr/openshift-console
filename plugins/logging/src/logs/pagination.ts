/**
 * Paging backwards through a log.
 *
 * The two sources could hardly differ more in what they support:
 *
 * - The kubelet's log endpoint has no notion of an offset. `tailLines=N` is
 *   "the last N lines", counted from *now*, and there is no "until". So the
 *   only way to see earlier lines is to ask for a bigger tail and work out
 *   which of the lines that come back are ones we do not already have --
 *   which is what {@link earlierPodLines} does, and why it has to deal with
 *   the window having shifted under it while the first request was in flight.
 *
 * - journald has real cursors. Every entry carries a `__CURSOR`, and
 *   journalctl will start from one, so the node journal pages exactly and the
 *   only work here is dropping the anchor entry itself
 *   ({@link earlierJournalLines}).
 */

/** Lines fetched per page when scrolling back. */
export const PAGE_LINES = 10_000;

/**
 * How far from the expected join point to look for the anchor line. Generous:
 * it only has to cover however many lines the container wrote between the two
 * requests, and a wrong guess here costs a duplicated or missing line, not a
 * broken view.
 */
const JOIN_SEARCH_SLACK = 2000;

/**
 * Picks out the lines from a larger tail that come *before* what is already
 * held.
 *
 * `tailLines` counts back from the present, so by the time the second request
 * is served the window has slid: asking for 20k after holding 10k does not
 * simply yield "the previous 10k" but 20k ending at a later point. The join is
 * therefore found by content -- locating the line we currently hold first --
 * and only falls back to arithmetic when that line cannot be found (the log
 * rotated, or the line is genuinely gone).
 */
export const earlierPodLines = (
  fetched: readonly string[],
  currentFirstLine: string | null,
  currentLength: number,
): string[] => {
  const expected = Math.max(0, fetched.length - currentLength);

  if (currentFirstLine !== null) {
    // Search outward from where the anchor should be, so a line that repeats
    // elsewhere in the log cannot drag the join far from the truth.
    for (let offset = 0; offset <= JOIN_SEARCH_SLACK; offset++) {
      for (const index of offset === 0
        ? [expected]
        : [expected - offset, expected + offset]) {
        if (
          index >= 0 &&
          index < fetched.length &&
          fetched[index] === currentFirstLine
        ) {
          return fetched.slice(0, index);
        }
      }
    }
  }

  return fetched.slice(0, expected);
};

/** The `__CURSOR` of a journald line, or null if it has none. */
export const cursorOf = (line: string): string | null => {
  try {
    const record: unknown = JSON.parse(line);
    if (typeof record !== 'object' || record === null) {
      return null;
    }
    const cursor = (record as Record<string, unknown>).__CURSOR;
    return typeof cursor === 'string' ? cursor : null;
  } catch {
    return null;
  }
};

/**
 * Turns a `journalctl --cursor C --reverse` page into lines to prepend.
 *
 * Reversed, because journalctl walks backwards from the cursor and the viewer
 * reads forwards; and with the anchor entry dropped, because `--cursor`
 * includes the entry it names and we already have that one.
 */
export const earlierJournalLines = (
  fetched: readonly string[],
  anchorCursor: string | null,
): string[] =>
  fetched
    .filter((line) => line !== '' && cursorOf(line) !== anchorCursor)
    .reverse();

/** Splits a fetched body into lines, dropping a trailing blank. */
export const splitLines = (body: string): string[] => {
  const lines = body.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
};

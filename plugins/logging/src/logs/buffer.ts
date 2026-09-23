/**
 * A line index over a growing log stream that never materialises one object
 * (or even one string) per line.
 *
 * Container logs routinely run to six figures of lines; the naive shape --
 * `text.split('\n').map(JSON.parse)` -- turns a 50 MB text buffer into a
 * ~250 MB live object graph that every minor GC then has to walk. What the
 * renderer actually needs is the ~150 lines currently mounted, so all this
 * keeps is where each line starts and ends. Parsing happens in the row
 * renderer (see ./parse.ts), on demand, for the rows the virtualiser mounted.
 *
 * Text is held in *pages* rather than one string. Appending to a JavaScript
 * string builds a rope, which is O(1) amortised, but any `slice()` on it
 * forces the engine to flatten the whole thing -- and while following a live
 * stream we slice on every frame. Sealing the buffer into ~1 MiB pages bounds
 * that: a sealed page is flattened at most once and never appended to again,
 * and only the (small) tail page is ever re-roped. A page is only ever sealed
 * on a line boundary, so no line ever spans two pages and a line's extent is
 * a single (page, start, end) triple.
 */

const DEFAULT_PAGE_SIZE = 1 << 20; // 1 MiB
const DEFAULT_MAX_LINES = 200_000;
const INITIAL_CAPACITY = 4096;

export interface LogBufferOptions {
  /** Lines retained before the oldest are dropped. */
  maxLines?: number;
  /** Soft target for page size; a page is sealed at the first line boundary past it. */
  pageSize?: number;
}

export class LogBuffer {
  private readonly maxLines: number;
  private readonly pageSize: number;

  /**
   * Text pages, in no particular order: `pageOf` holds the index, so a page
   * prepended later can sit after one appended earlier. A released page is
   * replaced by '' rather than removed, so every other index stays valid.
   */
  private pages: string[] = [''];
  /** Lines still referencing each page; a page is freed when this hits zero. */
  private pageRefs: number[] = [0];
  /** The page `append` writes into. Not necessarily the last one. */
  private tailPage = 0;

  private pageOf: Int32Array;
  private startAt: Int32Array;
  private endAt: Int32Array;

  /** Index of the oldest retained line within the arrays. */
  private base = 0;
  /** One past the newest retained line within the arrays. */
  private used = 0;
  /** Sequence number of the line at `base`. Sequence numbers never repeat. */
  private baseSeq = 0;

  /** Offset in the tail page at which the not-yet-terminated line begins. */
  private lineStart = 0;
  /** Offset in the tail page up to which we have already looked for newlines. */
  private scanFrom = 0;

  /**
   * Bumped by `clear()`. Sequence numbers restart from zero after a reset, so
   * anything caching by sequence number (the viewer's parsed-row cache) needs
   * a way to tell "line 7 of this stream" from "line 7 of the previous one".
   */
  private gen = 0;

  constructor(options: LogBufferOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
    this.pageSize = Math.max(1024, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.pageOf = new Int32Array(INITIAL_CAPACITY);
    this.startAt = new Int32Array(INITIAL_CAPACITY);
    this.endAt = new Int32Array(INITIAL_CAPACITY);
  }

  /** Increments on every `clear()`; see the field's own note. */
  get generation(): number {
    return this.gen;
  }

  /** Sequence number of the oldest retained line. */
  get firstSeq(): number {
    return this.baseSeq;
  }

  /** One past the sequence number of the newest retained line. */
  get endSeq(): number {
    return this.baseSeq + (this.used - this.base);
  }

  /** Number of retained, complete lines. */
  get length(): number {
    return this.used - this.base;
  }

  /** Lines dropped so far because of `maxLines`. */
  get droppedLines(): number {
    return this.baseSeq;
  }

  /** Characters of log text currently held. */
  get charLength(): number {
    let total = 0;
    for (const page of this.pages) {
      total += page.length;
    }
    return total;
  }

  /**
   * Indexes every complete line in `chunk`. A trailing fragment is carried
   * over and completed by the next append (or by `flushPartial`), which is
   * what makes this safe to feed straight from a stream reader.
   */
  append(chunk: string): void {
    if (!chunk) {
      return;
    }

    const page = this.tailPage;
    this.pages[page] += chunk;
    const text = this.pages[page];

    for (let from = this.scanFrom; ;) {
      const nl = text.indexOf('\n', from);
      if (nl < 0) {
        break;
      }
      this.pushLine(page, this.lineStart, nl);
      this.lineStart = nl + 1;
      from = nl + 1;
    }
    this.scanFrom = text.length;

    // Seal only on a line boundary, so a line never spans pages.
    if (text.length >= this.pageSize && this.lineStart === text.length) {
      this.tailPage = this.newPage('');
      this.lineStart = 0;
      this.scanFrom = 0;
    }

    this.evict();
  }

  /**
   * Commits a trailing line that never got its newline. Call once the stream
   * ends -- kubelet does not newline-terminate the final line of a finished
   * log, so without this the last line would be indexed but never shown.
   */
  flushPartial(): void {
    const page = this.tailPage;
    const text = this.pages[page];
    if (this.lineStart < text.length) {
      this.pushLine(page, this.lineStart, text.length);
      this.lineStart = text.length;
      this.evict();
    }
  }

  /** The text of one line, without its line terminator, or null if evicted. */
  lineAt(seq: number): string | null {
    const i = this.base + (seq - this.baseSeq);
    if (i < this.base || i >= this.used) {
      return null;
    }
    return this.pages[this.pageOf[i]].slice(this.startAt[i], this.endAt[i]);
  }

  /**
   * Every retained line joined back together, for "download". Built from the
   * line index rather than the pages, which are no longer in reading order
   * once anything has been prepended.
   */
  text(): string {
    const lines: string[] = [];
    for (let seq = this.firstSeq; seq < this.endSeq; seq++) {
      const line = this.lineAt(seq);
      if (line !== null) {
        lines.push(line);
      }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  /**
   * Adds older lines to the *front*, for paging backwards through a log.
   *
   * Sequence numbers already handed out do not move: the new lines take the
   * numbers below `firstSeq`, so anything holding a sequence number -- the
   * viewer's parsed-row cache, an expanded row -- stays correct, and the
   * caller can shift the scroll position by exactly the number of lines
   * added. `chunk` must be whole lines, in reading order.
   */
  prepend(chunk: string): number {
    if (chunk === '') {
      return 0;
    }

    const page = this.newPage(chunk);
    const extents: number[] = [];
    for (let from = 0; from < chunk.length;) {
      const nl = chunk.indexOf('\n', from);
      const end = nl < 0 ? chunk.length : nl;
      if (end > from) {
        extents.push(from, end);
      }
      if (nl < 0) {
        break;
      }
      from = nl + 1;
    }

    const count = extents.length / 2;
    if (count === 0) {
      return 0;
    }
    this.reserveFront(count);

    for (let i = 0; i < count; i++) {
      const target = this.base - count + i;
      const start = extents[i * 2];
      const end = extents[i * 2 + 1];
      this.pageOf[target] = page;
      this.startAt[target] = start;
      this.endAt[target] = chunk.charCodeAt(end - 1) === 13 ? end - 1 : end;
    }
    this.pageRefs[page] += count;
    this.base -= count;
    this.baseSeq -= count;
    return count;
  }

  clear(): void {
    this.pages = [''];
    this.pageRefs = [0];
    this.tailPage = 0;
    this.base = 0;
    this.used = 0;
    this.baseSeq = 0;
    this.lineStart = 0;
    this.scanFrom = 0;
    this.gen++;
  }

  private pushLine(page: number, start: number, end: number): void {
    // Tolerate CRLF: kubelet passes container output through byte for byte.
    const trimmed =
      end > start && this.pages[page].charCodeAt(end - 1) === 13
        ? end - 1
        : end;

    if (this.used === this.pageOf.length) {
      this.compactOrGrow();
    }
    this.pageOf[this.used] = page;
    this.startAt[this.used] = start;
    this.endAt[this.used] = trimmed;
    this.used++;
    this.pageRefs[page]++;
  }

  private newPage(text: string): number {
    this.pages.push(text);
    this.pageRefs.push(0);
    return this.pages.length - 1;
  }

  /** Makes room for `count` lines before `base`, reallocating if need be. */
  private reserveFront(count: number): void {
    if (this.base >= count) {
      return;
    }
    const live = this.used - this.base;
    const gap = Math.max(count, this.maxLines >> 2);
    const capacity = Math.max(this.pageOf.length, gap + live + 1);

    const pageOf = new Int32Array(capacity);
    const startAt = new Int32Array(capacity);
    const endAt = new Int32Array(capacity);
    pageOf.set(this.pageOf.subarray(this.base, this.used), gap);
    startAt.set(this.startAt.subarray(this.base, this.used), gap);
    endAt.set(this.endAt.subarray(this.base, this.used), gap);

    this.pageOf = pageOf;
    this.startAt = startAt;
    this.endAt = endAt;
    this.base = gap;
    this.used = gap + live;
  }

  /**
   * Reclaims the space eviction already freed at the front before resorting to
   * a bigger allocation, which keeps the arrays at roughly `maxLines` for a
   * stream of any length.
   */
  private compactOrGrow(): void {
    if (this.base > 0) {
      this.pageOf.copyWithin(0, this.base, this.used);
      this.startAt.copyWithin(0, this.base, this.used);
      this.endAt.copyWithin(0, this.base, this.used);
      this.used -= this.base;
      this.base = 0;
      return;
    }
    const grown = this.pageOf.length * 2;
    const pageOf = new Int32Array(grown);
    const startAt = new Int32Array(grown);
    const endAt = new Int32Array(grown);
    pageOf.set(this.pageOf);
    startAt.set(this.startAt);
    endAt.set(this.endAt);
    this.pageOf = pageOf;
    this.startAt = startAt;
    this.endAt = endAt;
  }

  /** Drops the oldest lines past `maxLines`, freeing any page they were the last users of. */
  private evict(): void {
    const excess = this.used - this.base - this.maxLines;
    if (excess <= 0) {
      return;
    }
    for (let i = this.base; i < this.base + excess; i++) {
      const page = this.pageOf[i];
      this.pageRefs[page]--;
      // Reference counted rather than "every page before this one", which
      // stopped being the same thing once pages could be prepended out of
      // order. The tail page is spared: it is still being written to.
      if (this.pageRefs[page] === 0 && page !== this.tailPage) {
        this.pages[page] = '';
      }
    }
    this.base += excess;
    this.baseSeq += excess;
  }
}

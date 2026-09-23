import type { FC, UIEvent } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AngleDownIcon, AngleRightIcon } from '@patternfly/react-icons';

import type { LogBuffer } from './buffer';
import { computeFillHeight, findScrollParent } from './fill-height';
import { formatTimestamp, parseLine } from './parse';
import type { LogEntry, LogFormat } from './parse';
import './log-viewer.css';

/**
 * Rows are a fixed height so the virtualiser can place any row without having
 * measured it -- which is what lets parsing happen in the row renderer instead
 * of ahead of it. Long messages are clipped; the expansion shows the whole
 * record.
 */
const ROW_HEIGHT = 22;
/** Rows rendered beyond each edge of the viewport, to cover a fast flick. */
const OVERSCAN = 25;
/** Distance from the bottom within which the view keeps following the tail. */
const STICK_THRESHOLD_PX = 24;
/** Parsed rows kept; large enough that scrolling back re-renders without re-parsing. */
const PARSE_CACHE_SIZE = 2000;

const EXPANSION_LINE_HEIGHT = 18;
const EXPANSION_CHROME_PX = 48;
const EXPANSION_MAX_ESTIMATE_PX = 420;

/**
 * Height to reserve for an expansion before it has been measured. Close enough
 * that opening a row does not visibly shift what is below it, which a flat
 * default would do for every short trace.
 */
const estimateExpansionHeight = (entry: LogEntry): number => {
  const body = entry.stackTrace ?? entry.raw;
  let lines = 1;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) === 10) {
      lines++;
    }
  }
  if (entry.record !== null && entry.stackTrace === null) {
    // Pretty-printed JSON is roughly one line per key.
    lines = Math.max(lines, Object.keys(entry.record).length + 2);
  }
  return Math.min(
    EXPANSION_MAX_ESTIMATE_PX,
    lines * EXPANSION_LINE_HEIGHT + EXPANSION_CHROME_PX,
  );
};

/**
 * Parsed rows, memoised per buffer. Deliberately a side table rather than a
 * hook: this is a pure function of (line text, format) that React neither
 * needs to see nor should ever throw away mid-scroll, and hanging it off the
 * buffer in a WeakMap means it is collected exactly when the buffer is.
 *
 * Entries stay valid for as long as the line is retained -- a line's text
 * never changes once the buffer has indexed it -- so the cache is only
 * invalidated when the columns would differ (a new format) or when sequence
 * numbers restart (a new stream, which bumps the buffer's generation).
 */
interface ParseCache {
  format: LogFormat;
  generation: number;
  entries: Map<number, LogEntry>;
}

const parseCaches = new WeakMap<LogBuffer, ParseCache>();

const entryFor = (
  buffer: LogBuffer,
  seq: number,
  format: LogFormat,
): LogEntry | null => {
  let cache = parseCaches.get(buffer);
  if (cache?.format !== format || cache.generation !== buffer.generation) {
    cache = { format, generation: buffer.generation, entries: new Map() };
    parseCaches.set(buffer, cache);
  }

  const cached = cache.entries.get(seq);
  if (cached !== undefined) {
    return cached;
  }

  const raw = buffer.lineAt(seq);
  if (raw === null) {
    return null;
  }
  const entry = parseLine(raw, format);
  cache.entries.set(seq, entry);
  if (cache.entries.size > PARSE_CACHE_SIZE) {
    // Map iterates in insertion order, so this drops the oldest.
    const oldest = cache.entries.keys().next();
    if (!oldest.done) {
      cache.entries.delete(oldest.value);
    }
  }
  return entry;
};

interface ExpansionProps {
  seq: number;
  entry: LogEntry;
  top: number;
  onMeasured: (seq: number, height: number) => void;
}

const Expansion: FC<ExpansionProps> = ({ seq, entry, top, onMeasured }) => {
  const { t } = useTranslation('plugin__logging-console-plugin');
  const ref = useRef<HTMLDivElement | null>(null);

  // The reserved height is an estimate until the content is on screen; feed
  // the real one back so the rows below settle into the right place.
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const report = () => {
      onMeasured(seq, element.getBoundingClientRect().height);
    };
    report();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [seq, entry, onMeasured]);

  const heading =
    entry.errorType && entry.errorMessage
      ? `${entry.errorType}: ${entry.errorMessage}`
      : (entry.errorType ?? entry.errorMessage ?? null);

  return (
    <div
      ref={ref}
      className={`logging-log-viewer__expansion${
        entry.stackTrace ? ' logging-log-viewer__expansion--stack' : ''
      }`}
      style={{ top }}
      data-test="log-expansion"
    >
      {entry.stackTrace !== null && (
        <>
          <div className="logging-log-viewer__expansion-title">
            {heading ?? t('Stack trace')}
          </div>
          <pre className="logging-log-viewer__pre">{entry.stackTrace}</pre>
        </>
      )}
      {entry.record !== null ? (
        <>
          {entry.stackTrace !== null && (
            <div className="logging-log-viewer__expansion-title">
              {t('Record')}
            </div>
          )}
          <pre className="logging-log-viewer__pre">
            {JSON.stringify(entry.record, null, 2)}
          </pre>
        </>
      ) : (
        <pre className="logging-log-viewer__pre">{entry.raw}</pre>
      )}
    </div>
  );
};

interface RowProps {
  seq: number;
  entry: LogEntry;
  top: number;
  format: LogFormat;
  isExpanded: boolean;
  onToggle: (seq: number, entry: LogEntry) => void;
}

const Row: FC<RowProps> = ({
  seq,
  entry,
  top,
  format,
  isExpanded,
  onToggle,
}) => {
  const { t } = useTranslation('plugin__logging-console-plugin');
  const plain = format === 'plain';
  const hasStack = entry.stackTrace !== null;

  return (
    <div
      className={`logging-log-viewer__row${
        format !== 'plain' && !entry.structured
          ? ' logging-log-viewer__row--unparsed'
          : ''
      }`}
      style={{ top, height: ROW_HEIGHT }}
      data-test="log-row"
      data-seq={seq}
    >
      <button
        type="button"
        className={`logging-log-viewer__toggle${
          hasStack ? ' logging-log-viewer__toggle--stack' : ''
        }`}
        onClick={() => {
          onToggle(seq, entry);
        }}
        aria-expanded={isExpanded}
        aria-label={hasStack ? t('Toggle stack trace') : t('Toggle full line')}
        title={hasStack ? t('Stack trace') : t('Full line')}
        data-test="log-row-toggle"
      >
        {isExpanded ? (
          <AngleDownIcon aria-hidden />
        ) : (
          <AngleRightIcon aria-hidden />
        )}
      </button>
      {!plain && (
        <>
          <span
            className="logging-log-viewer__cell logging-log-viewer__time"
            title={entry.timestamp ?? ''}
          >
            {formatTimestamp(entry.timestamp)}
          </span>
          <span
            className={`logging-log-viewer__cell logging-log-viewer__level${
              entry.levelClass
                ? ` logging-log-viewer__level--${entry.levelClass}`
                : ''
            }`}
            title={entry.level ?? ''}
          >
            {entry.level ?? ''}
          </span>
          <span
            className="logging-log-viewer__cell logging-log-viewer__logger"
            title={entry.logger ?? ''}
          >
            {entry.logger ?? ''}
          </span>
        </>
      )}
      <span
        className="logging-log-viewer__cell logging-log-viewer__message"
        title={entry.message}
      >
        {entry.message}
      </span>
    </div>
  );
};

export interface LogViewerProps {
  buffer: LogBuffer;
  /** Bumped by the stream hook whenever the buffer gained lines. */
  version: number;
  format: LogFormat;
  /** Keep the view pinned to the newest line as it arrives. */
  follow: boolean;
  emptyText?: string;
}

export const LogViewer: FC<LogViewerProps> = ({
  buffer,
  version,
  format,
  follow,
  emptyText,
}) => {
  const { t } = useTranslation('plugin__logging-console-plugin');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [scrollTop, setScrollTop] = useState(0);
  /** seq -> height reserved for its expansion. Keyed by sequence number, not
   * row index, so an expansion survives the oldest lines being evicted. */
  const [expanded, setExpanded] = useState<ReadonlyMap<number, number>>(
    () => new Map(),
  );
  const stickToBottom = useRef(true);

  const firstSeq = buffer.firstSeq;
  const count = buffer.length;

  // --- lazy parsing -------------------------------------------------------
  // Entries are produced by the row renderer below, for mounted rows only. A
  // line's text never changes once indexed, so a cached entry stays valid for
  // as long as that line is retained and the format is unchanged.
  const entryAt = (seq: number): LogEntry | null =>
    entryFor(buffer, seq, format);

  // --- geometry -----------------------------------------------------------
  // Rows are uniform, so a row's offset is index * ROW_HEIGHT plus the height
  // of any expansions above it. Expansions are a handful at most, so walking
  // them is cheaper than maintaining a prefix-sum structure.
  const expansions = useMemo(() => {
    const list: { index: number; seq: number; height: number }[] = [];
    expanded.forEach((height, seq) => {
      const index = seq - firstSeq;
      if (index >= 0 && index < count) {
        list.push({ index, seq, height });
      }
    });
    return list.sort((a, b) => a.index - b.index);
  }, [expanded, firstSeq, count]);

  const extraHeight = useMemo(
    () => expansions.reduce((sum, e) => sum + e.height, 0),
    [expansions],
  );
  const totalHeight = count * ROW_HEIGHT + extraHeight;

  const topOf = useCallback(
    (index: number): number => {
      let extra = 0;
      for (const expansion of expansions) {
        if (expansion.index >= index) {
          break;
        }
        extra += expansion.height;
      }
      return index * ROW_HEIGHT + extra;
    },
    [expansions],
  );

  /** Inverse of topOf: the row index drawn at a given offset. */
  const indexAt = useCallback(
    (offset: number): number => {
      let index = 0;
      let top = 0;
      for (const expansion of expansions) {
        const blockTop = top + (expansion.index - index) * ROW_HEIGHT;
        const blockBottom = blockTop + ROW_HEIGHT + expansion.height;
        if (offset < blockBottom) {
          return offset < blockTop
            ? index + Math.floor((offset - top) / ROW_HEIGHT)
            : expansion.index;
        }
        index = expansion.index + 1;
        top = blockBottom;
      }
      return index + Math.floor((offset - top) / ROW_HEIGHT);
    },
    [expansions],
  );

  const firstVisible = Math.max(0, indexAt(scrollTop) - OVERSCAN);
  const lastVisible = Math.min(
    count - 1,
    indexAt(scrollTop + viewportHeight) + OVERSCAN,
  );

  // --- scrolling ----------------------------------------------------------
  // The viewer gets an explicit pixel height, measured against the nearest
  // scrolling ancestor. See ./fill-height.ts for why neither `height: 100%`
  // nor `flex: 1` works here: console's own tab wrappers never shrink, so the
  // viewer would grow to its content, report a client height equal to its
  // scroll height, and mount every row in the log.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return undefined;
    }

    const measure = () => {
      const scroller = findScrollParent(element);
      const height = computeFillHeight({
        viewerTop: element.getBoundingClientRect().top,
        scrollerTop: scroller?.getBoundingClientRect().top ?? 0,
        scrollerClientHeight: scroller?.clientHeight ?? window.innerHeight,
        scrollerScrollTop: scroller?.scrollTop ?? window.scrollY,
      });
      element.style.height = `${String(height)}px`;
      setViewportHeight(element.clientHeight);
    };

    measure();
    window.addEventListener('resize', measure);
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        window.removeEventListener('resize', measure);
      };
    }

    // The toolbar above can wrap to a second line, and console's masthead and
    // sidebar shift things around; both move the viewer's top edge without a
    // window resize ever firing.
    const observer = new ResizeObserver(measure);
    const scroller = findScrollParent(element);
    if (scroller) {
      observer.observe(scroller);
    }
    if (element.parentElement) {
      observer.observe(element.parentElement);
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    // Scrolling away from the tail stops the view following it; scrolling
    // back to the bottom resumes, the same as a terminal pager.
    stickToBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <=
      STICK_THRESHOLD_PX;
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !follow || !stickToBottom.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
    setScrollTop(element.scrollTop);
  }, [follow, version, totalHeight]);

  // Re-following should jump to the tail even if the reader had scrolled away.
  useEffect(() => {
    if (follow) {
      stickToBottom.current = true;
    }
  }, [follow]);

  const handleToggle = useCallback(
    (seq: number, entry: LogEntry) => {
      setExpanded((previous) => {
        const next = new Map<number, number>();
        // Expansions whose line has since been evicted are dropped here, which
        // is the only place the map grows, so it cannot outrun the buffer.
        previous.forEach((height, key) => {
          if (key >= firstSeq) {
            next.set(key, height);
          }
        });
        if (next.has(seq)) {
          next.delete(seq);
        } else {
          next.set(seq, estimateExpansionHeight(entry));
        }
        return next;
      });
    },
    [firstSeq],
  );

  const handleMeasured = useCallback((seq: number, height: number) => {
    setExpanded((previous) => {
      const current = previous.get(seq);
      if (current === undefined || Math.abs(current - height) < 1) {
        return previous;
      }
      const next = new Map(previous);
      next.set(seq, height);
      return next;
    });
  }, []);

  const rows = [];
  for (let index = firstVisible; index <= lastVisible; index++) {
    const seq = firstSeq + index;
    const entry = entryAt(seq);
    if (entry === null) {
      continue;
    }
    const top = topOf(index);
    const isExpanded = expanded.has(seq);
    rows.push(
      <Row
        key={seq}
        seq={seq}
        entry={entry}
        top={top}
        format={format}
        isExpanded={isExpanded}
        onToggle={handleToggle}
      />,
    );
    if (isExpanded) {
      rows.push(
        <Expansion
          key={`${String(seq)}-expansion`}
          seq={seq}
          entry={entry}
          top={top + ROW_HEIGHT}
          onMeasured={handleMeasured}
        />,
      );
    }
  }

  return (
    <div
      ref={scrollRef}
      className={`logging-log-viewer${
        format === 'plain' ? ' logging-log-viewer--plain' : ''
      }`}
      onScroll={onScroll}
      data-test="log-viewer"
      tabIndex={0}
      role="log"
    >
      {count === 0 ? (
        <div className="logging-log-viewer__empty">
          {emptyText ?? t('No log entries.')}
        </div>
      ) : (
        <div
          className="logging-log-viewer__sizer"
          style={{ height: totalHeight }}
        >
          {rows}
        </div>
      )}
    </div>
  );
};

/**
 * Turns one raw log line into the four columns the viewer renders. Called
 * from the row renderer for mounted rows only -- see ./buffer.ts for why
 * nothing here runs over the whole stream.
 */

export type LogFormat = 'plain' | 'json' | 'ecs' | 'journald';

export const LOG_FORMATS: LogFormat[] = ['plain', 'json', 'ecs', 'journald'];

export const isLogFormat = (value: unknown): value is LogFormat =>
  typeof value === 'string' && (LOG_FORMATS as string[]).includes(value);

/**
 * How a record's field is read, as named in the `logs.kubernetes.io/format`
 * annotation (see ./format-annotation.ts). The type decides where the field
 * shows: the date types and `epoch` feed the time column, `log-level` the
 * level column, and `string`/`number` become columns of their own.
 *
 * `abbreviate` feeds the logger column, shortened Log4j2 `%c{1.}`-style:
 * `com.example.utils.MyLogger` shows as `c.e.u.MyLogger`. The journal view's
 * equivalent column is a systemd unit, which it leaves alone.
 *
 * `date/rfc3339nano` is accepted as its own name but reads the same as
 * `date/rfc3339`: both take any number of fractional digits.
 */
export type ColumnType =
  | 'date/rfc3339'
  | 'date/rfc3339nano'
  | 'date/epoch-ms'
  | 'epoch'
  | 'log-level'
  | 'abbreviate'
  | 'number'
  | 'string';

export const COLUMN_TYPES: ColumnType[] = [
  'date/rfc3339',
  'date/rfc3339nano',
  'date/epoch-ms',
  'epoch',
  'log-level',
  'abbreviate',
  'number',
  'string',
];

export const isColumnType = (value: unknown): value is ColumnType =>
  typeof value === 'string' && (COLUMN_TYPES as string[]).includes(value);

export interface ColumnSpec {
  /** The record key to read; dotted paths walk nested objects. */
  key: string;
  type: ColumnType;
}

/** The specs that get a column of their own, in the order they were listed. */
export const extraColumns = (columns: readonly ColumnSpec[]): ColumnSpec[] =>
  columns.filter((c) => c.type === 'string' || c.type === 'number');

/** Normalised severity, used for the level column's styling. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  /** The line exactly as it came off the stream. */
  raw: string;
  /** Display timestamp source, as found in the record (ISO string or epoch). */
  timestamp: string | null;
  /** Level as written in the record, e.g. "WARN". */
  level: string | null;
  /** Normalised level for styling; null when unrecognised. */
  levelClass: LogLevel | null;
  logger: string | null;
  /** The logger as an `abbreviate` column shows it; `logger` keeps the full name. */
  loggerShort: string | null;
  /** journald's PRIORITY, as its syslog name. */
  priority: string | null;
  /** journald's _SYSTEMD_UNIT. */
  unit: string | null;
  message: string;
  /** Java's ECS encoder emits this for a logged throwable. */
  stackTrace: string | null;
  errorType: string | null;
  errorMessage: string | null;
  /** The decoded record, for the expanded view. Null when rendered as plain. */
  record: Record<string, unknown> | null;
  /** Values for the `string`/`number` columns, aligned with extraColumns(). */
  extras: string[];
  /**
   * False when the line is shown as plain text: either the selected format is
   * 'plain', or it is 'json'/'ecs' and the line did not decode (requirement:
   * a line that cannot be read as JSON falls back to plain rather than
   * disappearing).
   */
  structured: boolean;
}

/**
 * Reads one field. ECS is specified as nested objects but the Java, Go and
 * Python encoders all emit the dotted key flat, and some emit a mix, so try
 * the flat key first and then walk the path.
 */
const pick = (record: Record<string, unknown>, path: string): unknown => {
  if (path in record) {
    return record[path];
  }
  let cursor: unknown = record;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const firstString = (
  record: Record<string, unknown>,
  paths: readonly string[],
): string | null => {
  for (const path of paths) {
    const value = pick(record, path);
    if (typeof value === 'string' && value !== '') {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
};

/** `error.stack_trace` is a string, or an array of frames when the Java encoder's `stackTraceAsArray` is on. */
const asStackTrace = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value === '' ? null : value;
  }
  if (Array.isArray(value)) {
    const lines = value.filter((v): v is string => typeof v === 'string');
    return lines.length > 0 ? lines.join('\n') : null;
  }
  return null;
};

// Key aliases for the generic JSON view. ECS deliberately does not use these:
// requirement 3 pins it to @timestamp / log.level / log.logger / message.
const JSON_TIME_KEYS = [
  '@timestamp',
  'timestamp',
  'time',
  'ts',
  'Time',
  'datetime',
  'date',
  'eventTime',
] as const;
const JSON_LEVEL_KEYS = [
  'log.level',
  'level',
  'levelname',
  'severity',
  'SeverityText',
  'loglevel',
  'lvl',
  'levelName',
] as const;
const JSON_LOGGER_KEYS = [
  'log.logger',
  'logger',
  'logger_name',
  'loggerName',
  'channel',
  'category',
  'module',
  'component',
  'name',
] as const;
const JSON_MESSAGE_KEYS = [
  'message',
  'msg',
  'Message',
  'log',
  'text',
  'body',
  'short_message',
] as const;
const JSON_STACK_KEYS = [
  'error.stack_trace',
  'stack_trace',
  'stacktrace',
  'stackTrace',
  'exception',
  'error.stack',
  'stack',
] as const;

const LEVEL_WORDS: Record<string, LogLevel | undefined> = {
  TRACE: 'trace',
  FINEST: 'trace',
  FINER: 'trace',
  VERBOSE: 'trace',
  DEBUG: 'debug',
  FINE: 'debug',
  DBG: 'debug',
  INFO: 'info',
  INFORMATION: 'info',
  NOTICE: 'info',
  CONFIG: 'info',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  ERR: 'error',
  SEVERE: 'error',
  CRIT: 'fatal',
  CRITICAL: 'fatal',
  FATAL: 'fatal',
  ALERT: 'fatal',
  EMERG: 'fatal',
  PANIC: 'fatal',
  DPANIC: 'fatal',
};

/**
 * Numeric levels are ambiguous across ecosystems, but not overlappingly so:
 * syslog severities run 0-7 (ascending = less severe) and pino/bunyan run
 * 10-60 (ascending = more severe), so the magnitude picks the scale.
 */
const normalizeLevel = (value: string | null): LogLevel | null => {
  if (value === null) {
    return null;
  }
  const word = LEVEL_WORDS[value.trim().toUpperCase()];
  if (word) {
    return word;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric <= 7) {
    if (numeric <= 2) return 'fatal';
    if (numeric === 3) return 'error';
    if (numeric === 4) return 'warn';
    if (numeric <= 6) return 'info';
    return 'debug';
  }
  if (numeric <= 10) return 'trace';
  if (numeric <= 20) return 'debug';
  if (numeric <= 30) return 'info';
  if (numeric <= 40) return 'warn';
  if (numeric <= 50) return 'error';
  return 'fatal';
};

const plainEntry = (raw: string): LogEntry => ({
  raw,
  timestamp: null,
  level: null,
  levelClass: null,
  logger: null,
  loggerShort: null,
  priority: null,
  unit: null,
  message: raw,
  stackTrace: null,
  errorType: null,
  errorMessage: null,
  record: null,
  extras: [],
  structured: false,
});

/** Only a JSON *object* is a log record; a bare array or number is not. */
const decodeRecord = (raw: string): Record<string, unknown> | null => {
  const trimmed = raw.trim();
  if (trimmed.charCodeAt(0) !== 123 /* { */) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * journald writes __REALTIME_TIMESTAMP as *microseconds* since the epoch, in
 * a string. Converted to an ISO instant here so everything downstream -- the
 * column, the tooltip, the expanded record -- reads one shape.
 */
const journaldTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  const micros = Number(value);
  if (!Number.isFinite(micros)) {
    return null;
  }
  const date = new Date(Math.floor(micros / 1000));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * MESSAGE is normally a string, but journald emits an array of byte values
 * for anything that is not valid UTF-8 (a process logging raw bytes, a
 * mis-encoded locale). Rendering "[80,65,84,...]" would be useless, so those
 * bytes are decoded.
 */
const journaldMessage = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const bytes = value.filter(
    (byte): byte is number =>
      typeof byte === 'number' && byte >= 0 && byte <= 255,
  );
  if (bytes.length !== value.length) {
    return null;
  }
  try {
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
};

/**
 * journald's PRIORITY is a bare syslog severity number. "6" tells a reader
 * nothing, so the column shows the name journalctl itself uses; the number
 * stays in the expanded record, and in the cell's tooltip.
 *
 * Note this keeps distinctions the styling throws away -- emerg/alert/crit all
 * colour as fatal, notice and info both as info -- which is the point of
 * showing the name rather than the class.
 */
const SYSLOG_NAMES = [
  'EMERG',
  'ALERT',
  'CRIT',
  'ERR',
  'WARNING',
  'NOTICE',
  'INFO',
  'DEBUG',
] as const;

export const syslogLevelName = (priority: string | null): string | null => {
  if (priority === null) {
    return null;
  }
  const value = Number(priority);
  return Number.isInteger(value) && value >= 0 && value < SYSLOG_NAMES.length
    ? SYSLOG_NAMES[value]
    : priority;
};

const journaldEntry = (
  raw: string,
  record: Record<string, unknown>,
): LogEntry => {
  // Kernel and audit entries carry no unit at all, so fall back to whatever
  // does name the source rather than leaving the column blank.
  const unit =
    firstString(record, ['_SYSTEMD_UNIT']) ??
    firstString(record, ['SYSLOG_IDENTIFIER', '_COMM']);

  const priority = firstString(record, ['PRIORITY']);

  return {
    raw,
    timestamp: journaldTimestamp(record.__REALTIME_TIMESTAMP),
    level: syslogLevelName(priority),
    // Classed from the number, not the name, so the syslog scale is read as
    // itself rather than guessed at from a word.
    levelClass: normalizeLevel(priority),
    logger: null,
    loggerShort: null,
    priority,
    unit,
    message: journaldMessage(record.MESSAGE) ?? raw,
    stackTrace: null,
    errorType: null,
    errorMessage: null,
    record,
    extras: [],
    structured: true,
  };
};

const parseDefault = (raw: string, format: LogFormat): LogEntry => {
  if (format === 'plain') {
    return plainEntry(raw);
  }

  const record = decodeRecord(raw);
  if (record === null) {
    // Requirement 2: anything that will not decode is shown as plain text,
    // which is also what keeps non-JSON output (startup banners, a crashing
    // JVM's own stderr) readable in a JSON-formatted stream.
    return plainEntry(raw);
  }

  if (format === 'journald') {
    return journaldEntry(raw, record);
  }

  const ecs = format === 'ecs';
  const timestamp = ecs
    ? firstString(record, ['@timestamp'])
    : firstString(record, JSON_TIME_KEYS);
  const level = ecs
    ? firstString(record, ['log.level'])
    : firstString(record, JSON_LEVEL_KEYS);
  const logger = ecs
    ? firstString(record, ['log.logger'])
    : firstString(record, JSON_LOGGER_KEYS);
  const message = ecs
    ? firstString(record, ['message'])
    : firstString(record, JSON_MESSAGE_KEYS);

  let stackTrace: string | null = null;
  if (ecs) {
    stackTrace = asStackTrace(pick(record, 'error.stack_trace'));
  } else {
    for (const key of JSON_STACK_KEYS) {
      stackTrace = asStackTrace(pick(record, key));
      if (stackTrace !== null) {
        break;
      }
    }
  }

  return {
    raw,
    timestamp,
    level,
    levelClass: normalizeLevel(level),
    logger,
    loggerShort: null,
    priority: null,
    unit: null,
    // A record with no message field at all would otherwise render an empty
    // row; showing the line itself keeps every line legible.
    message: message ?? raw,
    stackTrace,
    errorType: firstString(record, ['error.type']),
    errorMessage: firstString(record, ['error.message']),
    record,
    extras: [],
    structured: true,
  };
};

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** A number, or a string that is entirely one; null for anything else. */
const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
};

/** The value as a display-ready instant, or null when it is not one. */
const asTimestamp = (value: unknown, type: ColumnType): string | null => {
  if (type === 'epoch' || type === 'date/epoch-ms') {
    const numeric = asNumber(value);
    if (numeric === null) {
      return null;
    }
    const date = new Date(type === 'epoch' ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== 'string' || !RFC3339.test(value)) {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
};

/**
 * Every package segment down to its first character, the class name whole.
 * Spread rather than indexed so a segment starting with an astral character
 * is not cut in half.
 */
export const abbreviateLogger = (name: string): string => {
  const segments = name.split('.');
  return segments
    .map((segment, i) =>
      i === segments.length - 1 ? segment : (Array.from(segment)[0] ?? ''),
    )
    .join('.');
};

const asText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
};

/**
 * Applies an annotation's columns over a decoded entry. Each is a per-column
 * override: a field that is missing, or does not read as its declared type,
 * leaves the default lookup's answer in place rather than blanking the cell.
 * Where several columns feed the same slot (two date fields, say) the first
 * that reads wins, which makes the list double as "try this key, then that
 * one".
 */
const applyColumns = (
  entry: LogEntry,
  record: Record<string, unknown>,
  columns: readonly ColumnSpec[],
): LogEntry => {
  let { timestamp, level, levelClass } = entry;
  let timeSet = false;
  let levelSet = false;
  let loggerShort = entry.loggerShort;
  let loggerSet = false;
  const extras: string[] = [];

  for (const { key, type } of columns) {
    const value = pick(record, key);
    switch (type) {
      case 'date/rfc3339':
      case 'date/rfc3339nano':
      case 'date/epoch-ms':
      case 'epoch': {
        const parsed = timeSet ? null : asTimestamp(value, type);
        if (parsed !== null) {
          timestamp = parsed;
          timeSet = true;
        }
        break;
      }
      case 'log-level': {
        const text =
          levelSet || typeof value === 'object'
            ? null
            : firstString({ value }, ['value']);
        if (text !== null) {
          level = text;
          levelClass = normalizeLevel(text);
          levelSet = true;
        }
        break;
      }
      case 'abbreviate': {
        const text = loggerSet ? null : firstString({ value }, ['value']);
        if (text !== null) {
          loggerShort = abbreviateLogger(text);
          loggerSet = true;
        }
        break;
      }
      case 'number': {
        const numeric = asNumber(value);
        extras.push(numeric === null ? '' : String(numeric));
        break;
      }
      case 'string':
        extras.push(asText(value));
        break;
    }
  }

  return { ...entry, timestamp, level, levelClass, loggerShort, extras };
};

export const parseLine = (
  raw: string,
  format: LogFormat,
  columns: readonly ColumnSpec[] = [],
): LogEntry => {
  const entry = parseDefault(raw, format);
  // `record` is non-null exactly when the line decoded, so a plain line, or a
  // JSON view's undecodable one, has nothing for a column to read.
  return entry.record === null || columns.length === 0
    ? entry
    : applyColumns(entry, entry.record, columns);
};

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, '0');

/**
 * Time of day in local time. Deliberately not the date: a 100k-line buffer is
 * usually minutes of one service, and the column has to stay narrow. The full
 * value as written stays available in the cell's tooltip and in the expanded
 * record.
 */
export const formatTimestamp = (value: string | null): string => {
  if (value === null) {
    return '';
  }
  const numeric = Number(value);
  const date = new Date(
    Number.isFinite(numeric) && /^\d+$/.test(value.trim()) ? numeric : value,
  );
  if (Number.isNaN(date.getTime())) {
    return value.length > 12 ? `${value.slice(0, 12)}…` : value;
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}.${pad(date.getMilliseconds(), 3)}`;
};

/**
 * Date and time, for logs that span days -- a node journal reaches back as far
 * as the node has been up, so time of day alone is ambiguous. The full ISO
 * instant stays in the cell's tooltip and in the expanded record.
 */
export const formatTimestampWithDate = (value: string | null): string => {
  if (value === null) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return formatTimestamp(value);
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatTimestamp(
    value,
  )}`;
};

/**
 * Picks the format to start a pod's log view in, from the first lines that
 * arrive. Only ever the *initial* value: once the reader chooses a format
 * explicitly that choice is remembered and this is not consulted again.
 *
 * Every line is looked at rather than just the first, because a JSON-logging
 * process almost always writes something else first -- a JVM's
 * "Picked up JAVA_TOOL_OPTIONS", a framework banner, a runtime warning on
 * stderr -- and keying on line one alone would land every such container in
 * the plain view. A single structured line among them is enough to say what
 * the log is; those banner lines then fall back to plain individually
 * (see parseLine), which is where they belong.
 */
export const sniffFormat = (lines: readonly string[]): LogFormat => {
  let sawJson = false;
  for (const line of lines) {
    const record = decodeRecord(line);
    if (record === null) {
      continue;
    }
    // "@timestamp plus a dotted log.* key" is what distinguishes ECS from any
    // other JSON logger; `message` alone is far too common to key on.
    const isEcs =
      pick(record, '@timestamp') !== undefined &&
      (pick(record, 'log.level') !== undefined ||
        pick(record, 'log.logger') !== undefined ||
        pick(record, 'ecs.version') !== undefined);
    if (isEcs) {
      return 'ecs';
    }
    sawJson = true;
  }
  return sawJson ? 'json' : 'plain';
};

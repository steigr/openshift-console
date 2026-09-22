/**
 * Turns one raw log line into the four columns the viewer renders. Called
 * from the row renderer for mounted rows only -- see ./buffer.ts for why
 * nothing here runs over the whole stream.
 */

export type LogFormat = 'plain' | 'json' | 'ecs';

export const LOG_FORMATS: LogFormat[] = ['plain', 'json', 'ecs'];

export const isLogFormat = (value: unknown): value is LogFormat =>
  typeof value === 'string' && (LOG_FORMATS as string[]).includes(value);

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
  message: string;
  /** Java's ECS encoder emits this for a logged throwable. */
  stackTrace: string | null;
  errorType: string | null;
  errorMessage: string | null;
  /** The decoded record, for the expanded view. Null when rendered as plain. */
  record: Record<string, unknown> | null;
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
  message: raw,
  stackTrace: null,
  errorType: null,
  errorMessage: null,
  record: null,
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

export const parseLine = (raw: string, format: LogFormat): LogEntry => {
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
    // A record with no message field at all would otherwise render an empty
    // row; showing the line itself keeps every line legible.
    message: message ?? raw,
    stackTrace,
    errorType: firstString(record, ['error.type']),
    errorMessage: firstString(record, ['error.message']),
    record,
    structured: true,
  };
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

/*
 * The time zone terminal sessions run in: console's own time zone preference
 * (User Preferences -> Language, patches/0039-time-zone.patch), which console
 * mirrors into localStorage and which defaults to the browser's own zone. A
 * shell otherwise runs in its container's or node's zone, usually UTC.
 *
 * A session gets it two ways, because a container image may not ship tzdata:
 * the IANA name (proper abbreviations and historical rules) where
 * /usr/share/zoneinfo has it, and otherwise a POSIX TZ string derived here
 * from the zone's rules for the current year, which libc understands without
 * any data files.
 */

export const TIME_ZONE_STORAGE_KEY = 'bridge/time-zone';

export interface SessionTimeZone {
  /** IANA name, e.g. "Europe/Berlin". */
  name: string;
  /** POSIX TZ string, e.g. "<+01>-1<+02>-2,M3.5.0/2,M10.5.0/3". */
  posix: string;
}

// Shapes the node-terminal shim accepts too (timezone_valid_iana/_posix):
// anything else is never put into a command line or an environment.
const IANA_PATTERN = /^(?![.-])[A-Za-z0-9_+-]+(\/(?![.-])[A-Za-z0-9_+-]+)*$/;
const POSIX_PATTERN = /^[A-Za-z0-9<>+\-:,./]+$/;

export const isValidTimeZoneName = (name: string): boolean =>
  name.length <= 64 && IANA_PATTERN.test(name);

const isSupportedTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Minutes the zone is ahead of UTC at `time`. */
const offsetAt = (formatter: Intl.DateTimeFormat, time: number): number => {
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  formatter.formatToParts(time).forEach(({ type, value }) => {
    part[type] = Number(value);
  });
  const local = Date.UTC(
    part.year ?? 0,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    (part.hour ?? 0) % 24,
    part.minute ?? 0,
    part.second ?? 0,
  );
  return Math.round((local - Math.floor(time / 1000) * 1000) / MINUTE);
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "<+0530>": the quoted abbreviation form, for zones without a letter one. */
const posixName = (offset: number): string => {
  const abs = Math.abs(offset);
  const minutes = abs % 60;
  return `<${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${minutes ? pad(minutes) : ''}>`;
};

/** POSIX offsets count west of UTC: +01:00 is "-1", -05:00 is "5". */
const posixOffset = (offset: number): string => {
  const abs = Math.abs(offset);
  const minutes = abs % 60;
  return `${offset > 0 ? '-' : ''}${String(Math.floor(abs / 60))}${minutes ? `:${pad(minutes)}` : ''}`;
};

interface Transition {
  at: number;
  from: number;
  to: number;
}

/** "M3.5.0/2": month, week (5 = last), weekday, and the wall-clock time it happens at. */
const posixRule = ({ at, from }: Transition): string => {
  const wall = new Date(at + from * MINUTE);
  const day = wall.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const week = day + 7 > daysInMonth ? 5 : Math.ceil(day / 7);
  const minutes = wall.getUTCMinutes();
  return `M${String(wall.getUTCMonth() + 1)}.${String(week)}.${String(wall.getUTCDay())}/${String(
    wall.getUTCHours(),
  )}${minutes ? `:${pad(minutes)}` : ''}`;
};

/**
 * The zone's rules for `year` as a POSIX TZ string. A zone without daylight
 * saving time that year is a fixed offset; one whose rules do not fit POSIX's
 * two yearly transitions gets the offset in effect at `now`.
 */
export const posixTimeZone = (timeZone: string, now: Date = new Date()): string => {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') {
    return 'UTC0';
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);

  const transitions: Transition[] = [];
  let previous = offsetAt(formatter, start);
  for (let day = start; day < end; day += DAY) {
    const next = offsetAt(formatter, day + DAY);
    if (next !== previous) {
      // narrow the change down to the minute
      let low = day;
      let high = day + DAY;
      while (high - low > MINUTE) {
        const mid = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
        if (offsetAt(formatter, mid) === previous) {
          low = mid;
        } else {
          high = mid;
        }
      }
      transitions.push({ at: high, from: previous, to: next });
      previous = next;
    }
  }

  const fixed = (offset: number) => `${posixName(offset)}${posixOffset(offset)}`;
  if (transitions.length !== 2) {
    return fixed(offsetAt(formatter, now.getTime()));
  }
  const standard = Math.min(transitions[0].from, transitions[0].to);
  const daylight = Math.max(transitions[0].from, transitions[0].to);
  const toDaylight = transitions.find((t) => t.to === daylight);
  const toStandard = transitions.find((t) => t.to === standard);
  if (!toDaylight || !toStandard) {
    return fixed(offsetAt(formatter, now.getTime()));
  }
  return `${fixed(standard)}${fixed(daylight)},${posixRule(toDaylight)},${posixRule(toStandard)}`;
};

/** Console's preferred time zone, or the browser's own. */
export const preferredTimeZone = (): string => {
  let preference: string | null = null;
  try {
    preference = window.localStorage.getItem(TIME_ZONE_STORAGE_KEY);
  } catch {
    // storage unavailable
  }
  return preference && preference !== 'browser' && isSupportedTimeZone(preference)
    ? preference
    : new Intl.DateTimeFormat().resolvedOptions().timeZone;
};

/** The session's time zone, or null when it cannot be expressed safely. */
export const sessionTimeZone = (): SessionTimeZone | null => {
  try {
    const name = preferredTimeZone();
    const posix = posixTimeZone(name);
    return isValidTimeZoneName(name) && POSIX_PATTERN.test(posix) ? { name, posix } : null;
  } catch {
    return null;
  }
};

/**
 * Shell code that sets TZ for what follows it: the IANA name where the
 * container has it, the POSIX string otherwise. Empty without a time zone.
 * Both values are checked against their patterns above, so neither can
 * carry quotes or shell syntax.
 */
export const shellTimeZonePrefix = (timeZone: SessionTimeZone | null): string =>
  timeZone
    ? `if [ -e /usr/share/zoneinfo/${timeZone.name} ]; then TZ=${timeZone.name}; else TZ='${timeZone.posix}'; fi; export TZ; `
    : '';

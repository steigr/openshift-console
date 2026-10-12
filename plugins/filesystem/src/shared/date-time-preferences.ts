/*
 * Console's date and time preferences (User Preferences -> Language): a regional format, a
 * 12/24-hour clock and a time zone. Console mirrors them into localStorage for its own
 * formatters (steigr/openshift-console patches 0037/0039), and a plugin runs in console's
 * window, so it reads the same keys rather than depending on console internals. Kept in step
 * with console's own `getDateTimeLocale.ts` and `datetime.ts`; the same file lives in each of
 * this repo's plugins that formats dates itself.
 */

const LANGUAGE_KEY = 'bridge/last-language';
const DATE_TIME_LOCALE_KEY = 'bridge/date-time-locale';
const HOUR_CYCLE_KEY = 'bridge/hour-cycle';
const TIME_ZONE_KEY = 'bridge/time-zone';

const getItem = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const supportedLocales = new Map<string, boolean>();
const isSupportedLocale = (locale: string): boolean => {
  if (!supportedLocales.has(locale)) {
    try {
      supportedLocales.set(locale, Intl.DateTimeFormat.supportedLocalesOf(locale).length > 0);
    } catch {
      supportedLocales.set(locale, false);
    }
  }
  return supportedLocales.get(locale) ?? false;
};

const supportedTimeZones = new Map<string, boolean>();
const isSupportedTimeZone = (timeZone: string): boolean => {
  if (!supportedTimeZones.has(timeZone)) {
    try {
      new Intl.DateTimeFormat('en', { timeZone });
      supportedTimeZones.set(timeZone, true);
    } catch {
      supportedTimeZones.set(timeZone, false);
    }
  }
  return supportedTimeZones.get(timeZone) ?? false;
};

/** The console language, as console itself stores it. */
export const getConsoleLanguage = (): string => getItem(LANGUAGE_KEY) || navigator.language;

/**
 * The locale dates and times are formatted in: the chosen regional format, the browser's own
 * ("browser"), or else the console language -- `language` where the caller already knows it.
 */
export const getDateTimeLocale = (language?: string): string | undefined => {
  const preference = getItem(DATE_TIME_LOCALE_KEY);
  if (preference === 'browser') {
    return undefined;
  }
  if (preference && preference !== 'language' && isSupportedLocale(preference)) {
    return preference;
  }
  return language || getConsoleLanguage();
};

/** The hour cycle forced on times, or undefined for the locale's own. */
export const getHourCycle = (): 'h12' | 'h23' | undefined => {
  const preference = getItem(HOUR_CYCLE_KEY);
  return preference === 'h12' || preference === 'h23' ? preference : undefined;
};

/** The chosen time zone, or undefined for the browser's own (the default). */
export const getTimeZone = (): string | undefined => {
  const preference = getItem(TIME_ZONE_KEY);
  return preference && preference !== 'browser' && isSupportedTimeZone(preference)
    ? preference
    : undefined;
};

/** `options` with the hour cycle (for times) and time zone (unless `options` fixes one) applied. */
export const withDateTimePreferences = (
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormatOptions => {
  const hourCycle = options.hour ? getHourCycle() : undefined;
  const timeZone = options.timeZone ? undefined : getTimeZone();
  return {
    ...options,
    ...(hourCycle && { hourCycle }),
    ...(timeZone && { timeZone }),
  };
};

export type LazyDateTimeFormatter = Pick<
  Intl.DateTimeFormat,
  'format' | 'formatToParts' | 'resolvedOptions'
> & {
  /** The Intl.DateTimeFormat for the current preferences. */
  get: (language?: string) => Intl.DateTimeFormat;
};

/**
 * A formatter for `options` that applies the preferences when used rather than when created,
 * so a change applies without a reload. `format` is an arrow function, since callers pass it
 * around unbound (a chart's `tickFormat`), as Intl's own getter allows.
 */
export const lazyDateTimeFormatter = (
  options: Intl.DateTimeFormatOptions,
): LazyDateTimeFormatter => {
  let cached: { key: string; formatter: Intl.DateTimeFormat } | undefined;
  const get = (language?: string): Intl.DateTimeFormat => {
    const locale = getDateTimeLocale(language);
    const resolved = withDateTimePreferences(options);
    const key = `${locale ?? ''}|${resolved.hourCycle ?? ''}|${resolved.timeZone ?? ''}`;
    if (cached?.key !== key) {
      let formatter: Intl.DateTimeFormat;
      try {
        formatter = new Intl.DateTimeFormat(locale, resolved);
      } catch {
        formatter = new Intl.DateTimeFormat(language || getConsoleLanguage(), options);
      }
      cached = { key, formatter };
    }
    return cached.formatter;
  };
  return {
    format: (date?: Date | number) => get().format(date),
    formatToParts: (date?: Date | number) => get().formatToParts(date),
    resolvedOptions: () => get().resolvedOptions(),
    get,
  };
};

/** Wall-clock fields of an instant; `month` is 1-based. */
export type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const wallClockIn = (time: number, timeZone: string): WallClock => {
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
    .formatToParts(time)
    .forEach(({ type, value }) => {
      part[type] = Number(value);
    });
  return {
    year: part.year ?? 0,
    month: part.month ?? 1,
    day: part.day ?? 1,
    hour: (part.hour ?? 0) % 24,
    minute: part.minute ?? 0,
    second: part.second ?? 0,
  };
};

/**
 * The wall clock `date` shows in the chosen time zone (the browser's by default) -- what a
 * date/time input should show for it.
 */
export const toWallClock = (date: Date): WallClock => {
  const timeZone = getTimeZone();
  return timeZone
    ? wallClockIn(date.getTime(), timeZone)
    : {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
      };
};

/**
 * The instant a wall clock in the chosen time zone (the browser's by default) denotes -- what a
 * date/time input's value means. NaN when the fields do not name a real time there (Feb 30, or
 * a time skipped by a daylight saving change).
 */
export const fromWallClock = ({ year, month, day, hour, minute, second }: WallClock): number => {
  const timeZone = getTimeZone();
  if (!timeZone) {
    const date = new Date(year, month - 1, day, hour, minute, second);
    date.setFullYear(year);
    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day &&
      date.getHours() === hour &&
      date.getMinutes() === minute &&
      date.getSeconds() === second
      ? date.getTime()
      : NaN;
  }
  const asUTC = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  asUTC.setUTCFullYear(year);
  // The zone's offset is the gap between a guess and the wall clock it shows; two rounds settle
  // it even next to a daylight saving change.
  let time = asUTC.getTime();
  for (let i = 0; i < 2; i++) {
    const shown = wallClockIn(time, timeZone);
    const shownAsUTC = new Date(
      Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second),
    );
    shownAsUTC.setUTCFullYear(shown.year);
    time += asUTC.getTime() - shownAsUTC.getTime();
  }
  const check = wallClockIn(time, timeZone);
  return check.year === year &&
    check.month === month &&
    check.day === day &&
    check.hour === hour &&
    check.minute === minute &&
    check.second === second
    ? time
    : NaN;
};

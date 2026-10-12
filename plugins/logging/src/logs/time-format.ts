import { useEffect, useState } from 'react';
import type { DateFormatter, TimestampFormat } from './parse';

/*
 * Console's date and time format preferences (User Preferences -> Language),
 * as console itself mirrors them into localStorage for its own formatters
 * (patches/0037-date-time-format.patch, 0039-time-zone.patch). The plugin runs
 * in console's window, so it reads the same keys rather than depending on
 * console internals.
 */
export const DATE_TIME_LOCALE_STORAGE_KEY = 'bridge/date-time-locale';
export const HOUR_CYCLE_STORAGE_KEY = 'bridge/hour-cycle';
export const LANGUAGE_STORAGE_KEY = 'bridge/last-language';
export const TIME_ZONE_STORAGE_KEY = 'bridge/time-zone';
/** Dispatched by console on `window` when either preference changes. */
export const DATE_TIME_FORMAT_CHANGE_EVENT = 'console:date-time-format-change';

const getItem = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** The chosen time zone, or undefined for the browser's own (the default). */
export const timeZoneFromPreference = (): string | undefined => {
  const timeZone = getItem(TIME_ZONE_STORAGE_KEY);
  return timeZone && timeZone !== 'browser' && isValidTimeZone(timeZone)
    ? timeZone
    : undefined;
};

/**
 * The compact `20:01:02.345` / `09-22 20:01:02.345` of the default column, in
 * `timeZone` -- what a chosen time zone without a chosen format gets.
 */
const compactFormat = (timeZone: string): TimestampFormat => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
    timeZone,
  });
  const parts = (date: Date) => {
    const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    formatter.formatToParts(date).forEach(({ type, value }) => {
      part[type] = value;
    });
    return part;
  };
  const time = (date: Date) => {
    const p = parts(date);
    return `${p.hour ?? ''}:${p.minute ?? ''}:${p.second ?? ''}.${p.fractionalSecond ?? ''}`;
  };
  return {
    time: { format: time },
    dateTime: {
      format: (date: Date) => {
        const p = parts(date);
        return `${p.month ?? ''}-${p.day ?? ''} ${time(date)}`;
      },
    },
  };
};

/**
 * The time column's format, or null for the compact 24-hour default in the
 * browser's time zone.
 *
 * A format applies only once explicitly chosen: a log's time column is a
 * narrow, fixed-width column of milliseconds, so "same as language" -- which
 * for English would mean "08:01:02.345 PM" -- keeps the default it has always
 * had. A chosen time zone applies either way.
 */
export const timestampFormatFromPreference = (): TimestampFormat | null => {
  const locale = getItem(DATE_TIME_LOCALE_STORAGE_KEY);
  const storedHourCycle = getItem(HOUR_CYCLE_STORAGE_KEY);
  const hourCycle =
    storedHourCycle === 'h12' || storedHourCycle === 'h23'
      ? storedHourCycle
      : undefined;
  const timeZone = timeZoneFromPreference();
  const ownLocale = locale !== null && locale !== '' && locale !== 'language';
  if (!ownLocale && hourCycle === undefined) {
    return timeZone === undefined ? null : compactFormat(timeZone);
  }
  // "browser" is whatever Intl resolves to when given no locale at all.
  const resolved =
    locale === 'browser'
      ? undefined
      : ownLocale
        ? locale
        : (getItem(LANGUAGE_STORAGE_KEY) ?? navigator.language);
  const time: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    ...(hourCycle && { hourCycle }),
    ...(timeZone && { timeZone }),
  };
  try {
    return {
      time: new Intl.DateTimeFormat(resolved, time),
      dateTime: new Intl.DateTimeFormat(resolved, {
        month: '2-digit',
        day: '2-digit',
        ...time,
      }),
    };
  } catch {
    // a malformed tag; console falls back to the language, the column to its default
    return timeZone === undefined ? null : compactFormat(timeZone);
  }
};

/** Approximate width in `ch` of the mono font: CJK and similar count double. */
const displayWidth = (text: string): number =>
  Array.from(text).reduce(
    (width, char) => width + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1),
    0,
  );

/**
 * Width of the time column for `formatter`, measured on its widest output:
 * two-digit month, day and hour, in the morning and the evening, since day
 * periods differ in length.
 */
export const timestampColumnWidth = (formatter: DateFormatter): string => {
  const widest = Math.max(
    ...[10, 22].map((hour) =>
      displayWidth(formatter.format(new Date(2026, 11, 28, hour, 58, 58, 888))),
    ),
  );
  return `${String(widest + 1)}ch`;
};

/**
 * The preference as the viewer renders it, following changes made in this
 * window (console's own event) and in other tabs (`storage`).
 */
export const useTimestampFormat = (): TimestampFormat | null => {
  const [format, setFormat] = useState(timestampFormatFromPreference);
  useEffect(() => {
    const update = () => {
      setFormat(timestampFormatFromPreference());
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === DATE_TIME_LOCALE_STORAGE_KEY ||
        event.key === HOUR_CYCLE_STORAGE_KEY ||
        event.key === TIME_ZONE_STORAGE_KEY ||
        event.key === LANGUAGE_STORAGE_KEY
      ) {
        update();
      }
    };
    window.addEventListener(DATE_TIME_FORMAT_CHANGE_EVENT, update);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DATE_TIME_FORMAT_CHANGE_EVENT, update);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return format;
};

import { useEffect, useState } from 'react';
import type { TimestampFormat } from './parse';

/*
 * Console's date and time format preferences (User Preferences -> Language),
 * as console itself mirrors them into localStorage for its own formatters
 * (patches/0037-date-time-format.patch). The plugin runs in console's window,
 * so it reads the same keys rather than depending on console internals.
 */
export const DATE_TIME_LOCALE_STORAGE_KEY = 'bridge/date-time-locale';
export const HOUR_CYCLE_STORAGE_KEY = 'bridge/hour-cycle';
export const LANGUAGE_STORAGE_KEY = 'bridge/last-language';
/** Dispatched by console on `window` when either preference changes. */
export const DATE_TIME_FORMAT_CHANGE_EVENT = 'console:date-time-format-change';

const getItem = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * The time column's format, or null for the compact 24-hour default.
 *
 * Only an explicit choice applies: a log's time column is a narrow, fixed-width
 * column of milliseconds, so "same as language" -- which for English would
 * mean "08:01:02.345 PM" -- keeps the default it has always had.
 */
export const timestampFormatFromPreference = (): TimestampFormat | null => {
  const locale = getItem(DATE_TIME_LOCALE_STORAGE_KEY);
  const storedHourCycle = getItem(HOUR_CYCLE_STORAGE_KEY);
  const hourCycle =
    storedHourCycle === 'h12' || storedHourCycle === 'h23'
      ? storedHourCycle
      : undefined;
  const ownLocale = locale !== null && locale !== '' && locale !== 'language';
  if (!ownLocale && hourCycle === undefined) {
    return null;
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
    return null;
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
export const timestampColumnWidth = (
  formatter: Intl.DateTimeFormat,
): string => {
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

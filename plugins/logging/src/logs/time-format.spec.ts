import { act, renderHook } from '@testing-library/react';

import { formatTimestamp, formatTimestampWithDate } from './parse';
import {
  DATE_TIME_FORMAT_CHANGE_EVENT,
  DATE_TIME_LOCALE_STORAGE_KEY,
  HOUR_CYCLE_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  TIME_ZONE_STORAGE_KEY,
  timestampColumnWidth,
  timestampFormatFromPreference,
  useTimestampFormat,
} from './time-format';

const iso = new Date(2026, 8, 22, 20, 1, 2, 345).toISOString();

describe('timestampFormatFromPreference', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('keeps the compact default without an explicit choice', () => {
    expect(timestampFormatFromPreference()).toBeNull();
    localStorage.setItem(DATE_TIME_LOCALE_STORAGE_KEY, 'language');
    localStorage.setItem(HOUR_CYCLE_STORAGE_KEY, 'auto');
    expect(timestampFormatFromPreference()).toBeNull();
    expect(formatTimestamp(iso, timestampFormatFromPreference())).toBe(
      '20:01:02.345',
    );
  });

  it('formats in a chosen regional format', () => {
    localStorage.setItem(DATE_TIME_LOCALE_STORAGE_KEY, 'de-DE');
    const format = timestampFormatFromPreference();
    expect(formatTimestamp(iso, format)).toBe('20:01:02,345');
    expect(formatTimestampWithDate(iso, format)).toBe('22.09., 20:01:02,345');
  });

  it('applies a 12-hour clock in the console language', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    localStorage.setItem(HOUR_CYCLE_STORAGE_KEY, 'h12');
    expect(formatTimestamp(iso, timestampFormatFromPreference())).toBe(
      '08:01:02.345 PM',
    );
  });

  it('keeps the compact format in a chosen time zone', () => {
    const instant = new Date(
      Date.UTC(2026, 8, 22, 20, 1, 2, 345),
    ).toISOString();
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'Asia/Tokyo');
    const format = timestampFormatFromPreference();
    expect(formatTimestamp(instant, format)).toBe('05:01:02.345');
    expect(formatTimestampWithDate(instant, format)).toBe('09-23 05:01:02.345');
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'browser');
    expect(timestampFormatFromPreference()).toBeNull();
  });

  it('applies a chosen time zone to a chosen format', () => {
    const instant = new Date(
      Date.UTC(2026, 8, 22, 20, 1, 2, 345),
    ).toISOString();
    localStorage.setItem(DATE_TIME_LOCALE_STORAGE_KEY, 'de-DE');
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'UTC');
    expect(formatTimestamp(instant, timestampFormatFromPreference())).toBe(
      '20:01:02,345',
    );
  });

  it('ignores an unknown time zone', () => {
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'Mars/Olympus_Mons');
    expect(timestampFormatFromPreference()).toBeNull();
  });

  it('falls back to the default for a malformed locale', () => {
    localStorage.setItem(DATE_TIME_LOCALE_STORAGE_KEY, 'not a locale!');
    expect(timestampFormatFromPreference()).toBeNull();
  });
});

describe('timestampColumnWidth', () => {
  it('fits the widest output', () => {
    const format = new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h12',
    });
    // "10:58:58.888 PM"
    expect(timestampColumnWidth(format)).toBe('16ch');
  });
});

describe('useTimestampFormat', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("follows console's change event", () => {
    const { result } = renderHook(() => useTimestampFormat());
    expect(result.current).toBeNull();
    act(() => {
      localStorage.setItem(HOUR_CYCLE_STORAGE_KEY, 'h23');
      window.dispatchEvent(new Event(DATE_TIME_FORMAT_CHANGE_EVENT));
    });
    expect(result.current).not.toBeNull();
  });
});

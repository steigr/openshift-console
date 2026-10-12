import {
  fromWallClock,
  getDateTimeLocale,
  getHourCycle,
  getTimeZone,
  lazyDateTimeFormatter,
  toWallClock,
} from '../date-time-preferences';

// Some plugins test in a plain node environment: give it the one browser API this reads.
if (typeof localStorage === 'undefined') {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
  const win = typeof window === 'undefined' ? {} : window;
  Object.assign(win, { localStorage: storage });
  Object.assign(globalThis, { window: win, localStorage: storage });
}

// 2021-04-23 16:33:00 UTC
const instant = new Date(Date.UTC(2021, 3, 23, 16, 33));

describe('date-time-preferences', () => {
  beforeEach(() => {
    localStorage.setItem('bridge/last-language', 'en');
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('follows the console language until a regional format is chosen', () => {
    expect(getDateTimeLocale()).toBe('en');
    expect(getDateTimeLocale('fr')).toBe('fr');
    localStorage.setItem('bridge/date-time-locale', 'de-DE');
    expect(getDateTimeLocale('fr')).toBe('de-DE');
    localStorage.setItem('bridge/date-time-locale', 'browser');
    expect(getDateTimeLocale()).toBeUndefined();
    localStorage.setItem('bridge/date-time-locale', 'not a locale!');
    expect(getDateTimeLocale()).toBe('en');
  });

  it('reads the hour cycle and time zone, ignoring anything else', () => {
    expect(getHourCycle()).toBeUndefined();
    expect(getTimeZone()).toBeUndefined();
    localStorage.setItem('bridge/hour-cycle', 'h23');
    localStorage.setItem('bridge/time-zone', 'Asia/Tokyo');
    expect(getHourCycle()).toBe('h23');
    expect(getTimeZone()).toBe('Asia/Tokyo');
    localStorage.setItem('bridge/hour-cycle', 'auto');
    localStorage.setItem('bridge/time-zone', 'Mars/Olympus_Mons');
    expect(getHourCycle()).toBeUndefined();
    expect(getTimeZone()).toBeUndefined();
  });

  it('formats with the preferences in effect at the time of the call', () => {
    const formatter = lazyDateTimeFormatter({ hour: 'numeric', minute: 'numeric' });
    const { format } = formatter; // passed around unbound, e.g. as a tickFormat
    localStorage.setItem('bridge/time-zone', 'UTC');
    expect(format(instant)).toBe('4:33 PM');
    localStorage.setItem('bridge/hour-cycle', 'h23');
    localStorage.setItem('bridge/time-zone', 'Asia/Tokyo');
    expect(format(instant)).toBe('01:33');
    localStorage.setItem('bridge/date-time-locale', 'de-DE');
    localStorage.setItem('bridge/time-zone', 'Europe/Berlin');
    expect(lazyDateTimeFormatter({ day: 'numeric', month: 'short' }).format(instant)).toBe(
      '23. Apr.',
    );
    expect(format(instant)).toBe('18:33');
  });

  it('never moves a formatter that fixes its own time zone', () => {
    localStorage.setItem('bridge/time-zone', 'Asia/Tokyo');
    expect(
      lazyDateTimeFormatter({ hour: 'numeric', hourCycle: 'h23', timeZone: 'UTC' }).format(instant),
    ).toBe('16');
  });

  it('converts between instants and wall clocks in the chosen zone', () => {
    localStorage.setItem('bridge/time-zone', 'America/New_York');
    expect(toWallClock(instant)).toEqual({
      year: 2021,
      month: 4,
      day: 23,
      hour: 12,
      minute: 33,
      second: 0,
    });
    expect(fromWallClock({ year: 2021, month: 4, day: 23, hour: 12, minute: 33, second: 0 })).toBe(
      instant.getTime(),
    );
    // 02:30 does not exist on the day New York springs forward
    expect(fromWallClock({ year: 2021, month: 3, day: 14, hour: 2, minute: 30, second: 0 })).toBeNaN();
    expect(fromWallClock({ year: 2021, month: 2, day: 30, hour: 0, minute: 0, second: 0 })).toBeNaN();
  });

  it("uses the browser's own zone without a preference", () => {
    const local = new Date(2021, 3, 23, 16, 33, 5);
    expect(toWallClock(local)).toEqual({
      year: 2021,
      month: 4,
      day: 23,
      hour: 16,
      minute: 33,
      second: 5,
    });
    expect(fromWallClock(toWallClock(local))).toBe(local.getTime());
  });
});

import {
  posixTimeZone,
  preferredTimeZone,
  sessionTimeZone,
  shellTimeZonePrefix,
  TIME_ZONE_STORAGE_KEY,
} from '../timeZone';

const in2026 = new Date(Date.UTC(2026, 5, 1));

describe('posixTimeZone', () => {
  it('derives daylight saving rules', () => {
    expect(posixTimeZone('Europe/Berlin', in2026)).toBe('<+01>-1<+02>-2,M3.5.0/2,M10.5.0/3');
    expect(posixTimeZone('America/New_York', in2026)).toBe('<-05>5<-04>4,M3.2.0/2,M11.1.0/2');
    // southern hemisphere: daylight saving time spans the turn of the year
    expect(posixTimeZone('Australia/Sydney', in2026)).toBe(
      '<+10>-10<+11>-11,M10.1.0/2,M4.1.0/3',
    );
  });

  it('writes fixed offsets, including fractional ones', () => {
    expect(posixTimeZone('Asia/Kolkata', in2026)).toBe('<+0530>-5:30');
    expect(posixTimeZone('Asia/Tokyo', in2026)).toBe('<+09>-9');
    expect(posixTimeZone('UTC', in2026)).toBe('UTC0');
  });
});

describe('sessionTimeZone', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("follows console's preference, else the browser's zone", () => {
    expect(preferredTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'browser');
    expect(preferredTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'Asia/Tokyo');
    expect(sessionTimeZone()).toEqual({ name: 'Asia/Tokyo', posix: '<+09>-9' });
    localStorage.setItem(TIME_ZONE_STORAGE_KEY, 'Mars/Olympus_Mons');
    expect(preferredTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('shellTimeZonePrefix', () => {
  it('prefers the container’s tzdata and falls back to the POSIX rules', () => {
    expect(shellTimeZonePrefix({ name: 'Asia/Tokyo', posix: '<+09>-9' })).toBe(
      "if [ -e /usr/share/zoneinfo/Asia/Tokyo ]; then TZ=Asia/Tokyo; else TZ='<+09>-9'; fi; export TZ; ",
    );
    expect(shellTimeZonePrefix(null)).toBe('');
  });
});

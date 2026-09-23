import {
  formatTimestamp,
  formatTimestampWithDate,
  parseLine,
  sniffFormat,
} from './parse';

describe('parseLine', () => {
  it('leaves a plain line alone', () => {
    const entry = parseLine('just some output', 'plain');
    expect(entry.message).toBe('just some output');
    expect(entry.structured).toBe(false);
    expect(entry.record).toBeNull();
  });

  it('reads the four ECS columns from flat dotted keys', () => {
    const raw = JSON.stringify({
      '@timestamp': '2026-09-22T20:01:02.345Z',
      'log.level': 'WARN',
      'log.logger': 'com.example.Service',
      message: 'disk nearly full',
      'service.name': 'checkout',
    });
    const entry = parseLine(raw, 'ecs');

    expect(entry.timestamp).toBe('2026-09-22T20:01:02.345Z');
    expect(entry.level).toBe('WARN');
    expect(entry.levelClass).toBe('warn');
    expect(entry.logger).toBe('com.example.Service');
    expect(entry.message).toBe('disk nearly full');
    expect(entry.structured).toBe(true);
  });

  it('reads the same columns from nested ECS objects', () => {
    const raw = JSON.stringify({
      '@timestamp': '2026-09-22T20:01:02.345Z',
      log: { level: 'ERROR', logger: 'nested.Logger' },
      message: 'boom',
    });
    const entry = parseLine(raw, 'ecs');

    expect(entry.level).toBe('ERROR');
    expect(entry.logger).toBe('nested.Logger');
  });

  it('falls back to plain when the line is not JSON', () => {
    const entry = parseLine('Picked up JAVA_TOOL_OPTIONS: -Xmx512m', 'ecs');
    expect(entry.structured).toBe(false);
    expect(entry.message).toBe('Picked up JAVA_TOOL_OPTIONS: -Xmx512m');
    expect(entry.record).toBeNull();
  });

  it('falls back to plain on truncated JSON', () => {
    const entry = parseLine('{"message":"cut off in the mi', 'json');
    expect(entry.structured).toBe(false);
    expect(entry.message).toBe('{"message":"cut off in the mi');
  });

  it('does not treat a bare JSON array or scalar as a record', () => {
    expect(parseLine('[1,2,3]', 'json').structured).toBe(false);
    expect(parseLine('42', 'json').structured).toBe(false);
  });

  it('shows the whole line when a record has no message field', () => {
    const raw = '{"log.level":"INFO"}';
    expect(parseLine(raw, 'ecs').message).toBe(raw);
  });

  it('picks up a Java ECS stack trace as a string', () => {
    const raw = JSON.stringify({
      '@timestamp': '2026-09-22T20:01:02.345Z',
      'log.level': 'ERROR',
      'log.logger': 'com.example.Service',
      message: 'request failed',
      'error.type': 'java.lang.IllegalStateException',
      'error.message': 'closed',
      'error.stack_trace':
        'java.lang.IllegalStateException: closed\n\tat com.example.Service.handle(Service.java:42)',
    });
    const entry = parseLine(raw, 'ecs');

    expect(entry.errorType).toBe('java.lang.IllegalStateException');
    expect(entry.errorMessage).toBe('closed');
    expect(entry.stackTrace).toContain('at com.example.Service.handle');
  });

  it('joins a stack trace emitted as an array of frames', () => {
    // ecs-logging-java's stackTraceAsArray option.
    const raw = JSON.stringify({
      '@timestamp': '2026-09-22T20:01:02.345Z',
      'error.stack_trace': [
        'java.lang.RuntimeException: nope',
        '\tat A.a(A.java:1)',
      ],
    });
    expect(parseLine(raw, 'ecs').stackTrace).toBe(
      'java.lang.RuntimeException: nope\n\tat A.a(A.java:1)',
    );
  });

  it('ignores non-ECS aliases in ECS mode but honours them in JSON mode', () => {
    const raw = JSON.stringify({
      ts: '2026-09-22T20:01:02.345Z',
      severity: 'info',
      logger_name: 'bunyan.thing',
      msg: 'hello',
    });

    const ecs = parseLine(raw, 'ecs');
    expect(ecs.timestamp).toBeNull();
    expect(ecs.level).toBeNull();
    expect(ecs.logger).toBeNull();

    const json = parseLine(raw, 'json');
    expect(json.timestamp).toBe('2026-09-22T20:01:02.345Z');
    expect(json.level).toBe('info');
    expect(json.levelClass).toBe('info');
    expect(json.logger).toBe('bunyan.thing');
    expect(json.message).toBe('hello');
  });

  it('maps numeric levels by the scale their magnitude implies', () => {
    // pino/bunyan: 10..60 ascending in severity.
    expect(parseLine('{"level":30,"msg":"x"}', 'json').levelClass).toBe('info');
    expect(parseLine('{"level":50,"msg":"x"}', 'json').levelClass).toBe(
      'error',
    );
    // syslog: 0..7 descending in severity.
    expect(parseLine('{"level":3,"msg":"x"}', 'json').levelClass).toBe('error');
    expect(parseLine('{"level":6,"msg":"x"}', 'json').levelClass).toBe('info');
  });
});

describe('sniffFormat', () => {
  it('detects ECS from @timestamp plus a dotted log key', () => {
    expect(
      sniffFormat(['{"@timestamp":"2026-09-22T20:00:00Z","log.level":"INFO"}']),
    ).toBe('ecs');
  });

  it('detects plain JSON that is not ECS', () => {
    expect(sniffFormat(['{"level":"info","msg":"hi"}'])).toBe('json');
  });

  it('detects plain text', () => {
    expect(sniffFormat(['2026-09-22 20:00:00 INFO starting'])).toBe('plain');
  });

  it('skips blank leading lines', () => {
    expect(sniffFormat(['', '   ', '{"level":"info"}'])).toBe('json');
  });

  it('looks past the banner lines a JVM writes before its first log record', () => {
    expect(
      sniffFormat([
        'Picked up JAVA_TOOL_OPTIONS: -Xmx512m',
        'OpenJDK 64-Bit Server VM warning: ignoring option',
        '{"@timestamp":"2026-09-22T20:00:00Z","log.level":"INFO","message":"started"}',
      ]),
    ).toBe('ecs');
  });

  it('prefers ECS over plain JSON when both appear', () => {
    expect(
      sniffFormat([
        '{"level":"info","msg":"sidecar up"}',
        '{"@timestamp":"2026-09-22T20:00:00Z","log.level":"INFO"}',
      ]),
    ).toBe('ecs');
  });
});

describe('formatTimestamp', () => {
  it('renders time of day with milliseconds', () => {
    const iso = new Date(2026, 8, 22, 20, 1, 2, 345).toISOString();
    expect(formatTimestamp(iso)).toBe('20:01:02.345');
  });

  it('accepts epoch milliseconds', () => {
    const date = new Date(2026, 8, 22, 7, 8, 9, 10);
    expect(formatTimestamp(String(date.getTime()))).toBe('07:08:09.010');
  });

  it('passes an unparseable value through, truncated', () => {
    expect(formatTimestamp('not-a-time')).toBe('not-a-time');
    expect(formatTimestamp(null)).toBe('');
  });
});

describe('parseLine, journald', () => {
  // A real entry, trimmed to the fields the columns use.
  const entry = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      __REALTIME_TIMESTAMP: '1790143099610648',
      _SYSTEMD_UNIT: 'networkd-mtu-propagate.service',
      _TRANSPORT: 'stdout',
      SYSLOG_IDENTIFIER: 'networkd-mtu-propagate',
      PRIORITY: '6',
      MESSAGE: 'requested MTU 9216 exceeds cap 9198, capping',
      ...extra,
    });

  it('reads the four columns the tab shows', () => {
    const parsed = parseLine(entry(), 'journald');
    expect(parsed.unit).toBe('networkd-mtu-propagate.service');
    expect(parsed.transport).toBe('stdout');
    expect(parsed.message).toBe('requested MTU 9216 exceeds cap 9198, capping');
    expect(parsed.structured).toBe(true);
  });

  it('converts __REALTIME_TIMESTAMP from microseconds', () => {
    const parsed = parseLine(entry(), 'journald');
    // Microseconds, not milliseconds: read as ms this lands in the year 58000.
    expect(parsed.timestamp).toBe(new Date(1790143099610).toISOString());
    expect(parsed.timestamp).toMatch(/^2026-/);
  });

  it('falls back to the syslog identifier when there is no unit', () => {
    // Kernel and audit entries carry no _SYSTEMD_UNIT at all.
    const raw = JSON.stringify({
      __REALTIME_TIMESTAMP: '1790143099610648',
      _TRANSPORT: 'kernel',
      SYSLOG_IDENTIFIER: 'kernel',
      MESSAGE: 'bond0: link becomes ready',
    });
    const parsed = parseLine(raw, 'journald');
    expect(parsed.unit).toBe('kernel');
    expect(parsed.transport).toBe('kernel');
  });

  it('decodes a MESSAGE given as bytes', () => {
    // journald emits an array when the message is not valid UTF-8.
    const raw = JSON.stringify({
      __REALTIME_TIMESTAMP: '1790143099610648',
      MESSAGE: [104, 101, 108, 108, 111],
    });
    expect(parseLine(raw, 'journald').message).toBe('hello');
  });

  it('shows PRIORITY by name, keeping the number for the tooltip', () => {
    // "6" tells a reader nothing; INFO is what journalctl itself prints.
    const parsed = parseLine(entry({ PRIORITY: '6' }), 'journald');
    expect(parsed.level).toBe('INFO');
    expect(parsed.priority).toBe('6');
    expect(parsed.levelClass).toBe('info');
  });

  it('keeps the syslog names the level classes collapse together', () => {
    // NOTICE and INFO both colour as info; CRIT, ALERT and EMERG all as
    // fatal. The name is the only place that distinction survives.
    expect(parseLine(entry({ PRIORITY: '5' }), 'journald').level).toBe(
      'NOTICE',
    );
    expect(parseLine(entry({ PRIORITY: '2' }), 'journald').level).toBe('CRIT');
    expect(parseLine(entry({ PRIORITY: '0' }), 'journald').level).toBe('EMERG');
  });

  it('maps PRIORITY through the syslog scale', () => {
    expect(parseLine(entry({ PRIORITY: '3' }), 'journald').levelClass).toBe(
      'error',
    );
    expect(parseLine(entry({ PRIORITY: '4' }), 'journald').levelClass).toBe(
      'warn',
    );
    expect(parseLine(entry({ PRIORITY: '7' }), 'journald').level).toBe('DEBUG');
  });

  it('passes an unrecognised PRIORITY through untouched', () => {
    const parsed = parseLine(entry({ PRIORITY: 'weird' }), 'journald');
    expect(parsed.level).toBe('weird');
  });

  it('leaves the level empty when there is no PRIORITY', () => {
    const raw = JSON.stringify({
      __REALTIME_TIMESTAMP: '1790143099610648',
      MESSAGE: 'no priority here',
    });
    expect(parseLine(raw, 'journald').level).toBeNull();
  });

  it('falls back to plain for a line that is not JSON', () => {
    const parsed = parseLine(
      '-- Journal begins at Mon 2026-09-01 --',
      'journald',
    );
    expect(parsed.structured).toBe(false);
    expect(parsed.message).toBe('-- Journal begins at Mon 2026-09-01 --');
  });
});

describe('formatTimestampWithDate', () => {
  it('shows the date as well as the time', () => {
    const iso = new Date(2026, 8, 22, 20, 1, 2, 345).toISOString();
    expect(formatTimestampWithDate(iso)).toBe('09-22 20:01:02.345');
  });

  it('is empty for a missing timestamp', () => {
    expect(formatTimestampWithDate(null)).toBe('');
  });
});

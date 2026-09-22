import { LogBuffer } from './buffer';

const linesOf = (buffer: LogBuffer): string[] => {
  const out: string[] = [];
  for (let seq = buffer.firstSeq; seq < buffer.endSeq; seq++) {
    const line = buffer.lineAt(seq);
    if (line !== null) {
      out.push(line);
    }
  }
  return out;
};

describe('LogBuffer', () => {
  it('indexes complete lines and leaves a trailing fragment pending', () => {
    const buffer = new LogBuffer();
    buffer.append('first\nsecond\nthi');

    expect(buffer).toHaveLength(2);
    expect(linesOf(buffer)).toEqual(['first', 'second']);

    buffer.append('rd\n');
    expect(linesOf(buffer)).toEqual(['first', 'second', 'third']);
  });

  it('joins a line split across chunk boundaries', () => {
    const buffer = new LogBuffer();
    for (const chunk of ['{"mes', 'sage":"h', 'ello"}', '\n']) {
      buffer.append(chunk);
    }
    expect(linesOf(buffer)).toEqual(['{"message":"hello"}']);
  });

  it('commits an unterminated final line only once the stream ends', () => {
    const buffer = new LogBuffer();
    buffer.append('done\nlast line without newline');
    expect(buffer).toHaveLength(1);

    buffer.flushPartial();
    expect(linesOf(buffer)).toEqual(['done', 'last line without newline']);

    // Idempotent: a second flush must not duplicate the line.
    buffer.flushPartial();
    expect(buffer).toHaveLength(2);
  });

  it('strips a CRLF terminator without touching interior carriage returns', () => {
    const buffer = new LogBuffer();
    buffer.append('windows\r\nwith\rcr\n');
    expect(linesOf(buffer)).toEqual(['windows', 'with\rcr']);
  });

  it('keeps lines intact across page boundaries', () => {
    // A page size far below the line length forces a seal after every line.
    const buffer = new LogBuffer({ pageSize: 1024 });
    const line = 'x'.repeat(400);
    for (let i = 0; i < 20; i++) {
      buffer.append(`${line}${String(i)}\n`);
    }
    const lines = linesOf(buffer);
    expect(lines).toHaveLength(20);
    lines.forEach((value, index) => {
      expect(value).toBe(`${line}${String(index)}`);
    });
  });

  it('drops the oldest lines past maxLines and renumbers nothing', () => {
    const buffer = new LogBuffer({ maxLines: 10, pageSize: 1024 });
    for (let i = 0; i < 100; i++) {
      buffer.append(`line ${String(i)}\n`);
    }

    expect(buffer).toHaveLength(10);
    expect(buffer.droppedLines).toBe(90);
    expect(buffer.firstSeq).toBe(90);
    expect(buffer.endSeq).toBe(100);
    expect(buffer.lineAt(90)).toBe('line 90');
    expect(buffer.lineAt(99)).toBe('line 99');
    // Evicted sequence numbers are gone, not recycled.
    expect(buffer.lineAt(89)).toBeNull();
    expect(buffer.lineAt(100)).toBeNull();
  });

  it('releases the text pages the dropped lines were the last users of', () => {
    const buffer = new LogBuffer({ maxLines: 50, pageSize: 2048 });
    const line = `${'y'.repeat(200)}\n`;
    for (let i = 0; i < 2000; i++) {
      buffer.append(line);
    }
    // Without page release this would be ~400 KB of retained text.
    expect(buffer.charLength).toBeLessThan(50 * 201 + 4096);
  });

  it('bumps the generation on clear so sequence-number caches can invalidate', () => {
    const buffer = new LogBuffer();
    buffer.append('a\nb\n');
    const generation = buffer.generation;

    buffer.clear();
    expect(buffer.generation).toBe(generation + 1);
    expect(buffer).toHaveLength(0);
    expect(buffer.firstSeq).toBe(0);

    buffer.append('c\n');
    expect(buffer.lineAt(0)).toBe('c');
  });

  it('handles a stream of 100k lines without materialising them', () => {
    const buffer = new LogBuffer();
    let chunk = '';
    for (let i = 0; i < 100_000; i++) {
      chunk += `{"message":"line ${String(i)}"}\n`;
      if (chunk.length > 64 * 1024) {
        buffer.append(chunk);
        chunk = '';
      }
    }
    buffer.append(chunk);

    expect(buffer).toHaveLength(100_000);
    expect(buffer.lineAt(0)).toBe('{"message":"line 0"}');
    expect(buffer.lineAt(99_999)).toBe('{"message":"line 99999"}');
  });
});

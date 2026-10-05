import { annotatedFormat } from './format-annotation';

const hint = (annotation: string | undefined, container: string) =>
  annotatedFormat(annotation, container);

describe('annotatedFormat', () => {
  it('finds the entry for the container', () => {
    expect(hint('app=ecs,proxy=plain', 'app')).toEqual({
      format: 'ecs',
      columns: [],
    });
    expect(hint('app=ecs,proxy=plain', 'proxy')?.format).toBe('plain');
  });

  it('is null when the annotation is absent or does not mention the container', () => {
    expect(hint(undefined, 'app')).toBeNull();
    expect(hint('', 'app')).toBeNull();
    expect(hint('proxy=plain', 'app')).toBeNull();
  });

  it('does not match on a container-name prefix', () => {
    expect(hint('app-2=json', 'app')).toBeNull();
  });

  it('tolerates whitespace and case in the format', () => {
    expect(hint(' app = JSON , proxy=plain', 'app')?.format).toBe('json');
  });

  it('accepts journald', () => {
    expect(hint('app=journald', 'app')?.format).toBe('journald');
  });

  it('lets the last entry for a container win', () => {
    expect(hint('app=json,app=ecs', 'app')?.format).toBe('ecs');
  });

  describe('columns', () => {
    it('reads a column list after the format', () => {
      expect(
        hint('app=json:ts=epoch,lvl=log-level,user=string', 'app'),
      ).toEqual({
        format: 'json',
        columns: [
          { key: 'ts', type: 'epoch' },
          { key: 'lvl', type: 'log-level' },
          { key: 'user', type: 'string' },
        ],
      });
    });

    it('does not hand the next container the previous one columns', () => {
      const annotation =
        'app=json:ts=epoch,lvl=log-level,proxy=ecs,db=plain:n=number';
      expect(hint(annotation, 'app')?.columns).toHaveLength(2);
      expect(hint(annotation, 'proxy')).toEqual({
        format: 'ecs',
        columns: [],
      });
      expect(hint(annotation, 'db')?.columns).toEqual([
        { key: 'n', type: 'number' },
      ]);
    });

    it('reads every date type, and dotted keys', () => {
      const columns = hint(
        'app=ecs:a=date/rfc3339,b=date/rfc3339nano,c=date/epoch-ms,log.level=log-level,cls=abbreviate',
        'app',
      )?.columns;
      expect(columns?.map((c) => c.type)).toEqual([
        'date/rfc3339',
        'date/rfc3339nano',
        'date/epoch-ms',
        'log-level',
        'abbreviate',
      ]);
      expect(columns?.[3].key).toBe('log.level');
    });

    it('tolerates whitespace and a trailing comma', () => {
      expect(
        hint('app = json : ts = epoch , n = number ,', 'app')?.columns,
      ).toEqual([
        { key: 'ts', type: 'epoch' },
        { key: 'n', type: 'number' },
      ]);
    });

    it('drops an unknown column type and the columns after it, keeping the format', () => {
      expect(hint('app=json:a=epoch,b=bogus,c=string', 'app')).toEqual({
        format: 'json',
        columns: [{ key: 'a', type: 'epoch' }],
      });
      expect(hint('app=json:b=bogus,c=string', 'app')).toEqual({
        format: 'json',
        columns: [],
      });
    });

    it('drops an entry with an unknown format, and the columns that follow it', () => {
      const annotation = 'app=xml:a=epoch,b=string,proxy=plain';
      expect(hint(annotation, 'app')).toBeNull();
      expect(hint(annotation, 'proxy')?.format).toBe('plain');
    });

    it('does not give columns to the entry before a malformed one', () => {
      const annotation = 'app=json:a=epoch,oops=xml,b=string';
      expect(hint(annotation, 'app')?.columns).toEqual([
        { key: 'a', type: 'epoch' },
      ]);
    });
  });
});

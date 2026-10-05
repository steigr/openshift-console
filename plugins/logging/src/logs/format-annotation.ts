import { isColumnType, isLogFormat } from './parse';
import type { ColumnSpec, LogFormat } from './parse';

/**
 * Pod annotation a workload sets to say how each container's log should be
 * rendered:
 *
 *     container=format(,container=format)*
 *     format = format-name(:column-name=column-type(,column-name=column-type)*)?
 *
 * for example `app=ecs,proxy=json:ts=epoch,lvl=log-level,user=string`.
 * Containers it does not mention fall back to the reader's remembered choice
 * and then to sniffing.
 */
export const FORMAT_ANNOTATION = 'logs.kubernetes.io/format';

export interface FormatHint {
  format: LogFormat;
  columns: ColumnSpec[];
}

/**
 * Both lists are comma-separated, so `proxy=plain` after `app=json:ts=epoch`
 * is told apart from a column by what it could be: a format name is never a
 * column type and vice versa, and only a container's own entry carries the
 * `:`. A token that is neither (`app=xml`) cannot be placed, so it ends the
 * columns being collected rather than risk handing the next ones to the wrong
 * container.
 */
const parseHints = (annotation: string): Map<string, FormatHint> => {
  const hints = new Map<string, FormatHint>();
  let current: FormatHint | null = null;

  for (const token of annotation.split(',')) {
    const eq = token.indexOf('=');
    if (eq < 0) {
      if (token.trim() !== '') {
        current = null;
      }
      continue;
    }
    const name = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();

    const colon = value.indexOf(':');
    const head = (colon < 0 ? value : value.slice(0, colon))
      .trim()
      .toLowerCase();

    if (colon >= 0 || isLogFormat(head)) {
      // A container's own entry.
      if (name === '' || !isLogFormat(head)) {
        current = null;
        continue;
      }
      current = { format: head, columns: [] };
      hints.set(name, current);
      if (colon >= 0) {
        // The first column rides on the container's entry.
        const first = value.slice(colon + 1);
        const at = first.indexOf('=');
        const type = first.slice(at + 1).trim();
        if (at > 0 && isColumnType(type)) {
          current.columns.push({ key: first.slice(0, at).trim(), type });
        } else {
          current = null;
        }
      }
      continue;
    }

    if (current !== null && name !== '' && isColumnType(value)) {
      current.columns.push({ key: name, type: value });
    } else {
      current = null;
    }
  }
  return hints;
};

/**
 * What the annotation says about `container`, or null when the annotation is
 * absent or does not mention it. Lenient on purpose: an annotation is
 * hand-written YAML, and one malformed entry should cost only itself, not its
 * neighbours. An unknown format name drops the whole entry, and an unknown
 * column type drops that column and any after it in the same entry (the
 * default lookup covers what is left). When a container is listed twice, the
 * last entry wins.
 */
export const annotatedFormat = (
  annotation: string | undefined,
  container: string,
): FormatHint | null => {
  if (!annotation) {
    return null;
  }
  return parseHints(annotation).get(container) ?? null;
};

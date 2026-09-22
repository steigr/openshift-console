import { EntryType } from '../gen/filesystem/v1/filesystem_pb';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Binary units, matching what `ls -lh` and the rest of the console show. */
export const formatSize = (bytes: number | bigint): string => {
  let value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
};

const RWX = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];

/**
 * Renders st_mode's permission bits the way `ls -l` does, including the
 * setuid/setgid/sticky overlay - the detail that makes a mode worth showing
 * at all rather than just an octal number.
 */
export const formatMode = (mode: number, type: EntryType): string => {
  const kind =
    type === EntryType.DIRECTORY
      ? 'd'
      : type === EntryType.SYMLINK
        ? 'l'
        : type === EntryType.OTHER
          ? '?'
          : '-';

  const bits = [(mode >> 6) & 7, (mode >> 3) & 7, mode & 7].map((digit) => RWX[digit]);
  const overlay = (index: number, flag: number, set: string, unset: string) => {
    if ((mode & flag) === 0) {
      return;
    }
    const executable = bits[index][2] === 'x';
    bits[index] = bits[index].slice(0, 2) + (executable ? set : unset);
  };
  overlay(0, 0o4000, 's', 'S');
  overlay(1, 0o2000, 's', 'S');
  overlay(2, 0o1000, 't', 'T');

  return kind + bits.join('');
};

export const formatOctal = (mode: number): string => `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;

export const formatTime = (unixSeconds: number | bigint): string => {
  const seconds = Number(unixSeconds);
  if (!seconds) {
    return '-';
  }
  return new Date(seconds * 1000).toLocaleString();
};

/**
 * Suffixes the agent can unpack. Detection on the agent is by magic number,
 * not by name - this list only decides whether the context menu bothers
 * offering "Uncompress".
 */
const ARCHIVE_SUFFIXES = ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.zst', '.tar.zstd', '.tzst'];

export const looksLikeArchive = (name: string): boolean => {
  const lower = name.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/** Joins a directory and a child name into an absolute in-container path. */
export const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;

/** The directory holding a path; "/" is its own parent. */
export const parentPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
};

/** Every prefix of `path` from "/" down to `path` itself, in order — the directories a tree must expand to reveal it. */
export const ancestorPaths = (path: string): string[] => {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') {
    return ['/'];
  }
  const result = ['/'];
  let current = '';
  for (const part of trimmed.split('/').filter(Boolean)) {
    current += `/${part}`;
    result.push(current);
  }
  return result;
};

export const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') {
    // "/" has no name of its own; the archive writer calls it "root" and the
    // UI shows the slash.
    return '/';
  }
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
};

import type { ComponentType } from 'react';
import {
  BoltIcon,
  CogIcon,
  CompactDiscIcon,
  DatabaseIcon,
  ExchangeAltIcon,
  FileAltIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileExcelIcon,
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FilePowerpointIcon,
  FileVideoIcon,
  FileWordIcon,
  HddIcon,
  MicrochipIcon,
  PlugIcon,
  QuestionIcon,
  StreamIcon,
  TerminalIcon,
} from '@patternfly/react-icons';
import type { SVGIconProps } from '@patternfly/react-icons/dist/esm/createIcon';

import type { Entry } from '../gen/filesystem/v1/filesystem_pb';
import { EntryType } from '../gen/filesystem/v1/filesystem_pb';

export type IconComponent = ComponentType<SVGIconProps>;

/**
 * Extension -> icon. Every icon here is one of PatternFly's own monochrome,
 * `currentColor` SVGs, so it already follows console's light/dark theme
 * through the same `--pf-t--global--icon--color--*` tokens the rest of this
 * tree uses -- no separate icon asset per theme is needed.
 */
const EXTENSION_ICONS: Record<string, IconComponent> = {
  // archives
  tar: FileArchiveIcon,
  gz: FileArchiveIcon,
  tgz: FileArchiveIcon,
  tbz2: FileArchiveIcon,
  zip: FileArchiveIcon,
  bz2: FileArchiveIcon,
  xz: FileArchiveIcon,
  zst: FileArchiveIcon,
  zstd: FileArchiveIcon,
  '7z': FileArchiveIcon,
  rar: FileArchiveIcon,

  // images
  png: FileImageIcon,
  jpg: FileImageIcon,
  jpeg: FileImageIcon,
  gif: FileImageIcon,
  svg: FileImageIcon,
  bmp: FileImageIcon,
  webp: FileImageIcon,
  ico: FileImageIcon,
  tiff: FileImageIcon,

  // audio / video
  mp3: FileAudioIcon,
  wav: FileAudioIcon,
  flac: FileAudioIcon,
  ogg: FileAudioIcon,
  m4a: FileAudioIcon,
  mp4: FileVideoIcon,
  mkv: FileVideoIcon,
  mov: FileVideoIcon,
  avi: FileVideoIcon,
  webm: FileVideoIcon,

  // documents
  pdf: FilePdfIcon,
  doc: FileWordIcon,
  docx: FileWordIcon,
  xls: FileExcelIcon,
  xlsx: FileExcelIcon,
  ppt: FilePowerpointIcon,
  pptx: FilePowerpointIcon,
  csv: FileCsvIcon,
  tsv: FileCsvIcon,
  txt: FileAltIcon,
  md: FileAltIcon,
  log: FileAltIcon,

  // source / markup
  go: FileCodeIcon,
  py: FileCodeIcon,
  rb: FileCodeIcon,
  rs: FileCodeIcon,
  java: FileCodeIcon,
  c: FileCodeIcon,
  h: FileCodeIcon,
  cpp: FileCodeIcon,
  hpp: FileCodeIcon,
  php: FileCodeIcon,
  js: FileCodeIcon,
  jsx: FileCodeIcon,
  ts: FileCodeIcon,
  tsx: FileCodeIcon,
  html: FileCodeIcon,
  css: FileCodeIcon,
  scss: FileCodeIcon,
  json: FileCodeIcon,
  yaml: FileCodeIcon,
  yml: FileCodeIcon,
  xml: FileCodeIcon,
  toml: FileCodeIcon,

  // shell
  sh: TerminalIcon,
  bash: TerminalIcon,
  zsh: TerminalIcon,

  // config
  conf: CogIcon,
  cfg: CogIcon,
  ini: CogIcon,
  properties: CogIcon,
  plist: CogIcon,

  // databases
  db: DatabaseIcon,
  sqlite: DatabaseIcon,
  sqlite3: DatabaseIcon,

  // optical media / firmware
  iso: CompactDiscIcon,
  efi: MicrochipIcon,
};

const extensionOf = (name: string): string | null => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
};

/**
 * A shared library: `libfoo.so`, or a versioned SONAME like `libfoo.so.1` or
 * `libfoo.so.1.2.3`. `extensionOf` alone can't see this -- its extension is
 * "1.2.3" -- so it's matched separately, ahead of the plain extension table.
 */
const SHARED_LIBRARY = /\.so(\.\d+)*$/i;

/** A plain (non-directory, non-symlink) file's icon, guessed from its extension alone. */
export const fileIconFor = (name: string): IconComponent => {
  if (SHARED_LIBRARY.test(name)) {
    return PlugIcon;
  }
  const ext = extensionOf(name);
  return (ext && EXTENSION_ICONS[ext]) || FileIcon;
};

/** One of the Unix "special file" types `ls -l` marks with something other than `-` or `d`. */
const SPECIAL_TYPE_ICONS: Partial<Record<EntryType, IconComponent>> = {
  [EntryType.BLOCK_DEVICE]: HddIcon,
  [EntryType.CHAR_DEVICE]: MicrochipIcon,
  [EntryType.SOCKET]: ExchangeAltIcon,
  [EntryType.FIFO]: StreamIcon,
  [EntryType.OTHER]: QuestionIcon,
};

/** Any bit of `st_mode`'s user/group/other execute trio is set. */
const isExecutable = (mode: number): boolean => (mode & 0o111) !== 0;

/** `/proc` and `/sys` are kernel interfaces, not user data -- every entry in them is one gear. */
const isKernelInterfacePath = (path: string): boolean =>
  path === '/proc' || path.startsWith('/proc/') || path === '/sys' || path.startsWith('/sys/');

/**
 * The icon for a real (non-directory, non-symlink) entry -- a symlink always
 * takes the icon of what it points to instead, via `resolveSymlinkIcon` in
 * FileTree.tsx, so this is never asked to guess one for a link.
 *
 * Order: `/proc` and `/sys` win outright, then the Unix file type (device,
 * socket, FIFO, ...), then a shared-library or extension guess, and only
 * once none of those match does the executable bit fall back to a generic
 * "runnable" icon ahead of the plain file icon.
 */
export const iconForEntry = (entry: Entry, path: string): IconComponent => {
  if (isKernelInterfacePath(path)) {
    return CogIcon;
  }
  const special = SPECIAL_TYPE_ICONS[entry.type];
  if (special) {
    return special;
  }
  const byNameOrExtension = fileIconFor(entry.name);
  if (byNameOrExtension !== FileIcon) {
    return byNameOrExtension;
  }
  return isExecutable(entry.mode) ? BoltIcon : FileIcon;
};

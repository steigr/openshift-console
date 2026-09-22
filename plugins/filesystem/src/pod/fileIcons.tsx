import type { ComponentType } from 'react';
import {
  CogIcon,
  DatabaseIcon,
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
  TerminalIcon,
} from '@patternfly/react-icons';
import type { SVGIconProps } from '@patternfly/react-icons/dist/esm/createIcon';

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

  // databases
  db: DatabaseIcon,
  sqlite: DatabaseIcon,
  sqlite3: DatabaseIcon,
};

const extensionOf = (name: string): string | null => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
};

/** A plain (non-directory, non-symlink) file's icon, guessed from its extension. */
export const fileIconFor = (name: string): IconComponent => {
  const ext = extensionOf(name);
  return (ext && EXTENSION_ICONS[ext]) || FileIcon;
};

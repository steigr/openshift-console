import * as React from 'react';
import type { FC, DragEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@patternfly/react-core';
import { AngleDownIcon, AngleRightIcon, BanIcon, FolderIcon, FolderOpenIcon, LinkIcon } from '@patternfly/react-icons';

import type { Entry } from '../gen/filesystem/v1/filesystem_pb';
import { EntryType } from '../gen/filesystem/v1/filesystem_pb';
import type { IconComponent } from './fileIcons';
import { fileIconFor, iconForEntry } from './fileIcons';
import { baseName, formatSize, joinPath, parentPath } from './format';

/** How many hops a symlink chain is followed for icon purposes, matching the agent's own `maxSymlinks` guard. */
const MAX_SYMLINK_HOPS = 10;

/**
 * Drag payload for a move. A custom MIME type rather than "text/plain" so a
 * path dragged out of this tree cannot be dropped into an unrelated text
 * field, and so a file dragged in from the desktop (which carries
 * dataTransfer.files and no such type) is never mistaken for one.
 */
export const MOVE_MIME = 'application/x-console-filesystem-path';

export type DirState = {
  entries: Entry[];
  truncated: boolean;
  loading: boolean;
  error?: string;
};

export type FileTreeProps = {
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  busy: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string, entry: Entry | null) => void;
  onContextMenu: (path: string, entry: Entry | null, event: MouseEvent) => void;
  onDropFiles: (directory: string, files: FileList) => void;
  onMove: (source: string, directory: string) => void;
  /** Mount paths of this container's read-only volume mounts, from its pod spec. */
  readOnlyMounts: string[];
};

/** A directory, or a symlink that resolves to one, can be opened and dropped into. */
const isExpandable = (entry: Entry): boolean =>
  entry.type === EntryType.DIRECTORY || (entry.type === EntryType.SYMLINK && entry.targetIsDirectory);

const isUnderReadOnlyMount = (path: string, mounts: string[]): boolean =>
  mounts.some((mount) => path === mount || path.startsWith(mount.endsWith('/') ? mount : `${mount}/`));

/**
 * A symlink's own icon: the icon its target would have, so `bin -> usr/bin`
 * reads as a folder rather than a generic link glyph (the link itself is
 * shown as a small badge instead -- see `filesystem-tree__badge`).
 *
 * Only chases hops the tree has already loaded -- following an unopened
 * directory would mean issuing lookups the user never asked for. When a hop
 * lands outside what's loaded, this falls back to the server's own resolved
 * `targetIsDirectory` bit (which the agent computes by chasing the full
 * chain server-side, see `internal/rootfs/root.go`) plus the last known
 * target name's extension.
 */
const resolveSymlinkIcon = (entry: Entry, path: string, dirs: Record<string, DirState>): IconComponent => {
  let dir = parentPath(path);
  let target = entry.linkTarget;
  let name = target;

  for (let hop = 0; hop < MAX_SYMLINK_HOPS && target; hop++) {
    const resolved = target.startsWith('/') ? target : joinPath(dir, target);
    name = baseName(resolved);
    const found = dirs[parentPath(resolved)]?.entries.find((candidate) => candidate.name === name);
    if (!found) {
      break;
    }
    if (found.type === EntryType.SYMLINK) {
      dir = parentPath(resolved);
      target = found.linkTarget;
      continue;
    }
    return found.type === EntryType.DIRECTORY ? FolderIcon : iconForEntry(found, resolved);
  }

  return entry.targetIsDirectory ? FolderIcon : fileIconFor(name || '');
};

export const FileTree: FC<FileTreeProps> = (props) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');

  return (
    <div
      className="filesystem-tree"
      role="tree"
      aria-label={t('Container filesystem')}
      data-test="filesystem-tree"
    >
      <DirectoryRow path="/" entry={null} depth={0} {...props} />
    </div>
  );
};

type RowProps = FileTreeProps & {
  path: string;
  entry: Entry | null;
  depth: number;
};

/**
 * One row plus, when open, its children. Children are rendered from the
 * `dirs` map the tab fills on demand, so nothing below a closed directory has
 * ever been asked for.
 */
const DirectoryRow: FC<RowProps> = (props) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const { path, entry, depth, dirs, expanded, selected, busy } = props;

  const isRoot = path === '/';
  const expandable = isRoot || (entry !== null && isExpandable(entry));
  const open = expanded.has(path);
  const state = dirs[path];
  const isSymlink = entry?.type === EntryType.SYMLINK;
  const readOnly = isUnderReadOnlyMount(path, props.readOnlyMounts);

  const MainIcon: IconComponent = entry && isSymlink
    ? resolveSymlinkIcon(entry, path, dirs)
    : expandable
      ? open
        ? FolderOpenIcon
        : FolderIcon
      : entry
        ? iconForEntry(entry, path)
        : FolderIcon;

  // Rows are siblings in the DOM rather than nested, so a drop on a file row
  // never reaches the directory it is drawn under. Dropping onto a file is
  // still a sensible thing to do -- "put it here, next to this" -- so a
  // non-directory row takes its own parent as the destination.
  const dropTarget = expandable ? path : parentPath(path);

  const [dragOver, setDragOver] = React.useState(false);

  const onDragStart = (event: DragEvent) => {
    if (isRoot) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(MOVE_MIME, path);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (event: DragEvent) => {
    const moving = event.dataTransfer.types.includes(MOVE_MIME);
    const uploading = event.dataTransfer.types.includes('Files');
    if (!moving && !uploading) {
      return;
    }
    // Both branches need preventDefault, or the browser treats the drop as a
    // navigation and opens the dragged file in the tab.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = moving ? 'move' : 'copy';
    setDragOver(true);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);

    const source = event.dataTransfer.getData(MOVE_MIME);
    if (source) {
      props.onMove(source, dropTarget);
      return;
    }
    if (event.dataTransfer.files?.length) {
      props.onDropFiles(dropTarget, event.dataTransfer.files);
    }
  };

  const label = isRoot ? '/' : entry.name;
  const classes = [
    'filesystem-tree__row',
    selected === path ? 'filesystem-tree__row--selected' : '',
    dragOver ? 'filesystem-tree__row--drop' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div
        className={classes}
        style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
        role="treeitem"
        aria-expanded={expandable ? open : undefined}
        aria-selected={selected === path}
        tabIndex={0}
        draggable={!isRoot}
        data-test={`filesystem-row-${path}`}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => {
          props.onSelect(path, entry);
          if (expandable) {
            props.onToggle(path);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onSelect(path, entry);
          props.onContextMenu(path, entry, event);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onSelect(path, entry);
            if (expandable) {
              props.onToggle(path);
            }
          }
        }}
      >
        <span className="filesystem-tree__caret">
          {expandable ? open ? <AngleDownIcon /> : <AngleRightIcon /> : null}
        </span>
        <span className="filesystem-tree__icon">
          <MainIcon />
          {readOnly && (
            <BanIcon
              className="filesystem-tree__badge filesystem-tree__badge--forbidden"
              title={t('Read-only mount')}
            />
          )}
          {isSymlink && (
            <LinkIcon className="filesystem-tree__badge filesystem-tree__badge--link" title={t('Symbolic link')} />
          )}
        </span>
        <span className="filesystem-tree__name">{label}</span>
        {entry && entry.type === EntryType.SYMLINK && entry.linkTarget && (
          <span className="filesystem-tree__link"> → {entry.linkTarget}</span>
        )}
        {entry && entry.type === EntryType.FILE && (
          <span className="filesystem-tree__size">{formatSize(entry.size)}</span>
        )}
        {busy.has(path) && <Spinner size="sm" className="filesystem-tree__spinner" />}
      </div>

      {expandable && open && (
        <>
          {state?.loading && !state.entries.length && (
            <div className="filesystem-tree__note" style={{ paddingInlineStart: `${(depth + 1) * 16 + 24}px` }}>
              <Spinner size="sm" /> {t('Loading…')}
            </div>
          )}
          {state?.error && (
            <div
              className="filesystem-tree__note filesystem-tree__note--error"
              style={{ paddingInlineStart: `${(depth + 1) * 16 + 24}px` }}
            >
              {state.error}
            </div>
          )}
          {state?.entries.map((child) => (
            <DirectoryRow
              {...props}
              key={joinPath(path, child.name)}
              path={joinPath(path, child.name)}
              entry={child}
              depth={depth + 1}
            />
          ))}
          {state && !state.loading && !state.error && state.entries.length === 0 && (
            <div className="filesystem-tree__note" style={{ paddingInlineStart: `${(depth + 1) * 16 + 24}px` }}>
              {t('Empty')}
            </div>
          )}
          {state?.truncated && (
            <div
              className="filesystem-tree__note filesystem-tree__note--warning"
              style={{ paddingInlineStart: `${(depth + 1) * 16 + 24}px` }}
            >
              {t('Only the first {{count}} entries are shown.', { count: state.entries.length })}
            </div>
          )}
        </>
      )}
    </>
  );
};

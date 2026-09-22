import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import type { Entry } from '../../gen/filesystem/v1/filesystem_pb';
import { EntryType } from '../../gen/filesystem/v1/filesystem_pb';
import { FileTree, MOVE_MIME } from '../FileTree';
import type { DirState, FileTreeProps } from '../FileTree';

const entry = (name: string, type: EntryType, extra: Partial<Entry> = {}): Entry =>
  ({
    $typeName: 'filesystem.v1.Entry',
    name,
    type,
    size: 12n,
    mode: 0o644,
    uid: 0,
    gid: 0,
    modifiedUnix: 0n,
    linkTarget: '',
    targetIsDirectory: false,
    ...extra,
  }) as Entry;

const dirState = (entries: Entry[], extra: Partial<DirState> = {}): DirState => ({
  entries,
  truncated: false,
  loading: false,
  ...extra,
});

const renderTree = (overrides: Partial<FileTreeProps> = {}) => {
  const props: FileTreeProps = {
    dirs: {
      '/': dirState([
        entry('etc', EntryType.DIRECTORY),
        entry('motd', EntryType.FILE),
        entry('link', EntryType.SYMLINK, { linkTarget: '/etc', targetIsDirectory: true }),
      ]),
      '/etc': dirState([entry('hosts', EntryType.FILE)]),
    },
    expanded: new Set(['/']),
    selected: null,
    busy: new Set(),
    onToggle: jest.fn(),
    onSelect: jest.fn(),
    onContextMenu: jest.fn(),
    onDropFiles: jest.fn(),
    onMove: jest.fn(),
    readOnlyMounts: [],
    ...overrides,
  };
  return { props, ...render(<FileTree {...props} />) };
};

/** A DataTransfer stand-in: jsdom has no constructor for one. */
const dataTransfer = (opts: { move?: string; files?: unknown[] } = {}) => ({
  types: [...(opts.move ? [MOVE_MIME] : []), ...(opts.files ? ['Files'] : [])],
  getData: (type: string) => (type === MOVE_MIME ? (opts.move ?? '') : ''),
  files: opts.files ?? [],
  dropEffect: '',
  effectAllowed: '',
  setData: jest.fn(),
});

describe('FileTree', () => {
  it('renders only the children of expanded directories', () => {
    renderTree();

    expect(screen.getByTestId('filesystem-row-/etc')).toBeInTheDocument();
    expect(screen.getByTestId('filesystem-row-/motd')).toBeInTheDocument();
    // /etc is in `dirs` but not expanded, so nothing under it is drawn.
    expect(screen.queryByTestId('filesystem-row-/etc/hosts')).not.toBeInTheDocument();
  });

  it('shows a symlink with its target, and lets one pointing at a directory expand', () => {
    renderTree();
    const link = screen.getByTestId('filesystem-row-/link');

    expect(link).toHaveTextContent('→ /etc');
    expect(link).toHaveAttribute('aria-expanded', 'false');
    // A plain file offers no expansion at all.
    expect(screen.getByTestId('filesystem-row-/motd')).not.toHaveAttribute('aria-expanded');
  });

  it('toggles a directory on click and leaves a file alone', () => {
    const { props } = renderTree();

    fireEvent.click(screen.getByTestId('filesystem-row-/etc'));
    expect(props.onToggle).toHaveBeenCalledWith('/etc');

    (props.onToggle as jest.Mock).mockClear();
    fireEvent.click(screen.getByTestId('filesystem-row-/motd'));
    expect(props.onToggle).not.toHaveBeenCalled();
    expect(props.onSelect).toHaveBeenCalled();
  });

  it('opens the context menu at the pointer instead of the browser menu', () => {
    const { props } = renderTree();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: 120 });
    Object.defineProperty(event, 'clientY', { value: 240 });
    fireEvent(screen.getByTestId('filesystem-row-/motd'), event);

    expect(event.defaultPrevented).toBe(true);
    expect(props.onContextMenu).toHaveBeenCalledWith('/motd', expect.objectContaining({ name: 'motd' }), expect.anything());
  });

  it('uploads dropped files into the folder they were dropped on', () => {
    const { props } = renderTree();
    const files = [{ name: 'a.txt' }];

    fireEvent.drop(screen.getByTestId('filesystem-row-/etc'), { dataTransfer: dataTransfer({ files }) });

    expect(props.onDropFiles).toHaveBeenCalledWith('/etc', files);
  });

  it('treats a drop on a file as a drop into its parent folder', () => {
    const { props } = renderTree();
    const files = [{ name: 'a.txt' }];

    fireEvent.drop(screen.getByTestId('filesystem-row-/motd'), { dataTransfer: dataTransfer({ files }) });

    expect(props.onDropFiles).toHaveBeenCalledWith('/', files);
  });

  it('moves an entry dragged from the tree onto a folder', () => {
    const { props } = renderTree();

    fireEvent.drop(screen.getByTestId('filesystem-row-/etc'), {
      dataTransfer: dataTransfer({ move: '/motd' }),
    });

    expect(props.onMove).toHaveBeenCalledWith('/motd', '/etc');
    expect(props.onDropFiles).not.toHaveBeenCalled();
  });

  it('surfaces a directory that could not be listed, and one that was cut short', () => {
    renderTree({
      expanded: new Set(['/', '/etc']),
      dirs: {
        '/': dirState([entry('etc', EntryType.DIRECTORY)]),
        '/etc': dirState([entry('hosts', EntryType.FILE)], { truncated: true }),
      },
    });
    expect(screen.getByText(/Only the first/)).toBeInTheDocument();

    renderTree({
      dirs: { '/': dirState([], { error: 'permission denied' }) },
    });
    expect(screen.getByText('permission denied')).toBeInTheDocument();
  });
});

import * as React from 'react';
import type { FC, MouseEvent, Ref } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Flex,
  FlexItem,
  MenuToggle,
  Progress,
  ProgressSize,
  Select,
  SelectList,
  SelectOption,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import type { MenuToggleElement } from '@patternfly/react-core';
import { SyncAltIcon, UploadIcon } from '@patternfly/react-icons';
import { ConnectError } from '@connectrpc/connect';
import type { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import type { Entry, StatResponse } from '../gen/filesystem/v1/filesystem_pb';
import { EntryType } from '../gen/filesystem/v1/filesystem_pb';
import { createFileBrowserClient } from '../shared/client';
import { DEFAULT_CONFIG, loadPluginConfig } from '../shared/config';
import type { PluginConfig } from '../shared/config';
import { ContextMenu } from './ContextMenu';
import type { MenuAction } from './ContextMenu';
import {
  ArchiveModal,
  DeleteModal,
  ExtractModal,
  InfoModal,
  MoveModal,
  NewFolderModal,
  ViewModal,
} from './Dialogs';
import { FileTree } from './FileTree';
import type { DirState } from './FileTree';
import { baseName, joinPath, looksLikeArchive, parentPath } from './format';
import type { PodKind } from './types';
import {
  ARCHIVE_FORMATS,
  archiveFormatById,
  downloadArchive,
  downloadFile,
  readFileBytes,
  uploadFile,
} from './transfer';
import type { BrowseTarget } from './transfer';
import './file-browser.css';

type Dialog =
  | { kind: 'info'; path: string; stat: StatResponse }
  | { kind: 'view'; path: string; bytes: Uint8Array; truncated: boolean }
  | { kind: 'move'; path: string }
  | { kind: 'archive'; path: string }
  | { kind: 'extract'; path: string }
  | { kind: 'newFolder'; directory: string }
  | { kind: 'delete'; path: string; entry: Entry | null };

type ContextState = { x: number; y: number; path: string; entry: Entry | null };

type Transfer = { label: string; done: number; total?: number };

const ROOT = '/';

/** ConnectError carries the agent's own message; anything else is a surprise. */
const errorMessage = (error: unknown): string => {
  if (error instanceof ConnectError) {
    return error.rawMessage || error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * The Pod details page's "Files" tab.
 *
 * Every call goes to this plugin's backend over console's plugin proxy, which
 * checks that the logged-in user could `kubectl exec` into this pod before it
 * forwards anything to the node's agent -- so what a user can reach here is
 * exactly what they could already reach with a shell.
 */
export const PodFileBrowserTab: FC<PageComponentProps<PodKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');

  const namespace = obj?.metadata?.namespace ?? '';
  const podName = obj?.metadata?.name ?? '';

  const containers = useMemo(
    () => [
      ...(obj?.spec?.containers ?? []).map((container) => container.name),
      ...(obj?.spec?.initContainers ?? []).map((container) => container.name),
    ],
    [obj?.spec?.containers, obj?.spec?.initContainers],
  );

  // The same "pin to this container" annotation console core honours on its
  // Terminal and Logs tabs, so a pod that names a default container opens on
  // the one its author meant.
  const preferred = obj?.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];
  const [chosenContainer, setChosenContainer] = useState<string | null>(null);
  const container =
    (chosenContainer && containers.includes(chosenContainer) ? chosenContainer : null) ??
    (preferred && containers.includes(preferred) ? preferred : null) ??
    containers[0] ??
    '';

  // Read-only volume mounts of the container being browsed, so the tree can
  // flag paths under them rather than letting a write fail on the agent.
  const readOnlyMounts = useMemo(() => {
    const spec = [...(obj?.spec?.containers ?? []), ...(obj?.spec?.initContainers ?? [])].find(
      (candidate) => candidate.name === container,
    );
    return (spec?.volumeMounts ?? [])
      .filter((mount) => mount.readOnly && mount.mountPath)
      .map((mount) => mount.mountPath);
  }, [obj?.spec?.containers, obj?.spec?.initContainers, container]);

  const client = useMemo(() => createFileBrowserClient(), []);
  const target = useMemo<BrowseTarget>(
    () => ({ namespace, pod: podName, container }),
    [namespace, podName, container],
  );

  const [config, setConfig] = useState<PluginConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    let live = true;
    // A config the backend would not serve leaves DEFAULT_CONFIG in place;
    // the tab is already open, and its defaults are better than nothing.
    loadPluginConfig()
      .then((loaded) => live && setConfig(loaded))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]));
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [containerSelectOpen, setContainerSelectOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDirectory = useRef<string>(ROOT);

  const markBusy = useCallback((path: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }, []);

  const loadDirectory = useCallback(
    async (path: string) => {
      setDirs((current) => ({
        ...current,
        [path]: { entries: current[path]?.entries ?? [], truncated: false, loading: true },
      }));
      try {
        const response = await client.listDirectory({ target, path });
        setDirs((current) => ({
          ...current,
          [path]: { entries: response.entries, truncated: response.truncated, loading: false },
        }));
      } catch (caught) {
        setDirs((current) => ({
          ...current,
          [path]: { entries: [], truncated: false, loading: false, error: errorMessage(caught) },
        }));
      }
    },
    [client, target],
  );

  // A container switch invalidates every path in the tree: the same path in
  // another container is a different file.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set([ROOT]));
    setSelected(null);
    setError(null);
    setNotice(null);
    if (namespace && podName && container) {
      void loadDirectory(ROOT);
    }
  }, [namespace, podName, container, loadDirectory]);

  /** Reloads a directory only if it has been opened; unopened ones reload when they are. */
  const refresh = useCallback(
    (path: string) => {
      setDirs((current) => {
        if (!(path in current)) {
          return current;
        }
        void loadDirectory(path);
        return current;
      });
    },
    [loadDirectory],
  );

  const onToggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!dirs[path]) {
            void loadDirectory(path);
          }
        }
        return next;
      });
    },
    [dirs, loadDirectory],
  );

  /** Wraps an action with the busy marker, error banner and a refresh. */
  const run = useCallback(
    async (path: string, action: () => Promise<string | void>, refreshPaths: string[]) => {
      markBusy(path, true);
      setError(null);
      try {
        const message = await action();
        if (message) {
          setNotice(message);
        }
        refreshPaths.forEach(refresh);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        markBusy(path, false);
        setTransfer(null);
      }
    },
    [markBusy, refresh],
  );

  const doUpload = useCallback(
    (directory: string, files: FileList) => {
      const list = Array.from(files);
      void run(
        directory,
        async () => {
          for (const [index, file] of list.entries()) {
            await uploadFile(client, target, directory, file, {
              chunkBytes: config.uploadChunkBytes,
              onProgress: (done, total) =>
                setTransfer({
                  label: t('Uploading {{name}} ({{index}} of {{count}})', {
                    name: file.name,
                    index: index + 1,
                    count: list.length,
                  }),
                  done,
                  total,
                }),
            });
          }
          return list.length === 1
            ? t('Uploaded {{name}}.', { name: list[0].name })
            : t('Uploaded {{count}} files.', { count: list.length });
        },
        [directory],
      );
    },
    [client, config.uploadChunkBytes, run, t, target],
  );

  const doMove = useCallback(
    (source: string, destination: string, overwrite: boolean) =>
      run(
        source,
        async () => {
          await client.move({ target, source, destination, overwrite });
          return t('Moved to {{destination}}.', { destination });
        },
        [parentPath(source), parentPath(destination)],
      ),
    [client, run, t, target],
  );

  const onDropMove = useCallback(
    (source: string, directory: string) => {
      const destination = joinPath(directory, baseName(source));
      if (destination === source || directory === parentPath(source)) {
        return;
      }
      void doMove(source, destination, false);
    },
    [doMove],
  );

  const openContextMenu = useCallback((path: string, entry: Entry | null, event: MouseEvent) => {
    setContextMenu({ x: event.clientX, y: event.clientY, path, entry });
  }, []);

  const startArchive = useCallback(
    (path: string, formatId: string) =>
      void run(
        path,
        () =>
          downloadArchive(client, target, path, archiveFormatById(formatId), {
            onProgress: (done) =>
              setTransfer({ label: t('Archiving {{name}}', { name: baseName(path) || '/' }), done }),
          }),
        [],
      ),
    [client, run, t, target],
  );

  const actions = useMemo<MenuAction[]>(() => {
    if (!contextMenu) {
      return [];
    }
    const { path, entry } = contextMenu;
    const isRoot = path === ROOT;
    const isDirectory =
      isRoot ||
      entry?.type === EntryType.DIRECTORY ||
      (entry?.type === EntryType.SYMLINK && entry.targetIsDirectory);
    const isFile = !isRoot && entry?.type === EntryType.FILE;
    const defaultFormat = ARCHIVE_FORMATS.some((format) => format.id === config.defaultArchiveFormat)
      ? config.defaultArchiveFormat
      : DEFAULT_CONFIG.defaultArchiveFormat;

    const list: MenuAction[] = [];

    if (isFile) {
      list.push({
        id: 'view',
        label: t('View'),
        onSelect: () =>
          void run(
            path,
            async () => {
              const bytes = await readFileBytes(client, target, path, {
                maxBytes: config.viewMaxBytes,
                onProgress: (done, total) => setTransfer({ label: t('Reading {{name}}', { name: baseName(path) }), done, total }),
              });
              setDialog({
                kind: 'view',
                path,
                bytes,
                truncated: bytes.length >= config.viewMaxBytes,
              });
            },
            [],
          ),
      });
      list.push({
        id: 'download',
        label: t('Download'),
        onSelect: () =>
          void run(
            path,
            () =>
              downloadFile(client, target, path, {
                onProgress: (done, total) =>
                  setTransfer({ label: t('Downloading {{name}}', { name: baseName(path) }), done, total }),
              }),
            [],
          ),
      });
    }

    if (isDirectory) {
      list.push({
        id: 'download-archive',
        label: t('Download as {{format}}', { format: defaultFormat }),
        onSelect: () => startArchive(path, defaultFormat),
      });
      list.push({
        id: 'download-archive-as',
        label: t('Download as…'),
        onSelect: () => setDialog({ kind: 'archive', path }),
      });
      list.push({
        id: 'upload',
        label: t('Upload files…'),
        separatorBefore: true,
        onSelect: () => {
          uploadDirectory.current = path;
          uploadInput.current?.click();
        },
      });
      list.push({
        id: 'new-folder',
        label: t('New folder…'),
        onSelect: () => setDialog({ kind: 'newFolder', directory: path }),
      });
    }

    if (isFile && looksLikeArchive(path)) {
      list.push({
        id: 'extract',
        label: t('Uncompress…'),
        separatorBefore: true,
        onSelect: () => setDialog({ kind: 'extract', path }),
      });
    }

    if (!isRoot) {
      list.push({
        id: 'info',
        label: t('Info'),
        separatorBefore: true,
        onSelect: () =>
          void run(
            path,
            async () => {
              const stat = await client.stat({ target, path });
              setDialog({ kind: 'info', path, stat });
            },
            [],
          ),
      });
      list.push({
        id: 'move',
        label: t('Move to…'),
        onSelect: () => setDialog({ kind: 'move', path }),
      });
      list.push({
        id: 'delete',
        label: t('Delete'),
        isDanger: true,
        onSelect: () => setDialog({ kind: 'delete', path, entry }),
      });
    }

    list.push({
      id: 'refresh',
      label: t('Refresh'),
      separatorBefore: true,
      onSelect: () => (isDirectory ? refresh(path) : refresh(parentPath(path))),
    });

    return list;
  }, [
    contextMenu,
    client,
    config.defaultArchiveFormat,
    config.viewMaxBytes,
    refresh,
    run,
    startArchive,
    t,
    target,
  ]);

  if (!namespace || !podName || containers.length === 0) {
    return <div className="filesystem-browser__loading">{t('Loading…')}</div>;
  }

  return (
    <div className="filesystem-browser" data-test="filesystem-browser">
      <Toolbar className="filesystem-browser__toolbar">
        <ToolbarContent alignItems="center">
          <Flex direction={{ default: 'column', sm: 'row' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>{t('Browsing')}</FlexItem>
            <FlexItem>
              {containers.length > 1 ? (
                <Select
                  isOpen={containerSelectOpen}
                  selected={container}
                  onSelect={(_event, value) => {
                    setChosenContainer(value as string);
                    setContainerSelectOpen(false);
                  }}
                  onOpenChange={setContainerSelectOpen}
                  toggle={(toggleRef: Ref<MenuToggleElement>) => (
                    <MenuToggle
                      ref={toggleRef}
                      isExpanded={containerSelectOpen}
                      onClick={() => setContainerSelectOpen(!containerSelectOpen)}
                      data-test="filesystem-container-select"
                    >
                      {container}
                    </MenuToggle>
                  )}
                  shouldFocusToggleOnSelect
                  popperProps={{ appendTo: 'inline' }}
                >
                  <SelectList>
                    {containers.map((name) => (
                      <SelectOption key={name} value={name} data-test-dropdown-menu={name}>
                        {name}
                      </SelectOption>
                    ))}
                  </SelectList>
                </Select>
              ) : (
                <span data-test="filesystem-container-label">{container}</span>
              )}
            </FlexItem>
          </Flex>
          <ToolbarGroup align={{ default: 'alignEnd' }}>
            <ToolbarItem>
              <Button
                variant="link"
                icon={<UploadIcon className="co-icon-space-r" />}
                onClick={() => {
                  uploadDirectory.current = selected && dirs[selected] ? selected : ROOT;
                  uploadInput.current?.click();
                }}
                data-test="filesystem-upload"
              >
                {t('Upload')}
              </Button>
            </ToolbarItem>
            <ToolbarItem>
              <Button
                variant="link"
                icon={<SyncAltIcon className="co-icon-space-r" />}
                onClick={() => Object.keys(dirs).forEach(refresh)}
                data-test="filesystem-refresh"
              >
                {t('Refresh')}
              </Button>
            </ToolbarItem>
          </ToolbarGroup>
        </ToolbarContent>
      </Toolbar>

      {error && (
        <Alert
          variant="danger"
          isInline
          className="pf-v6-u-mb-md"
          title={error}
          actionClose={<Button variant="plain" onClick={() => setError(null)} aria-label={t('Close')} />}
          data-test="filesystem-error"
        />
      )}
      {notice && (
        <Alert
          variant="success"
          isInline
          className="pf-v6-u-mb-md"
          title={notice}
          actionClose={<Button variant="plain" onClick={() => setNotice(null)} aria-label={t('Close')} />}
        />
      )}
      {transfer && (
        <Progress
          className="pf-v6-u-mb-md"
          size={ProgressSize.sm}
          title={transfer.label}
          value={transfer.total ? (transfer.done / transfer.total) * 100 : 100}
          label={transfer.total ? undefined : t('Working…')}
          measureLocation={transfer.total ? undefined : 'none'}
        />
      )}

      <Alert
        isInline
        isPlain
        variant="info"
        className="pf-v6-u-mb-sm"
        title={t('Right-click an entry for actions, or drop files onto a folder to upload them.')}
      />

      <FileTree
        dirs={dirs}
        expanded={expanded}
        selected={selected}
        busy={busy}
        onToggle={onToggle}
        onSelect={(path) => setSelected(path)}
        onContextMenu={openContextMenu}
        onDropFiles={doUpload}
        onMove={onDropMove}
        readOnlyMounts={readOnlyMounts}
      />

      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        data-test="filesystem-upload-input"
        onChange={(event) => {
          if (event.target.files?.length) {
            doUpload(uploadDirectory.current, event.target.files);
          }
          // Reset, so picking the same file twice in a row fires again.
          event.target.value = '';
        }}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={actions}
          onClose={() => setContextMenu(null)}
        />
      )}

      {dialog?.kind === 'info' && (
        <InfoModal path={dialog.path} stat={dialog.stat} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'view' && (
        <ViewModal
          path={dialog.path}
          bytes={dialog.bytes}
          truncated={dialog.truncated}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveModal
          path={dialog.path}
          onClose={() => setDialog(null)}
          onConfirm={(destination, overwrite) => {
            setDialog(null);
            void doMove(dialog.path, destination, overwrite);
          }}
        />
      )}
      {dialog?.kind === 'archive' && (
        <ArchiveModal
          path={dialog.path}
          defaultFormat={config.defaultArchiveFormat}
          onClose={() => setDialog(null)}
          onConfirm={(formatId) => {
            setDialog(null);
            startArchive(dialog.path, formatId);
          }}
        />
      )}
      {dialog?.kind === 'extract' && (
        <ExtractModal
          path={dialog.path}
          defaultDestination={defaultExtractDestination(dialog.path)}
          onClose={() => setDialog(null)}
          onConfirm={(destination, overwrite) => {
            setDialog(null);
            void run(
              dialog.path,
              async () => {
                const response = await client.extract({
                  target,
                  path: dialog.path,
                  destination,
                  overwrite,
                });
                return t('Unpacked {{count}} entries into {{destination}}.', {
                  count: Number(response.entriesWritten),
                  destination: response.destination,
                });
              },
              [parentPath(destination), parentPath(dialog.path)],
            );
          }}
        />
      )}
      {dialog?.kind === 'newFolder' && (
        <NewFolderModal
          directory={dialog.directory}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            const path = joinPath(dialog.directory, name);
            setDialog(null);
            void run(
              dialog.directory,
              async () => {
                await client.createDirectory({ target, path, mode: 0 });
                return t('Created {{path}}.', { path });
              },
              [dialog.directory],
            );
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteModal
          path={dialog.path}
          entry={dialog.entry}
          onClose={() => setDialog(null)}
          onConfirm={(recursive) => {
            setDialog(null);
            void run(
              dialog.path,
              async () => {
                await client.delete({ target, path: dialog.path, recursive });
                return t('Deleted {{path}}.', { path: dialog.path });
              },
              [parentPath(dialog.path)],
            );
          }}
        />
      )}
    </div>
  );
};

/**
 * Mirrors the agent's own default: the archive's name with its suffix
 * stripped, so the modal opens on what would happen anyway.
 */
const ARCHIVE_SUFFIXES = ['.tar.zst', '.tar.zstd', '.tar.gz', '.tgz', '.tzst', '.tar', '.zip'];

export const defaultExtractDestination = (path: string): string => {
  const lower = path.toLowerCase();
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return path.slice(0, path.length - suffix.length);
    }
  }
  return `${path}.extracted`;
};

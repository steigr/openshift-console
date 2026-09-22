import * as React from 'react';
import type { FC, Ref } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Form,
  FormGroup,
  MenuToggle,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectList,
  SelectOption,
  TextInput,
} from '@patternfly/react-core';
import type { MenuToggleElement } from '@patternfly/react-core';

import type { Entry, StatResponse } from '../gen/filesystem/v1/filesystem_pb';
import { EntryType } from '../gen/filesystem/v1/filesystem_pb';
import { baseName, formatMode, formatOctal, formatSize, formatTime, parentPath } from './format';
import { ARCHIVE_FORMATS } from './transfer';

type Closable = { onClose: () => void };

/** "Info": everything the agent's Stat call reports about one entry. */
export const InfoModal: FC<Closable & { path: string; stat: StatResponse }> = ({
  path,
  stat,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const entry = stat.entry;

  const rows: [string, React.ReactNode][] = [
    [t('Path'), <code key="p">{path}</code>],
    [t('Type'), typeLabel(t, entry?.type)],
    [t('Size'), entry ? `${formatSize(entry.size)} (${entry.size.toString()} B)` : '-'],
    [
      t('Permissions'),
      entry ? `${formatMode(entry.mode, entry.type)}  ${formatOctal(entry.mode)}` : '-',
    ],
    [t('Owner'), entry ? `${entry.uid}:${entry.gid}` : '-'],
    [t('Modified'), entry ? formatTime(entry.modifiedUnix) : '-'],
    [t('Accessed'), formatTime(stat.accessedUnix)],
    [t('Changed'), formatTime(stat.changedUnix)],
    [t('Links'), stat.hardLinks.toString()],
    [t('Inode'), `${stat.inode.toString()} (device ${stat.device.toString()})`],
  ];

  if (entry?.linkTarget) {
    rows.splice(2, 0, [t('Link target'), <code key="l">{entry.linkTarget}</code>]);
  }
  if (stat.filesystemType) {
    rows.push([
      t('Filesystem'),
      stat.filesystemTotalBytes > 0n
        ? t('{{type}} - {{free}} free of {{total}}', {
            type: stat.filesystemType,
            free: formatSize(stat.filesystemFreeBytes),
            total: formatSize(stat.filesystemTotalBytes),
          })
        : stat.filesystemType,
    ]);
  }

  return (
    <Modal isOpen variant="medium" onClose={onClose} aria-label={t('File information')}>
      <ModalHeader title={baseName(path)} />
      <ModalBody>
        <DescriptionList isHorizontal isCompact>
          {rows.map(([term, description]) => (
            <DescriptionListGroup key={term}>
              <DescriptionListTerm>{term}</DescriptionListTerm>
              <DescriptionListDescription>{description}</DescriptionListDescription>
            </DescriptionListGroup>
          ))}
        </DescriptionList>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

const typeLabel = (t: (key: string) => string, type?: EntryType): string => {
  switch (type) {
    case EntryType.DIRECTORY:
      return t('Directory');
    case EntryType.SYMLINK:
      return t('Symbolic link');
    case EntryType.FILE:
      return t('Regular file');
    case EntryType.BLOCK_DEVICE:
      return t('Block device');
    case EntryType.CHAR_DEVICE:
      return t('Character device');
    case EntryType.SOCKET:
      return t('Socket');
    case EntryType.FIFO:
      return t('Named pipe (FIFO)');
    default:
      return t('Other');
  }
};

/**
 * "View": the file's bytes, decoded as UTF-8. Anything holding a NUL in its
 * first kilobyte is treated as binary and not shown at all, rather than
 * rendered as replacement characters that look like corruption.
 */
export const ViewModal: FC<Closable & { path: string; bytes: Uint8Array; truncated: boolean }> = ({
  path,
  bytes,
  truncated,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const binary = bytes.slice(0, 1024).includes(0);
  const text = binary ? '' : new TextDecoder().decode(bytes);

  return (
    <Modal isOpen variant="large" onClose={onClose} aria-label={t('File contents')}>
      <ModalHeader title={baseName(path)} description={path} />
      <ModalBody>
        {binary ? (
          <Alert
            isInline
            variant="info"
            title={t('This looks like a binary file, so it is not shown here. Download it instead.')}
          />
        ) : (
          <>
            {truncated && (
              <Alert
                isInline
                variant="warning"
                className="pf-v6-u-mb-md"
                title={t('Only the first {{size}} are shown. Download the file for the rest.', {
                  size: formatSize(bytes.length),
                })}
              />
            )}
            <pre className="filesystem-viewer" data-test="filesystem-viewer">
              {text}
            </pre>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/** "Move to…": a destination path, prefilled with where the entry is now. */
export const MoveModal: FC<Closable & { path: string; onConfirm: (destination: string, overwrite: boolean) => void }> = ({
  path,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const [destination, setDestination] = useState(path);
  const [overwrite, setOverwrite] = useState(false);
  const unchanged = destination.trim() === '' || destination === path;

  return (
    <Modal isOpen variant="small" onClose={onClose} aria-label={t('Move')}>
      <ModalHeader title={t('Move {{name}}', { name: baseName(path) })} />
      <ModalBody>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            if (!unchanged) {
              onConfirm(destination, overwrite);
            }
          }}
        >
          <FormGroup label={t('Destination path')} fieldId="filesystem-move-destination" isRequired>
            <TextInput
              id="filesystem-move-destination"
              value={destination}
              onChange={(_event, value) => setDestination(value)}
              data-test="filesystem-move-destination"
              autoFocus
            />
          </FormGroup>
          <Checkbox
            id="filesystem-move-overwrite"
            label={t('Replace the destination if it already exists')}
            isChecked={overwrite}
            onChange={(_event, checked) => setOverwrite(checked)}
          />
          <Alert
            isInline
            variant="info"
            isPlain
            title={t('A move stays inside this container and cannot cross a mount point.')}
          />
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          isDisabled={unchanged}
          onClick={() => onConfirm(destination, overwrite)}
          data-test="filesystem-move-confirm"
        >
          {t('Move')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/** "Download as…": the archive format for a folder download. */
export const ArchiveModal: FC<Closable & { path: string; defaultFormat: string; onConfirm: (formatId: string) => void }> = ({
  path,
  defaultFormat,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const [formatId, setFormatId] = useState(defaultFormat);
  const [isOpen, setIsOpen] = useState(false);
  const selected = ARCHIVE_FORMATS.find((format) => format.id === formatId) ?? ARCHIVE_FORMATS[0];

  return (
    <Modal isOpen variant="small" onClose={onClose} aria-label={t('Download folder')}>
      <ModalHeader title={t('Download {{name}}', { name: baseName(path) || '/' })} />
      <ModalBody>
        <FormGroup label={t('Archive format')} fieldId="filesystem-archive-format">
          <Select
            isOpen={isOpen}
            selected={formatId}
            onSelect={(_event, value) => {
              setFormatId(value as string);
              setIsOpen(false);
            }}
            onOpenChange={setIsOpen}
            toggle={(toggleRef: Ref<MenuToggleElement>) => (
              <MenuToggle
                ref={toggleRef}
                isExpanded={isOpen}
                onClick={() => setIsOpen(!isOpen)}
                data-test="filesystem-archive-format"
              >
                {selected.label}
              </MenuToggle>
            )}
            popperProps={{ appendTo: 'inline' }}
          >
            <SelectList>
              {ARCHIVE_FORMATS.map((format) => (
                <SelectOption key={format.id} value={format.id}>
                  {format.label}
                </SelectOption>
              ))}
            </SelectList>
          </Select>
        </FormGroup>
        <Alert
          isInline
          isPlain
          variant="info"
          className="pf-v6-u-mt-md"
          title={t(
            'The archive is built and compressed on the node, at the level the agent was rolled out with.',
          )}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={() => onConfirm(formatId)} data-test="filesystem-archive-confirm">
          {t('Download')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/** "Uncompress": where to unpack, and whether to overwrite what is there. */
export const ExtractModal: FC<Closable & { path: string; defaultDestination: string; onConfirm: (destination: string, overwrite: boolean) => void }> = ({
  path,
  defaultDestination,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const [destination, setDestination] = useState(defaultDestination);
  const [overwrite, setOverwrite] = useState(false);

  return (
    <Modal isOpen variant="small" onClose={onClose} aria-label={t('Uncompress')}>
      <ModalHeader title={t('Uncompress {{name}}', { name: baseName(path) })} />
      <ModalBody>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm(destination, overwrite);
          }}
        >
          <FormGroup label={t('Unpack into')} fieldId="filesystem-extract-destination" isRequired>
            <TextInput
              id="filesystem-extract-destination"
              value={destination}
              onChange={(_event, value) => setDestination(value)}
              data-test="filesystem-extract-destination"
              autoFocus
            />
          </FormGroup>
          <Checkbox
            id="filesystem-extract-overwrite"
            label={t('Replace files that already exist there')}
            isChecked={overwrite}
            onChange={(_event, checked) => setOverwrite(checked)}
          />
          <Alert
            isInline
            isPlain
            variant="info"
            title={t('zip, tar, tar.gz and tar.zst are recognised by their contents, not their name.')}
          />
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          isDisabled={!destination.trim()}
          onClick={() => onConfirm(destination, overwrite)}
          data-test="filesystem-extract-confirm"
        >
          {t('Uncompress')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/** "New folder", offered on a directory. */
export const NewFolderModal: FC<Closable & { directory: string; onConfirm: (path: string) => void }> = ({
  directory,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const [name, setName] = useState('');
  const invalid = !name.trim() || name.includes('/');

  return (
    <Modal isOpen variant="small" onClose={onClose} aria-label={t('New folder')}>
      <ModalHeader title={t('New folder in {{directory}}', { directory })} />
      <ModalBody>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) {
              onConfirm(name.trim());
            }
          }}
        >
          <FormGroup label={t('Name')} fieldId="filesystem-new-folder" isRequired>
            <TextInput
              id="filesystem-new-folder"
              value={name}
              onChange={(_event, value) => setName(value)}
              validated={name && invalid ? 'error' : 'default'}
              data-test="filesystem-new-folder"
              autoFocus
            />
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" isDisabled={invalid} onClick={() => onConfirm(name.trim())}>
          {t('Create')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/**
 * Delete confirmation. A directory needs the recursive box ticked, which is
 * the same distinction the agent enforces -- an empty directory goes either
 * way, a full one only with it.
 */
export const DeleteModal: FC<Closable & { path: string; entry: Entry | null; onConfirm: (recursive: boolean) => void }> = ({
  path,
  entry,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation('plugin__filesystem-console-plugin');
  const isDirectory = entry?.type === EntryType.DIRECTORY;
  const [recursive, setRecursive] = useState(false);

  return (
    <Modal isOpen variant="small" onClose={onClose} aria-label={t('Delete')}>
      <ModalHeader title={t('Delete {{name}}?', { name: baseName(path) })} titleIconVariant="warning" />
      <ModalBody>
        <p>
          {t('This removes {{path}} from the container. It cannot be undone.', { path })}
        </p>
        {isDirectory && (
          <Checkbox
            id="filesystem-delete-recursive"
            className="pf-v6-u-mt-md"
            label={t('Delete everything inside it as well')}
            isChecked={recursive}
            onChange={(_event, checked) => setRecursive(checked)}
            data-test="filesystem-delete-recursive"
          />
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="danger" onClick={() => onConfirm(recursive)} data-test="filesystem-delete-confirm">
          {t('Delete')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export { parentPath };

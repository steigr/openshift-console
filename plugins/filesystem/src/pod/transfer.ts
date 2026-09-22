import type { Client } from '@connectrpc/connect';

import type { FileBrowser } from '../gen/filesystem/v1/filesystem_pb';
import { ArchiveFormat } from '../gen/filesystem/v1/filesystem_pb';
import { baseName } from './format';

export type FileBrowserClient = Client<typeof FileBrowser>;

/**
 * The container every call names. This is the plain-object init shape rather
 * than the generated Target message type: protobuf-es messages carry a
 * $typeName that only generated code produces, while a Connect client accepts
 * the init shape and fills it in.
 */
export type BrowseTarget = {
  namespace: string;
  pod: string;
  container: string;
};

export type Progress = (bytes: number, total?: number) => void;

/**
 * Hands a Blob to the browser as a download.
 *
 * The whole file is in memory by the time this runs. That is a deliberate
 * limit rather than an oversight: streaming straight to disk needs the File
 * System Access API, which is Chromium-only and must be invoked synchronously
 * from the click that started it. The agent's own --max-archive-bytes and
 * --max-read-bytes are what keep a download inside what a tab can hold.
 */
export const saveBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: revoking synchronously races the navigation the
  // click just started in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Streams a file's bytes, reporting progress against the size the first message carries. */
export const readFileBytes = async (
  client: FileBrowserClient,
  target: BrowseTarget,
  path: string,
  options: { maxBytes?: number; signal?: AbortSignal; onProgress?: Progress } = {},
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let total: number | undefined;

  for await (const message of client.readFile(
    { target, path, maxBytes: BigInt(options.maxBytes ?? 0) },
    { signal: options.signal },
  )) {
    if (message.totalSize && total === undefined) {
      total = Number(message.totalSize);
    }
    if (message.data.length) {
      chunks.push(message.data);
      received += message.data.length;
      options.onProgress?.(received, total);
    }
  }
  return concat(chunks, received);
};

export const downloadFile = async (
  client: FileBrowserClient,
  target: BrowseTarget,
  path: string,
  options: { signal?: AbortSignal; onProgress?: Progress } = {},
): Promise<void> => {
  const bytes = await readFileBytes(client, target, path, options);
  saveBlob(new Blob([bytes as BlobPart]), baseName(path));
};

export const downloadArchive = async (
  client: FileBrowserClient,
  target: BrowseTarget,
  path: string,
  format: ArchiveFormat,
  options: { signal?: AbortSignal; onProgress?: Progress } = {},
): Promise<void> => {
  const chunks: Uint8Array[] = [];
  let received = 0;
  // The agent names the download in the first message, since it is the side
  // that knows which suffix the format it actually used carries.
  let filename = `${baseName(path) || 'root'}.archive`;

  for await (const message of client.archive(
    { target, path, format, compressionLevel: 0 },
    { signal: options.signal },
  )) {
    if (message.filename) {
      filename = message.filename;
    }
    if (message.data.length) {
      chunks.push(message.data);
      received += message.data.length;
      options.onProgress?.(received);
    }
  }
  saveBlob(new Blob([concat(chunks, received) as BlobPart]), filename);
};

/**
 * Uploads one browser File into a directory, a chunk per unary call.
 *
 * The first chunk goes at offset 0, which truncates - so a retried upload
 * replaces the file rather than leaving an older, longer one's tail behind.
 */
export const uploadFile = async (
  client: FileBrowserClient,
  target: BrowseTarget,
  directory: string,
  file: File,
  options: { chunkBytes: number; signal?: AbortSignal; onProgress?: Progress } = {
    chunkBytes: 4 * 1024 * 1024,
  },
): Promise<void> => {
  const path = directory === '/' ? `/${file.name}` : `${directory.replace(/\/+$/, '')}/${file.name}`;
  const chunkBytes = Math.max(1, options.chunkBytes);

  // An empty file still needs one call, or it is never created at all.
  for (let offset = 0; offset === 0 || offset < file.size; offset += chunkBytes) {
    const slice = file.slice(offset, Math.min(offset + chunkBytes, file.size));
    const data = new Uint8Array(await slice.arrayBuffer());
    const last = offset + chunkBytes >= file.size;
    await client.upload(
      { target, path, offset: BigInt(offset), data, last, mode: 0 },
      { signal: options.signal },
    );
    options.onProgress?.(Math.min(offset + data.length, file.size), file.size);
    if (last) {
      break;
    }
  }
};

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export const ARCHIVE_FORMATS: { id: string; label: string; format: ArchiveFormat }[] = [
  { id: 'tar.gz', label: 'tar.gz', format: ArchiveFormat.TAR_GZ },
  { id: 'tar.zst', label: 'tar.zst', format: ArchiveFormat.TAR_ZSTD },
  { id: 'zip', label: 'zip', format: ArchiveFormat.ZIP },
  { id: 'tar', label: 'tar (no compression)', format: ArchiveFormat.TAR },
];

export const archiveFormatById = (id: string): ArchiveFormat =>
  ARCHIVE_FORMATS.find((entry) => entry.id === id)?.format ?? ArchiveFormat.TAR_GZ;

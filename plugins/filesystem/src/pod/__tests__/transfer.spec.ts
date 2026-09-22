import { ArchiveFormat } from '../../gen/filesystem/v1/filesystem_pb';
import type { BrowseTarget, FileBrowserClient } from '../transfer';
import { archiveFormatById, downloadArchive, readFileBytes, uploadFile } from '../transfer';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(() => Promise.resolve({})),
}));

const target: BrowseTarget = { namespace: 'team-a', pod: 'web-0', container: 'app' };

/** jsdom has no object URLs; the download path only needs them to exist. */
const stubObjectURL = () => {
  const saved: { blob?: Blob; filename?: string } = {};
  const createObjectURL = jest.fn((blob: Blob) => {
    saved.blob = blob;
    return 'blob:stub';
  });
  Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function mockClick(this: HTMLAnchorElement) {
      saved.filename = this.download;
    });
  return { saved, click };
};

const stream = <T>(messages: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const message of messages) {
      yield message;
    }
  },
});

describe('readFileBytes', () => {
  it('joins the streamed chunks and reports progress against the declared size', async () => {
    const client = {
      readFile: jest.fn(() =>
        stream([
          { data: new Uint8Array([104, 105]), totalSize: 5n },
          { data: new Uint8Array([32, 121, 111]), totalSize: 0n },
        ]),
      ),
    } as unknown as FileBrowserClient;

    const progress: [number, number | undefined][] = [];
    const bytes = await readFileBytes(client, target, '/etc/motd', {
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(new TextDecoder().decode(bytes)).toBe('hi yo');
    expect(progress).toEqual([
      [2, 5],
      [5, 5],
    ]);
  });

  it('passes the viewer byte cap through as maxBytes', async () => {
    const readFile = jest.fn(() => stream([{ data: new Uint8Array([1]), totalSize: 1n }]));
    const client = { readFile } as unknown as FileBrowserClient;

    await readFileBytes(client, target, '/big', { maxBytes: 1024 });

    expect(readFile).toHaveBeenCalledWith(
      { target, path: '/big', maxBytes: 1024n },
      expect.anything(),
    );
  });
});

describe('uploadFile', () => {
  it('sends one chunk per slice, truncating at offset 0 and flagging the last', async () => {
    const upload = jest.fn(async (_request: Record<string, unknown>) => ({
      bytesWritten: 0n,
      size: 0n,
    }));
    const client = { upload } as unknown as FileBrowserClient;

    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'blob.bin');
    await uploadFile(client, target, '/srv', file, { chunkBytes: 2 });

    expect(upload).toHaveBeenCalledTimes(3);
    const calls = upload.mock.calls.map(([request]) => request);
    expect(calls.map((call) => call.offset)).toEqual([0n, 2n, 4n]);
    expect(calls.map((call) => call.last)).toEqual([false, false, true]);
    expect(calls.every((call) => call.path === '/srv/blob.bin')).toBe(true);
    expect(Array.from(calls[2].data as Uint8Array)).toEqual([5]);
  });

  it('still creates an empty file, which needs a call of its own', async () => {
    const upload = jest.fn(async (_request: Record<string, unknown>) => ({
      bytesWritten: 0n,
      size: 0n,
    }));
    const client = { upload } as unknown as FileBrowserClient;

    await uploadFile(client, target, '/', new File([], 'empty'), { chunkBytes: 1024 });

    expect(upload).toHaveBeenCalledTimes(1);
    const [request] = upload.mock.calls[0];
    expect(request.path).toBe('/empty');
    expect(request.last).toBe(true);
  });
});

describe('downloadArchive', () => {
  it('names the download from the filename the agent sends first', async () => {
    const { saved } = stubObjectURL();
    const client = {
      archive: jest.fn(() =>
        stream([
          { data: new Uint8Array([31, 139]), filename: 'log.tar.gz' },
          { data: new Uint8Array([8, 0]), filename: '' },
        ]),
      ),
    } as unknown as FileBrowserClient;

    await downloadArchive(client, target, '/var/log', ArchiveFormat.TAR_GZ);

    expect(saved.filename).toBe('log.tar.gz');
    expect(saved.blob?.size).toBe(4);
  });
});

describe('archiveFormatById', () => {
  it('maps the ids the config and the modal use', () => {
    expect(archiveFormatById('zip')).toBe(ArchiveFormat.ZIP);
    expect(archiveFormatById('tar')).toBe(ArchiveFormat.TAR);
    expect(archiveFormatById('tar.zst')).toBe(ArchiveFormat.TAR_ZSTD);
    // An unknown id falls back rather than sending UNSPECIFIED, which the
    // agent would have to guess about.
    expect(archiveFormatById('rar')).toBe(ArchiveFormat.TAR_GZ);
  });
});

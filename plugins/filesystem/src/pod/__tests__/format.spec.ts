import { EntryType } from '../../gen/filesystem/v1/filesystem_pb';
import {
  baseName,
  formatMode,
  formatOctal,
  formatSize,
  joinPath,
  looksLikeArchive,
  parentPath,
} from '../format';
import { defaultExtractDestination } from '../PodFileBrowserTab';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  consoleFetchJSON: jest.fn(() => Promise.resolve({})),
}));

describe('formatSize', () => {
  it('uses binary units, like ls -lh', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1.0 KiB');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(20 * 1024)).toBe('20 KiB');
    expect(formatSize(3n * 1024n * 1024n * 1024n)).toBe('3.0 GiB');
  });

  it('survives a nonsensical size rather than rendering NaN', () => {
    expect(formatSize(-1)).toBe('-');
  });
});

describe('formatMode', () => {
  it('renders the type and the permission triples', () => {
    expect(formatMode(0o755, EntryType.DIRECTORY)).toBe('drwxr-xr-x');
    expect(formatMode(0o644, EntryType.FILE)).toBe('-rw-r--r--');
    expect(formatMode(0o777, EntryType.SYMLINK)).toBe('lrwxrwxrwx');
  });

  it('overlays setuid, setgid and sticky the way ls does', () => {
    // 4755: setuid on an executable is a lowercase s.
    expect(formatMode(0o4755, EntryType.FILE)).toBe('-rwsr-xr-x');
    // 4644: setuid without the execute bit is an uppercase S.
    expect(formatMode(0o4644, EntryType.FILE)).toBe('-rwSr--r--');
    expect(formatMode(0o2755, EntryType.FILE)).toBe('-rwxr-sr-x');
    expect(formatMode(0o1777, EntryType.DIRECTORY)).toBe('drwxrwxrwt');
  });

  it('renders the octal form the way chmod takes it', () => {
    expect(formatOctal(0o644)).toBe('0644');
    expect(formatOctal(0o4755)).toBe('04755');
  });
});

describe('paths', () => {
  it('joins without doubling separators', () => {
    expect(joinPath('/', 'etc')).toBe('/etc');
    expect(joinPath('/var', 'log')).toBe('/var/log');
    expect(joinPath('/var/', 'log')).toBe('/var/log');
  });

  it('treats the root as its own parent', () => {
    expect(parentPath('/etc/hosts')).toBe('/etc');
    expect(parentPath('/etc')).toBe('/');
    expect(parentPath('/')).toBe('/');
  });

  it('takes the last component as the name', () => {
    expect(baseName('/etc/hosts')).toBe('hosts');
    expect(baseName('/etc/')).toBe('etc');
    expect(baseName('/')).toBe('/');
  });
});

describe('archives', () => {
  it('offers Uncompress only for suffixes the agent can unpack', () => {
    ['a.zip', 'a.tar', 'a.tar.gz', 'a.TGZ', 'a.tar.zst'].forEach((name) =>
      expect(looksLikeArchive(name)).toBe(true),
    );
    ['a.txt', 'a.gz', 'archive', 'a.zipper'].forEach((name) =>
      expect(looksLikeArchive(name)).toBe(false),
    );
  });

  // Must agree with the agent's own DefaultDestination, or the modal opens on
  // a different path than the one the backend would have chosen.
  it('proposes the archive name with its suffix stripped', () => {
    expect(defaultExtractDestination('/srv/app.tar.gz')).toBe('/srv/app');
    expect(defaultExtractDestination('/srv/app.zip')).toBe('/srv/app');
    expect(defaultExtractDestination('/srv/app.tar.zst')).toBe('/srv/app');
    expect(defaultExtractDestination('/srv/app')).toBe('/srv/app.extracted');
  });
});

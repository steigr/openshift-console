// transport.tsx re-exports VncPodConsole, which imports the SDK and noVNC at
// module scope - both need mocking here even though this spec only exercises
// listVncConnections, since importing anything from transport.tsx evaluates
// the whole module.
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({ consoleFetchJSON: jest.fn() }));
jest.mock('@novnc/novnc/lib/rfb', () => ({ __esModule: true, default: jest.fn() }));

import type { PodKind } from '../types';
import { VNC_ENABLED_LABEL, VNC_ENDPOINTS_ANNOTATION } from '../endpoints';
import { listVncConnections } from '../transport';

const pod = ({
  endpoints,
  containers = ['app', 'sidecar'],
}: {
  endpoints?: unknown[];
  containers?: string[];
}): PodKind => ({
  metadata: {
    name: 'test',
    namespace: 'default',
    labels: { [VNC_ENABLED_LABEL]: 'true' },
    ...(endpoints === undefined
      ? {}
      : { annotations: { [VNC_ENDPOINTS_ANNOTATION]: JSON.stringify(endpoints) } }),
  },
  spec: { containers: containers.map((name) => ({ name })) },
});

describe('listVncConnections', () => {
  it('uses the port as the connection id', () => {
    expect(listVncConnections(pod({ endpoints: [{ container: 'app', port: 5901 }] }))).toEqual([
      { id: '5901', containerName: 'app', label: 'VNC (app)' },
    ]);
  });

  it('falls back to "VNC (<container>)" when the endpoint has no label', () => {
    expect(
      listVncConnections(pod({ endpoints: [{ container: 'sidecar', port: 5902 }] })),
    ).toEqual([{ id: '5902', containerName: 'sidecar', label: 'VNC (sidecar)' }]);
  });

  it("uses the endpoint's own label verbatim when set, without a container/VNC prefix", () => {
    expect(
      listVncConnections(
        pod({
          endpoints: [
            { container: 'vm', port: 5900, label: 'Guest' },
            { container: 'vm', port: 5902, label: 'QEMU' },
          ],
          containers: ['vm'],
        }),
      ),
    ).toEqual([
      { id: '5900', containerName: 'vm', label: 'Guest' },
      { id: '5902', containerName: 'vm', label: 'QEMU' },
    ]);
  });

  it('passes an explicit priority straight through', () => {
    expect(
      listVncConnections(pod({ endpoints: [{ container: 'app', port: 5901, priority: 3 }] })),
    ).toEqual([{ id: '5901', containerName: 'app', label: 'VNC (app)', priority: 3 }]);
  });

  it('omits priority entirely when not set, rather than including it as undefined', () => {
    const [connection] = listVncConnections(pod({ endpoints: [{ container: 'app', port: 5901 }] }));
    expect('priority' in connection).toBe(false);
  });

  it('returns nothing for a pod with no VNC endpoints at all', () => {
    expect(listVncConnections(pod({ containers: ['app'] }))).toEqual([
      { id: '5900', containerName: 'app', label: 'VNC (app)' },
    ]);
    expect(
      listVncConnections({ spec: { containers: [{ name: 'app' }] } } as PodKind),
    ).toEqual([]);
  });
});

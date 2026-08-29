import type { PodKind } from '../types';
import {
  DEFAULT_VNC_PORT,
  VNC_ENABLED_LABEL,
  VNC_ENDPOINTS_ANNOTATION,
  isVncPod,
  vncEndpoints,
  vncPort,
} from '../endpoints';

const pod = ({
  enabled,
  endpoints,
  containers = ['app', 'sidecar'],
}: {
  enabled?: string;
  endpoints?: string;
  containers?: string[];
}): PodKind => ({
  metadata: {
    name: 'test',
    namespace: 'default',
    ...(enabled === undefined ? {} : { labels: { [VNC_ENABLED_LABEL]: enabled } }),
    ...(endpoints === undefined ? {} : { annotations: { [VNC_ENDPOINTS_ANNOTATION]: endpoints } }),
  },
  spec: { containers: containers.map((name) => ({ name })) },
});

describe('isVncPod', () => {
  it('requires the opt-in label to be exactly "true"', () => {
    expect(isVncPod(pod({ enabled: 'true' }))).toBe(true);
    expect(isVncPod(pod({ enabled: 'True' }))).toBe(false);
    expect(isVncPod(pod({ enabled: 'false' }))).toBe(false);
    expect(isVncPod(pod({ enabled: '' }))).toBe(false);
    expect(isVncPod(pod({}))).toBe(false);
  });

  it('tolerates pods without metadata', () => {
    expect(isVncPod({})).toBe(false);
    expect(isVncPod(undefined as unknown as PodKind)).toBe(false);
  });
});

describe('vncEndpoints', () => {
  it('returns nothing for a pod that did not opt in, whatever it annotates', () => {
    expect(vncEndpoints(pod({ endpoints: 'app=5901' }))).toEqual({});
    expect(vncEndpoints(pod({ enabled: 'false', endpoints: 'app=5901' }))).toEqual({});
  });

  it('defaults to the first container on the default port without an annotation', () => {
    expect(vncEndpoints(pod({ enabled: 'true' }))).toEqual({ app: DEFAULT_VNC_PORT });
  });

  it.each(['', '   '])('treats a blank annotation (%p) as absent', (endpoints) => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints }))).toEqual({ app: DEFAULT_VNC_PORT });
  });

  it('returns nothing when the pod has no containers at all', () => {
    expect(vncEndpoints(pod({ enabled: 'true', containers: [] }))).toEqual({});
  });

  it('defaults the port of an entry that omits one', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'sidecar' }))).toEqual({
      sidecar: DEFAULT_VNC_PORT,
    });
  });

  it('parses multiple entries and tolerates surrounding whitespace', () => {
    expect(
      vncEndpoints(pod({ enabled: 'true', endpoints: ' app = 5901 , sidecar=5902 ' })),
    ).toEqual({ app: 5901, sidecar: 5902 });
  });

  it('ignores containers the pod does not have', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'ghost=5901,app=5902' }))).toEqual({
      app: 5902,
    });
  });

  // Containers of a pod share a network namespace, so two of them cannot both
  // listen on the same port - the first entry wins.
  it('ignores an entry claiming an already claimed port', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'app=5901,sidecar=5901' }))).toEqual({
      app: 5901,
    });
  });

  it('ignores a repeated container, keeping its first port', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'app=5901,app=5902' }))).toEqual({
      app: 5901,
    });
  });

  it('applies the default port to the first entry that omits one, not to later ones', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'app,sidecar' }))).toEqual({
      app: DEFAULT_VNC_PORT,
    });
  });

  it.each([
    ['a non-numeric port', 'app=vnc'],
    ['a negative port', 'app=-1'],
    ['a zero port', 'app=0'],
    ['an out of range port', 'app=65536'],
    ['a hex port', 'app=0x17'],
    ['an exponent port', 'app=1e3'],
    ['a fractional port', 'app=59.01'],
    ['an empty port', 'app='],
    ['a doubled separator', 'app=5901=5902'],
  ])('ignores an entry with %s', (_name, endpoints) => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints }))).toEqual({});
  });

  it('keeps valid entries alongside invalid ones', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'app=nope,,sidecar=5902,' }))).toEqual({
      sidecar: 5902,
    });
  });

  it('does not fall back to the first container when every entry is unusable', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: 'ghost' }))).toEqual({});
  });
});

describe('vncPort', () => {
  it('reports the port of a container that serves VNC', () => {
    expect(vncPort(pod({ enabled: 'true', endpoints: 'sidecar=5902' }), 'sidecar')).toBe(5902);
  });

  it('reports nothing for a container that does not', () => {
    expect(vncPort(pod({ enabled: 'true', endpoints: 'sidecar=5902' }), 'app')).toBeUndefined();
    expect(vncPort(pod({ enabled: 'true' }), 'sidecar')).toBeUndefined();
    expect(vncPort(pod({}), 'app')).toBeUndefined();
  });
});

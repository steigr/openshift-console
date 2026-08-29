import type { PodKind } from '../types';
import {
  DEFAULT_VNC_PORT,
  VNC_ENABLED_LABEL,
  VNC_ENDPOINTS_ANNOTATION,
  isVncPod,
  vncAuth,
  vncEndpoints,
  vncPort,
} from '../endpoints';

const pod = ({
  enabled,
  endpoints,
  containers = ['app', 'sidecar'],
}: {
  enabled?: string;
  endpoints?: unknown[] | string;
  containers?: string[];
}): PodKind => ({
  metadata: {
    name: 'test',
    namespace: 'default',
    ...(enabled === undefined ? {} : { labels: { [VNC_ENABLED_LABEL]: enabled } }),
    ...(endpoints === undefined
      ? {}
      : {
          annotations: {
            [VNC_ENDPOINTS_ANNOTATION]:
              typeof endpoints === 'string' ? endpoints : JSON.stringify(endpoints),
          },
        }),
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
    expect(vncEndpoints(pod({ endpoints: [{ container: 'app', port: 5901 }] }))).toEqual({});
    expect(
      vncEndpoints(pod({ enabled: 'false', endpoints: [{ container: 'app', port: 5901 }] })),
    ).toEqual({});
  });

  it('defaults to the first container on the default port without an annotation', () => {
    expect(vncEndpoints(pod({ enabled: 'true' }))).toEqual({ app: { port: DEFAULT_VNC_PORT } });
  });

  it.each(['', '   '])('treats a blank annotation (%p) as absent', (endpoints) => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints }))).toEqual({
      app: { port: DEFAULT_VNC_PORT },
    });
  });

  it('returns nothing when the pod has no containers at all', () => {
    expect(vncEndpoints(pod({ enabled: 'true', containers: [] }))).toEqual({});
  });

  it('defaults the port of an entry that omits one', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: [{ container: 'sidecar' }] }))).toEqual(
      { sidecar: { port: DEFAULT_VNC_PORT } },
    );
  });

  it('parses multiple entries', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [
            { container: 'app', port: 5901 },
            { container: 'sidecar', port: 5902 },
          ],
        }),
      ),
    ).toEqual({ app: { port: 5901 }, sidecar: { port: 5902 } });
  });

  it('accepts a numeric-string port for hand-authored annotations', () => {
    expect(
      vncEndpoints(pod({ enabled: 'true', endpoints: [{ container: 'app', port: '5901' }] })),
    ).toEqual({ app: { port: 5901 } });
  });

  it('ignores containers the pod does not have', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [
            { container: 'ghost', port: 5901 },
            { container: 'app', port: 5902 },
          ],
        }),
      ),
    ).toEqual({ app: { port: 5902 } });
  });

  // Containers of a pod share a network namespace, so two of them cannot both
  // listen on the same port - the first entry wins.
  it('ignores an entry claiming an already claimed port', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [
            { container: 'app', port: 5901 },
            { container: 'sidecar', port: 5901 },
          ],
        }),
      ),
    ).toEqual({ app: { port: 5901 } });
  });

  it('ignores a repeated container, keeping its first port', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [
            { container: 'app', port: 5901 },
            { container: 'app', port: 5902 },
          ],
        }),
      ),
    ).toEqual({ app: { port: 5901 } });
  });

  it.each([
    ['a non-numeric port', 'nope'],
    ['a negative port', -1],
    ['a zero port', 0],
    ['an out of range port', 65536],
    ['a fractional port', 59.01],
  ])('ignores an entry with %s', (_name, port) => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: [{ container: 'app', port } as never] }))).toEqual(
      {},
    );
  });

  it.each([
    ['not JSON at all', 'app=5901,sidecar=5902'],
    ['a JSON object instead of an array', '{"container":"app","port":5901}'],
    ['truncated JSON', '[{"container":"app"'],
  ])('treats %s as no usable endpoints', (_name, endpoints) => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints }))).toEqual({});
  });

  it('ignores non-object entries in an otherwise valid array', () => {
    expect(
      vncEndpoints(pod({ enabled: 'true', endpoints: ['app', null, 42, { container: 'app', port: 5901 }] })),
    ).toEqual({ app: { port: 5901 } });
  });

  it('does not fall back to the first container when every entry is unusable', () => {
    expect(vncEndpoints(pod({ enabled: 'true', endpoints: [{ container: 'ghost' }] }))).toEqual({});
  });

  it('carries an inline password through to the endpoint', () => {
    expect(
      vncEndpoints(
        pod({ enabled: 'true', endpoints: [{ container: 'app', port: 5901, auth: { password: 'secret' } }] }),
      ),
    ).toEqual({ app: { port: 5901, auth: { password: 'secret' } } });
  });

  it('carries a secretRef through to the endpoint, key included', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [
            { container: 'app', port: 5901, auth: { secretRef: { name: 'vnc-creds', key: 'vncPassword' } } },
          ],
        }),
      ),
    ).toEqual({ app: { port: 5901, auth: { secretRef: { name: 'vnc-creds', key: 'vncPassword' } } } });
  });

  it('carries a secretRef without an explicit key', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [{ container: 'app', port: 5901, auth: { secretRef: { name: 'vnc-creds' } } }],
        }),
      ),
    ).toEqual({ app: { port: 5901, auth: { secretRef: { name: 'vnc-creds' } } } });
  });

  it('prefers an inline password over a secretRef if somehow both are given', () => {
    expect(
      vncEndpoints(
        pod({
          enabled: 'true',
          endpoints: [
            {
              container: 'app',
              port: 5901,
              auth: { password: 'secret', secretRef: { name: 'vnc-creds' } },
            },
          ],
        }),
      ),
    ).toEqual({ app: { port: 5901, auth: { password: 'secret' } } });
  });

  it.each([
    ['an empty object', {}],
    ['an empty password', { password: '' }],
    ['a secretRef with no name', { secretRef: { key: 'password' } }],
    ['a non-object secretRef', { secretRef: 'vnc-creds' }],
    ['a string instead of an object', 'secret'],
  ])('drops unusable auth (%s), keeping the endpoint unauthenticated', (_name, auth) => {
    expect(
      vncEndpoints(pod({ enabled: 'true', endpoints: [{ container: 'app', port: 5901, auth }] })),
    ).toEqual({ app: { port: 5901 } });
  });
});

describe('vncPort', () => {
  it('reports the port of a container that serves VNC', () => {
    expect(vncPort(pod({ enabled: 'true', endpoints: [{ container: 'sidecar', port: 5902 }] }), 'sidecar')).toBe(
      5902,
    );
  });

  it('reports nothing for a container that does not', () => {
    expect(
      vncPort(pod({ enabled: 'true', endpoints: [{ container: 'sidecar', port: 5902 }] }), 'app'),
    ).toBeUndefined();
    expect(vncPort(pod({ enabled: 'true' }), 'sidecar')).toBeUndefined();
    expect(vncPort(pod({}), 'app')).toBeUndefined();
  });
});

describe('vncAuth', () => {
  it('reports the auth of a container that has one', () => {
    expect(
      vncAuth(
        pod({ enabled: 'true', endpoints: [{ container: 'app', port: 5901, auth: { password: 'secret' } }] }),
        'app',
      ),
    ).toEqual({ password: 'secret' });
  });

  it('reports nothing for an endpoint with no auth, or no endpoint at all', () => {
    expect(vncAuth(pod({ enabled: 'true', endpoints: [{ container: 'app', port: 5901 }] }), 'app')).toBeUndefined();
    expect(vncAuth(pod({ enabled: 'true' }), 'sidecar')).toBeUndefined();
  });
});

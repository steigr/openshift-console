# Node terminal customization

Patch [`0006-node-terminal-podspec-via-configmap.patch`](../patches/0006-node-terminal-podspec-via-configmap.patch)
extends the upstream OpenShift console "Node → Terminal" feature so that
operators can fully control the debug pod that backs the in-browser shell.
The websocket proxy behaviour the shell relies on lives in other patches
(section 2).

It touches two files:

| File | Purpose |
|---|---|
| `frontend/packages/console-app/src/components/nodes/NodeTerminal.tsx` | Lets the frontend build the debug pod from a `ConfigMap` instead of the bundled template. |
| `.dockerignore` | Keeps `node_modules` trees out of the build context. |

It consolidates the original 4.14-era patches `0003`, `0012`, `0015`, `0026`,
`0027` and `0048`. The xterm 4 → 5 upgrade that used to live in this group is
no longer needed because release-5.1 already ships `@xterm/xterm@5.x`.

---

## 1. Frontend: pod spec from a `ConfigMap`

When the user opens the **Terminal** tab on a `Node`, the console normally
synthesizes a privileged `debug` pod from a hard-coded template (see
`getDebugPod` in `NodeTerminal.tsx`, mirroring `oc debug node/<name>`).

The patch adds an *override path* in front of that template.

### `getOverridePodSpecFromConfigMap(nodeName)`

```ts
const configMap = await k8sGet(ConfigMapModel, 'node-terminal', 'openshift-console');
const raw = configMap?.data?.spec;
const parsed = safeYAMLToJS(raw, null);
parsed.nodeName = nodeName;
return parsed;
```

Behaviour:

1. Reads the `ConfigMap` named **`node-terminal`** from the
   **`openshift-console`** namespace.
2. Parses the value of the **`spec`** key as YAML using the SDK's
   `safeYAMLToJS` helper (returns `null` instead of throwing on invalid input).
3. Pins the result to the requested node by overwriting `spec.nodeName`.
4. Returns `null` on any failure (CM missing, RBAC denied, invalid YAML, empty
   key …) so the caller transparently falls back to the bundled template.

### Wiring into `getDebugPod(...)`

`getDebugPod` now calls the override path first:

```ts
const overrideSpec = await getOverridePodSpecFromConfigMap(nodeName);
if (overrideSpec) {
  // ensure HAVE_SIXEL_SUPPORT=true is exported in the first container
  if (Array.isArray(overrideSpec.containers) && overrideSpec.containers.length > 0) {
    const c0 = overrideSpec.containers[0];
    c0.env = c0.env || [];
    if (!c0.env.some((e) => e?.name === 'HAVE_SIXEL_SUPPORT')) {
      c0.env.push({ name: 'HAVE_SIXEL_SUPPORT', value: 'true' });
    }
  }
  return {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name,
      namespace,
      annotations: {
        'debug.openshift.io/source-container':
          overrideSpec.containers?.[0]?.name || 'container-00',
        'debug.openshift.io/source-resource': `/v1, Resource=nodes/${nodeName}`,
        'openshift.io/scc': 'privileged',
      },
    },
    spec: overrideSpec,
  };
}
// …unchanged: fall back to the bundled `oc debug node` template.
```

Notes:

- The standard `debug.openshift.io/*` annotations and the `privileged` SCC
  hint are added so the resulting pod still looks like an `oc debug` pod to
  the rest of the platform (audit, admission, UI badges).
- The container name is taken from `containers[0].name`, defaulting to
  `container-00` so the annotation never ends up empty.
- `HAVE_SIXEL_SUPPORT=true` is injected into the first container's env so
  shells running inside the debug pod can detect that the embedded xterm.js
  terminal supports SIXEL graphics. The injection is idempotent — if the
  ConfigMap already declares the variable it is left alone.

### Example `ConfigMap`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-terminal
  namespace: openshift-console
data:
  spec: |
    hostNetwork: true
    hostPID: true
    restartPolicy: Never
    serviceAccountName: node-terminal
    tolerations:
      - operator: Exists
    containers:
      - name: shell
        image: registry.example.com/ops/node-shell:latest
        stdin: true
        tty: true
        securityContext:
          privileged: true
        volumeMounts:
          - name: host
            mountPath: /host
    volumes:
      - name: host
        hostPath:
          path: /
```

`spec.nodeName` is intentionally **not** set in the ConfigMap — the frontend
fills it in from the node the user selected. Anything else in the spec is
forwarded verbatim, so operators can swap the image, add tolerations, mount
host paths, attach pull secrets, etc.

If the ConfigMap is absent the upstream `oc debug node` template is used and
behaviour is unchanged.

### Required RBAC

The browser performs the lookup with the logged-in user's token, so that user
needs `get` on the `node-terminal` ConfigMap in `openshift-console`. A minimal
shared role:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: node-terminal-config-reader
  namespace: openshift-console
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["node-terminal"]
    verbs: ["get"]
```

Bind it to whichever group is allowed to use the node terminal.

---

## 2. Backend: websocket proxy

The console exposes Kubernetes' `pods/exec` (and similar) endpoints to the
browser by upgrading the HTTP request to a websocket and proxying it to the
API server (`/api/kubernetes/`, `pkg/proxy/proxy.go`). Patch 6 doesn't touch
that path itself; these patches do.

### 2.1 Optional service-account-token auth (patches 4 and 5)

With **`--user-auth-service-account-token`** (`BRIDGE_USER_AUTH_SERVICE_ACCOUNT_TOKEN`,
chart value `auth.serviceAccountToken`), requests to `/api/kubernetes/` and
`/api/graphql` authenticate with the bridge pod's own service account token
(`/var/run/secrets/kubernetes.io/serviceaccount/token`, re-read on every
request) instead of the user's OIDC token. It's meant for setups where the
kube-apiserver doesn't trust the OIDC issuer console logs users in with. The
user's identity travels in `Impersonate-User` / `Impersonate-Group` headers
derived from the session, so audit logs and RBAC still apply to the real user.

That service account can impersonate anyone, so the identity comes from the
session alone. Requests that bring their own impersonation (`Impersonate-*`
headers, `X-Console-Impersonate-Groups`, `Impersonate-User.` /
`Impersonate-Group.` websocket subprotocols, GraphQL `connection_init`
payloads) are refused, which means console's "Impersonate user" action doesn't
work in this mode, and so is a session no `Impersonate-User` can be derived
from. Every other endpoint (monitoring, Helm, ...) keeps using the user's own
token and never sees the service account's. The plugin endpoints
(`/api/plugins/` and the `--plugin-proxy` routes that ask to be authorized)
can opt back into the same treatment with `--plugin-impersonation`
(patch 23), for plugin backends that need to act as the user.

Without the flag console forwards the user's bearer token, the upstream
default.

### 2.2 Preserve client `Origin` (patch 4)

Upstream unconditionally overwrites the `Origin` header:

```go
proxiedHeader.Add("Origin", "http://localhost")
```

The patch turns that into a fallback:

```go
if proxiedHeader.Get("Origin") == "" {
    proxiedHeader.Add("Origin", "http://localhost")
}
```

This lets a client-supplied `Origin` (e.g. a reverse proxy that injects the
real public origin, or a custom node-terminal client) survive the hop. The
behaviour is unchanged when no `Origin` is present, so kube-apiserver's
websocket origin check still passes by default.

### 2.3 Origin enforcement (patches 14 and 22)

Websocket upgrades have to come from `--base-address`. The CSRF middleware
checks the origin of every websocket upgrade on an authenticated route, and
the k8s and plugin proxies check it again before dialing their backend, so a
refused upgrade never starts an exec session.

---

## 3. `.dockerignore` cleanup

Five extra entries are added so stray `node_modules` trees never end up in
the container build context:

```text
frontend/node_modules
frontend/packages/console-dynamic-plugin-sdk/node_modules
frontend/packages/console-plugin-shared/node_modules
frontend/packages/eslint-plugin-console/node_modules
frontend/public/dist/assets/node_modules/@patternfly-4/react-core/node_modules
```

This shrinks the build context dramatically (the last entry alone can be
hundreds of MB) and prevents accidental host-node modules from landing in the
final image — relevant for the node-terminal flow because the resulting
`bridge` image is what serves the in-browser shell.

---

## 4. Configuration summary

| Knob | Where | Type | Default | Effect |
|---|---|---|---|---|
| `node-terminal` ConfigMap (`openshift-console`) | cluster | `ConfigMap` with key `spec` (YAML PodSpec) | absent | Replaces the bundled `oc debug node` pod template. |
| `--user-auth-service-account-token` | bridge flag (`auth.serviceAccountToken`) | `bool` | `false` | Authenticate `/api/kubernetes/` and `/api/graphql` as the bridge SA, impersonating the session user. |
| `--plugin-impersonation` | bridge flag (`auth.pluginImpersonation`) | `bool` | `false` | Authenticate plugin-bound requests the same way, so a plugin backend can act as the user. Needs the flag above. |
| `HAVE_SIXEL_SUPPORT` | injected into first container | `string` | `"true"` (auto) | Hint for the in-pod shell that the embedded terminal renders SIXEL. |

---

## 5. End-to-end flow

```
          ┌─────────────────────────────┐
          │ Browser: Node → Terminal    │
          └──────────────┬──────────────┘
                         │ k8sGet ConfigMap "node-terminal"
                         ▼
              ┌──────────────────────┐    miss / error
              │ override pod spec?   │────────────┐
              └──────────┬───────────┘            │
                         │ hit                    ▼
        inject HAVE_SIXEL_SUPPORT      use bundled `oc debug node` template
        + debug.openshift.io annotations           │
                         └──────────────┬──────────┘
                                        ▼
                         k8sCreate Pod in user's namespace
                                        │
                         attach to /pods/{n}/exec via websocket
                                        ▼
                         ┌────────────────────────────────┐
                         │ bridge /api/kubernetes/        │
                         │  • websocket origin check      │
                         │  • optional SA-token auth      │
                         │ pkg/proxy.Proxy.ServeHTTP      │
                         │  • origin check before dialing │
                         │  • preserve client Origin      │
                         └──────────────┬─────────────────┘
                                        ▼
                                kube-apiserver
```

The override path is purely additive: when the ConfigMap is missing or
unreadable the user gets the upstream behaviour, and without
`--user-auth-service-account-token` the proxy authenticates with the user's
own token exactly as upstream does.


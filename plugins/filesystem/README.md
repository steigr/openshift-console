# Filesystem console plugin

Adds a **Files** tab to the Pod details page, next to Terminal: a tree of any
container's filesystem with upload, download, view, info, move, delete, folder
archiving and archive extraction.

```
browser (Files tab)
  │  Connect/JSON over POST
  ▼
console bridge  ──  /api/proxy/plugin/filesystem-console-plugin/api/...
  │  forwards the user's own credentials (ConsolePlugin spec.proxy, UserToken)
  ▼
filesystem-plugin  (Deployment, unprivileged)
  │  1. SelfSubjectAccessReview: may this user `create pods/exec` on this pod?
  │  2. GET the pod (as the user) -> node, container ID
  │  3. find the agent DaemonSet pod on that node (as itself)
  │  4. forward the same RPC, over gRPC
  ▼
filesystem-agent  (DaemonSet, hostPID, privileged)
     container ID -> PID (scan /proc/*/cgroup) -> /proc/<pid>/root
     every path resolved with openat2(RESOLVE_IN_ROOT)
```

Both halves are the same image and the same gRPC service
(`proto/filesystem/v1/filesystem.proto`); the backend implements it by
authorizing and forwarding, the agent by actually touching files. That is why
`Target` names a namespace, a pod and a container rather than a node and a
PID — the browser asks the question it can ask, and each hop answers one part
of it.

## Security model

**The permission this plugin requires is `create` on `pods/exec`**, scoped to
the pod being browsed, checked with a `SelfSubjectAccessReview` built from the
credentials console forwards. That is the permission `kubectl exec` and
`kubectl cp` need, and it is the honest equivalent of what the agent offers:
read, write and delete anywhere in the container. Asking for anything less
would make this plugin a way around the cluster's own exec policy.

A request that arrives without forwarded credentials is a 401, never a silent
fallback to the plugin's own ServiceAccount. The backend's ServiceAccount holds
exactly one permission — `get`/`list` pods in its own namespace, to find the
agent for a node — and that lookup never carries caller-supplied
`Impersonate-*` headers.

**The agent is the dangerous half.** It runs as root with `hostPID` and, by
default, `privileged: true`, because reaching into another container's mount
namespace is what it is for. Three things keep it from being a cluster-wide
door:

- it never calls the API server, and its ServiceAccount token is not mounted;
- it refuses to start without a shared token (`--agent-token`/`AGENT_TOKEN`),
  which the chart generates into a Secret and mounts into both halves;
- the chart ships a NetworkPolicy that lets only the backend reach its port.

`--allow-anonymous` removes the first of those. It exists so the failure mode
is an explicit flag rather than a silently unauthenticated listener; there is
no good reason to set it outside a throwaway cluster.

### Path resolution

The agent reaches a container through `/proc/<pid>/root`, which the kernel
resolves in that process's mount namespace. That alone is **not** safe: an
absolute symlink met during resolution is interpreted against the *agent's*
root, so a container that plants `/data -> /etc` would hand the browser the
node's `/etc`. Refusing absolute symlinks is not an option either — container
images are full of them (`/usr/bin -> /bin`, `/etc/localtime -> ...`).

`internal/rootfs` therefore resolves every path with
`openat2(2)`'s `RESOLVE_IN_ROOT`, which reinterprets absolute symlinks and `..`
against a root of our choosing, in the kernel, atomically — so a container
process cannot win a race by swapping a component between a check and an open.
`RESOLVE_NO_MAGICLINKS` is added as well, so a container's own `/proc` is not a
second way out. This needs **Linux 5.6 or newer**; an older kernel gets a
`failed_precondition` naming the requirement rather than an unsafe fallback.

`os.Root` (Go 1.24+) looks like the obvious alternative and is the wrong tool:
it rejects every absolute symlink as an escape, including the ones that resolve
back inside the root.

Off Linux, `rootfs` falls back to a user-space emulation of the same rules so
the test suite runs on a developer's machine; the `agent` command refuses to
serve on such a platform.

## Why gRPC over Connect, and no client streaming

Console's plugin proxy is an HTTP/1.1 reverse proxy. Of the three protocols
connect-go serves, the **Connect** protocol is the one that works over HTTP/1.1
for both unary calls and server streams, so that is what the browser speaks.
Client streaming and bidi need HTTP/2 and are not usable from a browser at all,
which is why `Upload` is a unary call carrying `offset`/`last` rather than a
client stream: the frontend drives the sequence. `ReadFile` and `Archive` are
server streams, so neither a large file nor a large archive is ever held whole
on the backend.

The backend↔agent hop is plain gRPC over h2c — same service, same messages,
forwarded unmodified.

## Archives

Folder download is `Archive`, which builds the archive **inside the agent pod**
and streams it out, so the bytes are compressed before they cross to the
backend, the console and the browser. Formats: `zip`, `tar`, `tar.gz`,
`tar.zst`.

The compression level is set at rollout, on the agent:

```
--archive-compression-level / ARCHIVE_COMPRESSION_LEVEL   (chart: agent.archiveCompressionLevel)
```

It is a 0–9 scale; 0 means each codec's own default. It maps directly onto
deflate for `zip` and `tar.gz`, and onto zstd's fastest/default/better/best
encoder levels for `tar.zst` (zstd's own scale runs to 22 and is not
numerically comparable, so the mapping is by intent).

"Uncompress" is `Extract`, which detects the format from the archive's magic
number rather than its name, refuses members that would land outside the
destination, and stops at `--max-extract-bytes`/`--max-extract-entries` so an
archive cannot unpack to far more than it weighs.

## Deploying

```bash
helm install filesystem-plugin plugins/filesystem/charts/console-filesystem-plugin \
  --namespace openshift-console
```

The API is served on console's **proxy** route, so the plugin needs a
`spec.proxy` entry with alias `api` — the chart's `ConsolePlugin` has it. A
console deployed from this repo's own chart reads `plugins[].proxy` instead, so
it needs the matching entry there:

```yaml
plugins:
  - name: filesystem-console-plugin
    url: https://filesystem-plugin.openshift-console.svc:8080
    proxy:
      alias: api
      authorize: true
```

Without it every call 404s, with nothing in the browser to say why.

Values worth knowing:

| Value | Default | What it does |
| --- | --- | --- |
| `tabs.podFiles` | `true` | Whether the Pod details page gets the tab at all |
| `agent.archiveCompressionLevel` | `0` | Folder-download compression level (0–9, 0 = codec default) |
| `agent.token` | generated | Shared secret; reused across upgrades via `lookup` |
| `agent.allowAnonymous` | `false` | Serve the agent with no token — see above |
| `agent.privileged` | `true` | Set false to use the capability set instead, where SELinux allows it |
| `frontend.defaultArchiveFormat` | `tar.gz` | Preselected folder-download format |
| `useServiceAccountToken` | `false` | Skip the caller's own permission check — read its comment first |

## Developing

```bash
go test ./...        # backend, agent, rootfs (runs on macOS via the portable resolver)
npm ci && npm test   # frontend
npx tsc --noEmit     # frontend typecheck
make build-filesystem
```

The Go suite is worth running on Linux too, since that is where the real
`openat2` resolver lives:

```bash
docker run --rm -v "$PWD":/src -w /src -e GOFLAGS=-buildvcs=false golang:1.26 go test ./internal/...
```

A note if you try the agent by hand on an Apple Silicon machine: an
`linux/amd64` image running under emulation reports `openat2` as unimplemented,
and the agent correctly refuses to serve. Build for the host architecture.

### Regenerating the API

The generated code is committed, so neither a normal build nor the Dockerfile
needs `protoc`. After editing `proto/filesystem/v1/filesystem.proto`:

```bash
# TypeScript (src/gen)
npm run generate

# Go (gen/)
GOBIN=$PWD/bin go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
GOBIN=$PWD/bin go install connectrpc.com/connect/cmd/protoc-gen-connect-go@latest
PATH=$PWD/bin:$PATH protoc --proto_path=proto \
  --go_out=gen --go_opt=module=console-filesystem-plugin/gen \
  --connect-go_out=gen --connect-go_opt=module=console-filesystem-plugin/gen \
  proto/filesystem/v1/filesystem.proto
```

## Layout

| Path | What |
| --- | --- |
| `proto/` | The one service definition both halves implement |
| `gen/`, `src/gen/` | Generated Go and TypeScript, committed |
| `api/` | Plugin backend: authorization, pod and agent lookup, the forwarding proxy |
| `internal/agent/` | The node agent: PID resolution, archives, extraction, the service |
| `internal/rootfs/` | `openat2(RESOLVE_IN_ROOT)` path resolution, and its portable test stand-in |
| `src/pod/` | The Files tab: tree, context menu, dialogs, transfers |
| `charts/` | Helm chart: Deployment, DaemonSet, Secret, NetworkPolicy, ConsolePlugin |

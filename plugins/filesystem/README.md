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
  │  container ID -> PID (scan /proc/*/cgroup)
  │  spawn/reuse a helper for that container; compress; translate uids
  ▼  gRPC over a socketpair -- no network, no listener, no address
filesystem-helper  (one process per container, inside its mount namespace)
     "/" *is* the container's root; ordinary os calls
```

All three speak the same gRPC service
(`proto/filesystem/v1/filesystem.proto`); the backend implements it by
authorizing and forwarding, the agent by routing and compressing, the helper by
actually touching files. That is why `Target` names a namespace, a pod and a
container rather than a node and a PID — the browser asks the question it can
ask, and each hop answers one part of it.

## Reaching into a container

The helper joins the target container's **mount namespace** and then serves
from inside it. Once that has happened `/` is the container's root, so an
absolute path is scoped to it, absolute symlinks resolve inside it, and `..`
above `/` clamps — all enforced by the kernel rather than by code that had to
get it right.

Three things about doing this from Go are not obvious, and the third is the one
that bites:

1. **`setns(CLONE_NEWNS)` returns `EINVAL`.** The usual explanation ("Go is
   multithreaded") is not quite the reason: the Go runtime creates threads with
   `CLONE_FS`, so they share one `fs_struct`, and `mntns_install()` refuses
   unless that struct has exactly one user. `unshare(CLONE_FS)` on a thread of
   our own makes it private, after which `setns` succeeds. This is why there is
   no cgo constructor and no `nsexec`-style assembly here — the whole runc
   apparatus works around a problem that one extra syscall removes.
2. **The kernel also moves root and cwd.** `mntns_install()` calls
   `set_fs_root()` and `set_fs_pwd()`, which is the property the design rests
   on.
3. **All of that applies to one thread.** A Go HTTP server answers on whatever
   goroutine the scheduler picks, on whatever thread it lands on — and those
   threads are still in the agent's namespace. Serving without re-executing
   produces exactly one symptom: the helper starts, reports success, and then
   answers every request out of the *agent's* filesystem. So `Enter` ends in an
   `execve`: a process that enters the namespace and then replaces its image
   starts single-threaded inside it, and every thread the new runtime spawns
   inherits it.

The binary cannot be re-executed by path — after the switch, this process's
filesystem is the container's, which does not contain the agent's image — so
`/proc/self/exe` is opened *before* entering and the exec is an `execveat(2)`
of that descriptor. That is also why the helper must be a static binary: there
is no dynamic loader in there either.

An earlier revision did all of this from outside, against `/proc/<pid>/root`,
and needed `openat2(2)`'s `RESOLVE_IN_ROOT` to be safe: resolved from the
agent's own root, an absolute symlink inside the container (`/data -> /etc`)
would otherwise have reached the node's `/etc`. It worked, but it required
Linux 5.6+, and every operation that must not follow a symlink in its last
position had to be written twice — an `openat2` of the parent plus the matching
`*at` syscall. Entering the namespace removes the problem instead of defending
against it. (`os.Root`, Go 1.24+, is not a substitute either way: it rejects
every absolute symlink as an escape, including the ones that resolve back
inside the root.)

### Helper lifetime

A process inside a container's mount namespace keeps that namespace — and every
mount in it — alive after the container is gone. That is how a volume fails to
detach and a pod sticks in `Terminating`, so a helper's life is bounded three
ways:

- **the container's PID 1**, watched with a `pidfd`, which fires on exit and
  kills the helper at once. A pidfd binds the *task*, not the number, so PID
  reuse cannot make a dead container look alive; the agent additionally
  re-checks the cgroup between resolving a PID and pinning it.
- **an idle grace period** (`agent.helperGraceSeconds`, 15s), so clicking
  through a tree does not pay for a respawn per directory. It is only an
  optimisation: spawning a helper measures at **~0.6 ms**, well under the two
  API-server round trips the backend already makes per request.
- **a cap** (`agent.maxHelpers`) on how many containers one node browses at
  once.

### User namespaces

A pod with `spec.hostUsers: false` runs in its own user namespace. Entry still
works: `mntns_install()` checks `ns_capable(owning_user_ns, CAP_SYS_ADMIN)`,
and a capability held in an ancestor user namespace applies in every
descendant, so a privileged agent joins the mount namespace directly.

What changes is **identity**. The helper joins only the mount namespace, so it
reads the node's numbering, where the container's uid 0 is some unprivileged
id. The agent therefore translates through `/proc/<pid>/uid_map` and
`gid_map` before answering (`internal/agent/idmap.go`); a pod without a user
namespace has the identity map and costs nothing.

The helper does not simply join the user namespace as well because it cannot:
`setns(CLONE_NEWUSER)` refuses a multithreaded caller with `EINVAL`, and the Go
runtime is always multithreaded — measured, not assumed.

## Security model

**The permission this plugin requires is `create` on `pods/exec`**, scoped to
the pod being browsed, checked with a `SelfSubjectAccessReview` built from the
credentials console forwards. That is the permission `kubectl exec` and
`kubectl cp` need, and it is the honest equivalent of what the helper offers:
read, write and delete anywhere in the container. Asking for anything less
would make this plugin a way around the cluster's own exec policy.

A request that arrives without forwarded credentials is a 401, never a silent
fallback to the plugin's own ServiceAccount. The backend's ServiceAccount holds
exactly one permission — `get`/`list` pods in its own namespace, to find the
agent for a node — and that lookup never carries caller-supplied
`Impersonate-*` headers.

**The agent is the privileged half.** It runs as root with `hostPID` and, by
default, `privileged: true` (`runAsUser: 0` is not optional: opening another
process's `/proc` entry needs ptrace-level access to it). Three things keep it
from being a cluster-wide door:

- it never calls the API server, and its ServiceAccount token is not mounted;
- it refuses to start without a shared token (`--agent-token`/`AGENT_TOKEN`),
  which the chart generates into a Secret and mounts into both halves;
- the chart ships a NetworkPolicy that lets only the backend reach its port.

`--allow-anonymous` removes the first of those. It exists so the failure mode
is an explicit flag rather than a silently unauthenticated listener; there is
no good reason to set it outside a throwaway cluster.

The helper inherits none of that reach: it has no listening socket, no address,
and exactly one descriptor beyond stdio — the socketpair the agent handed it.

## Why gRPC over Connect, and no client streaming

Console's plugin proxy is an HTTP/1.1 reverse proxy. Of the three protocols
connect-go serves, the **Connect** protocol is the one that works over HTTP/1.1
for both unary calls and server streams, so that is what the browser speaks.
Client streaming and bidi need HTTP/2 and are not usable from a browser at all,
which is why `Upload` is a unary call carrying `offset`/`last` and the frontend
drives the sequence; `ReadFile` and `Archive` are server streams, so neither a
large file nor a large archive is ever held whole on the backend.

The backend→agent hop is plain gRPC over h2c. The agent→helper hop is the same
gRPC over a `socketpair(AF_UNIX, SOCK_STREAM)` — a socketpair rather than the
pipe pair "gRPC over stdin/stdout" suggests, because it is bidirectional, it
becomes a real `net.Conn` via `net.FileConn` so the existing h2c server works on
it unchanged, and HTTP/2 multiplexes, so concurrent RPCs to one helper share it
without a framing protocol of their own.

## Archives

Folder download is `Archive`. The **helper** streams an uncompressed tar out of
the container and the **agent** wraps it — gzip, zstd, or a streaming
transcode to zip — so the bytes are compressed before they cross to the plugin
backend, the console and the browser, and the namespace-joined process stays
limited to syscalls and tar framing.

The compression level is set at rollout, on the agent:

```
--archive-compression-level / ARCHIVE_COMPRESSION_LEVEL   (chart: agent.archiveCompressionLevel)
```

It is a 0–9 scale; 0 means each codec's own default. It maps directly onto
deflate for `zip` and `tar.gz`, and onto zstd's fastest/default/better/best
encoder levels for `tar.zst` (zstd's own scale runs to 22 and is not
numerically comparable, so the mapping is by intent).

"Uncompress" is `Extract`, and it stays in the helper: its destination is
inside the container, so streaming a decompressed tar back in would need a
second channel for no gain, and the limits that matter against an archive that
unpacks to far more than it weighs are enforced at the point of write. It
detects the format from the archive's magic number rather than its name,
refuses members that would land outside the destination, and stops at
`--max-extract-bytes`/`--max-extract-entries`.

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
| `agent.helperGraceSeconds` | `15` | How long a helper outlives its last call |
| `agent.maxHelpers` | `64` | Containers browsed at once, per node |
| `agent.token` | generated | Shared secret; reused across upgrades via `lookup` |
| `agent.allowAnonymous` | `false` | Serve the agent with no token — see above |
| `agent.privileged` | `true` | Set false to use the capability set instead, where SELinux allows it |
| `frontend.defaultArchiveFormat` | `tar.gz` | Preselected folder-download format |
| `useServiceAccountToken` | `false` | Skip the caller's own permission check — read its comment first |

## Developing

```bash
go test ./...        # backend, agent, helper, rootfs (all run on macOS)
npm ci && npm test   # frontend
npx tsc --noEmit     # frontend typecheck
make build-filesystem
```

A test cannot join a mount namespace, so two seams stand in for one:
`rootfs.Sandbox` treats a directory as a root (emulating the same rules in user
space), and the agent's pool tests re-execute the test binary as a stand-in
helper — which exercises the socketpair, the descriptor inheritance, h2c over
it, and the whole spawn/grace/kill lifecycle for real.

Run the Go suite on Linux too, since that is where the namespace entry lives:

```bash
docker run --rm -v "$PWD":/src -w /src -e GOFLAGS=-buildvcs=false golang:1.26 go test ./...
```

For a real end-to-end check against a live container:

```bash
docker run -d --name target alpine sh -c 'mkdir -p /data && echo hi > /data/f && sleep 900'
CID=$(docker inspect -f '{{.Id}}' target)
docker run -d --name agent --privileged --pid=host --user 0 -p 19090:9090 \
  <image> agent --allow-anonymous
curl -s -X POST localhost:19090/filesystem.v1.FileBrowser/ListDirectory \
  -H 'Content-Type: application/json' -H "X-Filesystem-Container-Id: docker://$CID" \
  -d '{"path":"/data"}'
```

Build for the host architecture when doing this on Apple Silicon: an emulated
`linux/amd64` image does not implement every syscall this relies on.

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
| `proto/` | The one service definition all three roles implement |
| `gen/`, `src/gen/` | Generated Go and TypeScript, committed |
| `api/` | Plugin backend: authorization, pod and agent lookup, the forwarding proxy |
| `internal/agent/` | The node agent: PID resolution, helper pool and lifetime, compression, uid translation |
| `internal/helper/` | The in-namespace process: entry, listing, upload, tar, extraction |
| `internal/rootfs/` | The filesystem root — native (the helper's own) or a sandbox directory (tests) |
| `src/pod/` | The Files tab: tree, context menu, dialogs, transfers |
| `charts/` | Helm chart: Deployment, DaemonSet, Secret, NetworkPolicy, ConsolePlugin |

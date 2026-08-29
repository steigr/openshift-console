# Host Session Shim — Implementation Plan

## 1. Purpose

A static, single-binary C tool that, when invoked via `kubectl exec -it` into a
privileged, `hostPID`-enabled pod, produces a **real, PAM-authenticated login
on the underlying Kubernetes node** for the operator who created the pod —
with a genuinely ephemeral system user, a real home directory (bind-mounted
from a CSI-provided source), correct `utmp`/`wtmp` accounting, and guaranteed
teardown (user, mount, and all processes) the instant the exec session ends —
without ever blocking pod/volume cleanup on stray processes.

This is functionally a break-glass / node-debug session tool. It should be
engineered with the rigor of a security boundary, not a convenience script:
the container boundary is largely irrelevant once a session starts (the user
lands in host namespaces), so everything the binary does before and after
that point is what actually contains the blast radius.

## 2. Non-goals

- No support for processes that survive session termination (nohup'd,
  disowned, double-forked, or otherwise detached). Anything left running when
  the exec session ends is killed, not tracked to graceful exit.
- No dependency on `systemd` unit semantics for correctness (cgroup drain,
  `--wait`) — only best-effort use of a process group as a fast first-pass
  kill handle.
- No reliance on shelling out to `nsenter`, `mount`, `useradd`, `fuser`,
  `pkill`, or `systemd-run` — all of these are reimplemented as direct
  syscalls / direct file manipulation inside the static binary.
- No use of musl — glibc is the deliberate choice; NSS (`getpw*`) is avoided
  entirely in favor of direct `/etc/passwd`+`/etc/shadow` parsing, which
  sidesteps the static-glibc-NSS problem without needing an alternate libc.

## 3. High-level flow

```
kubectl apply -f session-pod.yaml
        │  (CSI ephemeral volume resolves admin's home dir into the pod's
        │   mount namespace at a known container-local path)
        ▼
container starts, PID 1 = shim binary, phase=idle (sleep/wait for exec)
        │
kubectl exec -it <pod> -- /shim --phase=setup+session
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ SHIM STATE MACHINE (runs as the exec'd process)            │
│                                                             │
│  enter_host_namespaces                                     │
│      → resolve_csi_source_path                             │
│          → allocate_uid                                    │
│              → write_passwd_shadow_group_entries            │
│                  → create_and_bind_mount_home                │
│                      → spawn_session (agetty --autologin)    │
│                          [ BLOCKS until login/shell exits ]  │
│                                                             │
│  On success of spawn_session, OR on failure of any step,   │
│  OR on SIGTERM/SIGINT (kubectl exec disconnect):            │
│      → unconditional full rollback, in reverse order        │
└───────────────────────────────────────────────────────────┘
        │
        ▼
shim exits 0 → container (PID 1) exits → pod → Completed
        │
        ▼
(pod deletion, separately, triggers CSI NodeUnpublishVolume — independent
 of the shim's own bind-mount teardown, see §8.4)
```

## 4. Pod specification requirements

- `spec.hostPID: true` — required for the shim to reach real host PID 1 via
  `/proc/1/ns/*`. Privileged mode alone is **not** sufficient; without
  `hostPID`, PID 1 inside the container is the container's own init, not the
  host's, and namespace-entry targets the wrong process.
- `securityContext.privileged: true` — needed for `setns()` across mount/pid/
  net/uts/ipc namespaces (`CAP_SYS_ADMIN`, effectively `CAP_SYS_PTRACE` for
  `/proc/1/ns/*` access) and for direct passwd/shadow writes on the host.
- CSI ephemeral volume, parameterized with the target operator's identity
  (e.g. `volumeAttributes: { username: <admin> }`), mounted at a fixed
  container-local path (e.g. `/mnt/userhome`).
- `restartPolicy: Never` (or `OnFailure`, deliberately not `Always`) so a
  completed/cleaned-up session doesn't respawn.
- No other sidecars — single container, shim as PID 1, minimizes what else
  is running in this namespace that could interfere with cleanup semantics.
- RBAC on `pods/exec` for this pod (or pods matching this label/annotation)
  must be the actual access-control boundary — see §9.1.

## 5. Binary architecture

### 5.1 Single static binary, phase-selected re-exec

The binary supports multiple phases, selected by an internal flag
(`--phase=setup-session`, `--phase=cleanup`, etc.), and **re-execs itself**
across the host-namespace boundary via `/proc/self/exe` rather than
referencing its own path:

```c
execve("/proc/self/exe", argv, environ);
```

`/proc/self/exe` is a magic symlink bound to the executable's **inode**, not
a path lookup — it continues to resolve correctly even after `setns(mnt)`
into the host's mount namespace, where the container's own path
(e.g. `/usr/local/bin/shim`) does not exist. Because the binary is statically
linked, `execve` via this route needs no ELF interpreter or shared library
resolution in the new mount namespace — the inode alone is sufficient. This
is a load-bearing reason for static linking, not just an image-size
optimization.

This gives a clean architecture: **one binary, one artifact to audit**, that
re-launches itself post-namespace-switch rather than depending on any
path/library layout being consistent between container and host.

### 5.2 Why glibc, and how NSS is avoided

Static glibc binaries cannot reliably use `getpwnam()`/`getpwuid()` and
friends, because glibc's NSS modules (`libnss_files.so`, `libnss_sss.so`,
etc.) are loaded via `dlopen()` at runtime independent of whether the calling
binary itself is static — this typically fails or emits a runtime warning.
The tool avoids the entire family of `getpw*`/`getgr*`/`setns`-adjacent NSS
calls and instead:

- Parses `/etc/passwd`, `/etc/shadow`, `/etc/group` directly with
  `fopen`/`fgets`/`sscanf`.
- Writes new entries by direct, locked, atomic file writes (§7.3).

This makes NSS/`nscd`/`sssd` caching irrelevant to the tool's own logic,
though see §8.5 for a residual caching risk affecting *other* host processes.

## 6. State machine design

### 6.1 Step/rollback model

```c
typedef struct {
    const char *name;
    int  (*do_fn)(session_ctx_t *ctx);   // 0 = success, nonzero = failure
    void (*undo_fn)(session_ctx_t *ctx); // must be idempotent, tolerate partial state
} step_t;
```

Steps execute strictly in order. On failure of any step, or on successful
(blocking) completion of the terminal "spawn session" step, or on receipt of
`SIGTERM`/`SIGINT`, the same rollback routine runs: undo functions for all
*completed* steps, in reverse order. **Normal session termination and
error-triggered rollback are the same code path** — this is deliberate: it
guarantees cleanup logic isn't duplicated or allowed to drift between the
"happy path" and "failure path."

### 6.2 Ordered step list

| # | Step | Forward action | Rollback action |
|---|------|-----------------|------------------|
| 1 | `enter_ns` | `setns()` into host `mnt`, `uts`, `ipc`, `net`, then `pid` (see §6.3) | n/a (namespace membership isn't undone; process simply exits) |
| 2 | `resolve_src` | Parse `/proc/self/mountinfo` (post-`setns(mnt)`, but read from the container's *original* mount namespace fd captured before switching — see §6.4) to resolve the CSI mount's real host-side source path | n/a (read-only) |
| 3 | `alloc_uid` | Acquire lock on a reserved-range UID allocation file; scan for a free UID; reserve it | Release/unreserve the UID |
| 4 | `write_identity` | Atomically append passwd/shadow/group entries for the ephemeral user (§7.3) | Remove those entries (atomic rewrite excluding the added lines) |
| 5 | `mkdir_home` | Create the ephemeral home directory path | `rmdir()` (only if empty / owned by us) |
| 6 | `bind_mount` | `mount(src, homedir, NULL, MS_BIND, NULL)` | `umount2(homedir, MNT_DETACH)` — lazy, non-blocking (§8) |
| 7 | `spawn_session` | `fork()`; child: `setpgid(0,0)`, re-exec self via `/proc/self/exe` into the `agetty --autologin` chain on the inherited pty (fd 0/1/2 from `kubectl exec -t -i`); parent: `waitpid()` on the direct child (blocks for the session's duration) | Multi-pass kill sweep (§8.1–8.3) |

### 6.3 Namespace entry order and rationale

`setns()` into `mnt`, `uts`, `ipc`, `net` first (order among these four is
not load-bearing), then `pid` **last**, followed immediately by `fork()`.
`setns(pid)` only affects the PID namespace of subsequently created
children — the calling process's own PID namespace membership is fixed at
its own creation and cannot be changed. This mirrors why `nsenter --pid`
requires `--fork`: the effect only manifests in the forked child.

### 6.4 A subtlety in `resolve_src`

Once the process has `setns(mnt)`'d into the host, `/proc/self/mountinfo`
reflects the **host** mount table — the CSI-provided path
(`/mnt/userhome`) that was visible in the *container's* mount namespace is no
longer resolvable by that path post-switch. The source path must be resolved
**before** switching mount namespaces (i.e., step 2 conceptually needs to run
against the container's original mount namespace), then carried forward as a
plain string into later steps that run post-switch. Implementation-wise, this
means either:

- Reordering: resolve the source path *before* step 1's `setns(mnt)`, using
  the container's own (default) mount namespace, and only enter the host
  mount namespace once the source path string is already in hand; or
- Keeping an `O_PATH` file descriptor open to the container's original mount
  namespace (`open("/proc/self/ns/mnt")`, saved before switching) to
  `setns()` back into transiently if re-resolution is ever needed.

The first option is simpler and should be the actual step order: **resolve
source path, then enter host namespaces**, not as listed in the table above
in strict numeric sequence — the table reflects logical dependency order
(you need the source path before you can bind-mount it), not necessarily
identical namespace context at each numbered step. Treat step 2 as running
pre-switch, steps 3 onward as running post-switch, and enter mount namespace
either right after step 2 or precisely staged such that step 6's `mount()`
call executes with the host mount namespace active (it must — a bind mount
performed in the container's mount namespace at a container-local path is
invisible on the host, defeating the entire design).

### 6.5 Signal handling

`SIGTERM`/`SIGINT` handlers set a `volatile sig_atomic_t` flag only (no
syscalls inside the handler itself); the main loop checks the flag at safe
points and, if set, jumps to the same rollback routine used for step failure
and normal termination. This covers `kubectl exec` disconnects and pod
deletion signaling the container.

## 7. Detailed step specifications

### 7.1 UID allocation

- Reserved range (e.g. `60000`–`65000`) that is **disjoint from any range
  real host accounts could ever occupy** — this must be a documented,
  enforced convention on the node image/provisioning side, not just an
  assumption in this tool.
- Allocation is lock-then-scan-then-claim against a dedicated lock file
  (`flock(LOCK_EX)`), not a bare `getent`-style check-then-act — two
  concurrent sessions on the same node must not race onto the same UID.
- **Never reuse a UID that has ever been assigned to a real host account**,
  even historically — if stale files elsewhere on the host carry that UID's
  ownership, the kill-by-UID sweep (§8.2) cannot distinguish session
  processes from unrelated ones, and cleanup could kill or misattribute the
  wrong things. The reserved range must be permanently excluded from any
  real-account allocation pool.

### 7.2 Session/user naming

- Username and home path both include the pod UID or exec session UUID as a
  suffix (e.g. `k8s-sess-<8charhex>`), not a bare admin username — prevents
  collisions across concurrent sessions or leftover state from a
  non-gracefully-terminated prior pod.

### 7.3 Identity file writes (passwd/shadow/group)

- Each write is **lock-then-atomic**: `flock()` the target file, write a
  full new copy to a temp file in the same directory, `fsync()`, then
  `rename()` over the original. This ensures any given do_fn either fully
  lands or leaves the file completely untouched — never a half-written
  entry — which is what allows the corresponding undo_fn to safely assume
  binary present/absent state rather than reasoning about partial writes.
- Shadow entry uses `*` or `!` as the password field — no password-based
  auth is needed since the login path is `agetty --autologin`, not
  credential entry.
- Rollback (`undo_remove_identity`) performs the same lock+atomic-rewrite
  pattern, filtering out the added username's line(s).

### 7.4 Home directory & bind mount

- `mkdir()` the ephemeral home path only after UID allocation succeeds (so
  the directory can be created with correct ownership from the start, or
  `chown()`'d immediately after `mkdir`).
- `mount(src, homedir, NULL, MS_BIND, NULL)` — a plain bind mount, not a CSI
  operation itself; this is a second, independent mount layered over
  whatever the CSI driver already mounted into the container's namespace
  (see §8.4 for why these are independent and don't need to be sequenced
  against each other on teardown).

### 7.5 Session spawn (`agetty --autologin`)

```c
execve("/proc/self/exe", (char*[]){
    "/proc/self/exe", "--phase=agetty-exec", euser, NULL
}, environ);
// which, in the --phase=agetty-exec branch, ultimately execs:
execlp("agetty", "agetty", "--autologin", euser,
       "--local-line", "--noclear", "-", "38400",
       "--term", getenv("TERM") ?: "xterm-256color", NULL);
```

- `"-"` as the line argument tells `agetty` to use the already-open
  stdin (fd 0) as the tty rather than opening a device by path — correct
  here because `kubectl exec -t -i` has already attached a pty to fd 0/1/2
  before this binary ever runs, and no container-local `/dev/pts/N` path
  needs to be threaded through.
- `--local-line` skips carrier-detect (`CLOCAL`) signaling, which a pty
  doesn't provide meaningfully.
- `--autologin <user>` skips only the username prompt; the full
  `agetty → /sbin/login → PAM` chain still runs, so `utmp`/`wtmp`
  registration, `pam_lastlog`, and session setup all occur exactly as a real
  interactive login would.
- Terminal resize is handled transparently: `kubectl exec -t` forwards
  resize events through the exec protocol, and the container runtime applies
  `TIOCSWINSZ` to the real underlying pty — no explicit handling needed in
  the shim.
- The parent process's `waitpid()` on this child is the sole blocking point
  in the entire state machine; everything before it is setup, everything
  after it (triggered by this child's exit, by signal, or by an earlier
  step's failure) is rollback.

## 8. Cleanup / rollback semantics

Cleanup must **never block** on stragglers. Ordering matters: kill first,
then unmount, so that lazy unmount has as few outstanding references as
possible to wait out.

### 8.1 Fast path: process-group kill

`kill(-session_pgid, SIGKILL)` — hits everything still attached to the
process group created via `setpgid(0,0)` in the session child. This is a
fast first pass but **not sufient alone**: any subprocess that itself called
`setsid()` (common in shells, daemonizing tools, `nohup` in some
implementations) detaches from this process group, exactly as it would
detach from a systemd scope's cgroup.

### 8.2 Authoritative sweep 1: kill by UID

Scan `/proc/[0-9]+/status`, parse the `Uid:` line, and `SIGKILL` any process
whose real UID matches the ephemeral user's allocated UID — regardless of
what PID/mount/cgroup/session namespace that process has since moved into.
UID is a kernel-global identity and cannot be escaped by namespace or
process-group tricks, which is precisely why this sweep is authoritative
where §8.1 is not.

### 8.3 Authoritative sweep 2: kill by mountpoint reference

Equivalent to `fuser -km <homedir>`: scan `/proc/*/fd/*` (open file
descriptors), `/proc/*/cwd`, and `/proc/*/maps` (mmap'd files) for anything
resolving under the ephemeral home path, and `SIGKILL` those PIDs too. This
catches processes referencing the mount **even if running as a different
UID** than the ephemeral user (e.g. something spawned as root within the
session) — a case §8.2 alone would miss.

### 8.4 Unmount

`umount2(homedir, MNT_DETACH)` — lazy unmount, detaches the mountpoint
immediately regardless of any remaining open references; the kernel
reclaims the underlying mount once the last reference drops. Since §8.2/8.3
should have already removed essentially all references, this should resolve
near-instantly in practice, but the call itself never blocks even if it
doesn't.

This bind mount is **independent of the CSI driver's own mount** — the CSI
volume mounts into the container's mount namespace at a container-local
path; the shim's bind mount is a separate mount point over the same
underlying host source, in the host mount namespace. Neither depends on the
other being torn down first: `NodeUnpublishVolume` (triggered by pod
deletion) and this lazy unmount can race freely.

### 8.5 Identity teardown

Remove the passwd/shadow/group entries via the same lock+atomic-rewrite
pattern as creation (§7.3). Note: if `nscd`/`sssd` or similar is running on
the node and caching NSS lookups, a **very short-lived stale cache entry**
for the now-deleted user is possible immediately after teardown — worth
confirming the node image's NSS caching configuration and, if present,
either disabling caching for the reserved UID range or accepting this as a
narrow, time-bounded residual risk.

### 8.6 Final directory removal

`rmdir()` the now-unmounted, now-empty home directory. If not empty (e.g. a
process created files *inside* the ephemeral homedir path itself rather than
inside the bind-mounted content, which would only happen if the mount
somehow failed earlier and was silently tolerated), this should fail loudly
rather than `rm -rf`, since silently recursive-deleting is exactly the kind
of "helpful" behavior that could delete unexpected host content if an
invariant elsewhere in the pipeline was violated.

## 9. Security considerations

### 9.1 Blast radius and access control

This design grants, to anyone able to `kubectl exec` into a correctly
labeled pod, a fully PAM-authenticated real host login — functionally
equivalent to root SSH access to the node. The Kubernetes-level control that
actually matters is RBAC on `pods/exec` (and separately, on who can *create*
pods with this privileged/hostPID/CSI spec in the first place, since anyone
who can create such a pod can also just write their own shim). Both must be
scoped as tightly as the access this tool is meant to gate.

### 9.2 UID range discipline

As above (§7.1): the reserved UID range is a hard security boundary for the
kill sweeps in §8.2. Any leak of that range into real account allocation, on
this node or any node the image runs on, undermines the isolation the
cleanup logic depends on.

### 9.3 Orphan recovery for non-graceful pod termination

`kubectl delete --force`, node crashes, or kubelet/container-runtime
failures can prevent the shim's own rollback from ever running. This design
does **not** solve that by itself — a separate, periodic reconciler (e.g. a
DaemonSet or cron job) should scan for passwd entries / bind mounts matching
the tool's naming convention that have no corresponding live pod, and reap
them. This is out of scope for the shim binary itself but is a required
companion component for the design to be operationally sound.

### 9.4 Capabilities

Running under `privileged: true` covers the required capability set
(`CAP_SYS_ADMIN` for `setns`/`mount`, `CAP_CHOWN`/`CAP_FOWNER`,
`CAP_SETUID`/`CAP_SETGID` for the login chain's privilege switch,
`CAP_AUDIT_WRITE` for PAM modules like `pam_loginuid`). If this is ever
tightened away from full `privileged: true` toward an explicit capability
list, all of the above must be enumerated explicitly rather than assumed.

### 9.5 `/etc/securetty` and root sessions

If the ephemeral user is ever created with UID 0 or otherwise granted root,
host `/etc/securetty` policy applies as it would to any other login path —
worth an explicit decision on whether ephemeral sessions should ever be
root-equivalent or should always be a non-zero, capability-limited UID
within the reserved range.

## 10. Testing / validation plan

1. **Namespace-entry correctness**: verify via a debug phase that
   `enter_ns` actually lands in host PID/mount namespaces (e.g. compare
   `/proc/self/mountinfo` contents or hostname against known host values),
   not just the container's own.
2. **Concurrency**: launch two exec sessions against two pods on the same
   node simultaneously; confirm UID allocation lock prevents collision and
   both sessions get independent, correct homedirs.
3. **Rollback on induced failure**: deliberately fail each pipeline step
   (e.g. pre-exhaust the UID range, make the bind-mount source path
   invalid) and confirm rollback correctly undoes only the steps that
   actually completed, with no leaked passwd entries, mounts, or
   directories.
4. **Orphan process survival test**: from within a session, deliberately
   `setsid()`-daemonize a background process; confirm §8.2/8.3 sweeps still
   kill it even though §8.1's process-group kill would miss it.
5. **Non-graceful termination**: `kubectl delete --force` a live session pod
   and confirm the orphan reconciler (§9.3) eventually reaps the resulting
   stale state.
6. **utmp/wtmp verification**: confirm `who`/`last` on the host correctly
   show the ephemeral user's login and logout timestamps for a normal
   session.
7. **Static binary re-exec verification**: confirm `/proc/self/exe`
   re-exec succeeds post-`setns(mnt)` even when the host rootfs has no
   compatible libc/loader at all (e.g. a minimal or different-distro host
   image), validating the static-linking rationale in §5.1.

## 11. Open questions

- Exact reserved UID range and where that convention is enforced/documented
  across the fleet (node image build, or a runtime check the shim itself
  performs against a known-bad range before allocating).
- Whether root-equivalent ephemeral sessions should be supported at all, or
  categorically disallowed (§9.5).
- Ownership and cadence of the orphan-reconciler companion component
  (§9.3) — not part of this binary, but required for the design to be
  complete.
- NSS caching behavior on target node images (§8.5) — confirm presence/
  absence of `nscd`/`sssd` and whether it needs explicit handling.

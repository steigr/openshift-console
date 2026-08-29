# node-terminal: host session shim

Implementation of [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md): a static,
single-binary C tool that, when `kubectl exec`'d into a privileged,
`hostPID`-enabled pod, produces a real PAM-authenticated login on the
underlying Kubernetes node for an ephemeral, auto-provisioned user, with
guaranteed teardown when the exec session ends.

This is a standalone break-glass tool, not itself an OpenShift console
plugin -- unlike the `terminal` plugin it lives under, it has no
frontend/backend of its own and doesn't run inside the console. It's the
debug-pod image both the `terminal` plugin's Node Terminal tab and console
core's own (patch `0006-node-terminal-podspec-via-configmap.patch`) point
at, built and shipped as its own container image so it can be referenced
directly from a pod spec, independent of the plugin's own image/release
cadence.

## Layout

```
include/        public headers for each module
src/            implementation
  main.c        argv parsing, phase dispatch, idle (PID 1) loop
  pipeline.c    the ordered step/rollback state machine (§6 of the plan)
  nsenter.c     setns() into host mnt/uts/ipc/net/pid (§6.3)
  mountns.c     mountinfo parsing, bind mount, lazy unmount (§6.4, §8.4)
  identity.c    passwd/shadow/group parsing + atomic writes, UID allocation (§7)
  session.c     fork + /proc/self/exe re-exec into agetty --autologin (§7.5),
                plus the --phase=test-worker path used only by integration tests
  cleanup.c     the three-pass kill sweep: pgid, by-uid, by-mount-reference (§8.1-8.3)
  signals.c     SIGTERM/SIGINT -> rollback plumbing (§6.5)
  fileutil.c    generic lock+atomic-rewrite-via-tempfile+rename helper
tests/unit/     pure-logic unit tests (no privilege/namespaces needed)
tests/lima/     privileged integration tests, run inside a real Lima VM
```

## Building

Release builds are multi-arch (linux/amd64 + linux/arm64) and static glibc,
via Docker/buildx -- see the root `Makefile`'s `build-terminal-shim` /
`push-terminal-shim` targets, or directly:

```bash
docker buildx build --platform=linux/amd64,linux/arm64 \
  --tag=<your-tag> --push plugins/terminal/node-terminal
```

For local Linux development, `make` / `make static` / `make test` in this
directory work directly (they won't cross-compile from macOS -- the code
uses Linux-only syscalls like `setns()`).

## Testing

Two tiers, matching what can and can't run without a real Linux kernel +
root:

1. **Unit tests** (`make test`, or automatically as part of the Docker
   build) cover pure logic with no privilege requirement: passwd/shadow/
   group file parsing and atomic rewriting, UID allocation over a range,
   and `/proc/self/mountinfo` parsing. These run in the Docker build itself
   (`RUN make test` in the `builder` stage) -- a failing test fails the
   image build.

2. **Integration tests** (`tests/lima/run-integration-tests.sh`) exercise
   the privileged parts -- `setns()`, `mount()`/`umount2()`, real
   `/etc/passwd` writes, and the kill sweeps -- against a real Linux kernel
   inside a [Lima](https://lima-vm.io/) VM (`brew install lima`). Each test
   session is launched inside `unshare --mount` to stand in for the pod's
   own (container-local) mount namespace, so the shim genuinely has to
   resolve the CSI source path before switching into the VM's ("host's")
   mount namespace -- see `tests/lima/vm-integration-test.sh` and its
   header comment for exactly what is and isn't modeled relative to a real
   cluster (notably: PID/net/uts/ipc namespaces are left shared with the VM,
   since only the mount-namespace crossing in §6.4 is load-bearing enough
   to be worth the complexity of faking).

   ```bash
   tests/lima/run-integration-tests.sh          # run, leave the VM up for follow-up debugging
   tests/lima/run-integration-tests.sh --stop    # run, then stop the VM
   tests/lima/run-integration-tests.sh --delete  # run, then delete the VM entirely
   ```

   Covers: basic session lifecycle (identity created, CSI content visible
   under the home dir, `getent`/`ps` proving the host can see the *active*
   session, everything torn down after the session ends), SIGTERM
   mid-session killing a deliberately `setsid()`-detached grandchild
   (validating that the UID/mount-reference sweeps in §8.2/§8.3 catch what
   the plain process-group kill in §8.1 would miss), two concurrent
   sessions not colliding on UID/state, a failed `resolve_src` leaving zero
   state behind, and the real `agetty --autologin` -> `/sbin/login` -> PAM
   chain (not `--test-mode`) actually registering in `utmp` -- confirmed
   via `who` -- and rolling back cleanly on SIGTERM. That last one needs a
   real pty (agetty refuses to run without one) even in a headless harness;
   see `tests/lima/pty_run.py`'s header comment for how that's provided
   without a live terminal, and why the more obvious `script`-based
   approach doesn't work non-interactively. Note: `w` has been observed
   *not* to surface these sessions in this VM even though `who` and
   `utmpdump` both show a correct entry -- looks like a procps `w` quirk
   around a stale duplicate utmp line agetty itself leaves behind (same
   truncated `ut_id`), not something this tool controls; the test logs it
   informationally but asserts only on `who`.

### What's *not* covered by either tier

- Non-graceful termination recovery (§9.3's orphan reconciler) is
  explicitly out of scope for this binary -- see the plan's Open Questions.
- Real `hostPID`/CSI-ephemeral-volume behavior end-to-end on an actual
  OpenShift cluster; the Lima harness approximates the container/host mount
  namespace boundary but isn't a Kubernetes environment.

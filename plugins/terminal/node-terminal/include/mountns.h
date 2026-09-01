#ifndef NODE_TERMINAL_MOUNTNS_H
#define NODE_TERMINAL_MOUNTNS_H

#include <stdio.h>

#include "shim.h"

/* Parse a mountinfo-format stream (as from /proc/self/mountinfo) looking
 * for the entry whose mount point equals `mount_point`, and copy its
 * device id ("major:minor", field 2) into out_dev and its `root` field
 * (field 3 -- the path *within* that device's filesystem the mount
 * exposes, NOT necessarily an absolute host path on its own; see
 * mountns_resolve_source) into out_root. Pure/testable: takes an
 * already-open FILE* so unit tests can feed it a fixture instead of the
 * real /proc file. Returns 0 if found, -1 if not found / on error. */
int mountns_parse_target(FILE *mountinfo_file, const char *mount_point,
                          char *out_dev, size_t out_dev_len,
                          char *out_root, size_t out_root_len);

/* Parse a mountinfo-format stream looking for the entry whose device id
 * (field 2) equals `dev_id` and whose own `root` field (field 3) is "/" --
 * i.e. the mount that exposes device `dev_id`'s filesystem as a whole,
 * rather than a bind mount of some subdirectory of it (as e.g. a CSI
 * ephemeral volume or a kubelet emptyDir's per-pod bind mount would be).
 * Copies its mount point (field 4) into out_mount_point. Returns 0 if
 * found, -1 if not found / on error. */
int mountns_parse_device_root(FILE *mountinfo_file, const char *dev_id,
                               char *out_mount_point, size_t out_len);

/* Phase 1 of source resolution (container-local): reads
 * /proc/self/mountinfo for ctx->csi_mount_point and stores its device id +
 * `root` field in ctx. Must run BEFORE nsenter_host()'s setns(mnt) -- see
 * §6.4: the container-local mount-point string is not resolvable once the
 * process has switched into the host mount namespace. Read-only, nothing
 * to roll back. Returns 0 on success, -1 on failure. */
int mountns_capture_target(session_ctx_t *ctx);

/* Phase 2 of source resolution (host-side): turns the device id + `root`
 * captured by mountns_capture_target() into an absolute host path and
 * stores it in ctx->src_path, by finding where that device is actually
 * mounted in the (now-active, post-nsenter_host()) host mount namespace
 * and concatenating that mount point with the captured `root`. This
 * two-phase split exists because a bind mount's `root` field is only a
 * path *within* its own filesystem -- it equals an absolute host path only
 * when that filesystem's own top-level mount is the host's "/" itself,
 * which does not hold whenever the relevant directory (typically
 * /var/lib/kubelet) is its own separate mount (a dedicated disk, ZFS
 * dataset, or LVM volume for kubelet data is a common real-world setup).
 * Must run AFTER nsenter_host(). Returns 0 on success, -1 on failure. */
int mountns_resolve_source(session_ctx_t *ctx);

/* mkdir(ctx->home_dir) (idempotent-ish: EEXIST on an empty dir is fine) and
 * chown it to ctx->uid/gid. Must run after nsenter_host() + alloc_uid, so
 * the directory lands on the host fs with the right ownership from the
 * start. Returns 0 on success, -1 on failure. */
int mountns_mkdir_home(session_ctx_t *ctx);

/* rmdir(ctx->home_dir) -- rollback for mountns_mkdir_home. Only removes it
 * if empty; logs (does not fail loudly to the caller) otherwise, per §8.6:
 * a non-empty homedir after unmount is an invariant violation worth
 * investigating, not something to force through with recursive delete. */
void mountns_rmdir_home(session_ctx_t *ctx);

/* Bind-mounts ctx->src_path onto ctx->home_dir. Must run with the host
 * mount namespace active (i.e. after nsenter_host()) -- a bind mount
 * performed in the container's mount namespace at a container-local path
 * is invisible on the host (§6.4). Returns 0 on success, -1 on failure. */
int mountns_bind_mount(session_ctx_t *ctx);

/* Lazy unmount (MNT_DETACH) of ctx->home_dir -- never blocks, even with
 * outstanding references, per §8.4. Independent of the CSI driver's own
 * mount/unmount of ctx->csi_mount_point. */
void mountns_unmount(session_ctx_t *ctx);

/* The container's own pty (inherited on fd 0/1/2) lives in a devpts
 * instance private to that container; once nsenter_host() has switched into
 * the host's mount namespace, that devpts instance (and any path into it,
 * e.g. what ttyname(0) reported before the switch) is no longer reachable
 * by path at all -- but the already-open fd keeps working for plain I/O
 * regardless. What breaks is anything that resolves the tty *by path*
 * (ttyname()), or that needs the tty's session/foreground-process-group
 * bookkeeping to be correct (tcsetattr() and friends) -- and login/PAM need
 * both. Getting there took three real fixes, layered on top of each other;
 * this comment (and mountns_claim_ctty's) records what each one addresses,
 * because the earlier two approaches for the mount itself genuinely don't
 * work and are worth not re-discovering:
 *   - A plain bind mount of /proc/self/fd/0, attempted post-nsenter: fails
 *     with EINVAL. A bind mount's source must be reachable from the
 *     *current* mount namespace's mount tree, and the container's own
 *     devpts instance no longer is, once we've switched away from it.
 *   - A symlink to the literal string "/proc/self/fd/0" (sidesteps that
 *     reachability check, since "self" isn't resolved until something later
 *     opens the symlink): works right up until whatever opens it (agetty,
 *     in earlier iterations of this design) closes and replaces its own
 *     inherited fd 0 partway through claiming the line, so by the time it
 *     actually opens the symlink, "self"'s fd 0 no longer refers to
 *     anything -- ENOENT.
 *
 * What's here instead is a real, persistent mount of the pty at a fresh
 * host path (SHIM_CTTY_BASE/node-terminal-ctty-<session>, stored in
 * ctx->ctty_path), split into three calls because of where in the pipeline
 * each part is possible or necessary:
 *   - mountns_capture_ctty() (pre-nsenter, container-local): OPEN_TREE_CLONE
 *     clones the pty's mount into a *detached* mount fd (ctx->ctty_tree_fd)
 *     while the container's own devpts instance is still reachable -- a
 *     detached mount fd carries no dependency on any one namespace's tree
 *     from that point on.
 *   - mountns_bind_ctty() (post-nsenter, host-side, in the shim's own
 *     top-level process): move_mount() attaches that detached mount fd onto
 *     ctx->ctty_path in the *host's* mount namespace. The reachability
 *     restriction that broke a plain bind mount doesn't apply here (the
 *     mount was captured before it could), and the result is a real,
 *     ordinary mount -- not a dynamic self-reference like the symlink
 *     attempt, so nothing closing/reopening its own fd 0 affects it.
 *   - mountns_claim_ctty() -- see its own doc comment for why this can't
 *     also happen in mountns_bind_ctty(), or in the shim's top-level
 *     process at all: it has to run in the exact process that's about to
 *     exec into login.
 *
 * Returns 0 on success, -1 on failure. */
int mountns_capture_ctty(session_ctx_t *ctx);
int mountns_bind_ctty(session_ctx_t *ctx);
int mountns_claim_ctty(session_ctx_t *ctx);

/* Lazy unmount (MNT_DETACH) + unlink of ctx->ctty_path -- rollback for
 * mountns_bind_ctty(). Never blocks, same rationale as mountns_unmount(). */
void mountns_unmount_ctty(session_ctx_t *ctx);

#endif /* NODE_TERMINAL_MOUNTNS_H */

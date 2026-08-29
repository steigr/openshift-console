#ifndef NODE_TERMINAL_MOUNTNS_H
#define NODE_TERMINAL_MOUNTNS_H

#include <stdio.h>

#include "shim.h"

/* Parse a mountinfo-format stream (as from /proc/self/mountinfo) looking
 * for the entry whose mount point equals `mount_point`, and copy its
 * mount-source field into out_src (size out_src_len). Pure/testable: takes
 * an already-open FILE* so unit tests can feed it a fixture instead of the
 * real /proc file. Returns 0 if found, -1 if not found / on error. */
int mountns_parse_source(FILE *mountinfo_file, const char *mount_point, char *out_src, size_t out_src_len);

/* Resolve ctx->csi_mount_point to its host-side source path by reading
 * /proc/self/mountinfo, and store it in ctx->src_path. Must be called
 * BEFORE nsenter_host()'s setns(mnt) -- see §6.4: the container-local path
 * is not resolvable once the process has switched into the host mount
 * namespace. Returns 0 on success, -1 on failure. */
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

#endif /* NODE_TERMINAL_MOUNTNS_H */

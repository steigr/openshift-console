#ifndef NODE_TERMINAL_CLEANUP_H
#define NODE_TERMINAL_CLEANUP_H

#include "shim.h"

/* Fast path (§8.1): kill(-pgid, SIGKILL). Not sufficient alone -- any
 * subprocess that called setsid() detaches from this process group. */
void cleanup_kill_pgid(pid_t pgid);

/* Authoritative sweep 1 (§8.2): scan /proc/[0-9]+/status, SIGKILL any
 * process whose real UID matches `uid`, regardless of what PID/mount/net
 * namespace it has since moved into. Returns the number of processes
 * signalled. */
int cleanup_kill_by_uid(uid_t uid);

/* Authoritative sweep 2 (§8.3): scan every pid's fd, cwd, and maps entries
 * under /proc for anything resolving under `path_prefix`, SIGKILL those
 * PIDs too -- catches processes referencing the mount even under a
 * different UID. Returns the number of processes signalled. */
int cleanup_kill_by_path_ref(const char *path_prefix);

/* Runs the full sweep in order (pgid, then uid, then path-ref) with a
 * short settle between passes, per §8: kill first, then unmount, so lazy
 * unmount has as few outstanding references as possible to wait out. */
void cleanup_full_sweep(session_ctx_t *ctx);

#endif /* NODE_TERMINAL_CLEANUP_H */

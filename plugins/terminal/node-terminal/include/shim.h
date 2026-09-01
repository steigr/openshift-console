#ifndef NODE_TERMINAL_SHIM_H
#define NODE_TERMINAL_SHIM_H

#include <sys/types.h>

/* Reserved UID/GID range for ephemeral session accounts. Must be disjoint
 * from any range real host accounts could ever occupy (§7.1, §9.2 of the
 * implementation plan) -- this is a documented convention enforced by
 * whoever provisions the node image, not something this tool can verify
 * on its own beyond refusing to allocate outside the range. */
#define SHIM_UID_RANGE_MIN 60000
#define SHIM_UID_RANGE_MAX 65000

#define SHIM_LOCK_PATH   "/etc/.node-terminal-uid.lock"
#define SHIM_PASSWD_PATH "/etc/passwd"
#define SHIM_SHADOW_PATH "/etc/shadow"
#define SHIM_GROUP_PATH  "/etc/group"
#define SHIM_HOME_BASE   "/home"
#define SHIM_USER_PREFIX "k8s-sess-"

#define SHIM_USERNAME_MAX 64
#define SHIM_PATH_MAX     256

/* Bound on how many of the sudo reference user's supplementary groups
 * identity_inherit_groups() will join the ephemeral account to - a real
 * host account is very unlikely to be in more than a handful of groups
 * that actually matter for this (sudo/wheel/admin-ish ones), so this is
 * generous headroom, not a tight budget. */
#define SHIM_MAX_INHERITED_GROUPS 32
#define SHIM_GROUPNAME_MAX        64

/* Base directory for the per-session controlling-tty alias - see
 * mountns_bind_ctty(). /dev is a reasonable, conventional home for it (a
 * fake pty living among the real ones), though nothing strictly requires it
 * there any more: mountns_claim_ctty() always opens ctx->ctty_path in full,
 * nothing parses it as a bare device *name* the way agetty's own `line`
 * argument once needed it to be, back when this design still ran agetty
 * (see session.c's own doc comment for why it no longer does). */
#define SHIM_CTTY_BASE "/dev"

/* Base directory for the host-resident copy of this binary that privacy
 * mode (NODE_TERMINAL_EXEC_MODE) publishes so `kubectl exec` has something
 * to find - see pipeline.c's publish_shim_binary() doc comment for why a
 * copy is needed at all rather than exec'ing "/node-terminal-shim" (the
 * container-local path) directly. Deliberately NOT /run: it's a tmpfs
 * commonly mounted `noexec` (confirmed live on this project's own test
 * cluster - executing a copy placed there fails with EPERM even though the
 * file's own permission bits are fine), whereas the node's real root
 * filesystem underneath /var/lib is reliably exec-capable. */
#define SHIM_PUBLISHED_BINARY_BASE "/var/lib/node-terminal-shim"

typedef struct {
    /* configuration, filled in from argv/env before the pipeline runs */
    char csi_mount_point[SHIM_PATH_MAX]; /* container-local CSI mount, e.g. /mnt/userhome */
    int  test_mode;                      /* skip login, run a scripted dummy session instead */
    int  test_duration_secs;             /* how long the test-mode session "runs" for */

    /* derived / allocated state, filled in as steps complete */
    char session_id[16];                 /* 8 hex chars + NUL */
    char username[SHIM_USERNAME_MAX];    /* SHIM_USER_PREFIX + session_id */
    uid_t uid;
    gid_t gid;
    char home_dir[SHIM_PATH_MAX];
    char csi_mount_dev[32];              /* csi_mount_point's device id ("major:minor"), captured pre-nsenter */
    char csi_mount_root[SHIM_PATH_MAX];  /* csi_mount_point's mountinfo `root` field, captured pre-nsenter */
    char src_path[SHIM_PATH_MAX];        /* host-side source, resolved post-nsenter from the above */
    char ctty_path[SHIM_PATH_MAX];       /* host-side alias for the inherited pty - see mountns_bind_ctty() */
    int  ctty_tree_fd;                   /* detached mount fd from mountns_capture_ctty(), consumed by mountns_bind_ctty() */

    /* groups ctx->username was actually added to by identity_inherit_groups()
     * (a subset of the sudo reference user's own supplementary groups, per
     * NODE_TERMINAL_SUDO_REFERENCE_USER - see identity_inherit_groups's own
     * doc comment), tracked so identity_leave_inherited_groups() (rollback)
     * knows exactly what to undo without re-deriving it. */
    char   inherited_groups[SHIM_MAX_INHERITED_GROUPS][SHIM_GROUPNAME_MAX];
    size_t inherited_groups_count;

    pid_t session_pid;
    pid_t session_pgid;

    int uid_lock_fd;                     /* held open across alloc_uid..write_identity */

    /* per-step completion flags, used to drive reverse-order rollback */
    int done_enter_ns;
    int done_resolve_src;
    int done_alloc_uid;
    int done_write_identity;
    int done_inherit_groups;
    int done_mkdir_home;
    int done_bind_mount;
    int done_bind_ctty;
    int done_publish_shim;
} session_ctx_t;

#endif /* NODE_TERMINAL_SHIM_H */

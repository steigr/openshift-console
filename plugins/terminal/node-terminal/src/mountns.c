#define _GNU_SOURCE
#include "mountns.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define MOUNTINFO_MAX_TOKENS 64

/* open_tree()/move_mount() (Linux 5.2+) - not wrapped by glibc as of many
 * still-common versions, so called via syscall() directly. Falls back to
 * hand-written syscall numbers (stable across x86_64 and arm64, the two
 * architectures this shim ships for) if an older <sys/syscall.h> doesn't
 * define them yet. */
#ifndef SYS_open_tree
#define SYS_open_tree 428
#endif
#ifndef SYS_move_mount
#define SYS_move_mount 429
#endif
#ifndef OPEN_TREE_CLONE
#define OPEN_TREE_CLONE 1
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif
#ifndef MOVE_MOUNT_F_EMPTY_PATH
#define MOVE_MOUNT_F_EMPTY_PATH 0x00000004
#endif

static int shim_open_tree(int dfd, const char *path, unsigned flags) {
    return (int)syscall(SYS_open_tree, dfd, path, flags);
}

static int shim_move_mount(int from_dfd, const char *from_path, int to_dfd, const char *to_path, unsigned flags) {
    return (int)syscall(SYS_move_mount, from_dfd, from_path, to_dfd, to_path, flags);
}

/* Splits a mountinfo line into its whitespace-separated tokens (up to
 * MOUNTINFO_MAX_TOKENS). Returns the token count; `*copy_out` receives the
 * strdup'd buffer the tokens point into (caller must free it), or NULL if
 * strdup failed (in which case the token count is 0). */
static int mountinfo_tokenize(const char *line, char *tokens[], int max_tokens, char **copy_out) {
    char *copy = strdup(line);
    *copy_out = copy;
    if (!copy) {
        return 0;
    }
    int ntok = 0;
    char *saveptr = NULL;
    char *tok = strtok_r(copy, " \t\n", &saveptr);
    while (tok && ntok < max_tokens) {
        tokens[ntok++] = tok;
        tok = strtok_r(NULL, " \t\n", &saveptr);
    }
    return ntok;
}

/* mountID(0) parentID(1) major:minor(2) root(3) mountPoint(4) mountOpts(5)
 * optFields...(N) "-"(sep) fsType shared-src superOpts */
int mountns_parse_target(FILE *mountinfo_file, const char *mount_point,
                          char *out_dev, size_t out_dev_len,
                          char *out_root, size_t out_root_len) {
    if (!mountinfo_file) {
        errno = EINVAL;
        return -1;
    }
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    int found = 0;

    while (!found && (n = getline(&line, &cap, mountinfo_file)) != -1) {
        char *tokens[MOUNTINFO_MAX_TOKENS];
        char *copy;
        int ntok = mountinfo_tokenize(line, tokens, MOUNTINFO_MAX_TOKENS, &copy);
        if (!copy) continue;

        if (ntok >= 5 && strcmp(tokens[4], mount_point) == 0) {
            strncpy(out_dev, tokens[2], out_dev_len - 1);
            out_dev[out_dev_len - 1] = '\0';
            strncpy(out_root, tokens[3], out_root_len - 1);
            out_root[out_root_len - 1] = '\0';
            found = 1;
        }
        free(copy);
    }
    free(line);

    if (!found) {
        errno = ENOENT;
        return -1;
    }
    return 0;
}

int mountns_parse_device_root(FILE *mountinfo_file, const char *dev_id,
                               char *out_mount_point, size_t out_len) {
    if (!mountinfo_file) {
        errno = EINVAL;
        return -1;
    }
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    int found = 0;

    while (!found && (n = getline(&line, &cap, mountinfo_file)) != -1) {
        char *tokens[MOUNTINFO_MAX_TOKENS];
        char *copy;
        int ntok = mountinfo_tokenize(line, tokens, MOUNTINFO_MAX_TOKENS, &copy);
        if (!copy) continue;

        if (ntok >= 5 && strcmp(tokens[2], dev_id) == 0 && strcmp(tokens[3], "/") == 0) {
            strncpy(out_mount_point, tokens[4], out_len - 1);
            out_mount_point[out_len - 1] = '\0';
            found = 1;
        }
        free(copy);
    }
    free(line);

    if (!found) {
        errno = ENOENT;
        return -1;
    }
    return 0;
}

int mountns_capture_target(session_ctx_t *ctx) {
    FILE *f = fopen("/proc/self/mountinfo", "r");
    if (!f) {
        shim_logerr("mountns_capture_target: open /proc/self/mountinfo");
        return -1;
    }
    int rc = mountns_parse_target(f, ctx->csi_mount_point,
                                   ctx->csi_mount_dev, sizeof(ctx->csi_mount_dev),
                                   ctx->csi_mount_root, sizeof(ctx->csi_mount_root));
    fclose(f);
    if (rc != 0) {
        shim_log("mountns_capture_target: no mountinfo entry for %s", ctx->csi_mount_point);
    }
    return rc;
}

/* base_mount_point + root, without doubling up "/" when either half is
 * already just "/" on its own (the common case: root == "/" whenever
 * csi_mount_point's device IS the host's top-level mount for itself, e.g.
 * a CSI driver bind-mounting a directory that's already on the node's root
 * filesystem). */
static void join_host_path(const char *base_mount_point, const char *root, char *out, size_t out_len) {
    if (strcmp(root, "/") == 0) {
        snprintf(out, out_len, "%s", base_mount_point);
    } else if (strcmp(base_mount_point, "/") == 0) {
        snprintf(out, out_len, "%s", root);
    } else {
        /* Both inputs are already-NUL-terminated, size-bounded mountinfo
         * fields (SHIM_PATH_MAX each), same as the destination - a
         * combined write can't actually overflow it in practice, but gcc
         * can't see that bound across two independent %s args, hence
         * -Wformat-truncation below; snprintf's own truncation is safe
         * either way (NUL-terminated, just possibly short). */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
        snprintf(out, out_len, "%s%s", base_mount_point, root);
#pragma GCC diagnostic pop
    }
}

int mountns_resolve_source(session_ctx_t *ctx) {
    FILE *f = fopen("/proc/self/mountinfo", "r");
    if (!f) {
        shim_logerr("mountns_resolve_source: open /proc/self/mountinfo");
        return -1;
    }
    char base_mount_point[SHIM_PATH_MAX];
    int rc = mountns_parse_device_root(f, ctx->csi_mount_dev, base_mount_point, sizeof(base_mount_point));
    fclose(f);
    if (rc != 0) {
        shim_log("mountns_resolve_source: no top-level host mount for device %s", ctx->csi_mount_dev);
        return rc;
    }
    join_host_path(base_mount_point, ctx->csi_mount_root, ctx->src_path, sizeof(ctx->src_path));
    return 0;
}

int mountns_mkdir_home(session_ctx_t *ctx) {
    if (mkdir(ctx->home_dir, 0700) != 0 && errno != EEXIST) {
        shim_logerr("mountns_mkdir_home: mkdir %s", ctx->home_dir);
        return -1;
    }
    if (chown(ctx->home_dir, ctx->uid, ctx->gid) != 0) {
        shim_logerr("mountns_mkdir_home: chown %s", ctx->home_dir);
        rmdir(ctx->home_dir);
        return -1;
    }
    return 0;
}

void mountns_rmdir_home(session_ctx_t *ctx) {
    if (rmdir(ctx->home_dir) != 0 && errno != ENOENT) {
        shim_logerr("mountns_rmdir_home: rmdir %s (non-empty? invariant violated, not force-removing, §8.6)", ctx->home_dir);
    }
}

int mountns_bind_mount(session_ctx_t *ctx) {
    if (mount(ctx->src_path, ctx->home_dir, NULL, MS_BIND, NULL) != 0) {
        shim_logerr("mountns_bind_mount: mount(%s -> %s)", ctx->src_path, ctx->home_dir);
        return -1;
    }
    return 0;
}

void mountns_unmount(session_ctx_t *ctx) {
    if (umount2(ctx->home_dir, MNT_DETACH) != 0 && errno != EINVAL && errno != ENOENT) {
        shim_logerr("mountns_unmount: umount2(%s, MNT_DETACH)", ctx->home_dir);
    }
}

int mountns_capture_ctty(session_ctx_t *ctx) {
    /* OPEN_TREE_CLONE + AT_EMPTY_PATH on dfd=0 (our own stdin, the pty
     * slave) clones the pty's mount into a new, detached "mount fd" --
     * captured while the container's own devpts instance (which backs it)
     * is still reachable, i.e. before nsenter_host()'s setns(mnt). A
     * detached mount fd carries no dependency on any particular mount
     * namespace's tree from this point on, unlike a plain path: it can be
     * attached into an entirely different one later via move_mount(), which
     * is exactly what mountns_bind_ctty() (post-nsenter) does with it. */
    ctx->ctty_tree_fd = shim_open_tree(0, "", OPEN_TREE_CLONE | AT_EMPTY_PATH);
    if (ctx->ctty_tree_fd < 0) {
        shim_logerr("mountns_capture_ctty: open_tree(fd 0)");
        return -1;
    }
    return 0;
}

int mountns_bind_ctty(session_ctx_t *ctx) {
    /* Short, hyphen-free, conventional-looking device name (rather than
     * e.g. "node-terminal-ctty-<session>") - `who`/`w`'s tty-name handling
     * on this host was observed truncating/mishandling the longer,
     * multi-hyphen form (see mountns.h's doc comment on why utmp/logind
     * visibility here is best-effort in the first place; this is a small
     * mitigation, not a guaranteed fix - the actual session and its
     * controlling terminal work identically either way). */
    snprintf(ctx->ctty_path, sizeof(ctx->ctty_path), "%s/ntty%s", SHIM_CTTY_BASE, ctx->session_id);

    /* See mountns.h's doc comment for why this is move_mount() of a
     * pre-captured detached mount, not a plain bind mount or a symlink. */
    int fd = open(ctx->ctty_path, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) {
        shim_logerr("mountns_bind_ctty: open %s", ctx->ctty_path);
        return -1;
    }
    close(fd);

    if (shim_move_mount(ctx->ctty_tree_fd, "", AT_FDCWD, ctx->ctty_path, MOVE_MOUNT_F_EMPTY_PATH) != 0) {
        shim_logerr("mountns_bind_ctty: move_mount(-> %s)", ctx->ctty_path);
        unlink(ctx->ctty_path);
        close(ctx->ctty_tree_fd);
        ctx->ctty_tree_fd = -1;
        return -1;
    }
    close(ctx->ctty_tree_fd);
    ctx->ctty_tree_fd = -1;
    return 0;
}

int mountns_claim_ctty(session_ctx_t *ctx) {
    /* Re-point our own fd 0/1/2 at a fresh open of ctty_path, replacing the
     * container-local ones inherited at container start, then claim it as
     * our controlling terminal (setsid() + ioctl(TIOCSCTTY, 1)).
     *
     * Re-pointing fd 0/1/2 is what actually fixes ttyname() for whatever
     * runs afterward: it operates on *whichever open file description* fd 0
     * currently is, and the kernel tracks the path used to open each one
     * independently of the underlying tty_struct they share -- our original
     * fd 0's path is still the container's own, unreachable devpts entry
     * (see mountns_bind_ctty's doc comment / mountns_capture_ctty's), but
     * this new one was opened through ctty_path, a real path in the
     * *current* (host, post-nsenter) mount namespace.
     *
     * The claim (setsid + TIOCSCTTY) is what fixes tcsetattr(): without an
     * explicit claim anywhere, the tty's foreground process group is never
     * set at all, and termios calls against a tty whose foreground group
     * doesn't match the caller's fail with EIO. setsid() is expected to
     * fail here with EPERM if the caller is already a session leader --
     * not a problem to fix, just means there's nothing to detach from.
     *
     * MUST be called by whichever process is about to become (via exec,
     * not fork) the interactive session itself -- i.e. from inside
     * session_spawn_and_wait's forked child, NOT from the shim's own
     * top-level process before forking. Both agetty and login, if allowed
     * to run their own internal claim logic, unconditionally call setsid()
     * on themselves regardless of what's already inherited (confirmed live
     * for both: agetty's attempt reliably fails with EPERM afterward;
     * login's succeeds in creating a new session but then stops itself with
     * SIGTTIN/SIGTTOU trying to read/write a tty whose foreground group it
     * no longer matches) -- since neither is itself a process-group leader
     * at exec time, their own setsid() calls succeed, silently detaching
     * from whatever the *parent* set up and discarding it. Doing the claim
     * in the exact process that will exec into agetty/login instead means
     * that process already *is* both session leader and tty owner by the
     * time agetty/login's own internal logic runs -- their own setsid()
     * calls then correctly fail with EPERM (already a leader) and skip
     * re-claiming, because there's nothing left to steal. */
    int newfd = open(ctx->ctty_path, O_RDWR);
    if (newfd < 0) {
        shim_logerr("mountns_claim_ctty: reopen %s", ctx->ctty_path);
        return -1;
    }
    if (dup2(newfd, STDIN_FILENO) < 0 || dup2(newfd, STDOUT_FILENO) < 0 || dup2(newfd, STDERR_FILENO) < 0) {
        shim_logerr("mountns_claim_ctty: dup2(%s onto 0/1/2)", ctx->ctty_path);
        close(newfd);
        return -1;
    }
    if (newfd > STDERR_FILENO) {
        close(newfd);
    }
    if (setsid() < 0 && errno != EPERM) {
        shim_logerr("mountns_claim_ctty: setsid");
        return -1;
    }
    if (ioctl(STDIN_FILENO, TIOCSCTTY, 1) != 0) {
        shim_logerr("mountns_claim_ctty: ioctl(TIOCSCTTY) on %s", ctx->ctty_path);
        return -1;
    }
    return 0;
}

void mountns_unmount_ctty(session_ctx_t *ctx) {
    if (umount2(ctx->ctty_path, MNT_DETACH) != 0 && errno != EINVAL && errno != ENOENT) {
        shim_logerr("mountns_unmount_ctty: umount2(%s, MNT_DETACH)", ctx->ctty_path);
    }
    if (unlink(ctx->ctty_path) != 0 && errno != ENOENT) {
        shim_logerr("mountns_unmount_ctty: unlink %s", ctx->ctty_path);
    }
}

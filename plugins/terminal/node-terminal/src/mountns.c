#define _GNU_SOURCE
#include "mountns.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define MOUNTINFO_MAX_TOKENS 64

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

int mountns_bind_ctty(session_ctx_t *ctx) {
    snprintf(ctx->ctty_path, sizeof(ctx->ctty_path), "%s/node-terminal-ctty-%s", SHIM_CTTY_BASE, ctx->session_id);

    int fd = open(ctx->ctty_path, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) {
        shim_logerr("mountns_bind_ctty: open %s", ctx->ctty_path);
        return -1;
    }
    close(fd);

    if (mount("/proc/self/fd/0", ctx->ctty_path, NULL, MS_BIND, NULL) != 0) {
        shim_logerr("mountns_bind_ctty: mount(/proc/self/fd/0 -> %s)", ctx->ctty_path);
        unlink(ctx->ctty_path);
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

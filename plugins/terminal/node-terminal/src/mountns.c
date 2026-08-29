#define _GNU_SOURCE
#include "mountns.h"
#include "log.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define MOUNTINFO_MAX_TOKENS 64

int mountns_parse_source(FILE *mountinfo_file, const char *mount_point, char *out_src, size_t out_src_len) {
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
        int ntok = 0;
        char *copy = strdup(line);
        if (!copy) continue;
        char *saveptr = NULL;
        char *tok = strtok_r(copy, " \t\n", &saveptr);
        while (tok && ntok < MOUNTINFO_MAX_TOKENS) {
            tokens[ntok++] = tok;
            tok = strtok_r(NULL, " \t\n", &saveptr);
        }

        /* mountID(0) parentID(1) major:minor(2) root(3) mountPoint(4)
         * mountOpts(5) optFields...(N) "-"(sep) fsType shared-src superOpts
         *
         * `root` (field 3), not the post-"-" mount-source field, is what we
         * want here: for a bind mount, mount-source names the *device*
         * backing the whole filesystem (e.g. /dev/vda1) -- constant across
         * every mount of that device -- while `root` is the path *within*
         * that filesystem the bind mount exposes. For a CSI ephemeral
         * volume backed by a real on-disk host directory (the case this
         * tool assumes, per the plan), that filesystem's root is the node's
         * own root filesystem, so `root` doubles as the absolute host path
         * -- exactly what bind_mount() needs post-setns(mnt). This breaks
         * down for volumes backed by a filesystem not rooted at the host's
         * "/" (e.g. a private tmpfs), which is a limitation of the
         * bind-mount-based CSI approach itself, not of this parser. */
        if (ntok >= 5 && strcmp(tokens[4], mount_point) == 0) {
            strncpy(out_src, tokens[3], out_src_len - 1);
            out_src[out_src_len - 1] = '\0';
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

int mountns_resolve_source(session_ctx_t *ctx) {
    FILE *f = fopen("/proc/self/mountinfo", "r");
    if (!f) {
        shim_logerr("mountns_resolve_source: open /proc/self/mountinfo");
        return -1;
    }
    int rc = mountns_parse_source(f, ctx->csi_mount_point, ctx->src_path, sizeof(ctx->src_path));
    fclose(f);
    if (rc != 0) {
        shim_log("mountns_resolve_source: no mountinfo entry for %s", ctx->csi_mount_point);
    }
    return rc;
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

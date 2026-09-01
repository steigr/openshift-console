#define _GNU_SOURCE
#include "identity.h"
#include "fileutil.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <time.h>
#include <unistd.h>

int identity_find_free_uid(const char *passwd_path, uid_t range_min, uid_t range_max, uid_t *out_uid) {
    if (range_max < range_min) {
        errno = EINVAL;
        return -1;
    }
    size_t range = (size_t)(range_max - range_min) + 1;
    /* Bounded by the reserved range size (a few thousand entries, per the
     * plan's §7.1 recommendation of 60000-65000) -- a bitmap is simplest
     * and avoids any dynamic growth logic. */
    unsigned char *used = calloc(range, 1);
    if (!used) return -1;

    FILE *f = fopen(passwd_path, "r");
    if (f) {
        char *line = NULL;
        size_t cap = 0;
        ssize_t n;
        while ((n = getline(&line, &cap, f)) != -1) {
            (void)n;
            /* username:passwd:uid:gid:gecos:home:shell */
            char *saveptr = NULL;
            char *tmp = strdup(line);
            if (!tmp) continue;
            char *field = strtok_r(tmp, ":", &saveptr); /* username */
            field = strtok_r(NULL, ":", &saveptr);       /* passwd */
            field = strtok_r(NULL, ":", &saveptr);       /* uid */
            if (field) {
                errno = 0;
                char *endptr = NULL;
                unsigned long v = strtoul(field, &endptr, 10);
                if (errno == 0 && endptr != field) {
                    if (v >= range_min && v <= range_max) {
                        used[v - range_min] = 1;
                    }
                }
            }
            free(tmp);
        }
        free(line);
        fclose(f);
    } else if (errno != ENOENT) {
        free(used);
        return -1;
    }

    for (size_t i = 0; i < range; i++) {
        if (!used[i]) {
            *out_uid = range_min + (uid_t)i;
            free(used);
            return 0;
        }
    }
    free(used);
    errno = ENOSPC;
    return -1;
}

int identity_alloc_uid(session_ctx_t *ctx) {
    int fd = open(SHIM_LOCK_PATH, O_CREAT | O_RDWR, 0600);
    if (fd < 0) {
        shim_logerr("identity_alloc_uid: open lock %s", SHIM_LOCK_PATH);
        return -1;
    }
    if (flock(fd, LOCK_EX) != 0) {
        shim_logerr("identity_alloc_uid: flock %s", SHIM_LOCK_PATH);
        close(fd);
        return -1;
    }

    uid_t uid;
    if (identity_find_free_uid(SHIM_PASSWD_PATH, SHIM_UID_RANGE_MIN, SHIM_UID_RANGE_MAX, &uid) != 0) {
        shim_logerr("identity_alloc_uid: no free uid in [%d,%d]", SHIM_UID_RANGE_MIN, SHIM_UID_RANGE_MAX);
        flock(fd, LOCK_UN);
        close(fd);
        return -1;
    }

    ctx->uid = uid;
    ctx->gid = uid; /* dedicated per-session group, gid == uid, standard useradd convention */
    ctx->uid_lock_fd = fd; /* held across write_identity; released by rollback or explicit unlock */
    return 0;
}

void identity_release_uid_lock(session_ctx_t *ctx) {
    if (ctx->uid_lock_fd >= 0) {
        flock(ctx->uid_lock_fd, LOCK_UN);
        close(ctx->uid_lock_fd);
        ctx->uid_lock_fd = -1;
    }
}

struct append_ud {
    const char *line; /* without trailing newline */
};

static int append_transform(FILE *in, FILE *out, void *user_data) {
    struct append_ud *ud = user_data;
    int last_was_newline = 1;
    if (in) {
        int c;
        while ((c = fgetc(in)) != EOF) {
            fputc(c, out);
            last_was_newline = (c == '\n');
        }
    }
    if (!last_was_newline) {
        fputc('\n', out);
    }
    fputs(ud->line, out);
    fputc('\n', out);
    return 0;
}

struct remove_ud {
    const char *prefix; /* "username:" */
};

static int remove_transform(FILE *in, FILE *out, void *user_data) {
    struct remove_ud *ud = user_data;
    size_t prefix_len = strlen(ud->prefix);
    if (!in) return 0; /* nothing to remove from a file that doesn't exist */
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    while ((n = getline(&line, &cap, in)) != -1) {
        if ((size_t)n >= prefix_len && strncmp(line, ud->prefix, prefix_len) == 0) {
            continue; /* drop this line */
        }
        fwrite(line, 1, (size_t)n, out);
    }
    free(line);
    return 0;
}

int identity_write_entries_at(const char *passwd_path, const char *shadow_path,
                               const char *group_path, const char *username,
                               uid_t uid, gid_t gid, const char *home_dir) {
    char passwd_line[512];
    snprintf(passwd_line, sizeof(passwd_line), "%s:x:%u:%u:node-terminal ephemeral session:%s:/bin/sh",
              username, (unsigned)uid, (unsigned)gid, home_dir);
    struct append_ud pud = { .line = passwd_line };
    if (atomic_rewrite_file(passwd_path, append_transform, &pud) != 0) {
        return -1;
    }

    char group_line[512];
    snprintf(group_line, sizeof(group_line), "%s:x:%u:", username, (unsigned)gid);
    struct append_ud gud = { .line = group_line };
    if (atomic_rewrite_file(group_path, append_transform, &gud) != 0) {
        /* best-effort undo of the passwd entry we just added */
        struct remove_ud rud = { .prefix = NULL };
        char prefix[SHIM_USERNAME_MAX + 1];
        snprintf(prefix, sizeof(prefix), "%s:", username);
        rud.prefix = prefix;
        atomic_rewrite_file(passwd_path, remove_transform, &rud);
        return -1;
    }

    /* '!' locks password-based auth entirely -- login happens via
     * `login -f`, never a password prompt (§7.3). Fields:
     * user:pass:lastchg:min:max:warn:inactive:expire: */
    time_t now = time(NULL);
    long days_since_epoch = (long)(now / 86400);
    char shadow_line[512];
    snprintf(shadow_line, sizeof(shadow_line), "%s:!:%ld:0:99999:7:::", username, days_since_epoch);
    struct append_ud sud = { .line = shadow_line };
    if (atomic_rewrite_file(shadow_path, append_transform, &sud) != 0) {
        char prefix[SHIM_USERNAME_MAX + 1];
        snprintf(prefix, sizeof(prefix), "%s:", username);
        struct remove_ud rud = { .prefix = prefix };
        atomic_rewrite_file(passwd_path, remove_transform, &rud);
        atomic_rewrite_file(group_path, remove_transform, &rud);
        return -1;
    }

    return 0;
}

int identity_write_entries(session_ctx_t *ctx) {
    return identity_write_entries_at(SHIM_PASSWD_PATH, SHIM_SHADOW_PATH, SHIM_GROUP_PATH,
                                      ctx->username, ctx->uid, ctx->gid, ctx->home_dir);
}

int identity_remove_entries_at(const char *passwd_path, const char *shadow_path,
                                const char *group_path, const char *username) {
    char prefix[SHIM_USERNAME_MAX + 1];
    snprintf(prefix, sizeof(prefix), "%s:", username);
    struct remove_ud rud = { .prefix = prefix };

    int rc = 0;
    if (atomic_rewrite_file(passwd_path, remove_transform, &rud) != 0) rc = -1;
    if (atomic_rewrite_file(shadow_path, remove_transform, &rud) != 0) rc = -1;
    if (atomic_rewrite_file(group_path, remove_transform, &rud) != 0) rc = -1;
    return rc;
}

void identity_remove_entries(session_ctx_t *ctx) {
    if (identity_remove_entries_at(SHIM_PASSWD_PATH, SHIM_SHADOW_PATH, SHIM_GROUP_PATH, ctx->username) != 0) {
        shim_logerr("identity_remove_entries: failed to fully remove entries for %s", ctx->username);
    }
}

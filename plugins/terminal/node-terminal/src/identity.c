#define _GNU_SOURCE
#include "identity.h"
#include "fileutil.h"
#include "log.h"

#include <ctype.h>
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

int identity_valid_username(const char *username) {
    if (!username || !username[0]) {
        return 0;
    }
    size_t len = strlen(username);
    if (len > SHIM_USERNAME_MAX - 1) {
        return 0;
    }
    unsigned char c0 = (unsigned char)username[0];
    if (!(islower(c0) || c0 == '_')) {
        return 0;
    }
    for (size_t i = 1; i < len; i++) {
        unsigned char c = (unsigned char)username[i];
        if (!(islower(c) || isdigit(c) || c == '_' || c == '-')) {
            return 0;
        }
    }
    return 1;
}

int identity_username_exists_at(const char *passwd_path, const char *username) {
    FILE *f = fopen(passwd_path, "r");
    if (!f) {
        return 0; /* a file that doesn't exist yet has no entries to collide with */
    }
    size_t ulen = strlen(username);
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    int found = 0;
    while (!found && (n = getline(&line, &cap, f)) != -1) {
        if ((size_t)n > ulen && strncmp(line, username, ulen) == 0 && line[ulen] == ':') {
            found = 1;
        }
    }
    free(line);
    fclose(f);
    return found;
}

int identity_resolve_username(session_ctx_t *ctx) {
    if (identity_username_exists_at(SHIM_PASSWD_PATH, ctx->username)) {
        shim_log("identity_resolve_username: %s already exists on the host, falling back to %s%s",
                 ctx->username, SHIM_USER_PREFIX, ctx->session_id);
        snprintf(ctx->username, sizeof(ctx->username), "%s%s", SHIM_USER_PREFIX, ctx->session_id);
        snprintf(ctx->home_dir, sizeof(ctx->home_dir), "%s/%s", SHIM_HOME_BASE, ctx->username);
    }
    return 0;
}

/* username:passwd:gid:member1,member2,... - splits a mutable copy of one
 * group line into its four fields. `*out_members` is set to NULL if the
 * member-list field is empty (a group with no supplementary members at
 * all). Returns 0 if at least the first three fields were present, -1 if
 * the line is too malformed to touch safely (caller should leave it
 * untouched in that case). */
static int split_group_line(char *line_copy, char **out_name, char **out_passwd,
                             char **out_gid, char **out_members) {
    char *nl = strchr(line_copy, '\n');
    if (nl) *nl = '\0';
    char *saveptr = NULL;
    *out_name = strtok_r(line_copy, ":", &saveptr);
    *out_passwd = strtok_r(NULL, ":", &saveptr);
    *out_gid = strtok_r(NULL, ":", &saveptr);
    *out_members = strtok_r(NULL, ":", &saveptr);
    return (*out_name && *out_passwd && *out_gid) ? 0 : -1;
}

int identity_find_supplementary_groups_at(const char *group_path, const char *username,
                                           char out_names[][SHIM_GROUPNAME_MAX], size_t max_names,
                                           size_t *out_count) {
    *out_count = 0;
    FILE *f = fopen(group_path, "r");
    if (!f) {
        return (errno == ENOENT) ? 0 : -1;
    }
    size_t ulen = strlen(username);
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    while (*out_count < max_names && (n = getline(&line, &cap, f)) != -1) {
        char *copy = strdup(line);
        if (!copy) continue;
        char *name, *passwd, *gid, *members;
        if (split_group_line(copy, &name, &passwd, &gid, &members) == 0 && members) {
            char *saveptr2 = NULL;
            char *tok = strtok_r(members, ",", &saveptr2);
            while (tok) {
                if (strlen(tok) == ulen && strcmp(tok, username) == 0) {
                    snprintf(out_names[*out_count], SHIM_GROUPNAME_MAX, "%s", name);
                    (*out_count)++;
                    break;
                }
                tok = strtok_r(NULL, ",", &saveptr2);
            }
        }
        free(copy);
    }
    free(line);
    fclose(f);
    return 0;
}

struct group_member_ud {
    const char *group_name;
    const char *username;
    int add; /* 1 = ensure present, 0 = ensure absent */
};

static int group_member_transform(FILE *in, FILE *out, void *user_data) {
    struct group_member_ud *ud = user_data;
    if (!in) {
        return 0; /* nothing to modify in a group file that doesn't exist */
    }
    size_t gname_len = strlen(ud->group_name);
    size_t ulen = strlen(ud->username);
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    while ((n = getline(&line, &cap, in)) != -1) {
        if (!((size_t)n > gname_len && strncmp(line, ud->group_name, gname_len) == 0 && line[gname_len] == ':')) {
            fwrite(line, 1, (size_t)n, out);
            continue;
        }

        char *copy = strdup(line);
        char *name, *passwd, *gid, *members;
        if (!copy || split_group_line(copy, &name, &passwd, &gid, &members) != 0) {
            /* Too malformed to safely rewrite - pass the original line
             * through unchanged rather than risk corrupting it. */
            fwrite(line, 1, (size_t)n, out);
            free(copy);
            continue;
        }

        char newmembers[2048];
        newmembers[0] = '\0';
        int already_present = 0;
        if (members) {
            char *saveptr2 = NULL;
            char *tok = strtok_r(members, ",", &saveptr2);
            while (tok) {
                int is_target = (strlen(tok) == ulen && strcmp(tok, ud->username) == 0);
                if (is_target) {
                    already_present = 1;
                }
                if (!(is_target && !ud->add)) {
                    if (newmembers[0]) {
                        strncat(newmembers, ",", sizeof(newmembers) - strlen(newmembers) - 1);
                    }
                    strncat(newmembers, tok, sizeof(newmembers) - strlen(newmembers) - 1);
                }
                tok = strtok_r(NULL, ",", &saveptr2);
            }
        }
        if (ud->add && !already_present) {
            if (newmembers[0]) {
                strncat(newmembers, ",", sizeof(newmembers) - strlen(newmembers) - 1);
            }
            strncat(newmembers, ud->username, sizeof(newmembers) - strlen(newmembers) - 1);
        }
        fprintf(out, "%s:%s:%s:%s\n", name, passwd, gid, newmembers);
        free(copy);
    }
    free(line);
    return 0;
}

int identity_add_group_member_at(const char *group_path, const char *group_name, const char *username) {
    struct group_member_ud ud = { .group_name = group_name, .username = username, .add = 1 };
    return atomic_rewrite_file(group_path, group_member_transform, &ud);
}

int identity_remove_group_member_at(const char *group_path, const char *group_name, const char *username) {
    struct group_member_ud ud = { .group_name = group_name, .username = username, .add = 0 };
    return atomic_rewrite_file(group_path, group_member_transform, &ud);
}

int identity_inherit_groups(session_ctx_t *ctx) {
    const char *reference_user = getenv("NODE_TERMINAL_SUDO_REFERENCE_USER");
    if (!reference_user || !reference_user[0]) {
        return 0;
    }
    if (!identity_valid_username(reference_user)) {
        shim_log("identity_inherit_groups: NODE_TERMINAL_SUDO_REFERENCE_USER %s is not a valid username, ignoring",
                  reference_user);
        return 0;
    }

    char group_names[SHIM_MAX_INHERITED_GROUPS][SHIM_GROUPNAME_MAX];
    size_t group_count = 0;
    if (identity_find_supplementary_groups_at(SHIM_GROUP_PATH, reference_user,
                                               group_names, SHIM_MAX_INHERITED_GROUPS, &group_count) != 0) {
        shim_logerr("identity_inherit_groups: reading %s", SHIM_GROUP_PATH);
        return 0;
    }
    if (group_count == 0) {
        shim_log("identity_inherit_groups: reference user %s has no supplementary groups (or doesn't exist) in %s",
                  reference_user, SHIM_GROUP_PATH);
        return 0;
    }

    for (size_t i = 0; i < group_count; i++) {
        if (identity_add_group_member_at(SHIM_GROUP_PATH, group_names[i], ctx->username) != 0) {
            shim_logerr("identity_inherit_groups: adding %s to group %s", ctx->username, group_names[i]);
            continue;
        }
        /* Both arrays are provably char[SHIM_GROUPNAME_MAX] - gcc loses
         * that bound across the 2D-array-decays-to-pointer parameter of
         * identity_find_supplementary_groups_at(), hence -Wformat-
         * truncation below despite this being a same-size copy. */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
        snprintf(ctx->inherited_groups[ctx->inherited_groups_count], SHIM_GROUPNAME_MAX, "%s", group_names[i]);
#pragma GCC diagnostic pop
        ctx->inherited_groups_count++;
    }
    if (ctx->inherited_groups_count > 0) {
        shim_log("identity_inherit_groups: %s joined %zu group(s) inherited from reference user %s",
                  ctx->username, ctx->inherited_groups_count, reference_user);
    }
    return 0;
}

void identity_leave_inherited_groups(session_ctx_t *ctx) {
    for (size_t i = 0; i < ctx->inherited_groups_count; i++) {
        if (identity_remove_group_member_at(SHIM_GROUP_PATH, ctx->inherited_groups[i], ctx->username) != 0) {
            shim_logerr("identity_leave_inherited_groups: removing %s from group %s",
                         ctx->username, ctx->inherited_groups[i]);
        }
    }
    ctx->inherited_groups_count = 0;
}

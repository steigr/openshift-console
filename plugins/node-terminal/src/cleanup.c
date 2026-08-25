#define _GNU_SOURCE
#include "cleanup.h"
#include "log.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

void cleanup_kill_pgid(pid_t pgid) {
    if (pgid <= 1) return; /* never signal pgid 0 (caller's own group) or 1 */
    if (kill(-pgid, SIGKILL) != 0 && errno != ESRCH) {
        shim_logerr("cleanup_kill_pgid: kill(-%d, SIGKILL)", (int)pgid);
    }
}

static int parse_uid_from_status(const char *path, uid_t *out_ruid) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    int found = 0;
    while ((n = getline(&line, &cap, f)) != -1) {
        if (strncmp(line, "Uid:", 4) == 0) {
            unsigned long ruid;
            if (sscanf(line + 4, "%lu", &ruid) == 1) {
                *out_ruid = (uid_t)ruid;
                found = 1;
            }
            break;
        }
    }
    free(line);
    fclose(f);
    return found ? 0 : -1;
}

static int is_all_digits(const char *s) {
    if (!*s) return 0;
    for (const char *p = s; *p; p++) {
        if (!isdigit((unsigned char)*p)) return 0;
    }
    return 1;
}

int cleanup_kill_by_uid(uid_t uid) {
    DIR *d = opendir("/proc");
    if (!d) {
        shim_logerr("cleanup_kill_by_uid: opendir /proc");
        return 0;
    }
    int signalled = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (!is_all_digits(de->d_name)) continue;
        char status_path[320];
        snprintf(status_path, sizeof(status_path), "/proc/%s/status", de->d_name);
        uid_t ruid;
        if (parse_uid_from_status(status_path, &ruid) != 0) continue;
        if (ruid != uid) continue;
        pid_t pid = (pid_t)atoi(de->d_name);
        if (kill(pid, SIGKILL) == 0) {
            signalled++;
        } else if (errno != ESRCH) {
            shim_logerr("cleanup_kill_by_uid: kill(%d)", (int)pid);
        }
    }
    closedir(d);
    return signalled;
}

static int link_target_has_prefix(const char *link_path, const char *prefix) {
    char buf[4096];
    ssize_t n = readlink(link_path, buf, sizeof(buf) - 1);
    if (n < 0) return 0;
    buf[n] = '\0';
    return strncmp(buf, prefix, strlen(prefix)) == 0;
}

/* /proc/<pid>/maps lines end with an optional mapped file path; scan for
 * any line whose trailing path starts with `prefix`. */
static int maps_reference_prefix(const char *maps_path, const char *prefix) {
    FILE *f = fopen(maps_path, "r");
    if (!f) return 0;
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    size_t plen = strlen(prefix);
    int found = 0;
    while (!found && (n = getline(&line, &cap, f)) != -1) {
        /* address perms offset dev inode [pathname] -- pathname is
         * whatever follows the last run of whitespace, if present. */
        char *last_space = NULL;
        for (char *p = line; *p; p++) {
            if (*p == ' ') last_space = p;
        }
        if (!last_space) continue;
        char *path_field = last_space + 1;
        size_t plen_line = strlen(path_field);
        if (plen_line > 0 && path_field[plen_line - 1] == '\n') {
            path_field[plen_line - 1] = '\0';
        }
        if (strncmp(path_field, prefix, plen) == 0) {
            found = 1;
        }
    }
    free(line);
    fclose(f);
    return found;
}

static int pid_references_path_prefix(const char *pid_str, const char *prefix) {
    char path[320];

    snprintf(path, sizeof(path), "/proc/%s/cwd", pid_str);
    if (link_target_has_prefix(path, prefix)) return 1;

    snprintf(path, sizeof(path), "/proc/%s/exe", pid_str);
    if (link_target_has_prefix(path, prefix)) return 1;

    char fd_dir[320];
    snprintf(fd_dir, sizeof(fd_dir), "/proc/%s/fd", pid_str);
    DIR *fdd = opendir(fd_dir);
    if (fdd) {
        struct dirent *fde;
        while ((fde = readdir(fdd)) != NULL) {
            if (fde->d_name[0] == '.') continue;
            char fd_path[640];
            snprintf(fd_path, sizeof(fd_path), "%s/%s", fd_dir, fde->d_name);
            if (link_target_has_prefix(fd_path, prefix)) {
                closedir(fdd);
                return 1;
            }
        }
        closedir(fdd);
    }

    snprintf(path, sizeof(path), "/proc/%s/maps", pid_str);
    if (maps_reference_prefix(path, prefix)) return 1;

    return 0;
}

int cleanup_kill_by_path_ref(const char *path_prefix) {
    DIR *d = opendir("/proc");
    if (!d) {
        shim_logerr("cleanup_kill_by_path_ref: opendir /proc");
        return 0;
    }
    int signalled = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (!is_all_digits(de->d_name)) continue;
        if (!pid_references_path_prefix(de->d_name, path_prefix)) continue;
        pid_t pid = (pid_t)atoi(de->d_name);
        if (kill(pid, SIGKILL) == 0) {
            signalled++;
        } else if (errno != ESRCH) {
            shim_logerr("cleanup_kill_by_path_ref: kill(%d)", (int)pid);
        }
    }
    closedir(d);
    return signalled;
}

void cleanup_full_sweep(session_ctx_t *ctx) {
    cleanup_kill_pgid(ctx->session_pgid);

    struct timespec settle = { .tv_sec = 0, .tv_nsec = 50 * 1000 * 1000 };
    nanosleep(&settle, NULL);

    int by_uid = cleanup_kill_by_uid(ctx->uid);
    int by_path = cleanup_kill_by_path_ref(ctx->home_dir);
    if (by_uid > 0 || by_path > 0) {
        shim_log("cleanup_full_sweep: killed %d by uid, %d by path-ref for session %s",
                  by_uid, by_path, ctx->username);
        nanosleep(&settle, NULL);
    }
}

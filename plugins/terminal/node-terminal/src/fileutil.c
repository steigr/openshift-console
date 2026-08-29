#define _GNU_SOURCE
#include "fileutil.h"
#include "log.h"

#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

int atomic_rewrite_file(const char *path, atomic_transform_fn fn, void *user_data) {
    char dirbuf[512];
    char base_for_dirname[512];
    strncpy(base_for_dirname, path, sizeof(base_for_dirname) - 1);
    base_for_dirname[sizeof(base_for_dirname) - 1] = '\0';
    const char *dir = dirname(base_for_dirname);
    strncpy(dirbuf, dir, sizeof(dirbuf) - 1);
    dirbuf[sizeof(dirbuf) - 1] = '\0';

    /* Lock a dedicated sibling lock file, not `path` itself, so readers
     * using plain fopen() elsewhere are unaffected and we don't need O_RDWR
     * on files we may only want to read. */
    char lockpath[600];
    snprintf(lockpath, sizeof(lockpath), "%s.node-terminal-shim.lock", path);
    int lockfd = open(lockpath, O_CREAT | O_RDWR, 0600);
    if (lockfd < 0) {
        shim_logerr("atomic_rewrite_file: open lock %s", lockpath);
        return -1;
    }
    if (flock(lockfd, LOCK_EX) != 0) {
        shim_logerr("atomic_rewrite_file: flock %s", lockpath);
        close(lockfd);
        return -1;
    }

    FILE *in = fopen(path, "r"); /* NULL is fine: caller's fn must tolerate a fresh file */

    char tmppath[600];
    snprintf(tmppath, sizeof(tmppath), "%s/.node-terminal-shim.tmp.XXXXXX", dirbuf);
    int tmpfd = mkstemp(tmppath);
    if (tmpfd < 0) {
        shim_logerr("atomic_rewrite_file: mkstemp in %s", dirbuf);
        if (in) fclose(in);
        flock(lockfd, LOCK_UN);
        close(lockfd);
        return -1;
    }
    fchmod(tmpfd, 0644);
    FILE *out = fdopen(tmpfd, "w");
    if (!out) {
        shim_logerr("atomic_rewrite_file: fdopen tmp");
        close(tmpfd);
        unlink(tmppath);
        if (in) fclose(in);
        flock(lockfd, LOCK_UN);
        close(lockfd);
        return -1;
    }

    int rc = fn(in, out, user_data);
    if (in) fclose(in);

    if (rc != 0) {
        fclose(out);
        unlink(tmppath);
        flock(lockfd, LOCK_UN);
        close(lockfd);
        errno = EINVAL;
        return -1;
    }

    if (fflush(out) != 0 || fsync(fileno(out)) != 0) {
        shim_logerr("atomic_rewrite_file: fsync tmp");
        fclose(out);
        unlink(tmppath);
        flock(lockfd, LOCK_UN);
        close(lockfd);
        return -1;
    }
    fclose(out);

    if (rename(tmppath, path) != 0) {
        shim_logerr("atomic_rewrite_file: rename %s -> %s", tmppath, path);
        unlink(tmppath);
        flock(lockfd, LOCK_UN);
        close(lockfd);
        return -1;
    }

    flock(lockfd, LOCK_UN);
    close(lockfd);
    return 0;
}

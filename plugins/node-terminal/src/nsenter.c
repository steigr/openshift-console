#define _GNU_SOURCE
#include "nsenter.h"
#include "log.h"

#include <fcntl.h>
#include <sched.h>
#include <unistd.h>

static int setns_by_path(const char *path, int nstype) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        shim_logerr("nsenter_host: open %s", path);
        return -1;
    }
    if (setns(fd, nstype) != 0) {
        shim_logerr("nsenter_host: setns %s", path);
        close(fd);
        return -1;
    }
    close(fd);
    return 0;
}

int nsenter_host(void) {
    /* mnt, uts, ipc, net first -- order among these four is not
     * load-bearing (§6.3) -- then pid last, immediately before the caller
     * forks the session child. */
    if (setns_by_path("/proc/1/ns/mnt", CLONE_NEWNS) != 0) return -1;
    if (setns_by_path("/proc/1/ns/uts", CLONE_NEWUTS) != 0) return -1;
    if (setns_by_path("/proc/1/ns/ipc", CLONE_NEWIPC) != 0) return -1;
    if (setns_by_path("/proc/1/ns/net", CLONE_NEWNET) != 0) return -1;
    if (setns_by_path("/proc/1/ns/pid", CLONE_NEWPID) != 0) return -1;
    return 0;
}

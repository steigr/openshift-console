#include "log.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static void vlogf(const char *fmt, va_list ap, int with_errno) {
    int saved_errno = errno;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tmv;
    gmtime_r(&ts.tv_sec, &tmv);
    char stamp[32];
    strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%SZ", &tmv);

    fprintf(stderr, "[%s] node-terminal-shim: ", stamp);
    vfprintf(stderr, fmt, ap);
    if (with_errno) {
        fprintf(stderr, ": %s", strerror(saved_errno));
    }
    fprintf(stderr, "\n");
}

void shim_log(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vlogf(fmt, ap, 0);
    va_end(ap);
}

void shim_logerr(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vlogf(fmt, ap, 1);
    va_end(ap);
}

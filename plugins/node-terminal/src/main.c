#define _GNU_SOURCE
#include "log.h"
#include "pipeline.h"
#include "session.h"
#include "shim.h"

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int gen_session_id(char *out, size_t out_len) {
    if (out_len < 9) return -1;
    unsigned char raw[4];
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0) return -1;
    ssize_t n = read(fd, raw, sizeof(raw));
    close(fd);
    if (n != (ssize_t)sizeof(raw)) return -1;
    snprintf(out, out_len, "%02x%02x%02x%02x", raw[0], raw[1], raw[2], raw[3]);
    return 0;
}

static void usage(const char *prog) {
    fprintf(stderr,
        "usage: %s [--phase=setup-session] --csi-path=<container-local mount>\n"
        "           [--test-mode[=SECONDS]]\n"
        "       %s --phase=agetty-exec <username>          (internal re-exec target)\n"
        "       %s --phase=test-worker <home_dir> <secs> <uid> <gid>  (internal re-exec target)\n",
        prog, prog, prog);
}

static volatile sig_atomic_t g_idle_stop = 0;
static void idle_on_term(int signo) { (void)signo; g_idle_stop = 1; }

/* PID 1's idle phase (see the plan's §3 flow diagram): the container just
 * waits here for `kubectl exec` to run this same binary again with
 * --csi-path set. Nothing privileged happens in this phase. */
static int run_idle_phase(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = idle_on_term;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    shim_log("main: idle phase, waiting for kubectl exec");
    while (!g_idle_stop) {
        pause();
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 1) {
        return run_idle_phase();
    }
    if (argc >= 2 && strcmp(argv[1], "--phase=agetty-exec") == 0) {
        if (argc < 3) { usage(argv[0]); return 2; }
        return session_phase_agetty_exec(argv[2]);
    }
    if (argc >= 2 && strcmp(argv[1], "--phase=test-worker") == 0) {
        if (argc < 6) { usage(argv[0]); return 2; }
        return session_phase_test_worker(argv[2], atoi(argv[3]),
                                          (uid_t)atoi(argv[4]), (gid_t)atoi(argv[5]));
    }

    session_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.test_duration_secs = 5;

    int have_csi_path = 0;
    for (int i = 1; i < argc; i++) {
        if (strncmp(argv[i], "--csi-path=", 11) == 0) {
            strncpy(ctx.csi_mount_point, argv[i] + 11, sizeof(ctx.csi_mount_point) - 1);
            have_csi_path = 1;
        } else if (strcmp(argv[i], "--phase=setup-session") == 0) {
            /* default phase, accepted explicitly for clarity in pod specs */
        } else if (strncmp(argv[i], "--test-mode", 11) == 0) {
            ctx.test_mode = 1;
            if (argv[i][11] == '=') {
                ctx.test_duration_secs = atoi(argv[i] + 12);
            }
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "unrecognized argument: %s\n", argv[i]);
            usage(argv[0]);
            return 2;
        }
    }

    if (!have_csi_path) {
        fprintf(stderr, "--csi-path is required\n");
        usage(argv[0]);
        return 2;
    }

    if (gen_session_id(ctx.session_id, sizeof(ctx.session_id)) != 0) {
        shim_logerr("main: failed to generate session id");
        return 1;
    }
    /* Username/home path both include the session id, not a bare admin
     * username -- prevents collisions across concurrent sessions or
     * leftover state from a non-gracefully-terminated prior pod (§7.2). */
    snprintf(ctx.username, sizeof(ctx.username), "%s%s", SHIM_USER_PREFIX, ctx.session_id);
    snprintf(ctx.home_dir, sizeof(ctx.home_dir), "%s/%s", SHIM_HOME_BASE, ctx.username);

    shim_log("main: starting session %s (csi_path=%s test_mode=%d)",
              ctx.username, ctx.csi_mount_point, ctx.test_mode);

    return pipeline_run(&ctx);
}

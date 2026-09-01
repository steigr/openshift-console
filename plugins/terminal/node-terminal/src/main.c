#define _GNU_SOURCE
#include "fileutil.h"
#include "identity.h"
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

static void usage(const char *prog) {
    fprintf(stderr,
        "usage: %s [--phase=setup-session] --csi-path=<container-local mount>\n"
        "           [--test-mode[=SECONDS]]\n"
        "       %s --phase=login-exec <username>           (internal re-exec target)\n"
        "       %s --phase=exec-session                    (kubectl exec entry point, privacy mode)\n"
        "       %s --phase=test-worker <home_dir> <secs> <uid> <gid>  (internal re-exec target)\n",
        prog, prog, prog, prog);
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
    if (argc >= 2 && strcmp(argv[1], "--phase=login-exec") == 0) {
        if (argc < 3) { usage(argv[0]); return 2; }
        return session_phase_login_exec(argv[2]);
    }
    if (argc >= 2 && strcmp(argv[1], "--phase=exec-session") == 0) {
        return pipeline_run_exec_session();
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

    if (fileutil_gen_random_hex(ctx.session_id, sizeof(ctx.session_id)) != 0) {
        shim_logerr("main: failed to generate session id");
        return 1;
    }
    /* NODE_TERMINAL_REQUESTED_USER, when set (by the frontend, from the
     * logged-in console user's own identity - see the terminal plugin's
     * own README for how), lets the ephemeral account be named after them
     * instead of the generic k8s-sess-<session_id> scheme, purely for
     * readability (`who`/`ps`/shell prompt). It is NOT trusted blindly:
     * identity_valid_username() is the actual security boundary here (this
     * value gets written straight into host-wide passwd/shadow/group
     * files), and identity_resolve_username() -- once the host's real
     * /etc/passwd is visible, later in the pipeline, post-nsenter -- falls
     * back to the collision-safe default scheme if it turns out to collide
     * with a real host account (or, astronomically unlikely, another
     * concurrent session). Session id is still generated unconditionally
     * either way: it's also used for ctx->ctty_path, independent of
     * whichever username ends up chosen. */
    const char *requested_user = getenv("NODE_TERMINAL_REQUESTED_USER");
    if (requested_user && identity_valid_username(requested_user)) {
        snprintf(ctx.username, sizeof(ctx.username), "%s", requested_user);
    } else {
        snprintf(ctx.username, sizeof(ctx.username), "%s%s", SHIM_USER_PREFIX, ctx.session_id);
    }
    snprintf(ctx.home_dir, sizeof(ctx.home_dir), "%s/%s", SHIM_HOME_BASE, ctx.username);

    shim_log("main: starting session %s (csi_path=%s test_mode=%d)",
              ctx.username, ctx.csi_mount_point, ctx.test_mode);

    return pipeline_run(&ctx);
}

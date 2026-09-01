#include "pipeline.h"
#include "cleanup.h"
#include "fileutil.h"
#include "identity.h"
#include "log.h"
#include "mountns.h"
#include "nsenter.h"
#include "session.h"
#include "signals.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Marker file `pipeline_run()` publishes the resolved username to once its
 * own setup succeeds, and `pipeline_run_exec_session()` (a *separate*
 * `kubectl exec` process, not a child of this one) reads it back from -
 * see privacy mode's own doc comment on pipeline_run() below.
 * NODE_TERMINAL_POD_UID (set via the Kubernetes downward API,
 * fieldRef: metadata.uid, in the debug pod's own spec - see the terminal
 * plugin's debugPod.ts) keys this per-pod, so unrelated concurrent debug
 * pods on the same node never share one; if it's somehow unset despite
 * exec mode being on, falls back to a fixed name (correct as long as only
 * one such pod is active per node at a time). */
static void active_user_marker_path(char *out, size_t out_len) {
    const char *pod_uid = getenv("NODE_TERMINAL_POD_UID");
    if (pod_uid && pod_uid[0]) {
        snprintf(out, out_len, "/run/node-terminal-active-user-%s", pod_uid);
    } else {
        snprintf(out, out_len, "/run/node-terminal-active-user");
    }
}

static int write_active_user_marker(const char *username) {
    char path[SHIM_PATH_MAX];
    active_user_marker_path(path, sizeof(path));
    FILE *f = fopen(path, "w");
    if (!f) {
        shim_logerr("write_active_user_marker: open %s", path);
        return -1;
    }
    fprintf(f, "%s\n", username);
    fclose(f);
    return 0;
}

static void remove_active_user_marker(void) {
    char path[SHIM_PATH_MAX];
    active_user_marker_path(path, sizeof(path));
    unlink(path);
}

/* Reads back the username write_active_user_marker() published, trimming
 * the trailing newline. Returns 0 on success, -1 if the marker doesn't
 * exist (yet, or any more) or is empty. */
static int read_active_user_marker(char *out, size_t out_len) {
    char path[SHIM_PATH_MAX];
    active_user_marker_path(path, sizeof(path));
    FILE *f = fopen(path, "r");
    if (!f) {
        return -1;
    }
    int rc = -1;
    if (fgets(out, (int)out_len, f)) {
        size_t n = strlen(out);
        if (n > 0 && out[n - 1] == '\n') {
            out[n - 1] = '\0';
            n--;
        }
        rc = (n > 0) ? 0 : -1;
    }
    fclose(f);
    return rc;
}

/* Unconditional rollback in reverse order of what actually completed
 * (§6.1). Called after step failure, after spawn_session's blocking wait
 * returns (normal exit or termination signal), or if spawn_session itself
 * couldn't be started -- always the same code path, deliberately, so
 * cleanup logic can't drift between happy-path and failure-path. */
static void rollback(session_ctx_t *ctx) {
    if (ctx->done_bind_mount || ctx->session_pgid > 0) {
        /* Kill before unmount, so lazy unmount has as few outstanding
         * references as possible to wait out (§8). */
        cleanup_full_sweep(ctx);
    }
    if (ctx->done_bind_mount) {
        mountns_unmount(ctx);
        ctx->done_bind_mount = 0;
    }
    if (ctx->done_mkdir_home) {
        mountns_rmdir_home(ctx);
        ctx->done_mkdir_home = 0;
    }
    if (ctx->done_inherit_groups) {
        identity_leave_inherited_groups(ctx);
        ctx->done_inherit_groups = 0;
    }
    if (ctx->done_write_identity) {
        identity_remove_entries(ctx);
        ctx->done_write_identity = 0;
    }
    if (ctx->done_alloc_uid) {
        identity_release_uid_lock(ctx);
        ctx->done_alloc_uid = 0;
    }
    if (ctx->done_bind_ctty) {
        mountns_unmount_ctty(ctx);
        ctx->done_bind_ctty = 0;
    }
    /* resolve_src is read-only: nothing to undo.
     * enter_ns: namespace membership isn't undone; the process simply
     * exits once rollback completes. */
}

int pipeline_run(session_ctx_t *ctx) {
    signals_install_handlers();
    ctx->uid_lock_fd = -1;
    ctx->ctty_tree_fd = -1;

    /* Step 2 conceptually, but must run BEFORE step 1's setns(mnt): once
     * switched into the host mount namespace, the container-local CSI path
     * is no longer resolvable (§6.4). Only captures the device id + `root`
     * fragment here -- turning that into an absolute host path needs the
     * *host's* mount table, which is only visible after nsenter_host()
     * below (see mountns_resolve_source's own doc comment for why this is
     * two phases at all, not one). */
    if (mountns_capture_target(ctx) != 0) {
        shim_log("pipeline_run: capture_target failed, aborting before any state was touched");
        return 1;
    }
    ctx->done_resolve_src = 1;

    /* Same reason, same timing constraint: the container's own pty is only
     * reachable to *clone a mount from* while still in its own mount
     * namespace (see mountns_capture_ctty's own doc comment, on
     * mountns_bind_ctty, for why this needs a real mount at all rather than
     * a plain path). */
    if (mountns_capture_ctty(ctx) != 0) {
        shim_log("pipeline_run: capture_ctty failed, aborting before any state was touched");
        return 1;
    }

    if (nsenter_host() != 0) {
        shim_log("pipeline_run: enter_ns failed");
        rollback(ctx);
        return 1;
    }
    ctx->done_enter_ns = 1;

    if (mountns_resolve_source(ctx) != 0) {
        shim_log("pipeline_run: resolve_src failed");
        rollback(ctx);
        return 1;
    }

    /* Also host-mount-namespace-dependent, same reason as resolve_source
     * above: establishes a tty path that's actually valid post-nsenter,
     * instead of the container-local one that's now unresolvable (see
     * mountns_bind_ctty's own doc comment). mountns_claim_ctty(), which
     * actually re-points fd 0/1/2 at it and claims it as a controlling
     * terminal, deliberately does NOT run here -- see its own doc comment
     * for why that has to happen in session_spawn_and_wait's forked child
     * instead, right before it execs into login. */
    if (mountns_bind_ctty(ctx) != 0) {
        shim_log("pipeline_run: bind_ctty failed");
        rollback(ctx);
        return 1;
    }
    ctx->done_bind_ctty = 1;

    /* Host-mount-namespace-dependent for the same reason as resolve_source:
     * SHIM_PASSWD_PATH only refers to the *host's* /etc/passwd once
     * nsenter_host() has run, so a collision against a real host account
     * can only be detected here, not back when main.c first chose
     * ctx->username from NODE_TERMINAL_REQUESTED_USER. */
    identity_resolve_username(ctx);

    if (identity_alloc_uid(ctx) != 0) {
        shim_log("pipeline_run: alloc_uid failed");
        rollback(ctx);
        return 1;
    }
    ctx->done_alloc_uid = 1;

    /* home_dir depends on the allocated uid via the session id, but the
     * session id/username are chosen by the caller before the pipeline
     * starts (see main.c) so home_dir is already known here. */

    if (identity_write_entries(ctx) != 0) {
        shim_log("pipeline_run: write_identity failed");
        rollback(ctx);
        return 1;
    }
    ctx->done_write_identity = 1;

    /* Best-effort, never fails the pipeline - see identity_inherit_groups's
     * own doc comment. Runs after write_identity: the ephemeral account
     * has to actually exist before joining it to extra groups means
     * anything. */
    identity_inherit_groups(ctx);
    ctx->done_inherit_groups = 1;

    /* The allocation lock only needs to be held across scan-then-claim
     * (alloc_uid) and the write that durably records the claim
     * (write_identity) -- once the passwd/shadow/group entries are on
     * disk, identity_find_free_uid() will see this UID as taken without
     * any lock help, so holding the lock any longer would needlessly
     * serialize unrelated concurrent sessions for their entire lifetime. */
    identity_release_uid_lock(ctx);

    if (mountns_mkdir_home(ctx) != 0) {
        shim_log("pipeline_run: mkdir_home failed");
        rollback(ctx);
        return 1;
    }
    ctx->done_mkdir_home = 1;

    if (mountns_bind_mount(ctx) != 0) {
        shim_log("pipeline_run: bind_mount failed");
        rollback(ctx);
        return 1;
    }
    ctx->done_bind_mount = 1;

    /* NODE_TERMINAL_EXEC_MODE (set only by the terminal plugin's own
     * frontend - see debugPod.ts - never by console core's own unmodified
     * debug-pod flow, patch 0006's ConfigMap convention, which still
     * `pods/attach`es and so still needs the interactive session to run
     * directly on this container's own primary pty, exactly as below):
     * privacy mode. `pods/attach` connects to whatever this container's
     * own PID 1 (i.e. THIS process) is doing on its own primary pty, and
     * CRI-O/conmon relays *everything* that flows through that pty into
     * the container's persistent log file - which is exactly what
     * `kubectl logs`/any log-forwarding pipeline reads, meaning anyone
     * with pods/log RBAC on this ephemeral namespace could otherwise
     * silently read the whole session transcript. `pods/exec` allocates
     * its own, separate pty per call that CRI-O does *not* persist to
     * that log file - so in this mode, this process (still PID 1) never
     * runs the interactive session on its own pty at all: it publishes
     * the resolved username to a marker file (write_active_user_marker())
     * for a separate `pods/exec` process to pick up
     * (pipeline_run_exec_session(), invoked by the frontend once the pod
     * is Running instead of attaching), and just waits here for that
     * process to signal completion (SIGTERM, sent to pid 1 - i.e. this
     * process - once its own session ends), since only this process has
     * the identity/mount state to roll back correctly. */
    if (getenv("NODE_TERMINAL_EXEC_MODE")) {
        if (write_active_user_marker(ctx->username) != 0) {
            rollback(ctx);
            return 1;
        }
        shim_log("pipeline_run: setup complete for %s, waiting for a kubectl exec session (privacy mode)",
                 ctx->username);
        while (!g_termination_requested) {
            pause();
        }
        shim_log("pipeline_run: session %s ended, rolling back", ctx->username);
        remove_active_user_marker();
        rollback(ctx);
        return 0;
    }

    /* Blocks for the session's duration. Returns on: child exit (normal
     * termination), or g_termination_requested via SIGTERM/SIGINT
     * (kubectl exec disconnect / pod deletion). Either way, rollback
     * below is unconditional. */
    int wait_status = session_spawn_and_wait(ctx);

    if (g_termination_requested) {
        shim_log("pipeline_run: session %s ended (termination requested)", ctx->username);
    } else if (WIFEXITED(wait_status)) {
        shim_log("pipeline_run: session %s ended (login-exec chain exited, status=%d)",
                 ctx->username, WEXITSTATUS(wait_status));
    } else if (WIFSIGNALED(wait_status)) {
        shim_log("pipeline_run: session %s ended (login-exec chain killed by signal %d)",
                 ctx->username, WTERMSIG(wait_status));
    } else {
        shim_log("pipeline_run: session %s ended (wait_status=%d)", ctx->username, wait_status);
    }
    shim_log("pipeline_run: session %s rolling back", ctx->username);
    rollback(ctx);
    return 0;
}

int pipeline_run_exec_session(void) {
    signals_install_handlers();

    session_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.uid_lock_fd = -1;
    ctx.ctty_tree_fd = -1;

    /* Own random id, independent of pipeline_run()'s own session_id: only
     * used to name *this* process's own ctty_path (mountns_bind_ctty), so
     * it can't collide with that process's, or another concurrent exec
     * session's. */
    if (fileutil_gen_random_hex(ctx.session_id, sizeof(ctx.session_id)) != 0) {
        shim_logerr("pipeline_run_exec_session: failed to generate a session id");
        return 1;
    }

    /* Same ordering constraint as pipeline_run()'s own capture_ctty/
    * nsenter_host/bind_ctty sequence, and for the same reason: this
     * `kubectl exec` call gets its *own* fresh pty (that's the whole
     * point - see pipeline_run's own doc comment above), which needs
     * capturing before nsenter_host() makes it unresolvable by path. */
    if (mountns_capture_ctty(&ctx) != 0) {
        shim_log("pipeline_run_exec_session: capture_ctty failed");
        return 1;
    }
    if (nsenter_host() != 0) {
        shim_log("pipeline_run_exec_session: enter_ns failed");
        return 1;
    }
    if (mountns_bind_ctty(&ctx) != 0) {
        shim_log("pipeline_run_exec_session: bind_ctty failed");
        return 1;
    }

    /* pipeline_run()'s own setup (identity/home) may still be in progress
     * when this runs - `kubectl exec` can be issued the instant the pod is
     * Running, well before that finishes. Poll briefly (10s total) rather
     * than fail outright the first time the marker isn't there yet. */
    int found = 0;
    for (int attempt = 0; attempt < 50 && !found; attempt++) {
        if (read_active_user_marker(ctx.username, sizeof(ctx.username)) == 0) {
            found = 1;
            break;
        }
        struct timespec wait_step = { .tv_sec = 0, .tv_nsec = 200000000L }; /* 200ms */
        nanosleep(&wait_step, NULL);
    }
    if (!found) {
        shim_log("pipeline_run_exec_session: no active session found after waiting "
                  "(setup never completed, or the session already ended)");
        mountns_unmount_ctty(&ctx);
        return 1;
    }

    shim_log("pipeline_run_exec_session: attaching %s to a new exec session", ctx.username);
    int wait_status = session_spawn_and_wait(&ctx);
    if (WIFEXITED(wait_status)) {
        shim_log("pipeline_run_exec_session: session %s ended (login-exec chain exited, status=%d)",
                 ctx.username, WEXITSTATUS(wait_status));
    } else if (WIFSIGNALED(wait_status)) {
        shim_log("pipeline_run_exec_session: session %s ended (login-exec chain killed by signal %d)",
                 ctx.username, WTERMSIG(wait_status));
    } else {
        shim_log("pipeline_run_exec_session: session %s ended (wait_status=%d)", ctx.username, wait_status);
    }

    mountns_unmount_ctty(&ctx);

    /* Only pipeline_run()'s own process allocated a UID and wrote passwd/
     * shadow/group/home-mount state - it, not this process, has to be the
     * one to roll that back. See pipeline_run's own privacy-mode doc
     * comment for the full picture. */
    shim_log("pipeline_run_exec_session: signaling pid 1 to roll back identity/mount state");
    kill(1, SIGTERM);
    return 0;
}

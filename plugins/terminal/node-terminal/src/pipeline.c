#include "pipeline.h"
#include "cleanup.h"
#include "identity.h"
#include "log.h"
#include "mountns.h"
#include "nsenter.h"
#include "session.h"
#include "signals.h"

#include <sys/wait.h>

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

#ifndef NODE_TERMINAL_SESSION_H
#define NODE_TERMINAL_SESSION_H

#include "shim.h"

/* fork()s the session child: setpgid(0,0), then re-exec self via
 * /proc/self/exe into either the agetty --autologin chain (normal mode) or
 * a scripted dummy worker (ctx->test_mode, for integration tests that can't
 * drive a real interactive PAM login headlessly). Fills ctx->session_pid /
 * ctx->session_pgid and blocks in waitpid() for the session's duration --
 * this call IS the "session is active" period. Returns the child's exit
 * status via waitpid semantics on success, or -1 on setup failure before
 * the child could even be waited on. */
int session_spawn_and_wait(session_ctx_t *ctx);

/* Entry point for --phase=agetty-exec: execlp's agetty --autologin for the
 * given username on `ctty_path` (see mountns_bind_ctty -- a host-mount-
 * namespace-valid alias for the pty already open on fd 0/1/2, NOT the
 * container-local path agetty's own ttyname()-based resolution can no
 * longer see post-nsenter). Never returns on success. */
int session_phase_agetty_exec(const char *username, const char *ctty_path);

/* Entry point for --phase=test-worker: used only when ctx->test_mode is
 * set. Drops privilege to uid/gid (standing in for what a real
 * agetty->login->PAM chain would do) then deliberately setsid()'s a
 * detached grandchild that touches a marker file under home_dir and
 * sleeps, so integration tests can verify the kill-by-UID /
 * kill-by-mountpoint sweeps (§8.2/§8.3) catch processes that a plain
 * process-group kill (§8.1) would miss. Sleeps for `duration_secs` itself,
 * then exits 0. */
int session_phase_test_worker(const char *home_dir, int duration_secs, uid_t uid, gid_t gid);

#endif /* NODE_TERMINAL_SESSION_H */

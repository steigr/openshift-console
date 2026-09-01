#ifndef NODE_TERMINAL_PIPELINE_H
#define NODE_TERMINAL_PIPELINE_H

#include "shim.h"

/* Runs the full ordered step list from §6.2/§6.4 of the implementation
 * plan: capture_target (pre-namespace-switch) -> enter_ns -> resolve_source
 * -> bind_ctty -> alloc_uid -> write_identity -> mkdir_home -> bind_mount
 * -> spawn_session (blocks).
 * Regardless of how the pipeline ends -- a step failing, spawn_session's
 * child exiting normally, or SIGTERM/SIGINT arriving mid-session -- the
 * SAME rollback routine runs afterward, undoing only the steps that
 * actually completed, in reverse order (§6.1). Returns 0 if the session
 * ran and rolled back cleanly, nonzero if setup failed before a session
 * ever started. */
int pipeline_run(session_ctx_t *ctx);

/* Entry point for --phase=exec-session: the `kubectl exec` (not `attach`)
 * side of privacy mode (see the terminal plugin's own README, "Session
 * privacy" section, and pipeline_run's own doc comment on
 * NODE_TERMINAL_EXEC_MODE). Runs entirely independently of pipeline_run()'s
 * own process (this is invoked as a *separate* `pods/exec` process, not a
 * child of it) except for the identity it reads back from the marker file
 * pipeline_run() published: captures + claims its own pty (the one this
 * particular exec call was given, distinct from pipeline_run()'s own
 * container-primary one), waits (briefly, retrying) for that marker to
 * appear if setup hasn't finished yet, then runs the exact same
 * claim+login chain as pipeline_run()'s own session_spawn_and_wait() over
 * it. When that session ends, signals pid 1 (SIGTERM) to trigger the
 * *real* identity/mount rollback, which only pipeline_run()'s own process
 * has the state to do correctly (this process never allocated a UID or
 * wrote passwd/shadow/group entries - it only borrows the identity that
 * process already established). Returns 0 if a session ran (regardless of
 * how it ended), nonzero if one was never established (e.g. the marker
 * never appeared - setup failed, or this exec call came in after the
 * session was already torn down). */
int pipeline_run_exec_session(void);

#endif /* NODE_TERMINAL_PIPELINE_H */

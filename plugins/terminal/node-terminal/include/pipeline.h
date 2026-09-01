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

#endif /* NODE_TERMINAL_PIPELINE_H */

#ifndef NODE_TERMINAL_SIGNALS_H
#define NODE_TERMINAL_SIGNALS_H

#include <signal.h>

/* Set only by the SIGTERM/SIGINT handlers (no syscalls in the handler
 * itself, per §6.5) and polled by session_spawn_and_wait's waitpid loop and
 * the pipeline's step loop so both can bail out into the same rollback
 * routine used for step failure and normal termination. */
extern volatile sig_atomic_t g_termination_requested;

void signals_install_handlers(void);

#endif /* NODE_TERMINAL_SIGNALS_H */

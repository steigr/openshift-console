#include "signals.h"

#include <string.h>

volatile sig_atomic_t g_termination_requested = 0;

static void on_term(int signo) {
    (void)signo;
    g_termination_requested = 1;
}

void signals_install_handlers(void) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_term;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0; /* deliberately no SA_RESTART: we want waitpid() to return EINTR */
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
}

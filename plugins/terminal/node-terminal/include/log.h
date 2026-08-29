#ifndef NODE_TERMINAL_LOG_H
#define NODE_TERMINAL_LOG_H

void shim_log(const char *fmt, ...);
void shim_logerr(const char *fmt, ...); /* appends ": <strerror(errno)>" */

#endif /* NODE_TERMINAL_LOG_H */

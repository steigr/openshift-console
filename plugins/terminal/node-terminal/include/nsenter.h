#ifndef NODE_TERMINAL_NSENTER_H
#define NODE_TERMINAL_NSENTER_H

/* setns() into host PID 1's mnt, uts, ipc, net namespaces (any order among
 * those four), then pid last (§6.3) -- the pid setns only takes effect for
 * children forked after this call, never for the caller itself, which is
 * why it must be immediately followed by fork() in the pipeline. Returns 0
 * on success, -1 on failure (errno set to the first syscall that failed). */
int nsenter_host(void);

#endif /* NODE_TERMINAL_NSENTER_H */

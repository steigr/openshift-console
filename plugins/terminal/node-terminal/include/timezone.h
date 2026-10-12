#ifndef NODE_TERMINAL_TIMEZONE_H
#define NODE_TERMINAL_TIMEZONE_H

#include <stddef.h>

/* The session's TZ, from what the terminal plugin put in the debug pod's
 * env: the console user's time zone as an IANA name (NODE_TERMINAL_TZ),
 * used when the host has it under `zoneinfo_dir`, or else the same zone's
 * current rules as a POSIX TZ string (NODE_TERMINAL_TZ_POSIX), which libc
 * interprets without any tzdata. Either value is checked against its own
 * character set first -- the IANA one also against path traversal, since
 * it becomes a path -- and an invalid one is ignored. Writes the chosen
 * value into `out` and returns it, or returns NULL when neither is usable
 * (the session then keeps the host's own time zone). */
const char *timezone_select(const char *iana, const char *posix,
                            const char *zoneinfo_dir, char *out, size_t out_len);

/* `Area/Location` shapes: 1-64 chars of [A-Za-z0-9_+-] segments joined by
 * single '/', no segment starting with '.' or '-'. */
int timezone_valid_iana(const char *name);

/* 1-128 chars of [A-Za-z0-9<>+-:,./]. Deliberately loose (libc is the
 * parser), but excludes everything a shell or env assignment would treat
 * specially. */
int timezone_valid_posix(const char *value);

#endif /* NODE_TERMINAL_TIMEZONE_H */

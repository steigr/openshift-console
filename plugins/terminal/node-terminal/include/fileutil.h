#ifndef NODE_TERMINAL_FILEUTIL_H
#define NODE_TERMINAL_FILEUTIL_H

#include <stdio.h>
#include <stddef.h>

/* Fills `out` with `(out_len - 1) / 2` random bytes rendered as lowercase
 * hex (i.e. pass a 9-byte buffer for 8 hex chars + NUL, matching
 * session_id's own shape) via /dev/urandom. Returns 0 on success, -1 on
 * failure (out_len too small, or /dev/urandom couldn't be read). Shared by
 * main.c (the session's own session_id) and pipeline.c
 * (pipeline_run_exec_session's independent one, for its own ctty_path
 * naming - see mountns.h). */
int fileutil_gen_random_hex(char *out, size_t out_len);

/* transform_fn reads whatever lines it wants from `in` (may be NULL if the
 * target file didn't exist yet) and writes the full desired new contents to
 * `out`. Returns 0 on success, nonzero to abort the whole rewrite (in which
 * case the original file is left untouched). */
typedef int (*atomic_transform_fn)(FILE *in, FILE *out, void *user_data);

/* Lock `path` (creating it if needed), write a full replacement via `fn`
 * into a temp file in the same directory, fsync it, then rename() it over
 * `path`. Either fully lands or leaves `path` completely untouched -- never
 * a partial write. Returns 0 on success, -1 on failure (errno set). */
int atomic_rewrite_file(const char *path, atomic_transform_fn fn, void *user_data);

#endif /* NODE_TERMINAL_FILEUTIL_H */

#ifndef NODE_TERMINAL_FILEUTIL_H
#define NODE_TERMINAL_FILEUTIL_H

#include <stdio.h>

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

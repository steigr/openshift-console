#ifndef NODE_TERMINAL_IDENTITY_H
#define NODE_TERMINAL_IDENTITY_H

#include <sys/types.h>

#include "shim.h"

/* Scan `passwd_path` for UIDs already in use within [range_min, range_max]
 * and return the lowest free one via *out_uid. Returns 0 on success, -1 if
 * the range is exhausted or the file can't be read. Pure, read-only --
 * exposed separately from allocation so it's unit-testable against fixture
 * files without any locking/side effects. */
int identity_find_free_uid(const char *passwd_path, uid_t range_min, uid_t range_max, uid_t *out_uid);

/* Acquires an flock() on lock_path (created if needed) and, while holding
 * it, scans passwd_path for a free UID in range and fills ctx->uid/gid.
 * The lock fd is stashed in ctx->uid_lock_fd and stays held -- callers must
 * pair this with identity_release_uid_lock() (rollback) or leave it held
 * across identity_write_entries() (forward path), matching the plan's
 * alloc_uid/write_identity step split. Returns 0 on success, -1 on failure. */
int identity_alloc_uid(session_ctx_t *ctx);

/* Releases the lock acquired by identity_alloc_uid without writing
 * anything -- the rollback action for the alloc_uid step. */
void identity_release_uid_lock(session_ctx_t *ctx);

/* Appends passwd/shadow/group entries for ctx->username/uid/gid/home_dir.
 * Must be called while still holding ctx->uid_lock_fd (see above) so no
 * other allocation can observe the UID as free in the gap between scan and
 * write. Returns 0 on success, -1 on failure (nothing left partially
 * written on either success or failure, per atomic_rewrite_file). */
int identity_write_entries(session_ctx_t *ctx);

/* Inverse of identity_write_entries: removes ctx->username's line(s) from
 * passwd/shadow/group. Idempotent -- safe to call even if the entries were
 * never written (e.g. write_identity itself failed partway through). */
void identity_remove_entries(session_ctx_t *ctx);

/* Test-seam variants that take explicit file paths instead of the SHIM_*
 * constants, so unit tests can point them at scratch fixture files. */
int identity_write_entries_at(const char *passwd_path, const char *shadow_path,
                               const char *group_path, const char *username,
                               uid_t uid, gid_t gid, const char *home_dir);
int identity_remove_entries_at(const char *passwd_path, const char *shadow_path,
                                const char *group_path, const char *username);

#endif /* NODE_TERMINAL_IDENTITY_H */

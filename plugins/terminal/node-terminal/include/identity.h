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

/* True iff `username` is safe to write into passwd/shadow/group as a bare
 * field: matches ^[a-z_][a-z0-9_-]{0,SHIM_USERNAME_MAX-2}$. This is the
 * actual security boundary for NODE_TERMINAL_REQUESTED_USER (§below) - it
 * comes from a debug pod env var, which a cluster operator controls but
 * this process must never trust blindly, since passwd/shadow/group are
 * host-wide auth-critical files a single stray ':' or newline could
 * corrupt. Pure/testable. */
int identity_valid_username(const char *username);

/* True iff `passwd_path` has a line whose username field is exactly
 * `username` (not just a substring/prefix match). Pure/testable. */
int identity_username_exists_at(const char *passwd_path, const char *username);

/* If ctx->username already exists in SHIM_PASSWD_PATH - a real host
 * account, or (astronomically unlikely) another concurrent session -
 * replaces both ctx->username and ctx->home_dir with the standard
 * SHIM_USER_PREFIX + session_id scheme, which by construction can't
 * collide with anything identity_alloc_uid() itself would have found
 * already taken. Must run after nsenter_host() (SHIM_PASSWD_PATH only
 * becomes the *host's* /etc/passwd then) and before identity_alloc_uid().
 * No-op if there's no collision. Always returns 0 (never fails the
 * session over this - correctness is guaranteed either way, this only
 * affects which name is used). */
int identity_resolve_username(session_ctx_t *ctx);

/* Best-effort: if NODE_TERMINAL_SUDO_REFERENCE_USER is set in the
 * environment, looks up that user's supplementary groups in
 * SHIM_GROUP_PATH (i.e. the *real* host groups an operator-designated
 * reference account belongs to - typically sudo/wheel/admin-ish ones) and
 * adds ctx->username to each, recording exactly which ones in
 * ctx->inherited_groups for identity_leave_inherited_groups() for
 * rollback. This is what lets an ephemeral break-glass session inherit
 * the same sudo policy as a real named admin account, without this tool
 * having any opinion of its own about what "admin" means on a given
 * cluster - that's the reference user's own group memberships, set by
 * whoever configured NODE_TERMINAL_SUDO_REFERENCE_USER.
 *
 * Deliberately never fails the session: an unset env var, an unresolvable
 * reference user, or a group-file write failure all just mean the
 * ephemeral account gets no extra groups (today's behavior) - logged, not
 * fatal. A misconfigured reference user should not be able to lock an
 * operator out of break-glass node access entirely. Must run after
 * identity_write_entries() (the ephemeral account has to exist before
 * group membership on top of it means anything). Always returns 0. */
int identity_inherit_groups(session_ctx_t *ctx);

/* Inverse of identity_inherit_groups(): removes ctx->username from each
 * group recorded in ctx->inherited_groups. Idempotent, best-effort (logs,
 * doesn't fail loudly) - same rationale as identity_remove_entries(). */
void identity_leave_inherited_groups(session_ctx_t *ctx);

/* Test-seam variants of the above two, operating on explicit paths/values
 * instead of session_ctx_t + the environment, so unit tests can drive them
 * directly against scratch fixture files. */
int identity_find_supplementary_groups_at(const char *group_path, const char *username,
                                           char out_names[][SHIM_GROUPNAME_MAX], size_t max_names,
                                           size_t *out_count);
int identity_add_group_member_at(const char *group_path, const char *group_name, const char *username);
int identity_remove_group_member_at(const char *group_path, const char *group_name, const char *username);

#endif /* NODE_TERMINAL_IDENTITY_H */

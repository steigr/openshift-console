#include "identity.h"
#include "tinytest.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static char g_tmpdir[128];

static void make_tmpdir(void) {
    strcpy(g_tmpdir, "/tmp/node-terminal-test.XXXXXX");
    if (!mkdtemp(g_tmpdir)) {
        perror("mkdtemp");
        exit(1);
    }
}

static void write_file(const char *path, const char *content) {
    FILE *f = fopen(path, "w");
    TT_ASSERT(f != NULL);
    fputs(content, f);
    fclose(f);
}

static int file_contains(const char *path, const char *needle) {
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char buf[4096];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    buf[n] = '\0';
    fclose(f);
    return strstr(buf, needle) != NULL;
}

static void test_find_free_uid_empty_file(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/passwd-empty", g_tmpdir);
    write_file(path, "");

    uid_t uid = 0;
    int rc = identity_find_free_uid(path, 60000, 60005, &uid);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_INT(uid, 60000);
}

static void test_find_free_uid_skips_used(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/passwd-used", g_tmpdir);
    write_file(path,
        "root:x:0:0:root:/root:/bin/sh\n"
        "k8s-sess-aaaaaaaa:x:60000:60000::/home/k8s-sess-aaaaaaaa:/bin/sh\n"
        "k8s-sess-bbbbbbbb:x:60001:60001::/home/k8s-sess-bbbbbbbb:/bin/sh\n");

    uid_t uid = 0;
    int rc = identity_find_free_uid(path, 60000, 60005, &uid);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_INT(uid, 60002);
}

static void test_find_free_uid_exhausted_range(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/passwd-full", g_tmpdir);
    write_file(path,
        "a:x:60000:60000::/home/a:/bin/sh\n"
        "b:x:60001:60001::/home/b:/bin/sh\n");

    uid_t uid = 0;
    int rc = identity_find_free_uid(path, 60000, 60001, &uid);
    TT_ASSERT(rc != 0);
}

static void test_find_free_uid_missing_file(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/does-not-exist", g_tmpdir);

    uid_t uid = 0;
    int rc = identity_find_free_uid(path, 60000, 60005, &uid);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_INT(uid, 60000);
}

static void test_write_then_remove_entries_roundtrip(void) {
    char passwd[256], shadow[256], group[256];
    snprintf(passwd, sizeof(passwd), "%s/rt-passwd", g_tmpdir);
    snprintf(shadow, sizeof(shadow), "%s/rt-shadow", g_tmpdir);
    snprintf(group, sizeof(group), "%s/rt-group", g_tmpdir);
    write_file(passwd, "root:x:0:0:root:/root:/bin/sh\n");
    write_file(shadow, "root:*:19000:0:99999:7:::\n");
    write_file(group, "root:x:0:\n");

    int rc = identity_write_entries_at(passwd, shadow, group, "k8s-sess-deadbeef",
                                        60123, 60123, "/home/k8s-sess-deadbeef", "/bin/sh");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(passwd, "k8s-sess-deadbeef:x:60123:60123:"));
    TT_ASSERT(file_contains(passwd, "/home/k8s-sess-deadbeef"));
    TT_ASSERT(file_contains(shadow, "k8s-sess-deadbeef:!:"));
    TT_ASSERT(file_contains(group, "k8s-sess-deadbeef:x:60123:"));
    /* pre-existing root entries must survive untouched */
    TT_ASSERT(file_contains(passwd, "root:x:0:0:root:/root:/bin/sh"));

    rc = identity_remove_entries_at(passwd, shadow, group, "k8s-sess-deadbeef");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(!file_contains(passwd, "k8s-sess-deadbeef"));
    TT_ASSERT(!file_contains(shadow, "k8s-sess-deadbeef"));
    TT_ASSERT(!file_contains(group, "k8s-sess-deadbeef"));
    TT_ASSERT(file_contains(passwd, "root:x:0:0:root:/root:/bin/sh"));
}

static void test_write_entries_uses_custom_shell(void) {
    char passwd[256], shadow[256], group[256];
    snprintf(passwd, sizeof(passwd), "%s/shell-passwd", g_tmpdir);
    snprintf(shadow, sizeof(shadow), "%s/shell-shadow", g_tmpdir);
    snprintf(group, sizeof(group), "%s/shell-group", g_tmpdir);
    write_file(passwd, "");
    write_file(shadow, "");
    write_file(group, "");

    int rc = identity_write_entries_at(passwd, shadow, group, "k8s-sess-shelltest",
                                        60124, 60124, "/home/k8s-sess-shelltest", "/bin/bash");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(passwd, "k8s-sess-shelltest:x:60124:60124:node-terminal ephemeral session:"
                                     "/home/k8s-sess-shelltest:/bin/bash"));
}

static void test_write_entries_empty_shell_falls_back_to_bin_sh(void) {
    char passwd[256], shadow[256], group[256];
    snprintf(passwd, sizeof(passwd), "%s/noshell-passwd", g_tmpdir);
    snprintf(shadow, sizeof(shadow), "%s/noshell-shadow", g_tmpdir);
    snprintf(group, sizeof(group), "%s/noshell-group", g_tmpdir);
    write_file(passwd, "");
    write_file(shadow, "");
    write_file(group, "");

    int rc = identity_write_entries_at(passwd, shadow, group, "k8s-sess-noshell",
                                        60125, 60125, "/home/k8s-sess-noshell", "");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(passwd, "k8s-sess-noshell:x:60125:60125:node-terminal ephemeral session:"
                                     "/home/k8s-sess-noshell:/bin/sh"));
}

static void test_lookup_shell_finds_matching_user(void) {
    char passwd[256];
    snprintf(passwd, sizeof(passwd), "%s/lookup-shell-passwd", g_tmpdir);
    write_file(passwd, "root:x:0:0:root:/root:/bin/bash\nservice:x:1000:1000:svc:/home/service:/bin/zsh\n");

    char shell[64];
    int rc = identity_lookup_shell_at(passwd, "service", shell, sizeof(shell));
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(shell, "/bin/zsh");
}

static void test_lookup_shell_missing_user(void) {
    char passwd[256];
    snprintf(passwd, sizeof(passwd), "%s/lookup-shell-missing-passwd", g_tmpdir);
    write_file(passwd, "root:x:0:0:root:/root:/bin/bash\n");

    char shell[64];
    int rc = identity_lookup_shell_at(passwd, "nosuchuser", shell, sizeof(shell));
    TT_ASSERT(rc != 0);
}

static void test_lookup_shell_empty_shell_field(void) {
    char passwd[256];
    snprintf(passwd, sizeof(passwd), "%s/lookup-shell-empty-passwd", g_tmpdir);
    write_file(passwd, "nologin:x:2:2:no shell:/home/nologin:\n");

    char shell[64];
    int rc = identity_lookup_shell_at(passwd, "nologin", shell, sizeof(shell));
    TT_ASSERT(rc != 0);
}

static void test_lookup_shell_missing_file(void) {
    char shell[64];
    int rc = identity_lookup_shell_at("/nonexistent/path/passwd", "anyone", shell, sizeof(shell));
    TT_ASSERT(rc != 0);
}

static void test_remove_only_matching_username_prefix(void) {
    /* A username that is a prefix of another must not over-match (e.g.
     * removing "k8s-sess-aa" must not also remove "k8s-sess-aabbccdd"). */
    char passwd[256], shadow[256], group[256];
    snprintf(passwd, sizeof(passwd), "%s/prefix-passwd", g_tmpdir);
    snprintf(shadow, sizeof(shadow), "%s/prefix-shadow", g_tmpdir);
    snprintf(group, sizeof(group), "%s/prefix-group", g_tmpdir);
    write_file(passwd,
        "k8s-sess-aa:x:60000:60000::/home/k8s-sess-aa:/bin/sh\n"
        "k8s-sess-aabbccdd:x:60001:60001::/home/k8s-sess-aabbccdd:/bin/sh\n");
    write_file(shadow, "");
    write_file(group, "");

    int rc = identity_remove_entries_at(passwd, shadow, group, "k8s-sess-aa");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(!file_contains(passwd, "k8s-sess-aa:"));
    TT_ASSERT(file_contains(passwd, "k8s-sess-aabbccdd:"));
}

static void test_remove_nonexistent_entry_is_idempotent(void) {
    char passwd[256], shadow[256], group[256];
    snprintf(passwd, sizeof(passwd), "%s/idem-passwd", g_tmpdir);
    snprintf(shadow, sizeof(shadow), "%s/idem-shadow", g_tmpdir);
    snprintf(group, sizeof(group), "%s/idem-group", g_tmpdir);
    write_file(passwd, "root:x:0:0:root:/root:/bin/sh\n");
    write_file(shadow, "root:*:19000:0:99999:7:::\n");
    write_file(group, "root:x:0:\n");

    int rc = identity_remove_entries_at(passwd, shadow, group, "k8s-sess-never-existed");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(passwd, "root:x:0:0:root:/root:/bin/sh"));
}

static void test_valid_username_accepts_conventional_names(void) {
    TT_ASSERT(identity_valid_username("alice"));
    TT_ASSERT(identity_valid_username("bob-2"));
    TT_ASSERT(identity_valid_username("_service"));
    TT_ASSERT(identity_valid_username("k8s-sess-deadbeef"));
}

static void test_valid_username_rejects_bad_input(void) {
    TT_ASSERT(!identity_valid_username(NULL));
    TT_ASSERT(!identity_valid_username(""));
    TT_ASSERT(!identity_valid_username("Alice"));           /* uppercase */
    TT_ASSERT(!identity_valid_username("1alice"));          /* leading digit */
    TT_ASSERT(!identity_valid_username("alice:root"));      /* colon - would corrupt passwd */
    TT_ASSERT(!identity_valid_username("alice\nroot:x:0")); /* newline injection */
    TT_ASSERT(!identity_valid_username("alice bob"));       /* space */
    char toolong[SHIM_USERNAME_MAX + 8];
    memset(toolong, 'a', sizeof(toolong) - 1);
    toolong[sizeof(toolong) - 1] = '\0';
    TT_ASSERT(!identity_valid_username(toolong));
}

static void test_username_exists_matches_exact_field_only(void) {
    char passwd[256];
    snprintf(passwd, sizeof(passwd), "%s/exists-passwd", g_tmpdir);
    write_file(passwd,
        "root:x:0:0:root:/root:/bin/sh\n"
        "alice:x:60000:60000::/home/alice:/bin/sh\n");

    TT_ASSERT(identity_username_exists_at(passwd, "alice"));
    TT_ASSERT(identity_username_exists_at(passwd, "root"));
    TT_ASSERT(!identity_username_exists_at(passwd, "ali"));   /* prefix, not exact */
    TT_ASSERT(!identity_username_exists_at(passwd, "bob"));
}

static void test_username_exists_missing_file_is_no_collision(void) {
    char passwd[256];
    snprintf(passwd, sizeof(passwd), "%s/does-not-exist-passwd", g_tmpdir);
    TT_ASSERT(!identity_username_exists_at(passwd, "alice"));
}

static void test_find_supplementary_groups_matches_exact_member(void) {
    char group[256];
    snprintf(group, sizeof(group), "%s/sup-group", g_tmpdir);
    write_file(group,
        "root:x:0:\n"
        "sudo:x:27:alice,bob\n"
        "docker:x:999:alicexyz,bob\n"
        "wheel:x:10:alice\n");

    char names[SHIM_MAX_INHERITED_GROUPS][SHIM_GROUPNAME_MAX];
    size_t count = 0;
    int rc = identity_find_supplementary_groups_at(group, "alice", names, SHIM_MAX_INHERITED_GROUPS, &count);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_INT((int)count, 2);
    TT_ASSERT_EQ_STR(names[0], "sudo");
    TT_ASSERT_EQ_STR(names[1], "wheel");
}

static void test_find_supplementary_groups_missing_file(void) {
    char group[256];
    snprintf(group, sizeof(group), "%s/no-such-group-file", g_tmpdir);
    char names[SHIM_MAX_INHERITED_GROUPS][SHIM_GROUPNAME_MAX];
    size_t count = 123;
    int rc = identity_find_supplementary_groups_at(group, "alice", names, SHIM_MAX_INHERITED_GROUPS, &count);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_INT((int)count, 0);
}

static void test_add_and_remove_group_member_roundtrip(void) {
    char group[256];
    snprintf(group, sizeof(group), "%s/roundtrip-group", g_tmpdir);
    write_file(group,
        "root:x:0:\n"
        "sudo:x:27:bob\n"
        "unrelated:x:500:someone\n");

    int rc = identity_add_group_member_at(group, "sudo", "alice");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(group, "sudo:x:27:bob,alice"));
    TT_ASSERT(file_contains(group, "unrelated:x:500:someone"));

    /* adding again must not duplicate the member */
    rc = identity_add_group_member_at(group, "sudo", "alice");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(!file_contains(group, "alice,alice"));
    TT_ASSERT(!file_contains(group, "bob,alice,alice"));

    rc = identity_remove_group_member_at(group, "sudo", "alice");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(group, "sudo:x:27:bob"));
    TT_ASSERT(!file_contains(group, "alice"));
    TT_ASSERT(file_contains(group, "unrelated:x:500:someone"));
}

static void test_add_group_member_to_empty_member_list(void) {
    char group[256];
    snprintf(group, sizeof(group), "%s/empty-members-group", g_tmpdir);
    write_file(group, "wheel:x:10:\n");

    int rc = identity_add_group_member_at(group, "wheel", "alice");
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT(file_contains(group, "wheel:x:10:alice"));
}

TT_MAIN_BEGIN()
    make_tmpdir();
    TT_RUN(test_find_free_uid_empty_file);
    TT_RUN(test_find_free_uid_skips_used);
    TT_RUN(test_find_free_uid_exhausted_range);
    TT_RUN(test_find_free_uid_missing_file);
    TT_RUN(test_write_then_remove_entries_roundtrip);
    TT_RUN(test_write_entries_uses_custom_shell);
    TT_RUN(test_write_entries_empty_shell_falls_back_to_bin_sh);
    TT_RUN(test_lookup_shell_finds_matching_user);
    TT_RUN(test_lookup_shell_missing_user);
    TT_RUN(test_lookup_shell_empty_shell_field);
    TT_RUN(test_lookup_shell_missing_file);
    TT_RUN(test_remove_only_matching_username_prefix);
    TT_RUN(test_remove_nonexistent_entry_is_idempotent);
    TT_RUN(test_valid_username_accepts_conventional_names);
    TT_RUN(test_valid_username_rejects_bad_input);
    TT_RUN(test_username_exists_matches_exact_field_only);
    TT_RUN(test_username_exists_missing_file_is_no_collision);
    TT_RUN(test_find_supplementary_groups_matches_exact_member);
    TT_RUN(test_find_supplementary_groups_missing_file);
    TT_RUN(test_add_and_remove_group_member_roundtrip);
    TT_RUN(test_add_group_member_to_empty_member_list);
TT_MAIN_END()

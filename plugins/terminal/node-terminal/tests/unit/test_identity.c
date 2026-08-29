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
                                        60123, 60123, "/home/k8s-sess-deadbeef");
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

TT_MAIN_BEGIN()
    make_tmpdir();
    TT_RUN(test_find_free_uid_empty_file);
    TT_RUN(test_find_free_uid_skips_used);
    TT_RUN(test_find_free_uid_exhausted_range);
    TT_RUN(test_find_free_uid_missing_file);
    TT_RUN(test_write_then_remove_entries_roundtrip);
    TT_RUN(test_remove_only_matching_username_prefix);
    TT_RUN(test_remove_nonexistent_entry_is_idempotent);
TT_MAIN_END()

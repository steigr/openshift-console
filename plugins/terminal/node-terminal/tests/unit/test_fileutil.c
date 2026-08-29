#include "fileutil.h"
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

static int append_a(FILE *in, FILE *out, void *ud) {
    (void)ud;
    int last_was_newline = 1;
    if (in) {
        int c;
        while ((c = fgetc(in)) != EOF) {
            fputc(c, out);
            last_was_newline = (c == '\n');
        }
    }
    if (!last_was_newline) fputc('\n', out);
    fputs("appended-line\n", out);
    return 0;
}

static int always_fail(FILE *in, FILE *out, void *ud) {
    (void)in; (void)out; (void)ud;
    return 1;
}

static void read_whole_file(const char *path, char *buf, size_t buflen) {
    FILE *f = fopen(path, "r");
    TT_ASSERT(f != NULL);
    size_t n = fread(buf, 1, buflen - 1, f);
    buf[n] = '\0';
    fclose(f);
}

static void test_append_to_nonexistent_file(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/fresh", g_tmpdir);

    int rc = atomic_rewrite_file(path, append_a, NULL);
    TT_ASSERT_EQ_INT(rc, 0);

    char buf[256];
    read_whole_file(path, buf, sizeof(buf));
    TT_ASSERT_EQ_STR(buf, "appended-line\n");
}

static void test_append_preserves_existing_content(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/existing", g_tmpdir);

    FILE *f = fopen(path, "w");
    fputs("line-one\nline-two\n", f);
    fclose(f);

    int rc = atomic_rewrite_file(path, append_a, NULL);
    TT_ASSERT_EQ_INT(rc, 0);

    char buf[256];
    read_whole_file(path, buf, sizeof(buf));
    TT_ASSERT_EQ_STR(buf, "line-one\nline-two\nappended-line\n");
}

static void test_append_adds_missing_trailing_newline(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/no-trailing-nl", g_tmpdir);

    FILE *f = fopen(path, "w");
    fputs("line-one-no-newline", f);
    fclose(f);

    int rc = atomic_rewrite_file(path, append_a, NULL);
    TT_ASSERT_EQ_INT(rc, 0);

    char buf[256];
    read_whole_file(path, buf, sizeof(buf));
    TT_ASSERT_EQ_STR(buf, "line-one-no-newline\nappended-line\n");
}

static void test_failed_transform_leaves_file_untouched(void) {
    char path[256];
    snprintf(path, sizeof(path), "%s/protected", g_tmpdir);

    FILE *f = fopen(path, "w");
    fputs("original-content\n", f);
    fclose(f);

    int rc = atomic_rewrite_file(path, always_fail, NULL);
    TT_ASSERT(rc != 0);

    char buf[256];
    read_whole_file(path, buf, sizeof(buf));
    TT_ASSERT_EQ_STR(buf, "original-content\n");
}

TT_MAIN_BEGIN()
    make_tmpdir();
    TT_RUN(test_append_to_nonexistent_file);
    TT_RUN(test_append_preserves_existing_content);
    TT_RUN(test_append_adds_missing_trailing_newline);
    TT_RUN(test_failed_transform_leaves_file_untouched);
TT_MAIN_END()

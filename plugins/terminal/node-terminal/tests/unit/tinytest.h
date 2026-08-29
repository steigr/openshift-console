#ifndef TINYTEST_H
#define TINYTEST_H

/* Minimal single-header test harness -- no external deps, since this repo
 * doesn't vendor a C test framework and pulling one in for a handful of
 * pure-logic unit tests isn't worth it. */

#include <stdio.h>
#include <string.h>

static int tt_failures = 0;
static int tt_count = 0;

#define TT_CHECK(cond, msg) do { \
    tt_count++; \
    if (!(cond)) { \
        tt_failures++; \
        fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, msg); \
    } \
} while (0)

#define TT_ASSERT(cond) TT_CHECK(cond, #cond)

#define TT_ASSERT_EQ_INT(a, b) do { \
    long _a = (long)(a), _b = (long)(b); \
    tt_count++; \
    if (_a != _b) { \
        tt_failures++; \
        fprintf(stderr, "FAIL %s:%d: %s == %s (%ld != %ld)\n", __FILE__, __LINE__, #a, #b, _a, _b); \
    } \
} while (0)

#define TT_ASSERT_EQ_STR(a, b) do { \
    const char *_a = (a), *_b = (b); \
    tt_count++; \
    if (strcmp(_a, _b) != 0) { \
        tt_failures++; \
        fprintf(stderr, "FAIL %s:%d: %s == %s (\"%s\" != \"%s\")\n", __FILE__, __LINE__, #a, #b, _a, _b); \
    } \
} while (0)

#define TT_RUN(fn) do { \
    fprintf(stderr, "-- %s\n", #fn); \
    fn(); \
} while (0)

#define TT_MAIN_BEGIN() int main(void) {
#define TT_MAIN_END() \
    fprintf(stderr, "%d assertions, %d failures\n", tt_count, tt_failures); \
    return tt_failures == 0 ? 0 : 1; \
}

#endif /* TINYTEST_H */

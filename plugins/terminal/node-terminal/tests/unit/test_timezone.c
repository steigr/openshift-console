#include "timezone.h"
#include "tinytest.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static char g_zoneinfo[128];

/* A zoneinfo tree holding only Europe/Berlin. */
static void make_zoneinfo(void) {
    strcpy(g_zoneinfo, "/tmp/node-terminal-tz.XXXXXX");
    if (!mkdtemp(g_zoneinfo)) {
        perror("mkdtemp");
        exit(1);
    }
    char path[256];
    snprintf(path, sizeof(path), "%s/Europe", g_zoneinfo);
    mkdir(path, 0755);
    snprintf(path, sizeof(path), "%s/Europe/Berlin", g_zoneinfo);
    FILE *f = fopen(path, "w");
    if (!f) {
        perror("fopen");
        exit(1);
    }
    fputs("TZif", f);
    fclose(f);
}

static void test_valid_iana(void) {
    TT_ASSERT(timezone_valid_iana("UTC"));
    TT_ASSERT(timezone_valid_iana("Europe/Berlin"));
    TT_ASSERT(timezone_valid_iana("America/Argentina/Buenos_Aires"));
    TT_ASSERT(timezone_valid_iana("Etc/GMT-5"));
    TT_ASSERT(!timezone_valid_iana(NULL));
    TT_ASSERT(!timezone_valid_iana(""));
    TT_ASSERT(!timezone_valid_iana("/etc/passwd"));
    TT_ASSERT(!timezone_valid_iana("../../etc/passwd"));
    TT_ASSERT(!timezone_valid_iana("Europe/../../etc"));
    TT_ASSERT(!timezone_valid_iana("Europe//Berlin"));
    TT_ASSERT(!timezone_valid_iana("Europe/Berlin/"));
    TT_ASSERT(!timezone_valid_iana("Europe/Berlin; rm -rf /"));
}

static void test_valid_posix(void) {
    TT_ASSERT(timezone_valid_posix("UTC0"));
    TT_ASSERT(timezone_valid_posix("<+01>-1<+02>,M3.5.0/2,M10.5.0/3"));
    TT_ASSERT(timezone_valid_posix("<+0530>-5:30"));
    TT_ASSERT(!timezone_valid_posix(NULL));
    TT_ASSERT(!timezone_valid_posix(""));
    TT_ASSERT(!timezone_valid_posix("UTC0 X=1"));
    TT_ASSERT(!timezone_valid_posix("UTC0\nX=1"));
    TT_ASSERT(!timezone_valid_posix("$(id)"));
}

static void test_select_prefers_installed_iana(void) {
    char out[160];
    const char *tz = timezone_select("Europe/Berlin", "<+01>-1<+02>,M3.5.0/2,M10.5.0/3",
                                     g_zoneinfo, out, sizeof(out));
    TT_ASSERT(tz != NULL);
    if (tz) TT_ASSERT_EQ_STR(tz, "Europe/Berlin");
}

static void test_select_falls_back_to_posix(void) {
    char out[160];
    const char *tz = timezone_select("Asia/Tokyo", "<+09>-9", g_zoneinfo, out, sizeof(out));
    TT_ASSERT(tz != NULL);
    if (tz) TT_ASSERT_EQ_STR(tz, "<+09>-9");
    tz = timezone_select("../Europe/Berlin", "<+09>-9", g_zoneinfo, out, sizeof(out));
    TT_ASSERT(tz != NULL);
    if (tz) TT_ASSERT_EQ_STR(tz, "<+09>-9");
}

static void test_select_nothing_usable(void) {
    char out[160];
    TT_ASSERT(timezone_select(NULL, NULL, g_zoneinfo, out, sizeof(out)) == NULL);
    TT_ASSERT(timezone_select("Asia/Tokyo", NULL, g_zoneinfo, out, sizeof(out)) == NULL);
    TT_ASSERT(timezone_select(NULL, "$(id)", g_zoneinfo, out, sizeof(out)) == NULL);
    char tiny[4];
    TT_ASSERT(timezone_select("Europe/Berlin", "UTC0", g_zoneinfo, tiny, sizeof(tiny)) == NULL);
}

TT_MAIN_BEGIN()
    make_zoneinfo();
    TT_RUN(test_valid_iana);
    TT_RUN(test_valid_posix);
    TT_RUN(test_select_prefers_installed_iana);
    TT_RUN(test_select_falls_back_to_posix);
    TT_RUN(test_select_nothing_usable);
TT_MAIN_END()

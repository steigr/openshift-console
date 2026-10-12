#include "timezone.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

int timezone_valid_iana(const char *name) {
    if (!name) return 0;
    size_t len = strlen(name);
    if (len == 0 || len > 64) return 0;
    int at_segment_start = 1;
    for (const char *p = name; *p; p++) {
        char c = *p;
        if (c == '/') {
            if (at_segment_start) return 0; /* leading or doubled '/' */
            at_segment_start = 1;
            continue;
        }
        if (at_segment_start && (c == '.' || c == '-')) return 0;
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '+' || c == '-')) {
            return 0;
        }
        at_segment_start = 0;
    }
    return !at_segment_start; /* no trailing '/' */
}

int timezone_valid_posix(const char *value) {
    if (!value) return 0;
    size_t len = strlen(value);
    if (len == 0 || len > 128) return 0;
    for (const char *p = value; *p; p++) {
        char c = *p;
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
              (c >= '0' && c <= '9') || strchr("<>+-:,./", c))) {
            return 0;
        }
    }
    return 1;
}

const char *timezone_select(const char *iana, const char *posix,
                            const char *zoneinfo_dir, char *out, size_t out_len) {
    if (timezone_valid_iana(iana)) {
        char path[256];
        int n = snprintf(path, sizeof(path), "%s/%s", zoneinfo_dir, iana);
        if (n > 0 && (size_t)n < sizeof(path) && access(path, R_OK) == 0 &&
            strlen(iana) < out_len) {
            strcpy(out, iana);
            return out;
        }
    }
    if (timezone_valid_posix(posix) && strlen(posix) < out_len) {
        strcpy(out, posix);
        return out;
    }
    return NULL;
}

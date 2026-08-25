#include "mountns.h"
#include "tinytest.h"

#include <stdio.h>
#include <string.h>

/* Real-ish /proc/self/mountinfo excerpt: a CSI ephemeral-volume bind mount
 * at /mnt/userhome, sourced from a host path under a CSI plugin's staging
 * directory, plus a couple of unrelated mounts to make sure the parser
 * doesn't just grab the first/last line. The mount-source field
 * (/dev/mapper/vg0-userhome) is deliberately the same *device* for both
 * /mnt/userhome and an unrelated mount, to make sure the parser reads the
 * `root` field (the bind's actual path) and not that constant device name. */
static const char *SAMPLE_MOUNTINFO =
    "23 60 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw\n"
    "24 60 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:8 - proc proc rw\n"
    "700 60 253:0 /var/lib/kubelet/pods/abc/volumes/kubernetes.io~csi/userhome-abc/mount "
        "/mnt/userhome rw,relatime shared:300 master:150 - ext4 /dev/mapper/vg0-userhome rw\n"
    "701 60 253:0 / /mnt/other rw,relatime shared:301 - ext4 /dev/mapper/vg0-userhome rw\n";

static FILE *open_sample(void) {
    return fmemopen((void *)SAMPLE_MOUNTINFO, strlen(SAMPLE_MOUNTINFO), "r");
}

static void test_finds_matching_mount_point(void) {
    FILE *f = open_sample();
    char out[256];
    int rc = mountns_parse_source(f, "/mnt/userhome", out, sizeof(out));
    fclose(f);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(out, "/var/lib/kubelet/pods/abc/volumes/kubernetes.io~csi/userhome-abc/mount");
}

static void test_returns_error_for_unknown_mount_point(void) {
    FILE *f = open_sample();
    char out[256];
    int rc = mountns_parse_source(f, "/mnt/does-not-exist", out, sizeof(out));
    fclose(f);
    TT_ASSERT(rc != 0);
}

static void test_does_not_confuse_similarly_named_mounts(void) {
    FILE *f = open_sample();
    char out[256];
    int rc = mountns_parse_source(f, "/mnt/other", out, sizeof(out));
    fclose(f);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(out, "/");
}

static void test_null_file_is_rejected(void) {
    char out[256];
    int rc = mountns_parse_source(NULL, "/mnt/userhome", out, sizeof(out));
    TT_ASSERT(rc != 0);
}

TT_MAIN_BEGIN()
    TT_RUN(test_finds_matching_mount_point);
    TT_RUN(test_returns_error_for_unknown_mount_point);
    TT_RUN(test_does_not_confuse_similarly_named_mounts);
    TT_RUN(test_null_file_is_rejected);
TT_MAIN_END()

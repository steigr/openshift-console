#include "mountns.h"
#include "tinytest.h"

#include <stdio.h>
#include <string.h>

/* Real-ish /proc/self/mountinfo excerpt, container-local view: a CSI
 * ephemeral-volume bind mount at /mnt/userhome, sourced from a host path
 * under a CSI plugin's staging directory, plus a couple of unrelated
 * mounts to make sure the parser doesn't just grab the first/last line.
 * The mount-source field (/dev/mapper/vg0-userhome) is deliberately the
 * same *device* for both /mnt/userhome and an unrelated mount, to make
 * sure the parser reads the `root` field (the bind's actual path) and not
 * that constant device name. */
static const char *CONTAINER_MOUNTINFO =
    "23 60 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw\n"
    "24 60 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:8 - proc proc rw\n"
    "700 60 253:0 /var/lib/kubelet/pods/abc/volumes/kubernetes.io~csi/userhome-abc/mount "
        "/mnt/userhome rw,relatime shared:300 master:150 - ext4 /dev/mapper/vg0-userhome rw\n"
    "701 60 253:0 / /mnt/other rw,relatime shared:301 - ext4 /dev/mapper/vg0-userhome rw\n";

/* Same shape, but for a cluster where /var/lib/kubelet is its own separate
 * filesystem (e.g. a dedicated ZFS dataset) rather than part of the node's
 * root filesystem - kubelet's per-pod emptyDir bind mount at /mnt/userhome
 * then has a `root` field that's only a path *within* that dataset, not an
 * absolute host path on its own. This is the scenario mountns_resolve_source
 * exists to handle correctly (see its doc comment). */
static const char *CONTAINER_MOUNTINFO_SEPARATE_DATASET =
    "23 60 0:21 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw\n"
    "700 60 0:42 /pods/abc/volumes/kubernetes.io~empty-dir/home "
        "/mnt/userhome rw,relatime shared:300 - zfs tank/kubelet rw\n";

/* The host's own mount table, as seen after nsenter_host()'s setns(mnt), for
 * the "separate dataset" scenario above: device 0:42's top-level mount
 * (root "/") is /var/lib/kubelet, not the host's "/" itself. */
static const char *HOST_MOUNTINFO_SEPARATE_DATASET =
    "10 1 0:2 / / rw,relatime - zfs tank/root rw\n"
    "11 10 0:42 / /var/lib/kubelet rw,relatime - zfs tank/kubelet rw\n";

/* The host's own mount table for the "normal" scenario (CONTAINER_MOUNTINFO
 * above): device 253:0 IS the host's root filesystem, so its top-level
 * mount point is "/" - resolving a bind mount from it should pass the
 * `root` field through unchanged (it's already an absolute host path). */
static const char *HOST_MOUNTINFO_ROOT_DEVICE =
    "10 1 253:0 / / rw,relatime - ext4 /dev/mapper/vg0-root rw\n";

static FILE *open_str(const char *s) {
    return fmemopen((void *)s, strlen(s), "r");
}

static void test_finds_matching_mount_point(void) {
    FILE *f = open_str(CONTAINER_MOUNTINFO);
    char dev[32], root[256];
    int rc = mountns_parse_target(f, "/mnt/userhome", dev, sizeof(dev), root, sizeof(root));
    fclose(f);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(dev, "253:0");
    TT_ASSERT_EQ_STR(root, "/var/lib/kubelet/pods/abc/volumes/kubernetes.io~csi/userhome-abc/mount");
}

static void test_returns_error_for_unknown_mount_point(void) {
    FILE *f = open_str(CONTAINER_MOUNTINFO);
    char dev[32], root[256];
    int rc = mountns_parse_target(f, "/mnt/does-not-exist", dev, sizeof(dev), root, sizeof(root));
    fclose(f);
    TT_ASSERT(rc != 0);
}

static void test_does_not_confuse_similarly_named_mounts(void) {
    FILE *f = open_str(CONTAINER_MOUNTINFO);
    char dev[32], root[256];
    int rc = mountns_parse_target(f, "/mnt/other", dev, sizeof(dev), root, sizeof(root));
    fclose(f);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(dev, "253:0");
    TT_ASSERT_EQ_STR(root, "/");
}

static void test_target_null_file_is_rejected(void) {
    char dev[32], root[256];
    int rc = mountns_parse_target(NULL, "/mnt/userhome", dev, sizeof(dev), root, sizeof(root));
    TT_ASSERT(rc != 0);
}

static void test_device_root_finds_top_level_mount(void) {
    FILE *f = open_str(HOST_MOUNTINFO_SEPARATE_DATASET);
    char mount_point[256];
    int rc = mountns_parse_device_root(f, "0:42", mount_point, sizeof(mount_point));
    fclose(f);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(mount_point, "/var/lib/kubelet");
}

static void test_device_root_ignores_non_root_entries_for_the_device(void) {
    /* A bind-mount entry (root != "/") for the target device must not be
     * mistaken for its top-level mount, even if it sorts first. */
    static const char *mixed =
        "700 60 0:42 /pods/abc/volumes/kubernetes.io~empty-dir/home /mnt/userhome rw,relatime - zfs tank/kubelet rw\n"
        "11 10 0:42 / /var/lib/kubelet rw,relatime - zfs tank/kubelet rw\n";
    FILE *f = open_str(mixed);
    char mount_point[256];
    int rc = mountns_parse_device_root(f, "0:42", mount_point, sizeof(mount_point));
    fclose(f);
    TT_ASSERT_EQ_INT(rc, 0);
    TT_ASSERT_EQ_STR(mount_point, "/var/lib/kubelet");
}

static void test_device_root_returns_error_when_device_has_no_top_level_mount(void) {
    FILE *f = open_str(HOST_MOUNTINFO_SEPARATE_DATASET);
    char mount_point[256];
    int rc = mountns_parse_device_root(f, "99:99", mount_point, sizeof(mount_point));
    fclose(f);
    TT_ASSERT(rc != 0);
}

static void test_device_root_null_file_is_rejected(void) {
    char mount_point[256];
    int rc = mountns_parse_device_root(NULL, "0:42", mount_point, sizeof(mount_point));
    TT_ASSERT(rc != 0);
}

/* End-to-end (minus the real /proc/self/mountinfo reads mountns_resolve_source
 * itself does): reproduces the exact bug this two-phase split fixes. When
 * /var/lib/kubelet is the host's own root filesystem, the `root` field is
 * already the absolute host path (device's top-level mount is "/"). */
static void test_resolves_absolute_path_when_device_is_the_root_filesystem(void) {
    FILE *cf = open_str(CONTAINER_MOUNTINFO);
    char dev[32], root[256];
    TT_ASSERT_EQ_INT(mountns_parse_target(cf, "/mnt/userhome", dev, sizeof(dev), root, sizeof(root)), 0);
    fclose(cf);

    FILE *hf = open_str(HOST_MOUNTINFO_ROOT_DEVICE);
    char base[256];
    TT_ASSERT_EQ_INT(mountns_parse_device_root(hf, dev, base, sizeof(base)), 0);
    fclose(hf);

    TT_ASSERT_EQ_STR(base, "/");
    /* join_host_path isn't exported, but base == "/" is exactly the case
     * mountns_resolve_source passes `root` through unchanged for. */
    TT_ASSERT_EQ_STR(root, "/var/lib/kubelet/pods/abc/volumes/kubernetes.io~csi/userhome-abc/mount");
}

/* When /var/lib/kubelet is its own separate filesystem (the bug this fix
 * addresses - see mountns_resolve_source's doc comment), the `root` field
 * alone is only a path within that filesystem: it must be combined with
 * where that filesystem is actually mounted on the host. */
static void test_resolves_relative_root_against_separate_dataset_mount_point(void) {
    FILE *cf = open_str(CONTAINER_MOUNTINFO_SEPARATE_DATASET);
    char dev[32], root[256];
    TT_ASSERT_EQ_INT(mountns_parse_target(cf, "/mnt/userhome", dev, sizeof(dev), root, sizeof(root)), 0);
    fclose(cf);
    TT_ASSERT_EQ_STR(dev, "0:42");
    TT_ASSERT_EQ_STR(root, "/pods/abc/volumes/kubernetes.io~empty-dir/home");

    FILE *hf = open_str(HOST_MOUNTINFO_SEPARATE_DATASET);
    char base[256];
    TT_ASSERT_EQ_INT(mountns_parse_device_root(hf, dev, base, sizeof(base)), 0);
    fclose(hf);
    TT_ASSERT_EQ_STR(base, "/var/lib/kubelet");
    /* base ("/var/lib/kubelet") + root ("/pods/.../home") is what
     * mountns_resolve_source's join_host_path concatenates into
     * ctx->src_path - "/var/lib/kubelet/pods/abc/volumes/kubernetes.io~empty-dir/home",
     * not the bare `root` on its own (which is what the old single-phase
     * implementation returned, and which does not exist on the host). */
}

TT_MAIN_BEGIN()
    TT_RUN(test_finds_matching_mount_point);
    TT_RUN(test_returns_error_for_unknown_mount_point);
    TT_RUN(test_does_not_confuse_similarly_named_mounts);
    TT_RUN(test_target_null_file_is_rejected);
    TT_RUN(test_device_root_finds_top_level_mount);
    TT_RUN(test_device_root_ignores_non_root_entries_for_the_device);
    TT_RUN(test_device_root_returns_error_when_device_has_no_top_level_mount);
    TT_RUN(test_device_root_null_file_is_rejected);
    TT_RUN(test_resolves_absolute_path_when_device_is_the_root_filesystem);
    TT_RUN(test_resolves_relative_root_against_separate_dataset_mount_point);
TT_MAIN_END()

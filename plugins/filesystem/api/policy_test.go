package api

import (
	"testing"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
)

func TestVisibilityHidesDevProcSysByDefault(t *testing.T) {
	vis := newVisibility(&podTarget{})
	for _, path := range []string{"/dev", "/dev/null", "/proc", "/proc/1", "/proc/sys", "/proc/sys/kernel", "/sys", "/sys/fs"} {
		if vis.allowed(path) {
			t.Errorf("allowed(%q) = true, want false with no sysctls or device passthrough", path)
		}
	}
}

func TestVisibilityAllowsOrdinaryPaths(t *testing.T) {
	vis := newVisibility(&podTarget{})
	for _, path := range []string{"/", "/etc/passwd", "/home/app", "/devious"} {
		if !vis.allowed(path) {
			t.Errorf("allowed(%q) = false, want true", path)
		}
	}
}

func TestVisibilityAllowsOnlyDeclaredDevPaths(t *testing.T) {
	vis := newVisibility(&podTarget{AllowedDevPaths: []string{"/dev/xvda"}})

	for _, path := range []string{"/dev", "/dev/xvda"} {
		if !vis.allowed(path) {
			t.Errorf("allowed(%q) = false, want true", path)
		}
	}
	for _, path := range []string{"/dev/null", "/dev/pts", "/dev/shm", "/dev/zero"} {
		if vis.allowed(path) {
			t.Errorf("allowed(%q) = true, want false: only the declared device is visible", path)
		}
	}
}

func TestVisibilityAllowsOnlyTunedProcSysPaths(t *testing.T) {
	vis := newVisibility(&podTarget{ProcSysPaths: []string{"/proc/sys/net/ipv4/ip_forward"}})

	for _, path := range []string{"/proc", "/proc/sys", "/proc/sys/net", "/proc/sys/net/ipv4", "/proc/sys/net/ipv4/ip_forward"} {
		if !vis.allowed(path) {
			t.Errorf("allowed(%q) = false, want true: on the path to a tuned sysctl", path)
		}
	}
	for _, path := range []string{"/proc/1", "/proc/cpuinfo", "/proc/sys/kernel", "/proc/sys/net/ipv6", "/proc/sys/net/ipv4/ip_default_ttl"} {
		if vis.allowed(path) {
			t.Errorf("allowed(%q) = true, want false: not a tuned sysctl", path)
		}
	}
}

func TestVisibilityNeverAllowsSys(t *testing.T) {
	// /sys has no exception, unlike /dev and /proc/sys.
	vis := newVisibility(&podTarget{
		AllowedDevPaths: []string{"/dev/xvda"},
		ProcSysPaths:    []string{"/proc/sys/net/ipv4/ip_forward"},
	})
	for _, path := range []string{"/sys", "/sys/fs", "/sys/class/net"} {
		if vis.allowed(path) {
			t.Errorf("allowed(%q) = true, want false", path)
		}
	}
}

func TestSysctlProcSysPath(t *testing.T) {
	got := sysctlProcSysPath("net.ipv4.ip_forward")
	want := "/proc/sys/net/ipv4/ip_forward"
	if got != want {
		t.Errorf("sysctlProcSysPath() = %q, want %q", got, want)
	}
}

func TestPodResponseAllowedDevPaths(t *testing.T) {
	var pod podResponse
	pod.Spec.Volumes = []struct {
		Name     string `json:"name"`
		HostPath *struct {
			Path string `json:"path"`
			Type string `json:"type"`
		} `json:"hostPath"`
	}{
		{Name: "gpu", HostPath: &struct {
			Path string `json:"path"`
			Type string `json:"type"`
		}{Path: "/dev/nvidia0", Type: "CharDevice"}},
		{Name: "scratch", HostPath: &struct {
			Path string `json:"path"`
			Type string `json:"type"`
		}{Path: "/data", Type: "Directory"}},
	}
	pod.Spec.Containers = []containerSpec{{
		Name: "main",
		VolumeMounts: []struct {
			Name      string `json:"name"`
			MountPath string `json:"mountPath"`
		}{
			{Name: "gpu", MountPath: "/dev/nvidia0"},
			{Name: "scratch", MountPath: "/mnt/scratch"},
		},
		VolumeDevices: []struct {
			Name       string `json:"name"`
			DevicePath string `json:"devicePath"`
		}{
			{Name: "block-pvc", DevicePath: "/dev/xvdf"},
		},
	}}

	got := pod.allowedDevPaths("main")
	want := map[string]bool{"/dev/nvidia0": true, "/dev/xvdf": true}
	if len(got) != len(want) {
		t.Fatalf("allowedDevPaths() = %v, want exactly %v", got, want)
	}
	for _, p := range got {
		if !want[p] {
			t.Errorf("allowedDevPaths() included %q unexpectedly (a non-device volume mount must not be treated as a passthrough device)", p)
		}
	}

	if got := pod.allowedDevPaths("sidecar"); len(got) != 0 {
		t.Errorf("allowedDevPaths(%q) = %v, want none: paths belong to a different container", "sidecar", got)
	}
}

func TestFilterEntriesDropsHiddenChildren(t *testing.T) {
	vis := newVisibility(&podTarget{AllowedDevPaths: []string{"/dev/xvda"}})
	resp := &filesystemv1.ListDirectoryResponse{
		Entries: []*filesystemv1.Entry{
			{Name: "xvda"},
			{Name: "null"},
			{Name: "pts"},
		},
	}

	filterEntries(resp, "/dev", vis)

	if len(resp.Entries) != 1 || resp.Entries[0].GetName() != "xvda" {
		t.Errorf("filterEntries() left %v, want only \"xvda\"", resp.Entries)
	}
}

func TestRequestPathsCoversEveryPathBearingMessage(t *testing.T) {
	cases := []struct {
		name string
		msg  any
		want []string
	}{
		{"list", &filesystemv1.ListDirectoryRequest{Path: "/a"}, []string{"/a"}},
		{"stat", &filesystemv1.StatRequest{Path: "/a"}, []string{"/a"}},
		{"read", &filesystemv1.ReadFileRequest{Path: "/a"}, []string{"/a"}},
		{"upload", &filesystemv1.UploadRequest{Path: "/a"}, []string{"/a"}},
		{"archive", &filesystemv1.ArchiveRequest{Path: "/a"}, []string{"/a"}},
		{"extract without destination", &filesystemv1.ExtractRequest{Path: "/a"}, []string{"/a"}},
		{"extract with destination", &filesystemv1.ExtractRequest{Path: "/a", Destination: "/b"}, []string{"/a", "/b"}},
		{"move", &filesystemv1.MoveRequest{Source: "/a", Destination: "/b"}, []string{"/a", "/b"}},
		{"delete", &filesystemv1.DeleteRequest{Path: "/a"}, []string{"/a"}},
		{"mkdir", &filesystemv1.CreateDirectoryRequest{Path: "/a"}, []string{"/a"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := requestPaths(tc.msg)
			if len(got) != len(tc.want) {
				t.Fatalf("requestPaths() = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("requestPaths()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

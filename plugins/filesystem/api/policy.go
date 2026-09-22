package api

import (
	"path"
	"strings"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
)

// visibility says which paths inside a container's filesystem this plugin
// will show. /dev, /proc and /sys hold host/kernel state that has nothing to
// do with a container's own files -- /proc in particular can leak details of
// the node itself -- so all three are hidden by default. Two narrow
// exceptions exist, both driven by the pod's own spec rather than by
// anything the caller can influence:
//
//   - /dev: entries explicitly given to the container -- a raw block PVC
//     (volumeDevices) or a passed-through host device (a hostPath volume of
//     type CharDevice/BlockDevice) -- are the container's own, deliberately
//     placed there, and are shown; nothing else under /dev is.
//   - /proc/sys: when the pod applies sysctls, only the tuned files
//     themselves (and the directories leading to them) are shown, nothing
//     else under /proc.
//
// /sys has no such exception: it is always fully hidden.
type visibility struct {
	devPaths     []string
	procSysPaths []string
}

func newVisibility(target *podTarget) *visibility {
	return &visibility{
		devPaths:     cleanAll(target.AllowedDevPaths),
		procSysPaths: cleanAll(target.ProcSysPaths),
	}
}

func cleanAll(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if p != "" {
			out = append(out, cleanPath(p))
		}
	}
	return out
}

func cleanPath(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return path.Clean(p)
}

// allowed reports whether p -- an entry, or a directory about to be listed --
// may be shown to the caller.
func (v *visibility) allowed(p string) bool {
	p = cleanPath(p)
	switch {
	case p == "/sys" || strings.HasPrefix(p, "/sys/"):
		return false
	case p == "/dev" || strings.HasPrefix(p, "/dev/"):
		return matchesAny(p, v.devPaths)
	case p == "/proc" || strings.HasPrefix(p, "/proc/"):
		return matchesAny(p, v.procSysPaths)
	default:
		return true
	}
}

// matchesAny reports whether p is one of leaves, an ancestor directory of one
// (so the tree can be walked down to it), or a descendant of one (a leaf can
// itself be a directory -- some /proc/sys entries are -- and everything under
// it is shown).
func matchesAny(p string, leaves []string) bool {
	for _, leaf := range leaves {
		if p == leaf || strings.HasPrefix(leaf, p+"/") || strings.HasPrefix(p, leaf+"/") {
			return true
		}
	}
	return false
}

// filterEntries drops directory entries this plugin's policy hides, in
// place, so a listing of "/" never shows more than an allowed sliver of /dev
// or /proc/sys, and /sys not at all.
func filterEntries(resp *filesystemv1.ListDirectoryResponse, dir string, vis *visibility) {
	kept := resp.GetEntries()[:0]
	for _, entry := range resp.GetEntries() {
		if vis.allowed(path.Join(dir, entry.GetName())) {
			kept = append(kept, entry)
		}
	}
	resp.Entries = kept
}

// requestPaths returns the absolute container paths a request names, so
// connectAgent can check each one against the caller's visibility before the
// request ever reaches the agent.
func requestPaths(msg any) []string {
	switch m := msg.(type) {
	case *filesystemv1.ListDirectoryRequest:
		return []string{m.GetPath()}
	case *filesystemv1.StatRequest:
		return []string{m.GetPath()}
	case *filesystemv1.ReadFileRequest:
		return []string{m.GetPath()}
	case *filesystemv1.UploadRequest:
		return []string{m.GetPath()}
	case *filesystemv1.ArchiveRequest:
		return []string{m.GetPath()}
	case *filesystemv1.ExtractRequest:
		paths := []string{m.GetPath()}
		if dest := m.GetDestination(); dest != "" {
			paths = append(paths, dest)
		}
		return paths
	case *filesystemv1.MoveRequest:
		return []string{m.GetSource(), m.GetDestination()}
	case *filesystemv1.DeleteRequest:
		return []string{m.GetPath()}
	case *filesystemv1.CreateDirectoryRequest:
		return []string{m.GetPath()}
	default:
		return nil
	}
}

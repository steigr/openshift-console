package rootfs

import "strings"

// splitComponents drops empty and "." components, keeping ".." for the
// kernel (or, off Linux, the emulation) to apply against the root.
func splitComponents(cleaned string) []string {
	parts := strings.Split(cleaned, "/")
	out := parts[:0]
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		out = append(out, part)
	}
	return out
}

// baseName is the final component of an in-container path, or "/" for the
// root itself -- used only to label a Stat.
func baseName(p string) string {
	cleaned, err := CleanPath(p)
	if err != nil || cleaned == "." {
		return "/"
	}
	parts := splitComponents(cleaned)
	if len(parts) == 0 {
		return "/"
	}
	return parts[len(parts)-1]
}

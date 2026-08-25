package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const (
	// fieldManager identifies this controller's own writes in a Node's
	// managedFields, so a later sync can tell "we set this label
	// ourselves" apart from "something else owns this label" without
	// having to remember prior state.
	fieldManager = "openshift-synchronizer"

	// instanceTypeSourceLabel/instanceTypeTargetLabel: the console reads
	// the deprecated beta label for its "Instance type" column (see
	// node.ts in console-shared); OpenShift nodes instead carry the
	// non-beta equivalent.
	instanceTypeSourceLabel = "openshift.io/instance-type"
	instanceTypeTargetLabel = "beta.kubernetes.io/instance-type"

	// zoneSourceLabel/zoneTargetLabel: same story for the "Zone" column.
	zoneSourceLabel = "topology.openshift.io/zone"
	zoneTargetLabel = "topology.kubernetes.io/zone"
)

// syncNode backfills instanceTypeTargetLabel and zoneTargetLabel on a
// single Node from their OpenShift-native equivalents (and, for instance
// type, from a Prometheus-compatible backend as a last resort). A missing
// Node is a no-op (it was deleted, and there's nothing to clean up). A
// target label already claimed by some other field manager is left alone
// entirely, on the assumption something else (e.g. a real cloud provider
// integration) is already the authority for it.
func (c *Controller) syncNode(ctx context.Context, name string) error {
	node, err := c.nodeLister.Get(name)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("get node %q: %w", name, err)
	}

	toApply := map[string]string{}

	if isLabelManagedByOthers(node, instanceTypeTargetLabel) {
		log.Printf("skipping %s on node %q: already managed by another field manager", instanceTypeTargetLabel, name)
	} else if v := c.desiredInstanceType(ctx, node); v != "" && node.Labels[instanceTypeTargetLabel] != v {
		toApply[instanceTypeTargetLabel] = v
	}

	if isLabelManagedByOthers(node, zoneTargetLabel) {
		log.Printf("skipping %s on node %q: already managed by another field manager", zoneTargetLabel, name)
	} else if v := node.Labels[zoneSourceLabel]; v != "" && node.Labels[zoneTargetLabel] != v {
		toApply[zoneTargetLabel] = v
	}

	if len(toApply) == 0 {
		return nil
	}

	return c.applyNodeLabels(ctx, name, toApply)
}

// desiredInstanceType returns the value instanceTypeTargetLabel should
// have: the OpenShift-native label when the Node carries one, otherwise -
// if a Prometheus backend is configured - a value derived from the DMI
// info node_exporter reports for that Node.
func (c *Controller) desiredInstanceType(ctx context.Context, node *corev1.Node) string {
	if v := node.Labels[instanceTypeSourceLabel]; v != "" {
		return v
	}
	if c.prometheusURL == "" {
		return ""
	}

	v, err := c.instanceTypeFromPrometheus(ctx, node.Name)
	if err != nil {
		log.Printf("querying prometheus dmi info for node %q: %v", node.Name, err)
		return ""
	}
	return v
}

// isLabelManagedByOthers reports whether some field manager other than
// this controller's own has claimed ownership of the given label in the
// Node's managedFields.
func isLabelManagedByOthers(node *corev1.Node, label string) bool {
	for _, mf := range node.ManagedFields {
		if mf.Manager == fieldManager || mf.FieldsV1 == nil {
			continue
		}

		var top map[string]json.RawMessage
		if err := json.Unmarshal(mf.FieldsV1.Raw, &top); err != nil {
			continue
		}
		metadataRaw, ok := top["f:metadata"]
		if !ok {
			continue
		}

		var metadataFields map[string]json.RawMessage
		if err := json.Unmarshal(metadataRaw, &metadataFields); err != nil {
			continue
		}
		labelsRaw, ok := metadataFields["f:labels"]
		if !ok {
			continue
		}

		var labelFields map[string]json.RawMessage
		if err := json.Unmarshal(labelsRaw, &labelFields); err != nil {
			continue
		}
		if _, ok := labelFields["f:"+label]; ok {
			return true
		}
	}
	return false
}

// applyNodeLabels sets the given labels on a Node via server-side apply
// under fieldManager, one label at a time, so ownership of exactly those
// fields is recorded for future isLabelManagedByOthers checks without
// touching any label this controller doesn't itself own. Deliberately does
// NOT force: isLabelManagedByOthers is a best-effort, cache-based
// pre-check, and Force would silently steal a field from its real owner
// whenever that check raced or missed - forcing exactly the write/write
// ping-pong the pre-check exists to prevent. Without force, the API server
// itself is the final word: a genuine conflict comes back as 409 and is
// treated the same as the pre-check catching it, per label, so one
// contested label can't block the other from being applied.
func (c *Controller) applyNodeLabels(ctx context.Context, name string, labels map[string]string) error {
	for label, value := range labels {
		patch := map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Node",
			"metadata": map[string]interface{}{
				"name": name,
				"labels": map[string]interface{}{
					label: value,
				},
			},
		}

		data, err := json.Marshal(patch)
		if err != nil {
			return fmt.Errorf("marshal label patch for node %q: %w", name, err)
		}

		_, err = c.kubeClient.CoreV1().Nodes().Patch(ctx, name, types.ApplyPatchType, data, metav1.PatchOptions{
			FieldManager: fieldManager,
		})
		if apierrors.IsConflict(err) {
			log.Printf("skipping %s on node %q: conflicts with another field manager", label, name)
			continue
		}
		if err != nil {
			return fmt.Errorf("apply label %s on node %q: %w", label, name, err)
		}

		log.Printf("set %s=%q on node %q", label, value, name)
	}
	return nil
}

// promVectorResponse is the subset of Prometheus's /api/v1/query response
// shape (instant vector queries) this controller needs.
type promVectorResponse struct {
	Status string `json:"status"`
	Data   struct {
		Result []struct {
			Metric map[string]string `json:"metric"`
		} `json:"result"`
	} `json:"data"`
}

// instanceTypeFromPrometheus queries c.prometheusURL for
// node_dmi_info{node="<nodeName>"} and derives an instance-type-style
// value from the returned DMI labels: board_vendor/board_name/bios_release
// normally, or system_vendor/product_name when board_vendor is "KVM" (a
// virtualized board_vendor doesn't identify real hardware).
func (c *Controller) instanceTypeFromPrometheus(ctx context.Context, nodeName string) (string, error) {
	u, err := url.Parse(strings.TrimRight(c.prometheusURL, "/") + "/api/v1/query")
	if err != nil {
		return "", fmt.Errorf("parse prometheus url: %w", err)
	}
	q := u.Query()
	q.Set("query", fmt.Sprintf(`node_dmi_info{node=%q}`, nodeName))
	u.RawQuery = q.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", fmt.Errorf("build prometheus request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("query prometheus: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("prometheus query returned status %d", resp.StatusCode)
	}

	var parsed promVectorResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("decode prometheus response: %w", err)
	}
	if parsed.Status != "success" || len(parsed.Data.Result) == 0 {
		return "", nil
	}
	if len(parsed.Data.Result) > 1 {
		// Ambiguous: picking an arbitrary element here would flap the
		// computed value between reconciles whenever the backend doesn't
		// guarantee stable result ordering (e.g. VictoriaMetrics doesn't,
		// for plain vector selectors). Leave the label as-is rather than
		// guess.
		return "", fmt.Errorf("node_dmi_info{node=%q} matched %d series, want exactly 1", nodeName, len(parsed.Data.Result))
	}

	return instanceTypeFromDMI(parsed.Data.Result[0].Metric), nil
}

// instanceTypeFromDMI turns node_dmi_info's labels into an instance-type
// style value. A board_vendor of "KVM" means the board fields describe the
// hypervisor's virtual motherboard rather than real hardware, so system
// (vendor, product) is used instead.
func instanceTypeFromDMI(metric map[string]string) string {
	if metric["board_vendor"] != "KVM" {
		return sanitizeLabelValue(strings.Join([]string{
			metric["board_vendor"], metric["board_name"], metric["bios_release"],
		}, "-"))
	}
	return sanitizeLabelValue(strings.Join([]string{
		metric["system_vendor"], metric["product_name"],
	}, "-"))
}

var labelValueInvalidChars = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// sanitizeLabelValue coerces s into a valid Kubernetes label value:
// alphanumerics/'-'/'_'/'.' only, starting and ending alphanumeric, at
// most 63 characters.
func sanitizeLabelValue(s string) string {
	s = labelValueInvalidChars.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-_.")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-_.")
	}
	return s
}

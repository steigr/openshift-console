package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	kubefake "k8s.io/client-go/kubernetes/fake"
	corelisters "k8s.io/client-go/listers/core/v1"
	clienttesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/cache"
)

// newTestNodeController builds a Controller whose node lister is backed by a
// plain indexer (seeded with initialNodes, no informer involved) and whose
// kubeClient is a fake seeded with initialNodes, so Node patches can be
// observed.
func newTestNodeController(t *testing.T, prometheusURL string, initialNodes ...runtime.Object) (*Controller, *kubefake.Clientset) {
	t.Helper()

	indexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	for _, obj := range initialNodes {
		if err := indexer.Add(obj); err != nil {
			t.Fatalf("seed node indexer: %v", err)
		}
	}

	kubeClient := kubefake.NewSimpleClientset(initialNodes...)

	return &Controller{
		kubeClient:    kubeClient,
		prometheusURL: prometheusURL,
		nodeLister:    corelisters.NewNodeLister(indexer),
	}, kubeClient
}

func node(name string, labels map[string]string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: labels,
		},
	}
}

func nodeWithManagedFields(name string, labels map[string]string, manager string, managedLabels ...string) *corev1.Node {
	n := node(name, labels)

	labelFields := map[string]interface{}{}
	for _, l := range managedLabels {
		labelFields["f:"+l] = map[string]interface{}{}
	}
	raw, err := json.Marshal(map[string]interface{}{
		"f:metadata": map[string]interface{}{
			"f:labels": labelFields,
		},
	})
	if err != nil {
		panic(err)
	}

	n.ManagedFields = []metav1.ManagedFieldsEntry{
		{
			Manager:  manager,
			FieldsV1: &metav1.FieldsV1{Raw: raw},
		},
	}
	return n
}

func getNodeLabels(t *testing.T, kubeClient *kubefake.Clientset, name string) map[string]string {
	t.Helper()
	updated, err := kubeClient.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get node: %v", err)
	}
	return updated.Labels
}

func TestSyncNode_TransfersInstanceTypeAndZone(t *testing.T) {
	n := node("n1", map[string]string{
		instanceTypeSourceLabel: "m5.large",
		zoneSourceLabel:         "eu-central-1a",
	})
	c, kubeClient := newTestNodeController(t, "", n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "m5.large" {
		t.Errorf("%s = %q, want %q", instanceTypeTargetLabel, got, "m5.large")
	}
	if got := labels[zoneTargetLabel]; got != "eu-central-1a" {
		t.Errorf("%s = %q, want %q", zoneTargetLabel, got, "eu-central-1a")
	}
}

func TestSyncNode_NoOpWhenSourceLabelsAbsentAndNoPrometheus(t *testing.T) {
	n := node("n1", nil)
	c, kubeClient := newTestNodeController(t, "", n)

	kubeClient.PrependReactor("patch", "nodes", func(action clienttesting.Action) (bool, runtime.Object, error) {
		t.Errorf("unexpected patch action; no source labels and no prometheus backend, nothing should be applied")
		return false, nil, nil
	})

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if _, ok := labels[instanceTypeTargetLabel]; ok {
		t.Errorf("expected no %s label, got %q", instanceTypeTargetLabel, labels[instanceTypeTargetLabel])
	}
	if _, ok := labels[zoneTargetLabel]; ok {
		t.Errorf("expected no %s label, got %q", zoneTargetLabel, labels[zoneTargetLabel])
	}
}

func TestSyncNode_SkipsTargetLabelManagedByOtherFieldManager(t *testing.T) {
	n := nodeWithManagedFields("n1", map[string]string{
		instanceTypeSourceLabel: "m5.large",
		instanceTypeTargetLabel: "already-set-by-someone-else",
		zoneSourceLabel:         "eu-central-1a",
	}, "some-other-controller", instanceTypeTargetLabel, zoneTargetLabel)
	c, kubeClient := newTestNodeController(t, "", n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "already-set-by-someone-else" {
		t.Errorf("%s = %q, want untouched %q", instanceTypeTargetLabel, got, "already-set-by-someone-else")
	}
	if _, ok := labels[zoneTargetLabel]; ok {
		t.Errorf("expected no %s label written, got %q", zoneTargetLabel, labels[zoneTargetLabel])
	}
}

func TestSyncNode_DoesNotSkipLabelManagedByItself(t *testing.T) {
	n := nodeWithManagedFields("n1", map[string]string{
		instanceTypeSourceLabel: "m5.large",
	}, fieldManager, instanceTypeTargetLabel)
	c, kubeClient := newTestNodeController(t, "", n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "m5.large" {
		t.Errorf("%s = %q, want %q", instanceTypeTargetLabel, got, "m5.large")
	}
}

func TestSyncNode_FallsBackToPrometheusDMIInfo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("query"); got != `node_dmi_info{node="n1"}` {
			t.Errorf("unexpected query: %s", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status": "success",
			"data": {
				"resultType": "vector",
				"result": [
					{"metric": {"board_vendor": "Dell Inc.", "board_name": "0ABC123", "bios_release": "2.15"}}
				]
			}
		}`))
	}))
	defer srv.Close()

	n := node("n1", nil)
	c, kubeClient := newTestNodeController(t, srv.URL, n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "Dell-Inc.-0ABC123-2.15" {
		t.Errorf("%s = %q, want %q", instanceTypeTargetLabel, got, "Dell-Inc.-0ABC123-2.15")
	}
}

func TestSyncNode_PrometheusFallbackUsesSystemVendorForKVM(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status": "success",
			"data": {
				"resultType": "vector",
				"result": [
					{"metric": {"board_vendor": "KVM", "board_name": "-", "bios_release": "1.0", "system_vendor": "QEMU", "product_name": "Standard PC"}}
				]
			}
		}`))
	}))
	defer srv.Close()

	n := node("n1", nil)
	c, kubeClient := newTestNodeController(t, srv.URL, n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "QEMU-Standard-PC" {
		t.Errorf("%s = %q, want %q", instanceTypeTargetLabel, got, "QEMU-Standard-PC")
	}
}

func TestSyncNode_PrometheusFallbackNoOpOnEmptyResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status": "success", "data": {"resultType": "vector", "result": []}}`))
	}))
	defer srv.Close()

	n := node("n1", nil)
	c, kubeClient := newTestNodeController(t, srv.URL, n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if _, ok := labels[instanceTypeTargetLabel]; ok {
		t.Errorf("expected no %s label, got %q", instanceTypeTargetLabel, labels[instanceTypeTargetLabel])
	}
}

func TestSyncNode_PrometheusFallbackSkipsAmbiguousMultiResult(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"status": "success",
			"data": {
				"resultType": "vector",
				"result": [
					{"metric": {"board_vendor": "Dell Inc.", "board_name": "0ABC123", "bios_release": "2.15"}},
					{"metric": {"board_vendor": "Dell Inc.", "board_name": "0XYZ999", "bios_release": "1.0"}}
				]
			}
		}`))
	}))
	defer srv.Close()

	// Existing value must survive: picking either ambiguous result
	// arbitrarily is exactly the bug that made this label flap between
	// reconciles (worse, unstable backend ordering like VictoriaMetrics'
	// means the "arbitrary" choice isn't even stable across queries).
	n := nodeWithManagedFields("n1", map[string]string{
		instanceTypeTargetLabel: "existing-value",
	}, fieldManager, instanceTypeTargetLabel)
	c, kubeClient := newTestNodeController(t, srv.URL, n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "existing-value" {
		t.Errorf("%s = %q, want untouched %q (ambiguous prometheus result should not be applied)", instanceTypeTargetLabel, got, "existing-value")
	}
}

func TestApplyNodeLabels_ConflictOnOneLabelDoesNotBlockTheOther(t *testing.T) {
	n := node("n1", nil)
	c, kubeClient := newTestNodeController(t, "", n)

	kubeClient.PrependReactor("patch", "nodes", func(action clienttesting.Action) (bool, runtime.Object, error) {
		patchAction := action.(clienttesting.PatchAction)
		if patchAction.GetPatchType() != types.ApplyPatchType {
			return false, nil, nil
		}
		var patch struct {
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal(patchAction.GetPatch(), &patch); err != nil {
			t.Fatalf("unmarshal patch: %v", err)
		}
		if _, ok := patch.Metadata.Labels[zoneTargetLabel]; ok {
			return true, nil, apierrors.NewConflict(
				corev1.Resource("nodes"), "n1", fmt.Errorf("conflicting field manager"),
			)
		}
		return false, nil, nil
	})

	err := c.applyNodeLabels(context.Background(), "n1", map[string]string{
		instanceTypeTargetLabel: "m5.large",
		zoneTargetLabel:         "eu-central-1a",
	})
	if err != nil {
		t.Fatalf("applyNodeLabels: %v", err)
	}

	labels := getNodeLabels(t, kubeClient, "n1")
	if got := labels[instanceTypeTargetLabel]; got != "m5.large" {
		t.Errorf("%s = %q, want %q (a conflict on zone must not block instance-type)", instanceTypeTargetLabel, got, "m5.large")
	}
	if _, ok := labels[zoneTargetLabel]; ok {
		t.Errorf("expected no %s label written after conflict, got %q", zoneTargetLabel, labels[zoneTargetLabel])
	}
}

func TestSyncNode_NoOpWhenNodeGone(t *testing.T) {
	c, _ := newTestNodeController(t, "")

	if err := c.syncNode(context.Background(), "never-existed"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}
}

func TestInstanceTypeFromDMI(t *testing.T) {
	tests := []struct {
		name   string
		metric map[string]string
		want   string
	}{
		{
			"physical hardware",
			map[string]string{"board_vendor": "Dell Inc.", "board_name": "0ABC123", "bios_release": "2.15"},
			"Dell-Inc.-0ABC123-2.15",
		},
		{
			"KVM virtual machine",
			map[string]string{"board_vendor": "KVM", "system_vendor": "QEMU", "product_name": "Standard PC"},
			"QEMU-Standard-PC",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := instanceTypeFromDMI(tt.metric); got != tt.want {
				t.Errorf("instanceTypeFromDMI() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSanitizeLabelValue(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"already valid", "m5.large", "m5.large"},
		{"spaces become hyphens", "Dell Inc. PowerEdge", "Dell-Inc.-PowerEdge"},
		{"trims leading/trailing punctuation", "-.foo.-", "foo"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeLabelValue(tt.in); got != tt.want {
				t.Errorf("sanitizeLabelValue(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeLabelValue_TruncatesTo63Chars(t *testing.T) {
	in := strings.Repeat("a", 100)

	got := sanitizeLabelValue(in)
	if len(got) > 63 {
		t.Errorf("sanitizeLabelValue(100 a's) len = %d, want <= 63", len(got))
	}
	if got != strings.Repeat("a", 63) {
		t.Errorf("sanitizeLabelValue(100 a's) = %q, want 63 a's", got)
	}
}

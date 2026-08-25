package main

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	kubefake "k8s.io/client-go/kubernetes/fake"
	corelisters "k8s.io/client-go/listers/core/v1"
	clienttesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/cache"
)

// newTestNodeController builds a Controller whose node lister is backed by a
// plain indexer (seeded with initialNodes, no informer involved) and whose
// kubeClient is a fake seeded with initialNodes, so Node patches can be
// observed.
func newTestNodeController(t *testing.T, initialNodes ...runtime.Object) (*Controller, *kubefake.Clientset) {
	t.Helper()

	indexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	for _, obj := range initialNodes {
		if err := indexer.Add(obj); err != nil {
			t.Fatalf("seed node indexer: %v", err)
		}
	}

	kubeClient := kubefake.NewSimpleClientset(initialNodes...)

	return &Controller{
		kubeClient: kubeClient,
		nodeLister: corelisters.NewNodeLister(indexer),
	}, kubeClient
}

func node(name string, labels map[string]string, annotations map[string]string) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Labels:      labels,
			Annotations: annotations,
		},
	}
}

func TestRoleGroupForNode(t *testing.T) {
	tests := []struct {
		name   string
		labels map[string]string
		want   string
	}{
		{"no labels at all", nil, defaultRoleGroup},
		{"unrelated labels only", map[string]string{"kubernetes.io/hostname": "n1"}, defaultRoleGroup},
		{"single role", map[string]string{"node-role.kubernetes.io/worker": ""}, "worker"},
		{"control plane", map[string]string{"node-role.kubernetes.io/control-plane": ""}, "control-plane"},
		{
			"multiple roles sorted",
			map[string]string{
				"node-role.kubernetes.io/worker": "",
				"node-role.kubernetes.io/infra":  "",
			},
			"infra-worker",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := roleGroupForNode(node("n", tt.labels, nil))
			if got != tt.want {
				t.Errorf("roleGroupForNode() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSyncNode_SetsMachineSetAnnotationFromRoleLabels(t *testing.T) {
	n := node("worker-0", map[string]string{"node-role.kubernetes.io/worker": ""}, nil)
	c, kubeClient := newTestNodeController(t, n)

	if err := c.syncNode(context.Background(), "worker-0"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	updated, err := kubeClient.CoreV1().Nodes().Get(context.Background(), "worker-0", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get node: %v", err)
	}
	if got := updated.Annotations[machineSetAnnotation]; got != "worker" {
		t.Errorf("node annotation %q = %q, want %q", machineSetAnnotation, got, "worker")
	}
}

func TestSyncNode_GroupsMultipleRoleLabels(t *testing.T) {
	n := node("n1", map[string]string{
		"node-role.kubernetes.io/worker": "",
		"node-role.kubernetes.io/infra":  "",
	}, nil)
	c, kubeClient := newTestNodeController(t, n)

	if err := c.syncNode(context.Background(), "n1"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	updated, err := kubeClient.CoreV1().Nodes().Get(context.Background(), "n1", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get node: %v", err)
	}
	if got := updated.Annotations[machineSetAnnotation]; got != "infra-worker" {
		t.Errorf("node annotation %q = %q, want %q", machineSetAnnotation, got, "infra-worker")
	}
}

func TestSyncNode_DefaultsToWorkerWhenNoRoleLabels(t *testing.T) {
	n := node("plain-0", nil, nil)
	c, kubeClient := newTestNodeController(t, n)

	if err := c.syncNode(context.Background(), "plain-0"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}

	updated, err := kubeClient.CoreV1().Nodes().Get(context.Background(), "plain-0", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get node: %v", err)
	}
	if got := updated.Annotations[machineSetAnnotation]; got != defaultRoleGroup {
		t.Errorf("node annotation %q = %q, want %q", machineSetAnnotation, got, defaultRoleGroup)
	}
}

func TestSyncNode_SkipsNodeAlreadyBackedByRealMachine(t *testing.T) {
	n := node("real-0", map[string]string{"node-role.kubernetes.io/worker": ""}, map[string]string{
		machineAnnotation: "openshift-machine-api/real-0-abc123",
	})
	c, kubeClient := newTestNodeController(t, n)

	kubeClient.PrependReactor("patch", "nodes", func(action clienttesting.Action) (bool, runtime.Object, error) {
		t.Errorf("unexpected patch action on a node already backed by a real machine")
		return false, nil, nil
	})

	if err := c.syncNode(context.Background(), "real-0"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}
}

func TestSyncNode_NoOpWhenAnnotationAlreadyMatches(t *testing.T) {
	n := node("worker-0", map[string]string{"node-role.kubernetes.io/worker": ""}, map[string]string{
		machineSetAnnotation: "worker",
	})
	c, kubeClient := newTestNodeController(t, n)

	kubeClient.PrependReactor("patch", "nodes", func(action clienttesting.Action) (bool, runtime.Object, error) {
		t.Errorf("unexpected patch action; annotation already matched, no update should have been issued")
		return false, nil, nil
	})

	if err := c.syncNode(context.Background(), "worker-0"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}
}

func TestSyncNode_NoOpWhenNodeGone(t *testing.T) {
	c, _ := newTestNodeController(t)

	if err := c.syncNode(context.Background(), "never-existed"); err != nil {
		t.Fatalf("syncNode: %v", err)
	}
}

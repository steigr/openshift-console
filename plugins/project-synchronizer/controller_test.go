package main

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	corelisters "k8s.io/client-go/listers/core/v1"
	clienttesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/cache"
)

// newTestController builds a Controller whose namespace lister is backed by
// a plain indexer (seeded with initialNamespaces, no informer/API server
// involved) and whose dynamic client is a fake seeded with initialProjects.
func newTestController(t *testing.T, initialNamespaces []runtime.Object, initialProjects ...runtime.Object) (*Controller, *dynamicfake.FakeDynamicClient) {
	t.Helper()

	indexer := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	for _, obj := range initialNamespaces {
		if err := indexer.Add(obj); err != nil {
			t.Fatalf("seed namespace indexer: %v", err)
		}
	}

	scheme := runtime.NewScheme()
	dynamicClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		scheme,
		map[schema.GroupVersionResource]string{projectGVR: "ProjectList"},
		initialProjects...,
	)

	return &Controller{
		dynamicClient:   dynamicClient,
		namespaceLister: corelisters.NewNamespaceLister(indexer),
	}, dynamicClient
}

func namespace(name string, phase corev1.NamespacePhase) *corev1.Namespace {
	return &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status:     corev1.NamespaceStatus{Phase: phase},
	}
}

func getProject(t *testing.T, client *dynamicfake.FakeDynamicClient, name string) (*unstructured.Unstructured, error) {
	t.Helper()
	return client.Resource(projectGVR).Get(context.Background(), name, metav1.GetOptions{})
}

func TestSyncNamespace_CreatesProjectForNewNamespace(t *testing.T) {
	ns := namespace("team-a", corev1.NamespaceActive)
	c, dynamicClient := newTestController(t, []runtime.Object{ns})

	if err := c.syncNamespace(context.Background(), "team-a"); err != nil {
		t.Fatalf("syncNamespace: %v", err)
	}

	project, err := getProject(t, dynamicClient, "team-a")
	if err != nil {
		t.Fatalf("expected project to be created, get failed: %v", err)
	}

	phase, _, _ := unstructured.NestedString(project.Object, "status", "phase")
	if phase != "Active" {
		t.Errorf("status.phase = %q, want %q", phase, "Active")
	}
}

func TestSyncNamespace_UpdatesStatusPhaseOnExistingProject(t *testing.T) {
	ns := namespace("team-b", corev1.NamespaceTerminating)
	existingProject := newProject("team-b")
	if err := unstructured.SetNestedField(existingProject.Object, "Active", "status", "phase"); err != nil {
		t.Fatalf("seed project status: %v", err)
	}

	c, dynamicClient := newTestController(t, []runtime.Object{ns}, existingProject)

	if err := c.syncNamespace(context.Background(), "team-b"); err != nil {
		t.Fatalf("syncNamespace: %v", err)
	}

	project, err := getProject(t, dynamicClient, "team-b")
	if err != nil {
		t.Fatalf("get project: %v", err)
	}

	phase, _, _ := unstructured.NestedString(project.Object, "status", "phase")
	if phase != "Terminating" {
		t.Errorf("status.phase = %q, want %q", phase, "Terminating")
	}
}

func TestSyncNamespace_NoOpWhenPhaseAlreadyMatches(t *testing.T) {
	ns := namespace("team-c", corev1.NamespaceActive)
	existingProject := newProject("team-c")
	if err := unstructured.SetNestedField(existingProject.Object, "Active", "status", "phase"); err != nil {
		t.Fatalf("seed project status: %v", err)
	}

	c, dynamicClient := newTestController(t, []runtime.Object{ns}, existingProject)

	// The fake tracker doesn't reject or bump resourceVersion on a
	// no-op-looking update, so assert directly that no update/patch action
	// was issued at all.
	dynamicClient.PrependReactor("update", "projects", func(action clienttesting.Action) (bool, runtime.Object, error) {
		t.Errorf("unexpected %s action on projects; status.phase already matched, no update should have been issued", action.GetVerb())
		return false, nil, nil
	})
	dynamicClient.PrependReactor("patch", "projects", func(action clienttesting.Action) (bool, runtime.Object, error) {
		t.Errorf("unexpected %s action on projects; status.phase already matched, no update should have been issued", action.GetVerb())
		return false, nil, nil
	})

	if err := c.syncNamespace(context.Background(), "team-c"); err != nil {
		t.Fatalf("syncNamespace: %v", err)
	}
}

func TestSyncNamespace_DeletesProjectWhenNamespaceGone(t *testing.T) {
	existingProject := newProject("team-d")
	c, dynamicClient := newTestController(t, nil, existingProject)

	if err := c.syncNamespace(context.Background(), "team-d"); err != nil {
		t.Fatalf("syncNamespace: %v", err)
	}

	if _, err := getProject(t, dynamicClient, "team-d"); !apierrors.IsNotFound(err) {
		t.Errorf("expected project to be deleted, got err = %v", err)
	}
}

func TestSyncNamespace_DeleteIsNoopWhenProjectAlreadyGone(t *testing.T) {
	c, _ := newTestController(t, nil)

	if err := c.syncNamespace(context.Background(), "never-existed"); err != nil {
		t.Fatalf("syncNamespace: %v", err)
	}
}

package main

import (
	"context"
	"fmt"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	corelisters "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"
)

// projectGVR identifies the cluster-scoped project.openshift.io/v1 Project
// custom resource this repo ships via charts/openshift-console-crds. On a
// vanilla Kubernetes cluster there is no OpenShift project-registry
// aggregated API to back it, so this controller keeps a Project mirrored
// 1:1 with every Namespace instead.
var projectGVR = schema.GroupVersionResource{Group: "project.openshift.io", Version: "v1", Resource: "projects"}

// Controller watches Namespaces and mirrors each one onto a same-named
// Project: created when the Namespace appears, its status.phase kept in
// sync while both exist, and deleted once the Namespace is actually
// removed.
type Controller struct {
	dynamicClient dynamic.Interface

	factory          informers.SharedInformerFactory
	namespaceLister  corelisters.NamespaceLister
	namespacesSynced cache.InformerSynced

	workqueue workqueue.TypedRateLimitingInterface[string]
}

func NewController(kubeClient kubernetes.Interface, dynamicClient dynamic.Interface) *Controller {
	factory := informers.NewSharedInformerFactory(kubeClient, 10*time.Minute)
	nsInformer := factory.Core().V1().Namespaces()

	c := &Controller{
		dynamicClient:    dynamicClient,
		factory:          factory,
		namespaceLister:  nsInformer.Lister(),
		namespacesSynced: nsInformer.Informer().HasSynced,
		workqueue: workqueue.NewTypedRateLimitingQueue[string](
			workqueue.DefaultTypedControllerRateLimiter[string](),
		),
	}

	nsInformer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    c.enqueue,
		UpdateFunc: func(_, newObj interface{}) { c.enqueue(newObj) },
		DeleteFunc: c.enqueue,
	})

	return c
}

// Run starts the informer and blocks, processing Namespace events with the
// given number of worker goroutines, until ctx is cancelled.
func (c *Controller) Run(ctx context.Context, workers int) error {
	defer utilruntime.HandleCrash()
	defer c.workqueue.ShutDown()

	log.Println("starting openshift-synchronizer controller")
	c.factory.Start(ctx.Done())

	if ok := cache.WaitForCacheSync(ctx.Done(), c.namespacesSynced); !ok {
		return fmt.Errorf("failed waiting for namespace informer cache to sync")
	}

	for i := 0; i < workers; i++ {
		go wait.UntilWithContext(ctx, c.runWorker, time.Second)
	}

	log.Printf("openshift-synchronizer controller started with %d worker(s)", workers)
	<-ctx.Done()
	log.Println("shutting down openshift-synchronizer controller")
	return nil
}

func (c *Controller) enqueue(obj interface{}) {
	key, err := cache.DeletionHandlingMetaNamespaceKeyFunc(obj)
	if err != nil {
		utilruntime.HandleError(err)
		return
	}
	c.workqueue.Add(key)
}

func (c *Controller) runWorker(ctx context.Context) {
	for c.processNextWorkItem(ctx) {
	}
}

func (c *Controller) processNextWorkItem(ctx context.Context) bool {
	name, shutdown := c.workqueue.Get()
	if shutdown {
		return false
	}
	defer c.workqueue.Done(name)

	if err := c.syncNamespace(ctx, name); err != nil {
		c.workqueue.AddRateLimited(name)
		utilruntime.HandleError(fmt.Errorf("syncing namespace %q: %w", name, err))
		return true
	}

	c.workqueue.Forget(name)
	return true
}

// syncNamespace reconciles the Project for a single Namespace name. A
// missing Namespace means it was deleted, so the mirrored Project is
// deleted too; otherwise the Project is created/updated to match.
func (c *Controller) syncNamespace(ctx context.Context, name string) error {
	ns, err := c.namespaceLister.Get(name)
	if apierrors.IsNotFound(err) {
		return c.deleteProject(ctx, name)
	}
	if err != nil {
		return fmt.Errorf("get namespace %q: %w", name, err)
	}

	return c.reconcileProject(ctx, ns)
}

func (c *Controller) reconcileProject(ctx context.Context, ns *corev1.Namespace) error {
	client := c.dynamicClient.Resource(projectGVR)

	project, err := client.Get(ctx, ns.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		project, err = client.Create(ctx, newProject(ns.Name), metav1.CreateOptions{})
		if err != nil {
			if apierrors.IsAlreadyExists(err) {
				return nil
			}
			return fmt.Errorf("create project %q: %w", ns.Name, err)
		}
		log.Printf("created project %q for namespace %q", project.GetName(), ns.Name)
	} else if err != nil {
		return fmt.Errorf("get project %q: %w", ns.Name, err)
	}

	return c.syncStatus(ctx, project, ns)
}

func newProject(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "project.openshift.io/v1",
		"kind":       "Project",
		"metadata": map[string]interface{}{
			"name": name,
		},
		"spec": map[string]interface{}{},
	}}
}

// syncStatus mirrors the Namespace's phase onto the Project's status.phase,
// skipping the update when they already agree.
func (c *Controller) syncStatus(ctx context.Context, project *unstructured.Unstructured, ns *corev1.Namespace) error {
	phase := string(ns.Status.Phase)

	if current, _, _ := unstructured.NestedString(project.Object, "status", "phase"); current == phase {
		return nil
	}

	if err := unstructured.SetNestedField(project.Object, phase, "status", "phase"); err != nil {
		return fmt.Errorf("set status.phase on project %q: %w", ns.Name, err)
	}

	if _, err := c.dynamicClient.Resource(projectGVR).UpdateStatus(ctx, project, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update status of project %q: %w", ns.Name, err)
	}

	return nil
}

func (c *Controller) deleteProject(ctx context.Context, name string) error {
	err := c.dynamicClient.Resource(projectGVR).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete project %q: %w", name, err)
	}
	if err == nil {
		log.Printf("deleted project %q for removed namespace %q", name, name)
	}
	return nil
}

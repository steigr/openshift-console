package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const (
	// nodeRolePrefix marks a node label as a role, e.g.
	// node-role.kubernetes.io/worker. The suffix after the slash is the
	// role name; the label's value is conventionally empty.
	nodeRolePrefix = "node-role.kubernetes.io/"

	// defaultRoleGroup is used for nodes carrying no node-role label at
	// all, which is common for worker nodes on vanilla kubeadm clusters.
	defaultRoleGroup = "worker"

	// machineSetAnnotation mirrors the label the real machine-api-operator
	// puts on a Node's backing Machine (and syncs onto the Node itself on
	// real OpenShift). Set directly here from the Node's own role labels,
	// with no backing Machine/MachineSet object.
	machineSetAnnotation = "machine.openshift.io/cluster-api-machineset"
)

// roleGroupForNode derives a machine-set-style grouping name from a Node's
// node-role.kubernetes.io/* labels: the sorted, hyphen-joined set of role
// names, or "worker" when the Node carries no role label.
func roleGroupForNode(node *corev1.Node) string {
	var roles []string
	for label := range node.Labels {
		if role, ok := strings.CutPrefix(label, nodeRolePrefix); ok && role != "" {
			roles = append(roles, role)
		}
	}
	if len(roles) == 0 {
		return defaultRoleGroup
	}
	sort.Strings(roles)
	return strings.Join(roles, "-")
}

// syncNode reconciles the machineSetAnnotation on a single Node, derived
// from its node-role.kubernetes.io/* labels. Every Node is kept in sync,
// regardless of whether it's already backed by a real machine-api-operator,
// so the annotation always reflects the Node's current roles. A missing
// Node is a no-op (it was deleted, and there's nothing else to clean up).
func (c *Controller) syncNode(ctx context.Context, name string) error {
	node, err := c.nodeLister.Get(name)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("get node %q: %w", name, err)
	}

	roleGroup := roleGroupForNode(node)
	if node.Annotations[machineSetAnnotation] == roleGroup {
		return nil
	}

	patch := []byte(fmt.Sprintf(
		`{"metadata":{"annotations":{%q:%q}}}`,
		machineSetAnnotation, roleGroup,
	))

	if _, err := c.kubeClient.CoreV1().Nodes().Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		return fmt.Errorf("annotate node %q with machine set group: %w", name, err)
	}

	log.Printf("set %s=%q on node %q", machineSetAnnotation, roleGroup, name)
	return nil
}

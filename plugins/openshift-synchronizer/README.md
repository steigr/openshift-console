# openshift-synchronizer

Standalone controller — not a console plugin, no frontend/backend HTTP service of its own (unlike
the other components under `plugins/`). It backfills two pieces of OpenShift-specific API surface
that the console's UI depends on but that don't exist on a vanilla Kubernetes cluster:

## Project mirroring

Mirrors every `Namespace` onto a same-named `project.openshift.io/v1` `Project` custom resource:

- Namespace added → Project created (empty `spec`).
- Namespace's `status.phase` changes → mirrored onto the Project's `status.phase`.
- Namespace deleted → the mirrored Project is deleted.

`charts/openshift-console-crds` ships the `Project` CRD so the console's Project-backed views
(project switcher, project list/details pages) work even without OpenShift's aggregated
project-registry API (which only exists on real OpenShift, backed by `Namespace` + role bindings
under the hood). On a vanilla Kubernetes cluster nothing else keeps that CRD's objects in sync with
real namespaces — this controller is that sync loop.

## Machine set annotation

On real OpenShift, a Node's `machine.openshift.io/cluster-api-machineset` annotation/label is
maintained by the machine-api-operator and reflects the `MachineSet` that owns the `Machine`
backing the Node. Nothing provides that on a vanilla Kubernetes cluster.

For every `Node`, this controller sets `machine.openshift.io/cluster-api-machineset` to a group
name derived from the Node's own `node-role.kubernetes.io/*` labels: the sorted, hyphen-joined set
of role names (e.g. `control-plane`, `infra-worker`), or `worker` when the Node carries no role
label at all. No `Machine` or `MachineSet` object is created — this is an annotation only, kept in
sync as the Node's role labels change.

It uses `client-go`'s typed clientset to watch `Namespace`/`Node` (list/watch, no polling) and patch
Node annotations, and the dynamic client to CRUD `Project`, since `Project` isn't part of
`client-go`'s built-in scheme.

## Build

```bash
cd plugins/openshift-synchronizer
go build ./...
go vet ./...
go test ./...
```

## Image build

```bash
make build-openshift-synchronizer   # from the repo root
```

## Deploy

```bash
helm install openshift-synchronizer plugins/openshift-synchronizer/charts/openshift-synchronizer \
  --namespace openshift-console --create-namespace
```

Requires the `project.openshift.io` `Project` CRD (`charts/openshift-console-crds`,
`crds.Project=true`) to already be installed in the cluster.

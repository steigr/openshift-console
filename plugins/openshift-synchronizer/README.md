# openshift-synchronizer

Standalone controller — not a console plugin, no frontend/backend HTTP service of its own (unlike
the other components under `plugins/`). It mirrors every `Namespace` onto a same-named
`project.openshift.io/v1` `Project` custom resource:

- Namespace added → Project created (empty `spec`).
- Namespace's `status.phase` changes → mirrored onto the Project's `status.phase`.
- Namespace deleted → the mirrored Project is deleted.

## Why

`charts/openshift-console-crds` ships the `Project` CRD so the console's Project-backed views
(project switcher, project list/details pages) work even without OpenShift's aggregated
project-registry API (which only exists on real OpenShift, backed by `Namespace` + role bindings
under the hood). On a vanilla Kubernetes cluster nothing else keeps that CRD's objects in sync with
real namespaces — this controller is that sync loop.

It uses `client-go`'s typed clientset to watch `Namespace` (list/watch, no polling) and the dynamic
client to CRUD `Project`, since `Project` isn't part of `client-go`'s built-in scheme.

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

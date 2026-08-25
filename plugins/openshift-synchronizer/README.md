# openshift-synchronizer

Standalone controller — not a console plugin, no frontend/backend HTTP service of its own (unlike
the other components under `plugins/`). It backfills two pieces of OpenShift-specific API surface
the console's UI depends on but that don't exist (or aren't populated the same way) on a vanilla
Kubernetes cluster:

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

## Node label backfill

The console's Nodes page reads a couple of labels the OpenShift-native naming doesn't line up
with:

| Console column | Label it reads                    | OpenShift-native label            |
| --------------- | ---------------------------------- | ---------------------------------- |
| Instance type   | `beta.kubernetes.io/instance-type` | `openshift.io/instance-type`       |
| Zone            | `topology.kubernetes.io/zone`      | `topology.openshift.io/zone`       |

For every `Node`, this controller copies the OpenShift-native label's value onto its
`beta.kubernetes.io`/`topology.kubernetes.io` counterpart, whenever the value differs. A target
label already claimed by some other [field manager](https://kubernetes.io/docs/reference/using-api/server-side-apply/#field-management)
(checked via the Node's `managedFields`, not just whether the label is merely present) is left
alone entirely — this controller only ever touches fields it owns itself.

If a Node has no `openshift.io/instance-type` label and `--prometheus-url`/`$PROMETHEUS_URL` is
set, it falls back to deriving `beta.kubernetes.io/instance-type` from that Prometheus-compatible
backend's `node_dmi_info{node="<name>"}` metric (as reported by `node_exporter`'s DMI collector):

- `board_vendor` other than `KVM` → `<board_vendor>-<board_name>-<bios_release>`
- `board_vendor` of `KVM` (virtualized board info) → `<system_vendor>-<product_name>` instead

The result is sanitized into a valid label value (invalid characters replaced with `-`, truncated
to 63 characters).

It uses `client-go`'s typed clientset to watch `Namespace`/`Node` (list/watch, no polling) and
server-side-apply Node labels, and the dynamic client to CRUD `Project`, since `Project` isn't part
of `client-go`'s built-in scheme.

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
  --namespace openshift-console --create-namespace \
  --set prometheus.url=http://prometheus.openshift-monitoring.svc:9090
```

Requires the `project.openshift.io` `Project` CRD (`charts/openshift-console-crds`,
`crds.Project=true`) to already be installed in the cluster. `prometheus.url` is optional; leave it
unset to disable the instance-type Prometheus fallback.

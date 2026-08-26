# flux console plugin

Dynamic OpenShift console plugin for [FluxCD](https://fluxcd.io) — the GitOps Toolkit
(`source.toolkit.fluxcd.io`, `kustomize.toolkit.fluxcd.io`, `helm.toolkit.fluxcd.io`,
`notification.toolkit.fluxcd.io`, `image.toolkit.fluxcd.io`), the `source.extensions.fluxcd.io`
artifact-generator CRDs, and the [flux-operator](https://fluxcd.control-plane.io/operator/)
(`fluxcd.controlplane.io`) CRDs. Like `plugins/external-dns` and `plugins/cert-manager`, this is
not built by patching an upstream project — the frontend and backend source live directly in this
directory, scaffolded after
[openshift/console-plugin-template](https://github.com/openshift/console-plugin-template). List
pages watch resources directly through the console's own API proxy as the logged-in user; the
backend's only in-cluster API calls are the reconcile endpoint's (see below), which is why the
plugin's ServiceAccount gets a narrowly-scoped `get`/`patch` ClusterRole rather than none at all.

## Navigation

A single **FluxCD** nav group (gated behind a `FLUX` feature flag that only lights up once the
`Kustomization` CRD is resolvable, so the group is invisible on clusters without Flux installed),
separated into six blocks:

1. HelmRelease, HelmChart, Kustomization — the reconciled "applications"
2. GitRepository, OCIRepository, HelmRepository, Bucket — sources
3. ArtifactGenerator, ExternalArtifact — source-extensions
4. ImageRepository, ImagePolicy, ImageUpdateAutomation — image automation
5. Provider, Receiver, Alert, FluxReport — notification/reporting
6. FluxInstance, ResourceSet, ResourceSetInputProvider — flux-operator

List pages for groups 1, 2, and 5 carry kind-specific columns beyond the default Ready condition:

- **HelmRelease**: Chart, Revision, suspended state
- **HelmChart**: Chart, Version, Source, Revision
- **Kustomization**: Path, Source, Revision, suspended state
- **GitRepository** / **OCIRepository**: URL, Ref, Revision
- **HelmRepository**: URL, Type, Revision
- **Bucket**: Endpoint, Bucket, Provider, Revision
- **Provider**: Type, suspended state
- **Receiver**: Type, Webhook Path, suspended state
- **Alert**: Provider, Severity, suspended state
- **FluxReport**: Distribution version, cluster sync status

Groups 3, 4, and 6 get the Ready condition plus one or two obviously useful fields per kind, but
weren't the focus of the column pass.

## Access secret link, cross-linking

GitRepository, HelmRepository, OCIRepository and Bucket each get an **Access Secret** field on
their Details tab's right column (`console.resource/details-item`, `SecretRefItem` in
`src/components/details/FluxDetailsItems.tsx`) linking to `spec.secretRef`'s Secret when one is
set (always in the object's own namespace — verified against a live cluster's CRD schema, no
namespace field exists on `secretRef`) — "-" for a source that needs no credentials.

GitRepository and HelmChart each get a **Consumers** tab (`console.tab/horizontalNav`,
`src/components/tabs/ConsumersTab.tsx`) listing the objects that reference them, resolved by
watching the relevant kind(s) cluster-wide (not just the source's own namespace, since a
Kustomization/HelmRelease consuming a shared source is frequently not in the same namespace) and
filtering client-side:

- **GitRepository → Consumers**: every Kustomization whose `spec.sourceRef` points at it, and
  every HelmRelease whose chart template (`spec.chart.spec.sourceRef`) does. A HelmRelease's
  `chartRef` never points directly at a GitRepository (only at a HelmChart or OCIRepository), so
  it isn't checked for this one.
- **HelmChart → Consumers**: every HelmRelease whose chart is this HelmChart — either the object
  helm-controller materializes for a HelmRelease's `HelmChartTemplate` (named
  `<release-namespace>-<release-name>`, mirroring `api/reconcile.go`'s backend-side
  `resolveSource`), or one several HelmReleases share explicitly via `spec.chartRef`.

The matching logic lives in `src/utils/consumers.ts`, independent of the reconcile endpoint's
Go-side equivalent (they solve the same "what does this HelmRelease's chart come from" problem in
opposite directions - forward there, backward here - so the two aren't sharing code, just the same
understanding of the Flux API shapes).

HelmRelease gets a **Dependencies** tab (`src/components/tabs/DependenciesTab.tsx`) showing both
directions of `spec.dependsOn` (a HelmRelease can only depend on other HelmReleases - no `kind`
field on a `dependsOn` entry, verified against a live cluster's CRD schema):

- **Dependencies**: the HelmReleases this one's own `spec.dependsOn` names - helm-controller won't
  reconcile it until each is Ready. A named dependency that can't be resolved from the cluster-wide
  watch (broken reference, or just not visible under the caller's RBAC) still renders as a working
  link, just with no Ready condition to show.
- **Dependents**: every other HelmRelease (cluster-wide) whose own `spec.dependsOn` names this one.

Both cross-reference tabs share one table component, `src/components/tabs/ResourceRefTable.tsx`
(and its `useClusterWideWatch` hook), reused as-is by Consumers.

## Reconcile, suspend/resume actions

Every list row's kebab menu carries the same set of actions `flux reconcile ...` supports, for the
same fixed set of 11 kinds (`cmd/flux/reconcile_*.go` in
[fluxcd/flux2](https://github.com/fluxcd/flux2)): Bucket, GitRepository, HelmRepository,
OCIRepository, HelmChart, HelmRelease, Kustomization, ImagePolicy, ImageRepository,
ImageUpdateAutomation, Receiver. Provider/Alert/FluxReport/FluxInstance/ResourceSet/
ResourceSetInputProvider/ArtifactGenerator/ExternalArtifact have no `flux reconcile` equivalent and
get none of these actions.

- **Reconcile now** — patches `reconcile.fluxcd.io/requestedAt` to the current timestamp, exactly
  like the CLI's `requestReconciliation` (`cmd/flux/reconcile.go`). Every Flux controller watches
  for a change to that annotation and reconciles immediately regardless of its normal interval.
- **Reconcile with source** (Kustomization, HelmChart, HelmRelease only) — also resolves and
  patches the object's own source first (`spec.sourceRef` for Kustomization/HelmChart,
  `spec.chartRef` or the implied `<namespace>-<name>` HelmChart for a HelmRelease using a
  `chartSpec`), mirroring `--with-source`.
- **Force reconcile** / **Reset failures** (HelmRelease only) — set
  `reconcile.fluxcd.io/forceAt` / `reconcile.fluxcd.io/resetAt`, mirroring `--force`/`--reset`.
- **Suspend** / **Resume** — patches `spec.suspend`, shown mutually exclusively based on the
  object's current value (only "Suspend" when not suspended, only "Resume" when it is). Verified
  against a live cluster that all 11 reconcilable kinds carry `spec.suspend` in their CRD schema.
  Unlike reconcile, this goes through Console's own k8s API proxy as the logged-in user (a plain
  JSON Patch via `k8sPatch`) — no plugin backend involved.

The reconcile/force/reset actions hit a dedicated backend endpoint,
`GET /api/plugins/flux-console-plugin/api/v1/reconcile/{payload}` (`api/reconcile.go`), because
**console's bridge proxy for a dynamic plugin's own backend routes only ever forwards a bare GET
with the query string stripped** (`pkg/plugins/handlers.go` in `openshift/console` builds the
upstream request as `http.NewRequest("GET", url, nil)` from the path alone) — so the target
group/version/kind/namespace/name (plus `withSource`/`force`/`reset`) travels as a
base64url-encoded JSON path segment instead of a query string, the same convention as this
plugin's sibling cert-manager and external-dns plugins. The endpoint patches with its own
ServiceAccount (see `charts/console-flux-plugin/templates/clusterrole.yaml`), not the calling
user's token — the reconcile/force/reset kebab items are hidden from a user who lacks `patch` on
the resource via the normal `accessReview` mechanism, but that's a UI courtesy, not what actually
authorizes the patch; the backend does not otherwise check who's asking. It also doesn't wait for
the reconciliation to finish the way the CLI does (a single GET/response, not a long poll) - the
result becomes visible once each object's own live watch picks up the controller's update.

## Local frontend build

```bash
npm ci
npm run build
```

## Backend tests

```bash
go build ./...
go test ./...
```

`api/reconcile_test.go` uses `httptest.NewServer` to stand in for kube-apiserver, recording every
PATCH's path and body rather than hitting a live cluster.

## Image build

```bash
make build-flux   # from the repo root
```

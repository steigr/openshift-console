# VictoriaMetrics compatibility TODO

Findings from reviewing this repo's build of `openshift/monitoring-plugin` (release-4.22)
against a live cluster running the VictoriaMetrics operator instead of
cluster-monitoring-operator (CMO)/Prometheus Operator. Investigated via
`kubie exec home.alaunstras.se monitoring` for live cluster/PromQL checks and
`gh api`/`gh search code` against `openshift/monitoring-plugin` and `openshift/console`
for source verification.

Cluster-side fixes (missing recording rules, node-exporter nodeSelector, instance-label
relabeling) are tracked separately and intentionally excluded from this document — this
file is scoped to work that lands in **this repo** (Go backend + frontend patches), plus
one item that isn't fixable from this repo at all.

---

## 1. Notification bell ("Notifications Alerts could not be loaded") — NOT fixable from this repo

**Symptom:** the bell-icon notification drawer shows `TypeError: can't access property
"forEach", e.alerts is undefined`.

**Root cause:** this is the *same class* of bug we already patched in the plugin
(`getAlertsAndRules` calling `rule.alerts.forEach()` without a null-check, because
vmalert omits `alerts` entirely for non-firing rules while Prometheus always includes
`alerts: []`) — but it lives in a **separate, independent copy** of `getAlertsAndRules()`
inside **`openshift/console` core**, not in `openshift/monitoring-plugin`:

- `frontend/public/components/monitoring/utils.ts:56` (openshift/console repo)
- consumed by `frontend/packages/console-app/src/hooks/useNotificationPoller.ts` and
  `useNamespacedNotificationAlertsPoller.ts`, which drive the bell/notification drawer.

Our patch to `web/src/components/utils.ts` in `openshift/monitoring-plugin` has no effect
here because console core never calls into the plugin's copy of this function for the
notification drawer — it has its own.

**Why we can't just patch it here:** this repo only builds the `monitoring-plugin`
frontend/backend image; it does not build or patch the OpenShift `console` binary/image.

**Options to evaluate (none implemented yet):**
1. Check whether this is already fixed in a newer OCP console point release, or file an
   OCPBUGS upstream against `openshift/console` (same one-line fix:
   `(rule.alerts ?? []).forEach(...)`).
2. Investigate whether the notification poller's `/api/v1/rules` request actually transits
   through anything we control (it likely goes through console-core's own proxy straight to
   the configured Prometheus/Thanos/vmalert datasource, bypassing our plugin's Go backend
   entirely — needs confirming via network trace before assuming a proxy-side normalization
   fix is even possible). If it *is* interceptable, our Go backend could reverse-proxy and
   inject `alerts: []` into vmalert's `/api/v1/rules` response before console ever parses it.

**Action:** treat as tracked-but-blocked. Confirm request path before promising a fix.

---

## 2. "Source: Platform" filter is hardcoded — fixable here

**Symptom:** the Alerting/Targets "Source" filter always classifies everything as `User`,
never `Platform`.

**Root cause:** `targetSource()` / the analogous `alertingRuleSource()` hardcode:

```ts
// web/src/components/utils.ts
export const targetSource = (target: Target): AlertSource =>
  target.labels?.prometheus === 'openshift-monitoring/k8s'
    ? AlertSource.Platform
    : AlertSource.User;
```

Live VictoriaMetrics data carries `prometheus: "monitoring/victoria-metrics"` on every
series (confirmed via live `/api/v1/query`), which never matches the hardcoded
`'openshift-monitoring/k8s'` string, so nothing is ever classified as `Platform`.

**Fix plan:**
- Add a Go backend flag/env var, e.g. `--platform-prometheus-label` (default
  `openshift-monitoring/k8s` to preserve behavior on real CMO deployments), exposed via a
  small JSON config endpoint from this repo's `api` package (see item 6 below).
- Frontend patch (`patches/frontend/`) to `targetSource`/`alertingRuleSource` (and any other
  call sites matching `=== 'openshift-monitoring/k8s'`) to read this value instead of the
  hardcoded string, falling back to the current hardcoded default if the config fetch fails.

**Call sites to update (from `openshift-monitoring/k8s` grep):**
- `web/src/components/utils.ts` (`targetSource`)
- `web/src/components/alerting/AlertUtils.tsx` (`alertingRuleSource`, ~lines 66-78)
- test fixtures in `filter-rules.spec.ts` / `filter-alerts.spec.ts` assume the same hardcoded
  string — update or parameterize if we touch this logic.

---

## 3. Plugin has no concept of VictoriaMetrics CRDs — fixable here

**Symptom:** tenancy-scoping behavior (whether the namespace selector is shown, whether
tenancy-scoped API paths are used) is wrong/inconsistent under VictoriaMetrics.

**Root cause:** `MonitoringContext.tsx`'s `MonitoringProvider` runs a
`SelfSubjectAccessReview`-backed `useAccessReview` hardcoded against Prometheus-Operator
CRDs:

```ts
// web/src/contexts/MonitoringContext.tsx
useAccessReview({ group: 'monitoring.coreos.com', resource: 'prometheusrules', verb: 'get', namespace: '*' });
useAccessReview({ group: 'monitoring.coreos.com', resource: 'prometheuses/api', verb: 'get', name: 'k8s', namespace: '*' });
```

This cluster has no `monitoring.coreos.com` CRDs installed at all — it uses
`operator.victoriametrics.com` (`VMRule`, `VMAlert`, `VMAlertmanager`, etc., confirmed via
`kubectl api-resources`). Since nobody has RBAC policy referencing a nonexistent
group/resource, these access reviews always evaluate to `false`, which forces
`useAlertsTenancy`/`useMetricsTenancy` to always be `true` when `prometheus === 'cmo'` —
regardless of the user's actual permissions.

**Fix plan:**
- Extend the same runtime-config mechanism from item 2/6 to carry an overridable
  `{ group, resource }` pair for each of the two access reviews (default to the current
  `monitoring.coreos.com` values so real CMO deployments are unaffected).
- Frontend patch to `MonitoringContext.tsx` to source the group/resource from config instead
  of the literals.
- For this cluster specifically, the override would point at something like
  `operator.victoriametrics.com` / `vmrules` and `vmalerts` — needs confirming which
  VictoriaMetrics CRD/verb combination is the right analog for "cluster-wide read access"
  before wiring up the actual override value.

---

## 4. Pod CPU/Filesystem/Network empty (Memory works) — partially fixable here

**Root cause is cluster-side** (missing recording rules — tracked separately, not detailed
here), but there's a repo-relevant angle worth tracking: the plugin/console assume specific
CMO-only recording rule names (`pod:container_cpu_usage:sum`,
`pod_interface_network:container_network_receive_bytes:irate5m`,
`...transmit_bytes_total:irate5m`) exist. Once the cluster-side recording rules exist, no
plugin-side change should be needed — this was verified by the fact that
`pod:container_fs_usage_bytes:sum` (Filesystem) already exists in this cluster's VMRule set
and the Filesystem panel logic works the same way as CPU/Network once the rule is present.

**Action for this repo:** none required, pending cluster-side rule additions. Revisit only
if, after the recording rules are added, the panels are still empty — that would indicate an
actual plugin-side query bug worth patching here.

---

## 5. Pod count on Nodes empty — not fixable here

**Root cause is entirely cluster-side** (an `instance` label-format mismatch between what
console-core's hardcoded PromQL regex expects — `ip:port` — and what this cluster's
VMNodeScrape relabeling produces — bare hostname). No plugin source change is applicable;
tracked separately as a cluster config item.

---

## 6. server-m7yv9.netztronaut.de has no metrics — not fixable here

**Root cause is entirely cluster-side** (`node-exporter` DaemonSet `nodeSelector` restricts
it to the control-plane node only). No plugin source change is applicable; tracked
separately as a cluster config item.

---

## Repo-side implementation summary

Only items **2**, **3**, and the investigation half of **1** involve changes in this repo.
Suggested implementation order:

1. **Go backend** (`main.go` + `api/` package): add CLI flags/env vars and a small JSON
   config endpoint (e.g. `GET /config.json` or similar, served alongside the existing static
   plugin assets) exposing:
   - `platformPrometheusLabel` (default `openshift-monitoring/k8s`) — item 2
   - RBAC group/resource overrides for the two `MonitoringContext` access reviews — item 3
2. **Frontend patches** (`patches/frontend/`, following the same pattern as
   `0001-default-missing-rule-alerts-to-empty-array.patch`):
   - patch `targetSource`/`alertingRuleSource` to consult the config instead of the
     hardcoded `'openshift-monitoring/k8s'` string (item 2)
   - patch `MonitoringContext.tsx` to consult the config instead of the hardcoded
     `monitoring.coreos.com` group/resource literals (item 3)
   - both patches should fall back to today's hardcoded values if the config fetch fails, to
     avoid regressing real CMO/OCP deployments that don't run our custom backend flags
3. **Notification bell (item 1):** confirm whether the notification poller's `/api/v1/rules`
   request path is interceptable by our plugin backend at all before deciding between
   "wait for upstream OCP fix" vs. "add a reverse-proxy normalization layer."

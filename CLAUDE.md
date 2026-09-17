# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is a **build/patch aggregator**, not the console source itself. It clones three upstream
OpenShift repos, applies a curated stack of `git apply` patches, and produces three container
images:

- `openshift/console` (upstream, via `patches/`) → `containers/openshift-console/Dockerfile`
- `openshift/monitoring-plugin` (upstream, via `plugins/monitoring/patches/`) → `plugins/monitoring/Dockerfile`
- `openshift/networking-console-plugin` (upstream, via `plugins/networking/patches/`) → `plugins/networking/Dockerfile`

`console/`, `plugins/*/upstream/`, and `plugins/*/dist/` are all gitignored — they are cloned or
built on demand by `make` and must never be assumed to exist or be edited directly as permanent
repo content. `console/` in particular has its **own** `CLAUDE.md` and `.git` once cloned; that
guidance applies only while working inside a checked-out `console/` tree, not to this root repo.

## Commands

All orchestration is via the root `Makefile` + `config.mk` (override values via `config.local.mk`,
gitignored, or `VAR=value` on the command line).

```bash
# Full pipeline per component: clone → patch → build → containerize → push
make build              # build-console + build-monitoring + build-networking
make build-console      # clone (git init + fetch --depth=1 + checkout), apply patches/*.patch, run console/build.sh via mise
make build-monitoring   # docker build (clone+patch happens inside the Dockerfile's builder stage)
make build-networking   # same, for networking plugin
make container-console  # docker build the console image (copies containers/openshift-console/Dockerfile in)
make push / push-console / push-monitoring / push-networking
make clean / clean-console / clean-monitoring / clean-networking   # rm -rf the cloned/upstream dirs
make print-images       # print the three resolved image:tag references
```

Monitoring/networking plugin *frontend* patches can be applied standalone (outside Docker) for
local inspection:

```bash
make frontend-source-monitoring    # clone upstream monitoring-plugin into plugins/monitoring/upstream/, apply patches/frontend/*.patch
make frontend-source-networking    # same for networking-console-plugin
```

Key `config.mk` variables: `CONSOLE_REPO_URL`/`CONSOLE_BRANCH`, `MONITORING_PLUGIN_REPO_URL`/`_REF`,
`NETWORKING_PLUGIN_REPO_URL`/`_REF`, the three `*_IMAGE` names, `ARCH`/`PLATFORM`. `TAG` defaults to
`latest` on `main`, otherwise `git-<short-sha>`.

Plugin Go backends (`plugins/monitoring/api`, `plugins/networking/api`) are ordinary Go modules —
`cd plugins/<name> && go build ./... && go test ./...` works directly without Docker.

## Patch-stack architecture

The core pattern repeated across all three components: **numbered, ordered patches applied with
`git apply` against a fresh shallow clone of a pinned upstream branch/ref**. Patches are named
`NNNN-description.patch`, applied in sort order, and must apply cleanly (`git apply --check`) —
there is no fuzzy/interactive patching step. When a patch stops applying after bumping an upstream
ref, it must be regenerated against the new base, not force-applied.

- `patches/` — patches against `openshift/console` itself (internal endpoints, user
  impersonation/roles, node-terminal-via-configmap, namespace filtering, nav visibility policy,
  Alertmanager base host, OIDC refresh-token/CLI-flag/debug-log fixes, pod-terminal-tab and
  node-terminal-tab flag-gates, configurable nodes-list-view label grouping, websocket origin
  checks, opt-in plugin impersonation). If a patch stops applying
  after a `CONSOLE_BRANCH` bump, regenerate it against the new base (see "Working with patches"
  below) — the same Makefile-based workflow applies regardless of how far the base has moved.
- `patches.pending/` — patches drafted but not yet promoted into `patches/`. Currently empty.

  Two patches exist to support the `terminal` plugin (`plugins/terminal`, renamed from
  `vncviewer` — it now also provides an alternate Node Terminal tab and bundles the privileged
  `node-terminal` break-glass shim at `plugins/terminal/node-terminal`) rather than changing core
  behaviour outright. Both are the same shape: a `useFlag(TERMINAL_PLUGIN_*_ENABLED)` check in
  core's own `pages`/`pagesFor` array that hides core's built-in Terminal tab entirely once the
  matching flag is set, paired with the plugin registering its own `console.tab/horizontalNav`
  extension gated on that same flag — so exactly one of the two tabs is ever shown, and console
  stays entirely unaware of what the plugin's tab actually does (VNC, plain `exec`, xterm.js
  version, fonts, search, sixel — all internal to the plugin, not an extension contract):
  - `0019-pod-terminal-flag-gate.patch` gates `frontend/public/components/pod.tsx`'s
    `navFactory.terminal(PodConnectLoader)` entry on `TERMINAL_PLUGIN_POD_TERMINAL_ENABLED`.
  - `0020-node-terminal-flag-gate.patch` gates `NodeDetailsPage.tsx`'s equivalent entry on
    `TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED`.

  An earlier design (`0019-pod-connect-transport-extension.patch`, now retired) instead had core's
  own Pod Terminal tab stay in place and merely accept a pluggable *transport* extension
  (`stei.gr/pod-connect-transport`) for its VNC entries, leaving plain per-container entries on
  core's own `exec` logic and `terminal.tsx` component — which meant xterm.js version, search,
  sixel, and font were all out of the plugin's reach for those entries. Superseded once the ask
  became "every terminal view this plugin is responsible for", which requires owning the whole tab
  the same way the Node tab already does.
  - `0020-node-terminal-flag-gate.patch` lets `NodeDetailsPage.tsx` hide its own built-in Node
    Terminal tab when the plugin sets the `TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED` flag (via a
    `console.flag` extension, itself driven by an env var on the plugin's own backend) — needed
    because a plugin's `console.tab/horizontalNav` extension can only *add* a tab, never replace
    one, unlike the pod-connect extension point above. `plugins/terminal` similarly gates its Pod
    transport extension on `TERMINAL_PLUGIN_POD_TERMINAL_ENABLED`, so both tabs are independently
    switchable between "provided by the plugin" and "provided by core".

  `0021-node-list-label-grouping.patch` adds a `--node-grouping-label` bridge flag (env
  `BRIDGE_NODE_GROUPING_LABEL`, wired via `charts/openshift-console`'s `config.nodeGroupingLabel`
  value), plumbed through to the frontend as `window.SERVER_FLAGS.nodeGroupingLabel`. When set, the
  nodes list view (`/k8s/cluster/nodes`) groups nodes into collapsible accordion sections keyed by
  that label's value (nodes missing the label land in a trailing "no value" section); when unset,
  the list renders exactly as upstream, unchanged. When monitoring (Prometheus) is available, each
  group's accordion header also shows aggregated per-group metrics (pod count, CPU cores used/
  available, memory used/available), summed from the same per-node metrics the flat list's own
  Pods/CPU/Memory columns already poll — no separate query, just aggregated client-side per group.

  `0004`'s `--user-auth-service-account-token` swaps console's service account token in only on
  `/api/kubernetes/` and `/api/graphql`, never at authentication, so `User.Token` stays the user's
  own token for every other endpoint (plugin assets, `--plugin-proxy`, monitoring, Helm). On those
  two endpoints impersonation is derived from the session and any client-supplied impersonation is
  refused, since the service account can impersonate anyone. `0022-websocket-origin-checks.patch`
  requires websocket upgrades to come from `--base-address`: the CSRF middleware now checks them
  before its GET early return (upstream never reached that check, leaving `/api/graphql`
  websockets open), and `pkg/proxy` checks the origin before dialing the backend, reading `Origin`
  before plugin proxies' `HeaderBlacklist` strips it.

  `0023-plugin-impersonation.patch` adds `--plugin-impersonation` (env `BRIDGE_PLUGIN_IMPERSONATION`,
  chart `auth.pluginImpersonation`) to opt the plugin endpoints back into that same
  service-account-token auth: `/api/plugins/` requests and the `--plugin-proxy` routes that ask to
  be authorized then carry console's service account token plus session-derived
  `Impersonate-User`/`-Group`, so a plugin backend can act as the logged-in user on a cluster whose
  apiserver doesn't accept the user's own OIDC token. Client-supplied impersonation is refused
  there as well, it is off by default, and it does nothing without
  `--user-auth-service-account-token`.
- `plugins/<name>/patches/frontend/` — patches against the plugin's upstream JS/TS source, applied
  in the Docker builder stage before `npm ci && npm run build`.
- `plugins/<name>/patches/backend/` — patches applied against **this repo's own**
  `plugins/<name>/api` Go package (not upstream) in the Docker builder stage, via
  `git apply --no-index` (no `.git` needed there).

## Plugin backend extension pattern

Both `plugins/monitoring/main.go` and `plugins/networking/main.go` follow the same shape: build a
shared `http.ServeMux`, call `api.RegisterHandlers(mux)`, then serve the plugin's static frontend
assets (built from upstream) plus any registered API routes from that mux.

`plugins/*/api/api.go` defines the registration mechanism:

```go
func Register(registrar HandlerRegistrar)   // called from a backend patch's init()
func RegisterHandlers(mux *http.ServeMux)   // called once from main.go
```

New backend behavior is added as a **new `.go` file dropped into `api/` via a backend patch**,
registering its routes in an `init()` that calls `api.Register(...)`. `plugins/monitoring/api/config.go`
is a live example: it serves `/config.json` (proxied by console at
`/api/plugins/monitoring-plugin/config.json`) so the monitoring-plugin frontend can detect a
non-CMO Prometheus-compatible backend (e.g. VictoriaMetrics) via env-configurable
`PLATFORM_PROMETHEUS_LABEL` / `PLATFORM_*_ACCESS_REVIEW_*` instead of hardcoded CMO labels/RBAC —
see [plugins/monitoring/VICTORIA-METRICS-TODO.md](plugins/monitoring/VICTORIA-METRICS-TODO.md) for
the full set of VictoriaMetrics-compatibility findings and which are/aren't fixable from this repo
(some bugs live in `openshift/console` core itself, outside what this repo builds).

## Plugin APIs: proxy path and credentials

A plugin's REST API is served over console's **plugin proxy**, not its asset route. Console proxies
`/api/proxy/plugin/<ConsolePlugin name>/api/<rest>` to the plugin Service, strips that prefix (so
the backend sees `/<rest>`, i.e. routes are registered as `/v1/...`) and passes the method, query
string and body through. That is what makes ordinary REST possible; the asset route
(`/api/plugins/<name>/...`) only ever issues a bare GET and drops the query string, which is why
these APIs used to smuggle arguments as base64url-JSON path segments and custom headers. Only
things that genuinely are static assets stay on the asset route: the frontend bundle, i18n, and the
`/config.json` files the monitoring and terminal plugins read before any flag is set.

Each proxied plugin needs an entry in the console chart's `plugins[].proxy` (rendered into
`--plugin-proxy`/`BRIDGE_PLUGIN_PROXY`) — without it the plugin's API 404s. The plugin's own chart
declares the same thing in its `ConsolePlugin` `spec.proxy` for clusters where console-operator
reads the CR instead.

Backends authenticate with the credentials console forwards on those routes (`Authorization`, plus
`Impersonate-User`/`-Group` when console itself authenticates as its service account — see
`--plugin-impersonation`), so every API server call a plugin makes is subject to the logged-in
user's own RBAC and the plugin's ServiceAccount holds no roles. `USE_SERVICE_ACCOUNT_TOKEN=true`
(chart `useServiceAccountToken`) switches a plugin back to its own mounted token and re-renders its
RBAC. Two invariants: a request with no forwarded `Authorization` is a 401, never a silent fallback
to the plugin's own token; and the plugin's own token is never sent together with caller-supplied
`Impersonate-*` headers (the API server authorizes impersonation against the token's owner, so
forwarding both of *those* grants nothing extra, while pairing them would).

`plugins/node-logging` is the one exception, because finding the node-logs DaemonSet pod needs
permissions a user typically lacks: it keeps its own Role for that lookup and instead authorizes
the caller with a `SelfSubjectAccessReview` (`get nodes/proxy`, what console core's own Node Logs
tab requires) built from the forwarded credentials.

## Console base path

bridge can be served under a sub-path: `--base-path` (chart `config.basePath`). `--base-address`
is scheme://host only, and bridge drops any path given there. Every bridge route, `/health` and
`/api/...` included, then lives under that prefix, so plugin frontends must never hardcode
root-relative console URLs:
- this repo's own plugins use a small `consolePath()` helper (`SERVER_FLAGS.basePath`);
- the monitoring and kubevirt frontend patches prefix `window.SERVER_FLAGS.basePath` the same way;
- networking uses relative `api/...` URLs, which resolve under console's `<base href>`.

The SDK's k8s helpers (`useK8sWatchResource`, `k8sGetResource`, ...) already handle the prefix;
hand-built WebSocket URLs don't.

## Working with patches

1. Never hand-edit files inside a cloned `console/`, `plugins/*/upstream/`, or Docker build
   context expecting it to persist — those are ephemeral. Instead, edit or add a `.patch` file.
2. To modify existing behavior, edit the relevant `.patch` file directly (patches here are hand-
   maintained unified diffs, not auto-generated from a fork branch) — or regenerate one by cloning
   upstream, applying the existing patch stack, making the change, and running
   `git diff > patches/000N-name.patch`.
3. Patch order matters — later patches may depend on files/hunks introduced by earlier ones in the
   same directory. Keep numbering dense and sequential.
4. After touching any patch, verify it still applies cleanly against the pinned ref before
   committing (`make build-console` / `make frontend-source-monitoring` / `make frontend-source-networking`,
   or `git apply --check` inside a manual clone).

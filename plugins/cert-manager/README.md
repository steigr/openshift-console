# cert-manager console plugin

Dynamic OpenShift console plugin for [cert-manager](https://cert-manager.io) (`cert-manager.io`,
`acme.cert-manager.io`) and [trust-manager](https://cert-manager.io/docs/trust/trust-manager/)
(`trust.cert-manager.io`) CRDs. Like `plugins/external-secrets` and `plugins/external-dns`, this
is not built by patching an upstream project — the frontend and backend source live directly in
this directory, scaffolded after
[openshift/console-plugin-template](https://github.com/openshift/console-plugin-template).

## Navigation

Two nav groups:

- **Cert Manager**: Certificate, CertificateRequest — separator — Issuer, ClusterIssuer —
  separator — Order, Challenge
- **Trust Manager**: Bundle

List pages show the `Ready`/`Synced` condition alongside kind-specific columns (secret name and
issuer for Certificate, provider type for Issuer/ClusterIssuer, ACME state/reason for
Order/Challenge, target details for Bundle).

## Certificate enrichment

The plugin also adds a **Certificate** tab (`console.tab/horizontalNav`) to the details page of
resources it does not own — Ingress, Service (type LoadBalancer), Gateway API HTTPRoute/TLSRoute,
and external-dns' DNSEndpoint (gated behind a `console.flag/model` on the DNSEndpoint CRD so the
tab silently doesn't register when external-dns/its CRD isn't installed). The tab derives the
hostname(s) served by that resource and shows what TLS certificate is *actually* being presented
right now: issuer, root CA, remaining validity, and key type/size — independent of what any
Certificate object claims, which is the point (it catches drift between the desired and served
state).

This is powered by a small Go backend, modeled on `plugins/external-dns/api/lookup.go`'s shape: it
performs a real TLS handshake against each derived hostname (`crypto/tls`), reads the presented
certificate chain, and returns issuer/subject DNs, the last-in-chain (root) subject, `NotAfter`,
and key algorithm+size/curve as JSON. `InsecureSkipVerify` is used only so the raw chain can be
*fetched* even from a server whose CA the plugin's pod doesn't trust (private/self-signed CAs are
the norm for cert-manager) — validity/expiry are still computed from the certificate's own
`NotBefore`/`NotAfter` fields and reported accurately regardless.

## Backend API

The backend serves its static frontend assets at `/` and a REST API under `/v1`. The API is
reached through console's plugin proxy route, which forwards
`/api/proxy/plugin/cert-manager-console-plugin/api/<rest>` to this plugin's Service as `/<rest>`
— passing the request's method, query string and body through untouched, unlike the GET-only
plugin-asset route (`/api/plugins/<name>/...`) that drops the query string. It needs an entry in
the console chart's `plugins[].proxy` (and/or `spec.proxy` on the ConsolePlugin CR) to be reachable
at all.

| Method | Path | Parameters |
| --- | --- | --- |
| `GET` | `/v1/certinspect` | `host` (required), `protocol` (default `tcp`), `port` (default `443`) |
| `GET` | `/v1/inspect/ns/{namespace}/{gvk}/{name}` | `{gvk}` is `group~version~kind` (group empty for the core API group, e.g. `~v1~Service`); `{namespace}` is `-` for a cluster-scoped kind |

With `authorization: UserToken` on that proxy route, console forwards the logged-in user's own
credentials (plus `Impersonate-*` headers when console itself authenticates as its service
account). Every Kubernetes API read the backend makes carries them, so it is authorized as that
user and the plugin's own ServiceAccount needs no RBAC — see `USE_SERVICE_ACCOUNT_TOKEN` below.
A request that arrives without credentials is answered `401`.

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `CERT_MANAGER_ENABLE_IPV4` | `true` | Probe hostnames over IPv4 (`tcp4`). |
| `CERT_MANAGER_ENABLE_IPV6` | `true` | Probe hostnames over IPv6 (`tcp6`). |
| `USE_SERVICE_ACCOUNT_TOKEN` | `false` | Read the Kubernetes API with the pod's own mounted ServiceAccount token instead of the credentials console forwarded. Chart value `useServiceAccountToken`, which also renders the ClusterRole/Binding the backend then needs. Forwarded `Impersonate-*` headers are ignored in this mode, never combined with this plugin's token. |

Every certificate check (`certinspect`/`inspect`) probes a hostname over both address families
independently and reports `ipv4Connected`/`ipv6Connected` plus a per-family breakdown when the two
disagree. Setting either flag to `false` disables that family entirely — it's never dialed, and
the result looks exactly like a plain single-family check (no `familiesDiffer`, no per-family
breakdown) rather than reporting the disabled family as a connection failure. Accepts any
`strconv.ParseBool` form (`1`/`t`/`true`/`0`/`f`/`false`, case-insensitive); unset, empty, or
unparseable values fall back to the default.

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

`api/certcheck_test.go` uses `httptest.NewTLSServer` (a real local TLS listener with a
self-signed cert) rather than any live network call.

## Image build

```bash
make build-cert-manager   # from the repo root
```

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

This is powered by a small Go backend endpoint, `GET/POST /api/v1/certcheck`, modeled on
`plugins/external-dns/api/lookup.go`'s shape: given a batch of `{hostname, port}` targets, it
performs a real TLS handshake against each (`crypto/tls`), reads the presented certificate chain,
and returns issuer/subject DNs, the last-in-chain (root) subject, `NotAfter`, and key
algorithm+size/curve as JSON. `InsecureSkipVerify` is used only so the raw chain can be *fetched*
even from a server whose CA the plugin's pod doesn't trust (private/self-signed CAs are the norm
for cert-manager) — validity/expiry are still computed from the certificate's own
`NotBefore`/`NotAfter` fields and reported accurately regardless.

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

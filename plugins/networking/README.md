# console-networking-plugin

## Patch layout

- `patches/frontend`: patches applied in the frontend stage against `openshift/networking-console-plugin`
- `patches/backend`: patches applied in the backend (Go builder) stage against this project sources

## Gateway API and Traefik details pages

`patches/frontend/0010-add-gateway-api-and-traefik-details-pages.patch` replaces Console's generic
CRD details page for the Gateway API and Traefik routing kinds with pages that resolve the
references those objects make, the way the Ingress details page resolves its backend Services:

- routes (`HTTPRoute`, `GRPCRoute`, `TLSRoute`, `TCPRoute`, `UDPRoute`) get a **Parent references**
  table (each `spec.parentRefs` entry joined with its `status.parents[]` conditions, so a row shows
  whether that Gateway accepted the route) and a **Backend references** table
  (`spec.rules[].backendRefs`, with the rule's matches, port, weight and filters — an `ExtensionRef`
  filter is what Traefik uses to attach a `Middleware`, so those are linked too);
- `Gateway` gets a **Listeners** table (certificates, allowed routes, per-listener conditions and
  attached-route counts) plus an **Attached routes** table, the reverse of `parentRefs`, found by
  watching every route kind;
- `GatewayClass` gets its controller, parameters reference, supported features and the Gateways it
  owns; `ReferenceGrant` gets its from/to lists; `BackendTLSPolicy` gets its target references, CA
  certificate references and per-ancestor status;
- Traefik's `IngressRoute`, `IngressRouteTCP`, `IngressRouteUDP` and `TraefikService` get the same
  treatment for `spec.routes[].services`, `middlewares`, TLS secret/options/store and the
  weighted/mirrored backends of a `TraefikService`. The patch also adds nav entries for those four
  kinds, which previously had none.

The shared machinery lives in `src/utils/components/ResourceDetails/`. A page is registered per
served api version (`console.page/resource/details` matches `group~version~kind` exactly) but
resolves the *preferred* version at render time from the models Console discovered, so a CRD that
graduates from `v1alpha2` to `v1` keeps working. Tabs other plugins contribute through
`console.tab/horizontalNav` — cert-manager's **Certificate** tab, external-dns's **DNS Settings**
tab — are merged in by the SDK's `HorizontalNav`, so replacing the page does not drop them.

## Backend patch hooks

This project now includes a placeholder backend package at `api/`.

Patch files can add HTTP handlers by dropping a `.go` file into the `api` package and registering routes in `init()`.

Example:

```go
package api

import "net/http"

func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("/api/example", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	})
}
```

`main.go` creates a shared `http.ServeMux`, calls `api.RegisterHandlers(mux)`, and then serves static assets and any registered API routes from that mux.


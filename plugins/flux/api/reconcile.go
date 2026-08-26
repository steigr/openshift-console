package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// reconcileGVR is enough to build a REST path for a Flux kind.
type reconcileGVR struct {
	group   string
	version string
	plural  string
}

// reconcilableKinds mirrors the fixed set of `flux reconcile <...>`
// subcommands in fluxcd/flux2's cmd/flux/reconcile_*.go: every one of them
// (Bucket, GitRepository, HelmRepository, OCIRepository as `source
// bucket/git/helm/oci`, HelmChart as `source chart`, HelmRelease,
// Kustomization, ImagePolicy/ImageRepository/ImageUpdateAutomation as
// `image policy/repository/update`, and Receiver) works the same way under
// the hood: patch the object's `reconcile.fluxcd.io/requestedAt` annotation
// to a new timestamp (cmd/flux/reconcile.go's requestReconciliation), which
// every Flux controller's watch loop treats as "handle now regardless of
// the reconcile interval". Provider/Alert/FluxReport/FluxInstance/
// ResourceSet/ResourceSetInputProvider/ArtifactGenerator/ExternalArtifact
// have no `flux reconcile` subcommand and are deliberately absent here.
var reconcilableKinds = map[string]reconcileGVR{
	"Bucket":                {group: "source.toolkit.fluxcd.io", version: "v1", plural: "buckets"},
	"GitRepository":         {group: "source.toolkit.fluxcd.io", version: "v1", plural: "gitrepositories"},
	"HelmRepository":        {group: "source.toolkit.fluxcd.io", version: "v1", plural: "helmrepositories"},
	"OCIRepository":         {group: "source.toolkit.fluxcd.io", version: "v1", plural: "ocirepositories"},
	"HelmChart":             {group: "source.toolkit.fluxcd.io", version: "v1", plural: "helmcharts"},
	"HelmRelease":           {group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases"},
	"Kustomization":         {group: "kustomize.toolkit.fluxcd.io", version: "v1", plural: "kustomizations"},
	"ImagePolicy":           {group: "image.toolkit.fluxcd.io", version: "v1", plural: "imagepolicies"},
	"ImageRepository":       {group: "image.toolkit.fluxcd.io", version: "v1", plural: "imagerepositories"},
	"ImageUpdateAutomation": {group: "image.toolkit.fluxcd.io", version: "v1", plural: "imageupdateautomations"},
	"Receiver":              {group: "notification.toolkit.fluxcd.io", version: "v1", plural: "receivers"},
}

const reconcileRequestAnnotation = "reconcile.fluxcd.io/requestedAt"

// HelmRelease-only annotations, mirroring helm-controller/api/v2/annotations.go's
// ForceRequestAnnotation ("reconcile.fluxcd.io/forceAt", set by `flux
// reconcile helmrelease --force`) and ResetRequestAnnotation
// ("reconcile.fluxcd.io/resetAt", set by `--reset`).
const (
	helmReleaseForceRequestAnnotation = "reconcile.fluxcd.io/forceAt"
	helmReleaseResetRequestAnnotation = "reconcile.fluxcd.io/resetAt"
)

// reconcileTarget is the JSON shape base64url-encoded into the reconcile
// route's {payload} segment - see this route's registration comment below
// for why (console's bridge proxy for plugin backends only ever issues a
// bare GET with the query string dropped).
type reconcileTarget struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	// WithSource additionally reconciles the object's own source first
	// (resolved from its spec, see resolveSource), mirroring `flux
	// reconcile ... --with-source`. Only meaningful for Kustomization,
	// HelmRelease and HelmChart - ignored for every other kind.
	WithSource bool `json:"withSource,omitempty"`
	// Force/Reset mirror `flux reconcile helmrelease --force`/`--reset`.
	// Only meaningful when Kind is HelmRelease.
	Force bool `json:"force,omitempty"`
	Reset bool `json:"reset,omitempty"`
}

type reconcileResponse struct {
	RequestedAt       string `json:"requestedAt"`
	SourceRequestedAt string `json:"sourceRequestedAt,omitempty"`
	SourceKind        string `json:"sourceKind,omitempty"`
	SourceName        string `json:"sourceName,omitempty"`
}

func init() {
	Register(func(mux *http.ServeMux) {
		// Console's bridge proxy for a dynamic plugin's backend routes
		// (pkg/plugins/handlers.go's HandlePluginAssets, reached via
		// http.StripPrefix(pluginAssetsEndpoint, ...) in pkg/server/
		// server.go) strips the "/api/plugins/<plugin-name>/" prefix
		// entirely before forwarding, issues nothing but a bare GET
		// (non-GET is rejected with 405 before it ever reaches the plugin),
		// and never forwards the original request's query string - it
		// builds the upstream request as http.NewRequest("GET", url, nil)
		// from the plugin service's own basePath joined with the remaining
		// path alone. So this route must be registered bare (no
		// "/api/plugins/<name>" prefix - the target list travels as a
		// base64url-encoded JSON path segment instead of a query string,
		// same convention as this plugin's sibling cert-manager and
		// external-dns plugins.
		mux.HandleFunc("/api/v1/reconcile/{payload}", reconcileHandler)
	})
}

func reconcileHandler(w http.ResponseWriter, r *http.Request) {
	client, err := newInClusterK8sClient()
	if err != nil {
		http.Error(w, "backend is not running in-cluster: "+err.Error(), http.StatusInternalServerError)
		return
	}
	reconcileHandlerWithClient(w, r, client)
}

// reconcileHandlerWithClient is reconcileHandler's implementation, taking
// the k8sClient as a parameter so tests can inject one pointed at a fake
// kube-apiserver instead of the real in-cluster ServiceAccount mount.
func reconcileHandlerWithClient(w http.ResponseWriter, r *http.Request, client *k8sClient) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	raw, err := base64.RawURLEncoding.DecodeString(r.PathValue("payload"))
	if err != nil {
		http.Error(w, "invalid payload: not base64url", http.StatusBadRequest)
		return
	}
	var target reconcileTarget
	if err := json.Unmarshal(raw, &target); err != nil {
		http.Error(w, "invalid payload: not a JSON object", http.StatusBadRequest)
		return
	}
	if target.Namespace == "" || target.Name == "" {
		http.Error(w, "namespace and name are required", http.StatusBadRequest)
		return
	}

	gvr, ok := reconcilableKinds[target.Kind]
	if !ok {
		known := make([]string, 0, len(reconcilableKinds))
		for k := range reconcilableKinds {
			known = append(known, k)
		}
		http.Error(w, fmt.Sprintf("unsupported kind %q, must be one of: %s", target.Kind, strings.Join(known, ", ")), http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), k8sRequestTimeout)
	defer cancel()

	ts := time.Now().Format(time.RFC3339Nano)
	resp := reconcileResponse{RequestedAt: ts}

	if target.WithSource {
		sourceKind, sourceGVR, sourceNamespace, sourceName, err := resolveSource(ctx, client, target)
		if err != nil {
			http.Error(w, "resolving source: "+err.Error(), http.StatusBadGateway)
			return
		}
		if sourceKind != "" {
			if err := client.patchAnnotations(ctx, sourceGVR.group, sourceGVR.version, sourceGVR.plural, sourceNamespace, sourceName,
				map[string]string{reconcileRequestAnnotation: ts}); err != nil {
				http.Error(w, "reconciling source: "+err.Error(), http.StatusBadGateway)
				return
			}
			resp.SourceRequestedAt = ts
			resp.SourceKind = sourceKind
			resp.SourceName = sourceName
		}
	}

	annotations := map[string]string{reconcileRequestAnnotation: ts}
	if target.Kind == "HelmRelease" {
		if target.Force {
			annotations[helmReleaseForceRequestAnnotation] = ts
		}
		if target.Reset {
			annotations[helmReleaseResetRequestAnnotation] = ts
		}
	}

	if err := client.patchAnnotations(ctx, gvr.group, gvr.version, gvr.plural, target.Namespace, target.Name, annotations); err != nil {
		http.Error(w, "reconciling: "+err.Error(), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(resp)
}

// resolveSource fetches target's own object to read the source it depends
// on, mirroring flux2's getSource() methods (cmd/flux/reconcile_kustomization.go,
// reconcile_source_chart.go, reconcile_helmrelease.go). Returns a zero
// sourceKind (and no error) when the kind has no source to reconcile, or
// when the relevant spec field simply isn't set on this particular object.
//
// This deliberately does not replicate the CLI's wait-for-ready polling -
// see reconcileHandlerWithClient's doc comment above: a plugin backend
// route answers one GET with one response, so both the source and the
// object itself are patched and the handler returns immediately, without
// waiting to observe either reconciliation actually complete.
func resolveSource(ctx context.Context, client *k8sClient, target reconcileTarget) (kind string, gvr reconcileGVR, namespace, name string, err error) {
	obj, err := client.getResource(ctx, target.Group, target.Version, reconcilableKinds[target.Kind].plural, target.Namespace, target.Name)
	if err != nil {
		return "", reconcileGVR{}, "", "", err
	}

	switch target.Kind {
	case "Kustomization", "HelmChart":
		if ref, ok := getPath(obj, "spec", "sourceRef").(map[string]interface{}); ok {
			kind, _ = ref["kind"].(string)
			name, _ = ref["name"].(string)
			namespace, _ = ref["namespace"].(string)
		}
	case "HelmRelease":
		if chartRef, ok := getPath(obj, "spec", "chartRef").(map[string]interface{}); ok {
			kind, _ = chartRef["kind"].(string)
			name, _ = chartRef["name"].(string)
			namespace, _ = chartRef["namespace"].(string)
		} else {
			// No chartRef: the HelmRelease uses a HelmChartTemplate, and
			// helm-controller materializes a HelmChart object named
			// "<release-namespace>-<release-name>" for it.
			kind = "HelmChart"
			name = fmt.Sprintf("%s-%s", target.Namespace, target.Name)
			if ns, ok := getPath(obj, "spec", "chart", "spec", "sourceRef", "namespace").(string); ok {
				namespace = ns
			}
		}
	default:
		return "", reconcileGVR{}, "", "", nil
	}

	if kind == "" || name == "" {
		return "", reconcileGVR{}, "", "", nil
	}
	if namespace == "" {
		namespace = target.Namespace
	}

	sourceGVR, ok := reconcilableKinds[kind]
	if !ok {
		return "", reconcileGVR{}, "", "", fmt.Errorf("unsupported source kind %q", kind)
	}
	return kind, sourceGVR, namespace, name, nil
}

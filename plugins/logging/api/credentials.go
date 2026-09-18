package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

// useServiceAccountToken makes this backend serve node logs purely on the
// strength of its own mounted ServiceAccount, without checking the caller's
// own permissions first (USE_SERVICE_ACCOUNT_TOKEN=true, chart value
// useServiceAccountToken). Off by default: console forwards the logged-in
// user's own credentials on its authorized plugin proxy route, so this
// backend can ask the API server whether that user may read node logs at
// all before serving any.
//
// Unlike the other plugins in this repo, the forwarded credentials are used
// *only* for that check: finding the node-logs-api DaemonSet pod for a node
// needs permissions a regular user does not have, so the lookup and the
// fetch from that pod always run as this plugin's own ServiceAccount (see
// journal.go).
func useServiceAccountToken() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("USE_SERVICE_ACCOUNT_TOKEN")), "true")
}

// errNoCredentials says console forwarded no Authorization header, which
// means the request didn't arrive through a plugin proxy route configured to
// authorize (see the console chart's plugins[].proxy.authorize and this
// chart's ConsolePlugin spec.proxy). Handlers answer it with 401 rather than
// falling back to this plugin's own token, which would serve node logs to
// whoever managed to reach the Service directly.
var errNoCredentials = errors.New("no credentials on the request: console forwards them only on authorized plugin proxy routes")

// applyForwardedCredentials puts the credentials console forwarded on in
// onto the outgoing API server request out.
//
// out reuses the Authorization header verbatim, together with any
// Impersonate-* headers that came with it: the API server authorizes
// impersonation against whoever that token belongs to, so passing on
// whatever arrived grants nothing the caller didn't already have. Pairing
// this plugin's own token with caller-supplied impersonation headers would,
// which is why this never falls back to that token -- callers without
// credentials get errNoCredentials instead.
func applyForwardedCredentials(out, in *http.Request) error {
	authorization := in.Header.Get("Authorization")
	if authorization == "" {
		return errNoCredentials
	}
	out.Header.Set("Authorization", authorization)
	for key, values := range in.Header {
		if key = http.CanonicalHeaderKey(key); strings.HasPrefix(key, "Impersonate-") {
			out.Header[key] = values
		}
	}
	return nil
}

// The subset of authorization.k8s.io/v1 SelfSubjectAccessReview this backend
// sends and reads back. Any authenticated user may create one -- it only ever
// reports on the credentials it was sent with -- so this needs no RBAC of its
// own, which is what makes it usable as the caller's own permission check.
type accessReview struct {
	APIVersion string           `json:"apiVersion"`
	Kind       string           `json:"kind"`
	Spec       accessReviewSpec `json:"spec"`
}

type accessReviewSpec struct {
	ResourceAttributes accessReviewResource `json:"resourceAttributes"`
}

type accessReviewResource struct {
	Group       string `json:"group,omitempty"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Verb        string `json:"verb"`
	Name        string `json:"name,omitempty"`
}

type accessReviewResult struct {
	Status struct {
		Allowed         bool   `json:"allowed"`
		Reason          string `json:"reason"`
		EvaluationError string `json:"evaluationError"`
	} `json:"status"`
}

const accessReviewPath = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"

// authorizeNodeLogs answers whether the caller may read node's journal. It
// returns (0, nil) when they may, and otherwise the HTTP status the handler
// should answer with alongside the reason.
//
// The permission asked about is `get` on the nodes resource's `proxy`
// subresource, which is what console core's own Node Logs tab requires of a
// user (it reads the journal straight off the kubelet through
// /api/v1/nodes/<node>/proxy/logs/...). This plugin serves the same content
// from a DaemonSet instead, so it must not be an easier way in. The review is
// scoped to the node being asked about, so a Role narrowed with resourceNames
// still only opens the nodes it names.
func authorizeNodeLogs(r *http.Request, node string) (int, error) {
	if useServiceAccountToken() {
		return 0, nil
	}

	base, client, err := k8sAPI()
	if err != nil {
		return http.StatusBadGateway, err
	}

	review, err := json.Marshal(accessReview{
		APIVersion: "authorization.k8s.io/v1",
		Kind:       "SelfSubjectAccessReview",
		Spec: accessReviewSpec{
			ResourceAttributes: accessReviewResource{
				Resource:    "nodes",
				Subresource: "proxy",
				Verb:        "get",
				Name:        node,
			},
		},
	})
	if err != nil {
		return http.StatusInternalServerError, err
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, base+accessReviewPath, bytes.NewReader(review))
	if err != nil {
		return http.StatusInternalServerError, err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := applyForwardedCredentials(req, r); err != nil {
		return http.StatusUnauthorized, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return http.StatusBadGateway, fmt.Errorf("checking node log access: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		// The API server rejected the forwarded credentials themselves;
		// answering with its own status keeps that distinguishable from a
		// review that came back denied.
		return resp.StatusCode, fmt.Errorf("checking node log access: %s", resp.Status)
	case resp.StatusCode/100 != 2:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return http.StatusBadGateway, fmt.Errorf("checking node log access: %s: %s", resp.Status, body)
	}

	var result accessReviewResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return http.StatusBadGateway, fmt.Errorf("decoding access review: %w", err)
	}
	// An evaluationError means some authorizer failed while the rest still
	// reached a verdict; it is worth logging but not worth overriding either
	// answer with.
	if result.Status.EvaluationError != "" {
		log.Printf("access review for node %s: evaluation error: %s", node, result.Status.EvaluationError)
	}
	if !result.Status.Allowed {
		reason := result.Status.Reason
		if reason != "" {
			reason = ": " + reason
		}
		return http.StatusForbidden, fmt.Errorf("not allowed to get nodes/proxy for node %s%s", node, reason)
	}
	return 0, nil
}

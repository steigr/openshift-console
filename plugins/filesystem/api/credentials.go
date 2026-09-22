package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// errNoCredentials says console forwarded no Authorization header, which
// means the request did not arrive through a plugin proxy route configured to
// authorize (see the console chart's plugins[].proxy.authorize and this
// chart's ConsolePlugin spec.proxy). Handlers answer it with 401 rather than
// falling back to this plugin's own token, which would open every container
// on the cluster to whoever managed to reach the Service directly.
var errNoCredentials = errors.New("no credentials on the request: console forwards them only on authorized plugin proxy routes")

// applyForwardedCredentials copies the credentials console forwarded onto an
// outgoing API server request.
//
// The Authorization header is reused verbatim, together with any Impersonate-*
// headers that came with it: the API server authorizes impersonation against
// whoever that token belongs to, so passing on whatever arrived grants nothing
// the caller did not already have. Pairing this plugin's own token with
// caller-supplied impersonation headers would, which is why this never falls
// back to that token.
func applyForwardedCredentials(out http.Header, in http.Header) error {
	authorization := in.Get("Authorization")
	if authorization == "" {
		return errNoCredentials
	}
	out.Set("Authorization", authorization)
	for key, values := range in {
		if key = http.CanonicalHeaderKey(key); strings.HasPrefix(key, "Impersonate-") {
			out[key] = values
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
	Namespace   string `json:"namespace,omitempty"`
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

// authorizeContainerAccess answers whether the caller may browse a pod's
// container filesystems.
//
// The permission asked about is `create` on the pods resource's `exec`
// subresource, scoped to that one pod. That is the same permission `kubectl
// exec` and `kubectl cp` need, and it is the honest equivalent of what this
// plugin offers: an agent that reads, writes and deletes anywhere in the
// container. Asking for anything less -- `get pods`, say -- would make this
// plugin a way around the cluster's own exec policy, which is precisely the
// policy an administrator uses to decide who may reach into a running
// workload.
//
// The check is skipped only when useServiceAccountToken() is on, which is the
// deliberate "this cluster's console does not forward user credentials"
// escape hatch and is documented as such in the chart.
func authorizeContainerAccess(ctx context.Context, in http.Header, namespace, pod string) error {
	if useServiceAccountToken() {
		return nil
	}

	base, client, err := k8sAPI()
	if err != nil {
		return err
	}

	review, err := json.Marshal(accessReview{
		APIVersion: "authorization.k8s.io/v1",
		Kind:       "SelfSubjectAccessReview",
		Spec: accessReviewSpec{
			ResourceAttributes: accessReviewResource{
				Namespace:   namespace,
				Resource:    "pods",
				Subresource: "exec",
				Verb:        "create",
				Name:        pod,
			},
		},
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+accessReviewPath, bytes.NewReader(review))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := applyForwardedCredentials(req.Header, in); err != nil {
		return err
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("checking container access: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		// The API server rejected the forwarded credentials themselves;
		// answering with its own status keeps that distinguishable from a
		// review that came back denied.
		return &apiStatusError{status: resp.StatusCode, msg: fmt.Sprintf("checking container access: %s", resp.Status)}
	case resp.StatusCode/100 != 2:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("checking container access: %s: %s", resp.Status, body)
	}

	var result accessReviewResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decoding access review: %w", err)
	}
	// An evaluationError means some authorizer failed while the rest still
	// reached a verdict; worth logging, not worth overriding either answer.
	if result.Status.EvaluationError != "" {
		log.Printf("access review for pod %s/%s: evaluation error: %s", namespace, pod, result.Status.EvaluationError)
	}
	if !result.Status.Allowed {
		reason := result.Status.Reason
		if reason != "" {
			reason = ": " + reason
		}
		return &apiStatusError{
			status: http.StatusForbidden,
			msg:    fmt.Sprintf("browsing the files of pod %s/%s needs permission to create pods/exec on it%s", namespace, pod, reason),
		}
	}
	return nil
}

// useServiceAccountToken makes this backend serve on the strength of its own
// mounted ServiceAccount, without checking the caller's own permissions first
// (USE_SERVICE_ACCOUNT_TOKEN=true, chart value useServiceAccountToken). Off by
// default, and materially more dangerous here than in the sibling plugins:
// with it on, anyone who can open the console's Files tab can read and write
// every container on the cluster.
func useServiceAccountToken() bool {
	return BoolEnv("USE_SERVICE_ACCOUNT_TOKEN", false)
}

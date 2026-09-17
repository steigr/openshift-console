package api

import (
	"errors"
	"net/http"
	"os"
	"strings"
)

// useServiceAccountToken makes this backend authenticate to the API server
// with its own mounted ServiceAccount token instead of the credentials
// console forwards (USE_SERVICE_ACCOUNT_TOKEN=true, chart value
// useServiceAccountToken). Off by default: console sends the logged-in user's
// own token on its authorized plugin proxy routes -- plus Impersonate-*
// headers when console itself authenticates as its service account
// (--plugin-impersonation) -- so every API server call this backend makes is
// subject to that user's own RBAC and the plugin's ServiceAccount needs no
// permissions of its own.
func useServiceAccountToken() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("USE_SERVICE_ACCOUNT_TOKEN")), "true")
}

// errNoCredentials says console forwarded no Authorization header, which means
// the request didn't arrive through a plugin proxy route configured to
// authorize (see the console chart's plugins[].proxy.authorize). Handlers
// answer it with 401.
var errNoCredentials = errors.New("no credentials on the request: console forwards them only on authorized plugin proxy routes")

// applyCredentials puts the credentials for one API server request on out.
//
// With USE_SERVICE_ACCOUNT_TOKEN this plugin's own token is used and in is
// ignored. Otherwise out reuses the Authorization header console forwarded,
// together with any Impersonate-* headers that came with it: the API server
// authorizes impersonation against whoever that token belongs to, so passing
// on whatever arrived grants nothing the caller didn't already have. Pairing
// this plugin's own token with caller-supplied impersonation headers would,
// which is why the two modes never mix.
func applyCredentials(out, in *http.Request) error {
	if useServiceAccountToken() {
		token, err := bearerToken()
		if err != nil {
			return err
		}
		out.Header.Set("Authorization", "Bearer "+token)
		return nil
	}

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

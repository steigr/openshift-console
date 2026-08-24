package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const inspectTimeout = checkTimeout

// postHandshakeProbeTimeout bounds how long inspectEndpoint waits, after a
// handshake that completed without error, for the server to close the
// connection with a "certificate required" alert. See the comment on
// inspectEndpoint for why this second step is necessary.
const postHandshakeProbeTimeout = 750 * time.Millisecond

// clientAuthOff/Optional/Require describe whether the endpoint asked for a
// client certificate at all, and if so, whether presenting one was
// mandatory to complete the handshake.
const (
	clientAuthOff      = "Off"
	clientAuthOptional = "Optional"
	clientAuthRequire  = "mTLS"
)

// CertInspectResult is the response for a single ad-hoc TLS probe: the
// leaf certificate's identity, its SAN entries, the issuer, the root (if
// the server sent one), the leaf's validity window, and whether the
// endpoint requires/requests a client certificate.
type CertInspectResult struct {
	Protocol          string   `json:"protocol"`
	Hostname          string   `json:"hostname"`
	Port              int      `json:"port"`
	SubjectCommonName string   `json:"subjectCommonName,omitempty"`
	SANEntries        []string `json:"sanEntries,omitempty"`
	IssuerCommonName  string   `json:"issuerCommonName,omitempty"`
	RootCommonName    string   `json:"rootCommonName,omitempty"`
	NotBefore         string   `json:"notBefore,omitempty"`
	NotAfter          string   `json:"notAfter,omitempty"`
	ClientAuth        string   `json:"clientAuth,omitempty"`
	Error             string   `json:"error,omitempty"`
}

// sanEntries collects every Subject Alternative Name on a certificate -
// DNS names, IP addresses, email addresses, and URIs - into one flat list.
func sanEntries(cert *x509.Certificate) []string {
	entries := make([]string, 0, len(cert.DNSNames)+len(cert.IPAddresses)+len(cert.EmailAddresses)+len(cert.URIs))
	entries = append(entries, cert.DNSNames...)
	for _, ip := range cert.IPAddresses {
		entries = append(entries, ip.String())
	}
	entries = append(entries, cert.EmailAddresses...)
	for _, u := range cert.URIs {
		entries = append(entries, u.String())
	}
	return entries
}

// inspectEndpoint performs a single TLS handshake against hostname:port,
// requesting the certificate chain and probing whether a client
// certificate is requested and, if so, whether it is mandatory.
//
// Client-auth requirement is derived from a handshake that declines to
// present a client certificate: a GetClientCertificate callback is
// registered that hands back an empty certificate.
//
//   - If the server never asks for one, the callback is never invoked: Off.
//   - If it asks and the handshake then fails, a certificate was mandatory
//     (this is the TLS 1.2 behavior, and can also happen in TLS 1.3): mTLS.
//   - If it asks and the handshake succeeds, that is NOT proof enough on
//     its own: in TLS 1.3 the client completes its handshake as soon as it
//     sends its own Finished message, before the server has processed that
//     message and can reject the missing certificate - the server's
//     "certificate required" alert arrives asynchronously afterward. So
//     when the handshake succeeds after being asked for a certificate, a
//     short follow-up Read is attempted: an immediate error means the
//     server just rejected the empty certificate (mTLS); a read timeout
//     means the server is idling, waiting for application data as usual
//     (Optional).
func inspectEndpoint(ctx context.Context, protocol, hostname string, port int) CertInspectResult {
	result := CertInspectResult{Protocol: protocol, Hostname: hostname, Port: port}

	dialer := &net.Dialer{Timeout: inspectTimeout}
	rawConn, err := dialer.DialContext(ctx, "tcp", targetKey(hostname, port))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer rawConn.Close()

	_ = rawConn.SetDeadline(time.Now().Add(inspectTimeout))

	clientCertRequested := false
	tlsConn := tls.Client(rawConn, &tls.Config{
		ServerName:         hostname,
		InsecureSkipVerify: true, //nolint:gosec // see checkHostname doc comment in certcheck.go
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			clientCertRequested = true
			return &tls.Certificate{}, nil
		},
	})
	defer tlsConn.Close()

	handshakeErr := tlsConn.HandshakeContext(ctx)

	certs := tlsConn.ConnectionState().PeerCertificates
	if len(certs) > 0 {
		leaf := certs[0]
		root := certs[len(certs)-1]
		result.SubjectCommonName = leaf.Subject.CommonName
		result.IssuerCommonName = leaf.Issuer.CommonName
		result.RootCommonName = root.Subject.CommonName
		result.NotBefore = leaf.NotBefore.UTC().Format(time.RFC3339)
		result.NotAfter = leaf.NotAfter.UTC().Format(time.RFC3339)
		result.SANEntries = sanEntries(leaf)
	}

	switch {
	case !clientCertRequested:
		result.ClientAuth = clientAuthOff
	case handshakeErr != nil:
		result.ClientAuth = clientAuthRequire
	default:
		result.ClientAuth = probePostHandshakeClientAuth(tlsConn)
	}

	if handshakeErr != nil && len(certs) == 0 {
		// No certificate was ever observed - report the handshake failure
		// as the primary error since there is nothing else to show.
		result.Error = handshakeErr.Error()
	}

	return result
}

// probePostHandshakeClientAuth is called only once a handshake has
// completed successfully after the server asked for (and was refused) a
// client certificate. See the doc comment on inspectEndpoint for why a
// successful handshake alone does not settle Optional vs mTLS.
func probePostHandshakeClientAuth(tlsConn *tls.Conn) string {
	_ = tlsConn.SetReadDeadline(time.Now().Add(postHandshakeProbeTimeout))
	buf := make([]byte, 1)
	_, err := tlsConn.Read(buf)
	if err == nil {
		// The server sent data unprompted - treat that as accepting the
		// connection, i.e. the missing client certificate was optional.
		return clientAuthOptional
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		// No response within the window: the server is idling, waiting for
		// us to speak first, exactly as it would for any accepted connection.
		return clientAuthOptional
	}
	return clientAuthRequire
}

// certInspectPathTarget is the JSON shape base64url-encoded into the
// path-payload route's {payload} segment.
type certInspectPathTarget struct {
	Protocol string `json:"protocol,omitempty"`
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
}

func init() {
	Register(func(mux *http.ServeMux) {
		// See certcheck.go's init() for why this has to travel as a path
		// segment rather than a query string: bridge's plugin proxy drops
		// the original request's query string when forwarding to the
		// backend. Payload is a base64url-encoded JSON object
		// {protocol, host, port}.
		mux.HandleFunc(basePath+"/api/v1/certinspect/{payload}", certInspectPathHandler)
		// Bare paths, unreachable through bridge's proxy but kept for
		// local/direct testing (e.g. a port-forward straight to this pod).
		mux.HandleFunc("/api/v1/certinspect", certInspectHandler)
		mux.HandleFunc(basePath+"/api/v1/certinspect", certInspectHandler)
	})
}

func certInspectPathHandler(w http.ResponseWriter, r *http.Request) {
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
	var target certInspectPathTarget
	if err := json.Unmarshal(raw, &target); err != nil {
		http.Error(w, "invalid payload: not a JSON object", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(target.Host) == "" {
		http.Error(w, "host is required", http.StatusBadRequest)
		return
	}

	protocol := target.Protocol
	if protocol == "" {
		protocol = "tcp"
	}
	port := target.Port
	if port <= 0 {
		port = defaultTLSPort
	}

	writeCertInspectResult(w, r, protocol, target.Host, port)
}

func certInspectHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	hostname := strings.TrimSpace(query.Get("host"))
	if hostname == "" {
		http.Error(w, "host is required", http.StatusBadRequest)
		return
	}

	protocol := strings.TrimSpace(query.Get("protocol"))
	if protocol == "" {
		protocol = "tcp"
	}

	port := defaultTLSPort
	if raw := strings.TrimSpace(query.Get("port")); raw != "" {
		p, err := strconv.Atoi(raw)
		if err != nil || p <= 0 || p > 65535 {
			http.Error(w, "port must be a valid port number", http.StatusBadRequest)
			return
		}
		port = p
	}

	writeCertInspectResult(w, r, protocol, hostname, port)
}

func writeCertInspectResult(w http.ResponseWriter, r *http.Request, protocol, hostname string, port int) {
	ctx, cancel := context.WithTimeout(r.Context(), inspectTimeout)
	defer cancel()

	result := inspectEndpoint(ctx, protocol, hostname, port)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(result)
}

package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// defaultTLSPort is the port probed when a target does not specify one.
const defaultTLSPort = 443

const (
	maxTargetsPerRequest = 100
	checkTimeout         = 5 * time.Second
	maxConcurrentChecks  = 8
)

// CertInfo describes a single certificate in a presented chain.
type CertInfo struct {
	Subject      string `json:"subject"`
	Issuer       string `json:"issuer"`
	SerialNumber string `json:"serialNumber"`
	NotBefore    string `json:"notBefore"`
	NotAfter     string `json:"notAfter"`
	IsCA         bool   `json:"isCA"`
	KeyAlgorithm string `json:"keyAlgorithm"`
	KeySize      int    `json:"keySize,omitempty"`
	KeyCurve     string `json:"keyCurve,omitempty"`
}

// HostnameCertResult is the resolved TLS certificate state for one
// hostname:port target - the leaf certificate's issuer/subject, the root
// (last-in-chain) subject, remaining validity, and key details, plus the
// full chain for anyone that wants it.
type HostnameCertResult struct {
	Hostname         string     `json:"hostname"`
	Port             int        `json:"port"`
	Subject          string     `json:"subject,omitempty"`
	Issuer           string     `json:"issuer,omitempty"`
	RootCA           string     `json:"rootCA,omitempty"`
	NotBefore        string     `json:"notBefore,omitempty"`
	NotAfter         string     `json:"notAfter,omitempty"`
	ExpiresInSeconds int64      `json:"expiresInSeconds,omitempty"`
	Expired          bool       `json:"expired,omitempty"`
	KeyAlgorithm     string     `json:"keyAlgorithm,omitempty"`
	KeySize          int        `json:"keySize,omitempty"`
	KeyCurve         string     `json:"keyCurve,omitempty"`
	ChainLength      int        `json:"chainLength,omitempty"`
	Chain            []CertInfo `json:"chain,omitempty"`
	Error            string     `json:"error,omitempty"`
}

// certTarget is a single hostname/port pair to probe.
type certTarget struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port,omitempty"`
}

type certCheckRequest struct {
	Targets []certTarget `json:"targets"`
}

func targetKey(hostname string, port int) string {
	return net.JoinHostPort(hostname, strconv.Itoa(port))
}

// keyDetails extracts a human-readable algorithm name plus size (RSA bit
// length) or curve (ECDSA) from a certificate's public key.
func keyDetails(cert *x509.Certificate) (algorithm string, size int, curve string) {
	switch pub := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		return "RSA", pub.N.BitLen(), ""
	case *ecdsa.PublicKey:
		curveName := ""
		if pub.Curve != nil && pub.Curve.Params() != nil {
			curveName = pub.Curve.Params().Name
		}
		return "ECDSA", 0, curveName
	case ed25519.PublicKey:
		return "Ed25519", 0, ""
	default:
		return cert.PublicKeyAlgorithm.String(), 0, ""
	}
}

// checkHostname performs a TLS handshake against hostname:port and reports
// the certificate chain the server presented.
//
// InsecureSkipVerify is used only so the raw chain can be *fetched* even
// when the server presents a cert cert-manager issued from a CA the
// plugin's pod doesn't trust (private CAs, self-signed bootstrap certs,
// etc) - it does not affect what is *reported*: expiry/validity below is
// always computed from the certificate's own NotBefore/NotAfter fields, so
// an expired or not-yet-valid cert is still surfaced as such to the UI.
func checkHostname(ctx context.Context, hostname string, port int) HostnameCertResult {
	result := HostnameCertResult{Hostname: hostname, Port: port}

	dialer := &net.Dialer{Timeout: checkTimeout}
	rawConn, err := dialer.DialContext(ctx, "tcp", targetKey(hostname, port))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer rawConn.Close()

	deadline := time.Now().Add(checkTimeout)
	_ = rawConn.SetDeadline(deadline)

	tlsConn := tls.Client(rawConn, &tls.Config{
		ServerName:         hostname,
		InsecureSkipVerify: true, //nolint:gosec // see doc comment above
	})
	defer tlsConn.Close()

	if err := tlsConn.HandshakeContext(ctx); err != nil {
		result.Error = err.Error()
		return result
	}

	certs := tlsConn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		result.Error = "server did not present a certificate"
		return result
	}

	leaf := certs[0]
	root := certs[len(certs)-1]

	algorithm, size, curve := keyDetails(leaf)

	result.Subject = leaf.Subject.String()
	result.Issuer = leaf.Issuer.String()
	result.RootCA = root.Subject.String()
	result.NotBefore = leaf.NotBefore.UTC().Format(time.RFC3339)
	result.NotAfter = leaf.NotAfter.UTC().Format(time.RFC3339)
	result.ExpiresInSeconds = int64(time.Until(leaf.NotAfter).Seconds())
	result.Expired = time.Now().After(leaf.NotAfter)
	result.KeyAlgorithm = algorithm
	result.KeySize = size
	result.KeyCurve = curve
	result.ChainLength = len(certs)

	result.Chain = make([]CertInfo, 0, len(certs))
	for _, c := range certs {
		alg, sz, cv := keyDetails(c)
		result.Chain = append(result.Chain, CertInfo{
			Subject:      c.Subject.String(),
			Issuer:       c.Issuer.String(),
			SerialNumber: c.SerialNumber.String(),
			NotBefore:    c.NotBefore.UTC().Format(time.RFC3339),
			NotAfter:     c.NotAfter.UTC().Format(time.RFC3339),
			IsCA:         c.IsCA,
			KeyAlgorithm: alg,
			KeySize:      sz,
			KeyCurve:     cv,
		})
	}

	return result
}

func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("/api/v1/certcheck", certCheckHandler)
	})
}

// parseTarget accepts "host", "host:port", or "[ipv6]:port" and returns the
// hostname plus resolved port (defaultTLSPort when unspecified).
func parseTarget(raw string) (string, int) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", 0
	}
	if host, portStr, err := net.SplitHostPort(raw); err == nil {
		if port, err := strconv.Atoi(portStr); err == nil {
			return host, port
		}
	}
	return raw, defaultTLSPort
}

func certCheckHandler(w http.ResponseWriter, r *http.Request) {
	var targets []certTarget

	switch r.Method {
	case http.MethodGet:
		for _, raw := range r.URL.Query()["target"] {
			host, port := parseTarget(raw)
			if host == "" {
				continue
			}
			targets = append(targets, certTarget{Hostname: host, Port: port})
		}
	case http.MethodPost:
		var req certCheckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		targets = req.Targets
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	targets = normalizeTargets(targets)
	if len(targets) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		json.NewEncoder(w).Encode(map[string]HostnameCertResult{})
		return
	}
	if len(targets) > maxTargetsPerRequest {
		http.Error(w, "too many targets in one request", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()

	results := make(map[string]HostnameCertResult, len(targets))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrentChecks)

	for _, target := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(t certTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			res := checkHostname(ctx, t.Hostname, t.Port)
			mu.Lock()
			results[targetKey(t.Hostname, t.Port)] = res
			mu.Unlock()
		}(target)
	}
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(results)
}

// normalizeTargets fills in the default port, trims/drops empty hostnames,
// and deduplicates by hostname:port.
func normalizeTargets(in []certTarget) []certTarget {
	seen := make(map[string]struct{}, len(in))
	out := make([]certTarget, 0, len(in))
	for _, t := range in {
		hostname := strings.TrimSpace(t.Hostname)
		if hostname == "" {
			continue
		}
		port := t.Port
		if port <= 0 {
			port = defaultTLSPort
		}
		key := targetKey(hostname, port)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, certTarget{Hostname: hostname, Port: port})
	}
	return out
}

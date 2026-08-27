package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// defaultTLSPort is the port probed when a target does not specify one.
const defaultTLSPort = 443

// basePath must match this plugin's ConsolePlugin name (see
// charts/console-cert-manager-plugin/templates/consoleplugin.yaml and
// plugin-manifest.ts's pluginMetadata.name/baseURL). It is kept only for
// direct/local pod access - console's bridge proxy strips the
// "/api/plugins/<plugin-name>/" prefix entirely before forwarding, so every
// route reached through the real proxy must also be registered bare (no
// prefix) - see e.g. certinfo.go's and certinspect.go's init().
const basePath = "/api/plugins/cert-manager-console-plugin"

const checkTimeout = 5 * time.Second

// ipv4Enabled/ipv6Enabled gate whether checkHostname probes each address
// family at all - both default on. Package-level func vars (not plain
// funcs) so tests can override them directly instead of mutating process
// env vars, same pattern as k8sclient.go's bearerToken.
var (
	ipv4Enabled = func() bool { return envBoolOrDefault("CERT_MANAGER_ENABLE_IPV4", true) }
	ipv6Enabled = func() bool { return envBoolOrDefault("CERT_MANAGER_ENABLE_IPV6", true) }
)

// envBoolOrDefault parses key as a bool (accepting the same forms as
// strconv.ParseBool: "1"/"t"/"true"/"0"/"f"/"false", case-insensitive),
// falling back to def when the variable is unset, empty, or unparseable.
func envBoolOrDefault(key string, def bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	b, err := strconv.ParseBool(raw)
	if err != nil {
		return def
	}
	return b
}

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
//
// IPv4Connected/IPv6Connected always reflect whether a TLS handshake
// succeeded over that address family (this is what the UI's per-family
// badges are driven by, regardless of anything else below). The top-level
// Subject/Issuer/etc. fields above always carry a single shared view built
// from whichever family connected - when both connect and agree, that's
// the whole story. Families is populated only when the two disagree
// (FamiliesDiffer true): one family didn't connect at all, or both
// connected but presented different certificates - so a caller only pays
// for the per-family breakdown when there's something to actually show.
type HostnameCertResult struct {
	Hostname         string             `json:"hostname"`
	Port             int                `json:"port"`
	Subject          string             `json:"subject,omitempty"`
	Issuer           string             `json:"issuer,omitempty"`
	RootCA           string             `json:"rootCA,omitempty"`
	NotBefore        string             `json:"notBefore,omitempty"`
	NotAfter         string             `json:"notAfter,omitempty"`
	ExpiresInSeconds int64              `json:"expiresInSeconds,omitempty"`
	Expired          bool               `json:"expired,omitempty"`
	KeyAlgorithm     string             `json:"keyAlgorithm,omitempty"`
	KeySize          int                `json:"keySize,omitempty"`
	KeyCurve         string             `json:"keyCurve,omitempty"`
	ChainLength      int                `json:"chainLength,omitempty"`
	Chain            []CertInfo         `json:"chain,omitempty"`
	IPv4Connected    bool               `json:"ipv4Connected"`
	IPv6Connected    bool               `json:"ipv6Connected"`
	FamiliesDiffer   bool               `json:"familiesDiffer,omitempty"`
	Families         []FamilyCertResult `json:"families,omitempty"`
	Error            string             `json:"error,omitempty"`
}

// FamilyCertResult is one address family's independent view of a
// hostname:port target - present only in HostnameCertResult.Families, and
// only when the two families' results actually differ.
type FamilyCertResult struct {
	Family           string `json:"family"` // "IPv4" or "IPv6"
	Connected        bool   `json:"connected"`
	Subject          string `json:"subject,omitempty"`
	Issuer           string `json:"issuer,omitempty"`
	RootCA           string `json:"rootCA,omitempty"`
	NotBefore        string `json:"notBefore,omitempty"`
	NotAfter         string `json:"notAfter,omitempty"`
	ExpiresInSeconds int64  `json:"expiresInSeconds,omitempty"`
	Expired          bool   `json:"expired,omitempty"`
	KeyAlgorithm     string `json:"keyAlgorithm,omitempty"`
	KeySize          int    `json:"keySize,omitempty"`
	KeyCurve         string `json:"keyCurve,omitempty"`
	ChainLength      int    `json:"chainLength,omitempty"`
	Error            string `json:"error,omitempty"`
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

// familyProbe is checkHostnameOnNetwork's return value: a FamilyCertResult
// (the exported, per-family JSON shape) plus the full chain, which is only
// ever surfaced on HostnameCertResult's top level, never duplicated per
// family - kept out of FamilyCertResult's own JSON tags for that reason.
// Attempted is false when the family was skipped entirely because it's
// disabled (ipv4Enabled/ipv6Enabled) - combineFamilyResults treats an
// unattempted family as simply absent from the comparison, not as a
// connection failure.
type familyProbe struct {
	FamilyCertResult
	chain     []CertInfo
	attempted bool
}

// checkHostname performs a TLS handshake against hostname:port over
// whichever of IPv4/IPv6 are enabled (both, by default - see
// ipv4Enabled/ipv6Enabled), probing enabled families concurrently, and
// reports the certificate chain the server presented - see
// HostnameCertResult's doc comment for how multiple families' results are
// combined.
//
// InsecureSkipVerify is used only so the raw chain can be *fetched* even
// when the server presents a cert cert-manager issued from a CA the
// plugin's pod doesn't trust (private CAs, self-signed bootstrap certs,
// etc) - it does not affect what is *reported*: expiry/validity below is
// always computed from the certificate's own NotBefore/NotAfter fields, so
// an expired or not-yet-valid cert is still surfaced as such to the UI.
func checkHostname(ctx context.Context, hostname string, port int) HostnameCertResult {
	var v4, v6 familyProbe
	var wg sync.WaitGroup

	if ipv4Enabled() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v4 = checkHostnameOnNetwork(ctx, "tcp4", "IPv4", hostname, port)
			v4.attempted = true
		}()
	}
	if ipv6Enabled() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v6 = checkHostnameOnNetwork(ctx, "tcp6", "IPv6", hostname, port)
			v6.attempted = true
		}()
	}
	wg.Wait()

	return combineFamilyResults(hostname, port, v4, v6)
}

// checkHostnameOnNetwork performs checkHostname's handshake restricted to a
// single address family - network is "tcp4" or "tcp6", which also makes Go's
// resolver only consider A or AAAA records respectively, so a hostname with
// no record of that type fails here exactly as "not connected" without any
// separate DNS-lookup step.
func checkHostnameOnNetwork(ctx context.Context, network, familyLabel, hostname string, port int) familyProbe {
	var probe familyProbe
	probe.Family = familyLabel

	dialer := &net.Dialer{Timeout: checkTimeout}
	rawConn, err := dialer.DialContext(ctx, network, targetKey(hostname, port))
	if err != nil {
		probe.Error = err.Error()
		return probe
	}
	defer rawConn.Close()

	deadline := time.Now().Add(checkTimeout)
	_ = rawConn.SetDeadline(deadline)

	tlsConn := tls.Client(rawConn, &tls.Config{
		ServerName:         hostname,
		InsecureSkipVerify: true, //nolint:gosec // see checkHostname doc comment
	})
	defer tlsConn.Close()

	if err := tlsConn.HandshakeContext(ctx); err != nil {
		probe.Error = err.Error()
		return probe
	}

	certs := tlsConn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		probe.Error = "server did not present a certificate"
		return probe
	}

	leaf := certs[0]
	root := certs[len(certs)-1]

	algorithm, size, curve := keyDetails(leaf)

	probe.Connected = true
	probe.Subject = leaf.Subject.String()
	probe.Issuer = leaf.Issuer.String()
	probe.RootCA = root.Subject.String()
	probe.NotBefore = leaf.NotBefore.UTC().Format(time.RFC3339)
	probe.NotAfter = leaf.NotAfter.UTC().Format(time.RFC3339)
	probe.ExpiresInSeconds = int64(time.Until(leaf.NotAfter).Seconds())
	probe.Expired = time.Now().After(leaf.NotAfter)
	probe.KeyAlgorithm = algorithm
	probe.KeySize = size
	probe.KeyCurve = curve
	probe.ChainLength = len(certs)

	probe.chain = make([]CertInfo, 0, len(certs))
	for _, c := range certs {
		alg, sz, cv := keyDetails(c)
		probe.chain = append(probe.chain, CertInfo{
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

	return probe
}

// familyDetailsEqual reports whether two *connected* families presented the
// same certificate, by the fields that matter to a caller (identity,
// validity, key). Callers should only invoke this once both sides are
// known to be connected.
func familyDetailsEqual(a, b FamilyCertResult) bool {
	return a.Subject == b.Subject &&
		a.Issuer == b.Issuer &&
		a.NotAfter == b.NotAfter &&
		a.KeyAlgorithm == b.KeyAlgorithm &&
		a.KeySize == b.KeySize &&
		a.KeyCurve == b.KeyCurve
}

// combineFamilyResults merges the independent per-family probes into the
// single HostnameCertResult callers see. IPv4Connected/IPv6Connected always
// reflect each *attempted* family's own outcome (the badges) - an
// unattempted (disabled) family stays false there too, since nothing was
// connected, but never contributes an error or a families-differ entry: a
// disabled family isn't a disagreement, there was only ever one side to
// look at.
//
// When both families were attempted, the shared top-level fields are
// filled from whichever connected (preferring IPv4 when both did and
// agree), and Families is populated only when there's something to
// actually show there - one attempted family failed where the other
// didn't, or both connected but presented different certificates. When
// only one family was attempted, this degrades to that family's own view
// with no families-differ concept at all - the other side was never in
// the picture.
func combineFamilyResults(hostname string, port int, v4, v6 familyProbe) HostnameCertResult {
	result := HostnameCertResult{
		Hostname:      hostname,
		Port:          port,
		IPv4Connected: v4.attempted && v4.Connected,
		IPv6Connected: v6.attempted && v6.Connected,
	}

	switch {
	case v4.attempted && v6.attempted:
		switch {
		case v4.Connected && v6.Connected:
			result.FamiliesDiffer = !familyDetailsEqual(v4.FamilyCertResult, v6.FamilyCertResult)
			applyFamilyToResult(&result, v4)
		case v4.Connected:
			result.FamiliesDiffer = true
			applyFamilyToResult(&result, v4)
		case v6.Connected:
			result.FamiliesDiffer = true
			applyFamilyToResult(&result, v6)
		default:
			result.Error = fmt.Sprintf("IPv4: %s; IPv6: %s", errOrNone(v4.Error), errOrNone(v6.Error))
		}
		if result.FamiliesDiffer {
			result.Families = []FamilyCertResult{v4.FamilyCertResult, v6.FamilyCertResult}
		}
	case v4.attempted:
		applySoleFamilyToResult(&result, v4)
	case v6.attempted:
		applySoleFamilyToResult(&result, v6)
	default:
		result.Error = "no address family is enabled (CERT_MANAGER_ENABLE_IPV4/CERT_MANAGER_ENABLE_IPV6 both false)"
	}

	return result
}

// applySoleFamilyToResult handles the case where only one address family
// was ever attempted (the other disabled): its own outcome - success or
// failure - becomes the whole HostnameCertResult, exactly as checkHostname
// behaved before per-family probing existed.
func applySoleFamilyToResult(result *HostnameCertResult, p familyProbe) {
	if p.Connected {
		applyFamilyToResult(result, p)
		return
	}
	result.Error = p.Error
}

// applyFamilyToResult copies one family's probe onto the shared top-level
// fields of result - the "one, when equal" (or "best available", when only
// one family connects) view.
func applyFamilyToResult(result *HostnameCertResult, p familyProbe) {
	result.Subject = p.Subject
	result.Issuer = p.Issuer
	result.RootCA = p.RootCA
	result.NotBefore = p.NotBefore
	result.NotAfter = p.NotAfter
	result.ExpiresInSeconds = p.ExpiresInSeconds
	result.Expired = p.Expired
	result.KeyAlgorithm = p.KeyAlgorithm
	result.KeySize = p.KeySize
	result.KeyCurve = p.KeyCurve
	result.ChainLength = p.ChainLength
	result.Chain = p.chain
}

func errOrNone(s string) string {
	if s == "" {
		return "no error recorded"
	}
	return s
}


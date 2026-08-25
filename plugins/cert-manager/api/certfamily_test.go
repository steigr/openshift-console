package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"strconv"
	"testing"
	"time"
)

// familyTLSListener starts a real TLS listener restricted to one address
// family ("tcp4" on 127.0.0.1, or "tcp6" on ::1) presenting a cert with the
// given CommonName, and returns its host/port. Used to verify
// checkHostnameOnNetwork actually reaches the right family and doesn't
// accidentally cross-connect.
func familyTLSListener(t *testing.T, network, addr, commonName string) (string, int) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}

	ln, err := tls.Listen(network, net.JoinHostPort(addr, "0"), &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Skipf("%s loopback unavailable in this environment: %v", network, err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.(*tls.Conn).Handshake()
			}(conn)
		}
	}()

	host, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("parse listener address: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse listener port: %v", err)
	}
	return host, port
}

func TestCheckHostnameOnNetworkReachesCorrectFamily(t *testing.T) {
	v4Host, v4Port := familyTLSListener(t, "tcp4", "127.0.0.1", "ipv4-endpoint")
	v6Host, v6Port := familyTLSListener(t, "tcp6", "::1", "ipv6-endpoint")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	v4 := checkHostnameOnNetwork(ctx, "tcp4", "IPv4", v4Host, v4Port)
	if !v4.Connected || v4.Subject != "CN=ipv4-endpoint" {
		t.Fatalf("IPv4 probe = %+v, want Connected with CN=ipv4-endpoint", v4)
	}

	v6 := checkHostnameOnNetwork(ctx, "tcp6", "IPv6", v6Host, v6Port)
	if !v6.Connected || v6.Subject != "CN=ipv6-endpoint" {
		t.Fatalf("IPv6 probe = %+v, want Connected with CN=ipv6-endpoint", v6)
	}
}

func TestCombineFamilyResultsEqual(t *testing.T) {
	shared := FamilyCertResult{
		Connected: true, Subject: "CN=example.com", Issuer: "CN=ca",
		NotAfter: "2030-01-01T00:00:00Z", KeyAlgorithm: "RSA", KeySize: 2048,
	}
	v4 := familyProbe{FamilyCertResult: shared, attempted: true}
	v4.Family = "IPv4"
	v6 := familyProbe{FamilyCertResult: shared, attempted: true}
	v6.Family = "IPv6"

	result := combineFamilyResults("example.com", 443, v4, v6)

	if !result.IPv4Connected || !result.IPv6Connected {
		t.Fatalf("expected both families connected: %+v", result)
	}
	if result.FamiliesDiffer {
		t.Fatalf("expected FamiliesDiffer=false when both families agree: %+v", result)
	}
	if result.Families != nil {
		t.Fatalf("expected no Families breakdown when equal, got %+v", result.Families)
	}
	if result.Subject != "CN=example.com" || result.Issuer != "CN=ca" {
		t.Fatalf("expected shared top-level fields populated: %+v", result)
	}
}

func TestCombineFamilyResultsDifferentCerts(t *testing.T) {
	v4 := familyProbe{FamilyCertResult: FamilyCertResult{
		Family: "IPv4", Connected: true, Subject: "CN=v4.example.com", Issuer: "CN=ca-a",
	}, attempted: true}
	v6 := familyProbe{FamilyCertResult: FamilyCertResult{
		Family: "IPv6", Connected: true, Subject: "CN=v6.example.com", Issuer: "CN=ca-b",
	}, attempted: true}

	result := combineFamilyResults("example.com", 443, v4, v6)

	if !result.IPv4Connected || !result.IPv6Connected {
		t.Fatalf("expected both families connected: %+v", result)
	}
	if !result.FamiliesDiffer {
		t.Fatalf("expected FamiliesDiffer=true for different certs: %+v", result)
	}
	if len(result.Families) != 2 {
		t.Fatalf("expected a 2-entry Families breakdown, got %+v", result.Families)
	}
	// Top level falls back to the preferred (IPv4) family's view.
	if result.Subject != "CN=v4.example.com" {
		t.Fatalf("expected top-level Subject to prefer IPv4, got %q", result.Subject)
	}
}

func TestCombineFamilyResultsOnlyIPv4Connects(t *testing.T) {
	v4 := familyProbe{FamilyCertResult: FamilyCertResult{
		Family: "IPv4", Connected: true, Subject: "CN=v4-only.example.com",
	}, attempted: true}
	v6 := familyProbe{FamilyCertResult: FamilyCertResult{
		Family: "IPv6", Connected: false, Error: "no AAAA record",
	}, attempted: true}

	result := combineFamilyResults("example.com", 443, v4, v6)

	if !result.IPv4Connected {
		t.Fatalf("expected IPv4Connected=true: %+v", result)
	}
	if result.IPv6Connected {
		t.Fatalf("expected IPv6Connected=false: %+v", result)
	}
	if !result.FamiliesDiffer {
		t.Fatalf("expected FamiliesDiffer=true when only one family connects: %+v", result)
	}
	if len(result.Families) != 2 {
		t.Fatalf("expected a 2-entry Families breakdown (including the failed one), got %+v", result.Families)
	}
	if result.Subject != "CN=v4-only.example.com" {
		t.Fatalf("expected top-level Subject from the connected family, got %q", result.Subject)
	}
	if result.Error != "" {
		t.Fatalf("expected no top-level Error when at least one family connected, got %q", result.Error)
	}
}

func TestCombineFamilyResultsNeitherConnects(t *testing.T) {
	v4 := familyProbe{FamilyCertResult: FamilyCertResult{Family: "IPv4", Error: "connection refused"}, attempted: true}
	v6 := familyProbe{FamilyCertResult: FamilyCertResult{Family: "IPv6", Error: "network unreachable"}, attempted: true}

	result := combineFamilyResults("example.com", 443, v4, v6)

	if result.IPv4Connected || result.IPv6Connected {
		t.Fatalf("expected neither family connected: %+v", result)
	}
	if result.FamiliesDiffer {
		t.Fatalf("expected FamiliesDiffer=false when both simply failed: %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected a combined top-level Error, got none: %+v", result)
	}
}

// TestCombineFamilyResultsIPv6Disabled covers the new "one family
// disabled" path: unlike a family that was attempted and failed, a
// disabled family contributes nothing - no error, no families-differ
// entry, IPv4's own result is the whole story, exactly as checkHostname
// behaved before per-family probing existed.
func TestCombineFamilyResultsIPv6Disabled(t *testing.T) {
	v4 := familyProbe{FamilyCertResult: FamilyCertResult{
		Family: "IPv4", Connected: true, Subject: "CN=v4-only.example.com", Issuer: "CN=ca",
	}, attempted: true}
	var v6 familyProbe // never attempted: IPv6 disabled

	result := combineFamilyResults("example.com", 443, v4, v6)

	if !result.IPv4Connected {
		t.Fatalf("expected IPv4Connected=true: %+v", result)
	}
	if result.IPv6Connected {
		t.Fatalf("expected IPv6Connected=false when disabled: %+v", result)
	}
	if result.FamiliesDiffer {
		t.Fatalf("expected FamiliesDiffer=false when the other family was simply disabled: %+v", result)
	}
	if result.Families != nil {
		t.Fatalf("expected no Families breakdown when the other family was disabled, got %+v", result.Families)
	}
	if result.Subject != "CN=v4-only.example.com" || result.Issuer != "CN=ca" {
		t.Fatalf("expected the sole attempted family's fields, got %+v", result)
	}
	if result.Error != "" {
		t.Fatalf("expected no top-level Error, got %q", result.Error)
	}
}

func TestCombineFamilyResultsBothDisabled(t *testing.T) {
	var v4, v6 familyProbe // neither attempted: both disabled

	result := combineFamilyResults("example.com", 443, v4, v6)

	if result.IPv4Connected || result.IPv6Connected {
		t.Fatalf("expected neither connected: %+v", result)
	}
	if result.Error == "" {
		t.Fatalf("expected a top-level Error explaining both families are disabled, got none: %+v", result)
	}
}

// withFamiliesEnabled overrides ipv4Enabled/ipv6Enabled for the duration of
// a test, restoring the originals on cleanup - same override-a-package-var
// pattern as k8sclient_test.go's bearerToken swap.
func withFamiliesEnabled(t *testing.T, v4, v6 bool) {
	t.Helper()
	origV4, origV6 := ipv4Enabled, ipv6Enabled
	ipv4Enabled = func() bool { return v4 }
	ipv6Enabled = func() bool { return v6 }
	t.Cleanup(func() {
		ipv4Enabled = origV4
		ipv6Enabled = origV6
	})
}

// TestCheckHostnameSkipsDisabledFamily is an end-to-end check (real dial +
// handshake, not a synthetic familyProbe) that disabling IPv6 actually
// stops checkHostname from trying it at all: against an IPv4-only test
// server, the result should look exactly like a plain single-family
// check - no FamiliesDiffer, no Families breakdown, no error - where
// leaving both families on (the default) would flag FamiliesDiffer=true
// per TestCheckHostnameReturnsChainDetails's own target.
func TestCheckHostnameSkipsDisabledFamily(t *testing.T) {
	withFamiliesEnabled(t, true, false)

	_, host, port := tlsTestServer(t)

	result := checkHostname(context.Background(), host, port)

	if !result.IPv4Connected {
		t.Fatalf("expected IPv4Connected=true: %+v", result)
	}
	if result.IPv6Connected {
		t.Fatalf("expected IPv6Connected=false (disabled, never attempted): %+v", result)
	}
	if result.FamiliesDiffer {
		t.Fatalf("expected FamiliesDiffer=false with IPv6 disabled, got: %+v", result)
	}
	if result.Families != nil {
		t.Fatalf("expected no Families breakdown with IPv6 disabled, got %+v", result.Families)
	}
	if result.Error != "" {
		t.Fatalf("expected no error, got %q", result.Error)
	}
	if result.Issuer == "" {
		t.Fatalf("expected the IPv4 probe's own fields to populate the result: %+v", result)
	}
}

func TestCheckHostnameBothFamiliesDisabled(t *testing.T) {
	withFamiliesEnabled(t, false, false)

	_, host, port := tlsTestServer(t)

	result := checkHostname(context.Background(), host, port)

	if result.Error == "" {
		t.Fatalf("expected an error when both families are disabled, got none: %+v", result)
	}
}

func TestEnvBoolOrDefault(t *testing.T) {
	const key = "CERT_MANAGER_ENABLE_IPV4_TEST"
	cases := []struct {
		env       string
		def, want bool
	}{
		{"", true, true},
		{"", false, false},
		{"true", false, true},
		{"false", true, false},
		{"1", false, true},
		{"0", true, false},
		{"not-a-bool", true, true},
	}
	for _, c := range cases {
		t.Setenv(key, c.env)
		got := envBoolOrDefault(key, c.def)
		if got != c.want {
			t.Errorf("envBoolOrDefault(%q=%q, def=%v) = %v, want %v", key, c.env, c.def, got, c.want)
		}
	}
}

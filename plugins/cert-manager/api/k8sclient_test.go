package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/url"
	"os"
	"testing"
	"time"
)

// selfSignedCAPEM generates a throwaway self-signed cert's PEM bytes, just
// so newInClusterK8sClientFromPaths has something real to parse as a CA
// bundle in tests - its content is never used for a real handshake.
func selfSignedCAPEM(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test-ca"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IsCA:         true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

// TestNewInClusterK8sClientIPv6Host is a regression test for a live bug: on
// a dual-stack/IPv6 cluster, KUBERNETES_SERVICE_HOST is an IPv6 address
// (e.g. "fd10:96::1"), and building baseURL with a plain
// fmt.Sprintf("https://%s:%s", host, port) produces an unparseable
// authority ("https://fd10:96::1:443" - ambiguous with the address's own
// colons). Every certinfo request 502ed with exactly this until baseURL
// switched to net.JoinHostPort, which brackets IPv6 addresses correctly.
func TestNewInClusterK8sClientIPv6Host(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "fd10:96::1")
	t.Setenv("KUBERNETES_SERVICE_PORT", "443")

	tmp := t.TempDir()
	caPath := tmp + "/ca.crt"
	if err := os.WriteFile(caPath, selfSignedCAPEM(t), 0o600); err != nil {
		t.Fatalf("write fake CA: %v", err)
	}

	client, err := newInClusterK8sClientFromPaths(caPath)
	if err != nil {
		t.Fatalf("newInClusterK8sClientFromPaths: %v", err)
	}

	if _, err := url.Parse(client.baseURL); err != nil {
		t.Fatalf("baseURL %q does not parse as a URL: %v", client.baseURL, err)
	}
	want := "https://[fd10:96::1]:443"
	if client.baseURL != want {
		t.Fatalf("baseURL = %q, want %q", client.baseURL, want)
	}
}

func TestNewInClusterK8sClientIPv4Host(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
	t.Setenv("KUBERNETES_SERVICE_PORT", "443")

	tmp := t.TempDir()
	caPath := tmp + "/ca.crt"
	if err := os.WriteFile(caPath, selfSignedCAPEM(t), 0o600); err != nil {
		t.Fatalf("write fake CA: %v", err)
	}

	client, err := newInClusterK8sClientFromPaths(caPath)
	if err != nil {
		t.Fatalf("newInClusterK8sClientFromPaths: %v", err)
	}

	want := "https://10.0.0.1:443"
	if client.baseURL != want {
		t.Fatalf("baseURL = %q, want %q", client.baseURL, want)
	}
}

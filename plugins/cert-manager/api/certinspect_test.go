package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func generateTestCert(t *testing.T, commonName string, dnsNames []string) tls.Certificate {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: commonName},
		Issuer:       pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     dnsNames,
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		IsCA:         true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}

	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func startTLSListener(t *testing.T, clientAuth tls.ClientAuthType) (host string, port int) {
	t.Helper()

	cert := generateTestCert(t, "inspect.example.com", []string{"inspect.example.com", "alt.inspect.example.com"})

	cfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   clientAuth,
	}
	if clientAuth != tls.NoClientCert {
		pool := x509.NewCertPool()
		cfg.ClientCAs = pool
	}

	ln, err := tls.Listen("tcp", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatalf("listen: %v", err)
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
				tlsConn := c.(*tls.Conn)
				if err := tlsConn.Handshake(); err != nil {
					return
				}
				// Mirror a real server: stay connected and wait for the
				// client to speak first, rather than closing immediately.
				buf := make([]byte, 1)
				_, _ = tlsConn.Read(buf)
			}(conn)
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port
}

func TestInspectEndpointNoClientAuth(t *testing.T) {
	host, port := startTLSListener(t, tls.NoClientCert)

	result := inspectEndpoint(context.Background(), "tcp", host, port)

	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if result.ClientAuth != clientAuthOff {
		t.Fatalf("clientAuth = %q, want %q", result.ClientAuth, clientAuthOff)
	}
	if result.SubjectCommonName != "inspect.example.com" {
		t.Fatalf("subjectCommonName = %q", result.SubjectCommonName)
	}
	if len(result.SANEntries) != 2 {
		t.Fatalf("sanEntries = %v, want 2 entries", result.SANEntries)
	}
	if result.NotBefore == "" || result.NotAfter == "" {
		t.Fatalf("expected notBefore/notAfter to be populated, got %q/%q", result.NotBefore, result.NotAfter)
	}
}

func TestInspectEndpointOptionalClientAuth(t *testing.T) {
	host, port := startTLSListener(t, tls.VerifyClientCertIfGiven)

	result := inspectEndpoint(context.Background(), "tcp", host, port)

	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if result.ClientAuth != clientAuthOptional {
		t.Fatalf("clientAuth = %q, want %q", result.ClientAuth, clientAuthOptional)
	}
}

func TestInspectEndpointRequiredClientAuth(t *testing.T) {
	host, port := startTLSListener(t, tls.RequireAnyClientCert)

	result := inspectEndpoint(context.Background(), "tcp", host, port)

	if result.ClientAuth != clientAuthRequire {
		t.Fatalf("clientAuth = %q, want %q", result.ClientAuth, clientAuthRequire)
	}
	// Even though the handshake ultimately fails, the server's certificate
	// is sent before the client-auth phase, so it should still be captured.
	if result.SubjectCommonName != "inspect.example.com" {
		t.Fatalf("subjectCommonName = %q, want it populated despite handshake failure", result.SubjectCommonName)
	}
}

func TestCertInspectHandlerViaHTTP(t *testing.T) {
	host, port := startTLSListener(t, tls.NoClientCert)

	req := httptest.NewRequest("GET", "/api/v1/certinspect?host="+host+"&port="+strconv.Itoa(port), nil)
	rec := httptest.NewRecorder()

	certInspectHandler(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestCertInspectHandlerRequiresHost(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/certinspect", nil)
	rec := httptest.NewRecorder()

	certInspectHandler(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// TestCertInspectPathHandlerViaProxyPath exercises the route actually
// reachable through bridge's plugin proxy - see certcheck.go's init() doc
// comment for why the query-string route alone is unreachable there.
func TestCertInspectPathHandlerViaProxyPath(t *testing.T) {
	host, port := startTLSListener(t, tls.NoClientCert)

	payloadJSON, err := json.Marshal(certInspectPathTarget{Host: host, Port: port})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadJSON)

	mux := http.NewServeMux()
	mux.HandleFunc(basePath+"/api/v1/certinspect/{payload}", certInspectPathHandler)

	req := httptest.NewRequest(http.MethodGet, basePath+"/api/v1/certinspect/"+payload, nil)
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var result CertInspectResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if result.SubjectCommonName != "inspect.example.com" {
		t.Fatalf("subjectCommonName = %q, want it populated (proves the query-string-based path would silently fail)", result.SubjectCommonName)
	}
}

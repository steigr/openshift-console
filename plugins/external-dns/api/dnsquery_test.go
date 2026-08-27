package api

import (
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

// fakeDNSServer starts a local UDP DNS server driven by respond, which
// receives the raw query bytes and returns the raw response bytes to send
// back (or nil to send nothing, simulating a timeout). Returns the server's
// "host:port" address.
func fakeDNSServer(t *testing.T, respond func(query []byte) []byte) string {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	go func() {
		buf := make([]byte, 65535)
		for {
			n, addr, err := conn.ReadFrom(buf)
			if err != nil {
				return
			}
			resp := respond(append([]byte(nil), buf[:n]...))
			if resp == nil {
				continue
			}
			_, _ = conn.WriteTo(resp, addr)
		}
	}()

	return conn.LocalAddr().String()
}

// buildDNSResponse crafts a minimal, uncompressed DNS response to queryID
// answering with the given records for qname.
func buildDNSResponse(t *testing.T, queryID uint16, qname string, records []dnsRR) []byte {
	t.Helper()
	qnameBytes, err := encodeDNSName(qname)
	if err != nil {
		t.Fatalf("encodeDNSName: %v", err)
	}

	msg := make([]byte, 0, 128)
	msg = binary.BigEndian.AppendUint16(msg, queryID)
	msg = binary.BigEndian.AppendUint16(msg, 0x8180) // response, recursion available, no error
	msg = binary.BigEndian.AppendUint16(msg, 1)      // QDCOUNT
	msg = binary.BigEndian.AppendUint16(msg, uint16(len(records)))
	msg = binary.BigEndian.AppendUint16(msg, 0)
	msg = binary.BigEndian.AppendUint16(msg, 0)

	msg = append(msg, qnameBytes...)
	msg = binary.BigEndian.AppendUint16(msg, dnsTypeA) // QTYPE (unused by the parser)
	msg = binary.BigEndian.AppendUint16(msg, dnsClassIN)

	for _, rr := range records {
		nameBytes, err := encodeDNSName(qname)
		if err != nil {
			t.Fatalf("encodeDNSName: %v", err)
		}
		msg = append(msg, nameBytes...)
		msg = binary.BigEndian.AppendUint16(msg, rr.Type)
		msg = binary.BigEndian.AppendUint16(msg, dnsClassIN)
		msg = binary.BigEndian.AppendUint32(msg, rr.TTL)

		var rdata []byte
		switch rr.Type {
		case dnsTypeA:
			rdata = net.ParseIP(rr.Value).To4()
		case dnsTypeAAAA:
			rdata = net.ParseIP(rr.Value).To16()
		case dnsTypeCNAME:
			rdata, err = encodeDNSName(rr.Value)
			if err != nil {
				t.Fatalf("encodeDNSName: %v", err)
			}
		}
		msg = binary.BigEndian.AppendUint16(msg, uint16(len(rdata)))
		msg = append(msg, rdata...)
	}

	return msg
}

func parseQueryID(query []byte) uint16 {
	return binary.BigEndian.Uint16(query[0:2])
}

func TestQueryRecordsReturnsARecordWithTTL(t *testing.T) {
	addr := fakeDNSServer(t, func(query []byte) []byte {
		return buildDNSResponse(t, parseQueryID(query), "app.example.com", []dnsRR{
			{Type: dnsTypeA, Value: "203.0.113.10", TTL: 300},
		})
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	records, err := queryRecords(ctx, addr, "app.example.com", dnsTypeA)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %+v", records)
	}
	if records[0].Value != "203.0.113.10" || records[0].TTL != 300 {
		t.Errorf("unexpected record: %+v", records[0])
	}
}

func TestQueryRecordsIncludesCNAMEChain(t *testing.T) {
	addr := fakeDNSServer(t, func(query []byte) []byte {
		return buildDNSResponse(t, parseQueryID(query), "alias.example.com", []dnsRR{
			{Type: dnsTypeCNAME, Value: "target.example.com", TTL: 60},
			{Type: dnsTypeA, Value: "203.0.113.20", TTL: 120},
		})
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	records, err := queryRecords(ctx, addr, "alias.example.com", dnsTypeA)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected CNAME + A, got %+v", records)
	}
	if records[0].Type != dnsTypeCNAME || records[0].Value != "target.example.com" {
		t.Errorf("expected CNAME first: %+v", records[0])
	}
	if records[1].Type != dnsTypeA || records[1].Value != "203.0.113.20" {
		t.Errorf("expected A record second: %+v", records[1])
	}
}

func TestQueryRecordsAAAA(t *testing.T) {
	addr := fakeDNSServer(t, func(query []byte) []byte {
		return buildDNSResponse(t, parseQueryID(query), "v6.example.com", []dnsRR{
			{Type: dnsTypeAAAA, Value: "2001:db8::1", TTL: 45},
		})
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	records, err := queryRecords(ctx, addr, "v6.example.com", dnsTypeAAAA)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 1 || records[0].Value != "2001:db8::1" || records[0].TTL != 45 {
		t.Errorf("unexpected records: %+v", records)
	}
}

func TestQueryRecordsPropagatesTimeout(t *testing.T) {
	addr := fakeDNSServer(t, func(query []byte) []byte {
		return nil // never respond
	})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	_, err := queryRecords(ctx, addr, "slow.example.com", dnsTypeA)
	if err == nil {
		t.Error("expected a timeout error")
	}
}

func TestEncodeDecodeDNSNameRoundTrip(t *testing.T) {
	encoded, err := encodeDNSName("app.example.com")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// Pad with a trailing byte to make sure decodeDNSName stops at the
	// terminator rather than reading past it.
	buf := append(append([]byte{}, encoded...), 0xFF)

	got, next, err := decodeDNSName(buf, 0)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got != "app.example.com" {
		t.Errorf("got %q, want %q", got, "app.example.com")
	}
	if next != len(encoded) {
		t.Errorf("next = %d, want %d", next, len(encoded))
	}
}

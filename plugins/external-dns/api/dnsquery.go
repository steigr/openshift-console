package api

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"
)

// Minimal hand-rolled DNS wire-format client - just enough to ask a plain
// resolver for A/AAAA/CNAME records and get back each one's TTL, which
// net.Resolver (used by lookupHost/lookupTXT) never exposes at all. Same
// "no client-go/heavyweight dependency for a narrow, well-known need" spirit
// as cert-manager's api/k8sclient.go.

const (
	dnsTypeA     uint16 = 1
	dnsTypeCNAME uint16 = 5
	dnsTypeAAAA  uint16 = 28
	dnsTypeOPT   uint16 = 41
	dnsClassIN   uint16 = 1

	// dnsUDPPayloadSize is advertised via an EDNS0 OPT record so resolvers
	// answer over UDP with the full record set (registry TXT/A/AAAA
	// responses routinely exceed the original 512-byte UDP limit) instead of
	// silently truncating - queryRecords still falls back to TCP if a
	// resolver truncates anyway.
	dnsUDPPayloadSize = 4096
)

// dnsRecordTypeName renders a numeric DNS TYPE for display.
func dnsRecordTypeName(t uint16) string {
	switch t {
	case dnsTypeA:
		return "A"
	case dnsTypeAAAA:
		return "AAAA"
	case dnsTypeCNAME:
		return "CNAME"
	default:
		return fmt.Sprintf("TYPE%d", t)
	}
}

// dnsRR is one resource record from a query response: its type, rendered
// value (an IP for A/AAAA, a domain name for CNAME), and TTL in seconds as
// the server reported it - the whole reason this hand-rolled client exists,
// since net.Resolver never surfaces a record's real TTL.
type dnsRR struct {
	Type  uint16
	Value string
	TTL   uint32
}

// encodeDNSName encodes name as a sequence of length-prefixed labels
// terminated by a zero-length label, per RFC 1035 4.1.2. Trailing/leading
// dots and empty labels (a bare "..") are tolerated and skipped.
func encodeDNSName(name string) ([]byte, error) {
	var out []byte
	for _, label := range strings.Split(strings.Trim(name, "."), ".") {
		if label == "" {
			continue
		}
		if len(label) > 63 {
			return nil, fmt.Errorf("dns label %q exceeds 63 bytes", label)
		}
		out = append(out, byte(len(label)))
		out = append(out, label...)
	}
	out = append(out, 0)
	return out, nil
}

// buildDNSQuery encodes a standard, recursion-desired query for name/qtype,
// plus an EDNS0 OPT record advertising a larger-than-default UDP payload
// size (see dnsUDPPayloadSize). Returns the message and the transaction ID
// it was assigned so the caller can match it against the response.
func buildDNSQuery(name string, qtype uint16) ([]byte, uint16, error) {
	qname, err := encodeDNSName(name)
	if err != nil {
		return nil, 0, err
	}

	var idBuf [2]byte
	if _, err := rand.Read(idBuf[:]); err != nil {
		return nil, 0, fmt.Errorf("generating query id: %w", err)
	}
	id := binary.BigEndian.Uint16(idBuf[:])

	msg := make([]byte, 0, 12+len(qname)+4+11)
	msg = binary.BigEndian.AppendUint16(msg, id)
	msg = binary.BigEndian.AppendUint16(msg, 0x0100) // standard query, recursion desired
	msg = binary.BigEndian.AppendUint16(msg, 1)      // QDCOUNT
	msg = binary.BigEndian.AppendUint16(msg, 0)      // ANCOUNT
	msg = binary.BigEndian.AppendUint16(msg, 0)      // NSCOUNT
	msg = binary.BigEndian.AppendUint16(msg, 1)      // ARCOUNT (the EDNS0 OPT below)

	msg = append(msg, qname...)
	msg = binary.BigEndian.AppendUint16(msg, qtype)
	msg = binary.BigEndian.AppendUint16(msg, dnsClassIN)

	// EDNS0 OPT pseudo-record: root name, TYPE=OPT, CLASS=UDP payload size,
	// TTL carries extended-RCODE/version/flags (all zero here), no options.
	msg = append(msg, 0) // root name
	msg = binary.BigEndian.AppendUint16(msg, dnsTypeOPT)
	msg = binary.BigEndian.AppendUint16(msg, dnsUDPPayloadSize)
	msg = binary.BigEndian.AppendUint32(msg, 0) // extended RCODE/version/flags
	msg = binary.BigEndian.AppendUint16(msg, 0) // RDLENGTH

	return msg, id, nil
}

// decodeDNSName decodes a (possibly compressed, RFC 1035 4.1.4) domain name
// starting at offset in msg, returning the dotted name and the offset just
// past it in the *original* record (i.e. not following a pointer's target
// back into the caller's cursor).
func decodeDNSName(msg []byte, offset int) (string, int, error) {
	var labels []string
	cursor := offset
	end := -1 // where the caller should resume, once a pointer is followed
	jumps := 0

	for {
		if cursor >= len(msg) {
			return "", 0, errors.New("dns name runs past end of message")
		}
		length := int(msg[cursor])

		switch {
		case length == 0:
			cursor++
			if end == -1 {
				end = cursor
			}
			return strings.Join(labels, "."), end, nil

		case length&0xC0 == 0xC0: // compression pointer
			if cursor+1 >= len(msg) {
				return "", 0, errors.New("dns name pointer runs past end of message")
			}
			if end == -1 {
				end = cursor + 2
			}
			jumps++
			if jumps > 64 {
				return "", 0, errors.New("dns name has too many compression pointers")
			}
			cursor = int(binary.BigEndian.Uint16(msg[cursor:cursor+2]) &^ 0xC000)

		default:
			labelStart := cursor + 1
			labelEnd := labelStart + length
			if labelEnd > len(msg) {
				return "", 0, errors.New("dns name label runs past end of message")
			}
			labels = append(labels, string(msg[labelStart:labelEnd]))
			cursor = labelEnd
		}
	}
}

// parseDNSResponse validates id/qtype match the query and returns every
// resource record in the answer section.
func parseDNSResponse(msg []byte, wantID uint16) ([]dnsRR, bool, error) {
	if len(msg) < 12 {
		return nil, false, errors.New("dns response shorter than a header")
	}
	gotID := binary.BigEndian.Uint16(msg[0:2])
	if gotID != wantID {
		return nil, false, errors.New("dns response id mismatch")
	}
	flags := binary.BigEndian.Uint16(msg[2:4])
	truncated := flags&0x0200 != 0
	rcode := flags & 0x000F
	qdcount := int(binary.BigEndian.Uint16(msg[4:6]))
	ancount := int(binary.BigEndian.Uint16(msg[6:8]))

	offset := 12
	for i := 0; i < qdcount; i++ {
		_, next, err := decodeDNSName(msg, offset)
		if err != nil {
			return nil, truncated, err
		}
		offset = next + 4 // QTYPE + QCLASS
	}

	if rcode != 0 && rcode != 3 { // 3 = NXDOMAIN: a valid "no such name" answer
		return nil, truncated, fmt.Errorf("dns response code %d", rcode)
	}

	records := make([]dnsRR, 0, ancount)
	for i := 0; i < ancount; i++ {
		if offset >= len(msg) {
			break
		}
		_, next, err := decodeDNSName(msg, offset)
		if err != nil {
			return records, truncated, err
		}
		offset = next
		if offset+10 > len(msg) {
			return records, truncated, errors.New("dns resource record header runs past end of message")
		}
		rrType := binary.BigEndian.Uint16(msg[offset : offset+2])
		ttl := binary.BigEndian.Uint32(msg[offset+4 : offset+8])
		rdlength := int(binary.BigEndian.Uint16(msg[offset+8 : offset+10]))
		rdataStart := offset + 10
		rdataEnd := rdataStart + rdlength
		if rdataEnd > len(msg) {
			return records, truncated, errors.New("dns resource record data runs past end of message")
		}

		switch rrType {
		case dnsTypeA:
			if rdlength == 4 {
				records = append(records, dnsRR{Type: rrType, Value: net.IP(msg[rdataStart:rdataEnd]).String(), TTL: ttl})
			}
		case dnsTypeAAAA:
			if rdlength == 16 {
				records = append(records, dnsRR{Type: rrType, Value: net.IP(msg[rdataStart:rdataEnd]).String(), TTL: ttl})
			}
		case dnsTypeCNAME:
			target, _, err := decodeDNSName(msg, rdataStart)
			if err == nil {
				records = append(records, dnsRR{Type: rrType, Value: target, TTL: ttl})
			}
		}

		offset = rdataEnd
	}

	return records, truncated, nil
}

// queryRecords asks resolver for name's records of qtype, over UDP first
// (with EDNS0 advertising a large payload to avoid spurious truncation),
// retrying over TCP if the server truncates anyway. Any CNAME encountered
// along the way is included in the result regardless of qtype, since a
// resolver answering an A/AAAA query for an alias returns the CNAME chain
// in the same answer section.
func queryRecords(ctx context.Context, resolver, name string, qtype uint16) ([]dnsRR, error) {
	server := resolver
	if _, _, err := net.SplitHostPort(server); err != nil {
		server = net.JoinHostPort(server, "53")
	}

	query, id, err := buildDNSQuery(name, qtype)
	if err != nil {
		return nil, err
	}

	records, truncated, err := queryOverUDP(ctx, server, query, id)
	if err != nil {
		return nil, err
	}
	if truncated {
		return queryOverTCP(ctx, server, query, id)
	}
	return records, nil
}

func queryOverUDP(ctx context.Context, server string, query []byte, id uint16) ([]dnsRR, bool, error) {
	dialer := &net.Dialer{}
	conn, err := dialer.DialContext(ctx, "udp", server)
	if err != nil {
		return nil, false, err
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	if _, err := conn.Write(query); err != nil {
		return nil, false, err
	}

	buf := make([]byte, 65535)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, false, err
	}

	return parseDNSResponse(buf[:n], id)
}

func queryOverTCP(ctx context.Context, server string, query []byte, id uint16) ([]dnsRR, error) {
	dialer := &net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", server)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	framed := make([]byte, 0, len(query)+2)
	framed = binary.BigEndian.AppendUint16(framed, uint16(len(query)))
	framed = append(framed, query...)
	if _, err := conn.Write(framed); err != nil {
		return nil, err
	}

	var lenBuf [2]byte
	if _, err := readFull(conn, lenBuf[:]); err != nil {
		return nil, err
	}
	respLen := binary.BigEndian.Uint16(lenBuf[:])
	resp := make([]byte, respLen)
	if _, err := readFull(conn, resp); err != nil {
		return nil, err
	}

	records, _, err := parseDNSResponse(resp, id)
	return records, err
}

// readFull reads exactly len(buf) bytes, since net.Conn.Read may return
// short reads on a stream socket.
func readFull(conn net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

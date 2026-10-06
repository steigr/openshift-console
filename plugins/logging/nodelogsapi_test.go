package main

import (
	"reflect"
	"testing"
)

func TestJournalArgs(t *testing.T) {
	const cursor = "s=ca7d;i=5ca012;b=39e9;m=517d;t=65c2;x=fd47"
	base := []string{"--no-pager", "--utc", "-W"}

	for name, tc := range map[string]struct {
		query journalQuery
		want  []string
	}{
		"text is newest first": {
			journalQuery{tailLines: 100},
			append(append([]string{}, base...), "-r", "-n", "100"),
		},
		"json is chronological": {
			journalQuery{tailLines: 100, asJSON: true},
			append(append([]string{}, base...), "-o", "json", "-n", "100"),
		},
		"json with units": {
			journalQuery{tailLines: 5, asJSON: true, units: []string{"kubelet.service", "crio.service"}},
			append(append([]string{}, base...), "-o", "json", "-n", "5", "-u", "kubelet.service", "-u", "crio.service"),
		},
		"before a cursor walks backwards from it": {
			journalQuery{tailLines: 10000, asJSON: true, beforeCursor: cursor},
			append(append([]string{}, base...), "-o", "json", "-r", "--cursor="+cursor, "-n", "10000"),
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := journalArgs(tc.query); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("journalArgs() = %v, want %v", got, tc.want)
			}
		})
	}
}

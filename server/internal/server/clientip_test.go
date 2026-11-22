package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
)

func TestClientIP(t *testing.T) {
	t.Parallel()

	trusted := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}

	tests := []struct {
		name       string
		trusted    []netip.Prefix
		remoteAddr string
		xff        []string
		want       string
	}{
		{
			name:       "no trusted proxies uses the peer and ignores the header",
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"203.0.113.7"},
			want:       "10.0.0.5",
		},
		{
			name:       "trusted peer forwards the client",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"203.0.113.7"},
			want:       "203.0.113.7",
		},
		{
			name:       "trusted IPv6 peer forwards the client",
			trusted:    trusted,
			remoteAddr: "[::1]:4000",
			xff:        []string{"2001:db8::7"},
			want:       "2001:db8::7",
		},
		{
			name:       "trusted hops are skipped right to left",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"198.51.100.1, 203.0.113.7, 10.0.0.9"},
			want:       "203.0.113.7",
		},
		{
			name:       "untrusted peer cannot spoof a forwarded address",
			trusted:    trusted,
			remoteAddr: "192.0.2.50:4000",
			xff:        []string{"203.0.113.7"},
			want:       "192.0.2.50",
		},
		{
			name:       "trusted peer without the header falls back to the peer",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			want:       "10.0.0.5",
		},
		{
			name:       "chain of only trusted hops falls back to the peer",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"10.1.2.3, 10.0.0.9"},
			want:       "10.0.0.5",
		},
		{
			name:       "malformed chain falls back to the peer",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"not-an-ip"},
			want:       "10.0.0.5",
		},
		{
			name:       "v4-mapped forwarded address is folded to IPv4",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"::ffff:203.0.113.7"},
			want:       "203.0.113.7",
		},
		{
			name:       "v4-mapped trusted address cannot pose as a client",
			trusted:    trusted,
			remoteAddr: "10.0.0.5:4000",
			xff:        []string{"203.0.113.7, ::ffff:10.0.0.9"},
			want:       "203.0.113.7",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var got string
			h := chi.Chain(clientIP(tt.trusted)...).Handler(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
				got = middleware.GetClientIP(r.Context())
			}))
			req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
			req.RemoteAddr = tt.remoteAddr
			for _, v := range tt.xff {
				req.Header.Add("X-Forwarded-For", v)
			}
			h.ServeHTTP(httptest.NewRecorder(), req)
			assert.Equal(t, tt.want, got)
		})
	}
}

package oidc

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testClock is a manually advanced clock for exercising expiry.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func s256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

const testVerifier = "verifier-0123456789-0123456789-0123456789-abcdef"

func testRecord(intent string) NativeCodeRecord {
	return NativeCodeRecord{
		Issuer:        "https://idp.example",
		Subject:       "sub-1",
		UsernameSeed:  "alice",
		Intent:        intent,
		CodeChallenge: s256(testVerifier),
	}
}

func TestNativeCodeStoreRedeem(t *testing.T) {
	t.Parallel()

	t.Run("succeeds once then fails on reuse", func(t *testing.T) {
		t.Parallel()
		s := NewNativeCodeStore(10, time.Minute)
		code, err := s.Issue(testRecord("login"))
		require.NoError(t, err)

		rec, err := s.Redeem(code, testVerifier, "login")
		require.NoError(t, err)
		assert.Equal(t, testRecord("login"), rec)

		_, err = s.Redeem(code, testVerifier, "login")
		assert.ErrorIs(t, err, ErrNativeCodeInvalid)
	})

	t.Run("failed checks leave the code redeemable", func(t *testing.T) {
		t.Parallel()
		s := NewNativeCodeStore(10, time.Minute)
		code, err := s.Issue(testRecord("login"))
		require.NoError(t, err)

		_, err = s.Redeem(code, "wrong-"+testVerifier, "login")
		require.ErrorIs(t, err, ErrNativeCodeInvalid)
		_, err = s.Redeem(code, testVerifier, "link")
		require.ErrorIs(t, err, ErrNativeCodeInvalid)

		_, err = s.Redeem(code, testVerifier, "login")
		assert.NoError(t, err)
	})

	t.Run("challenge or hex digest as verifier fails", func(t *testing.T) {
		t.Parallel()
		s := NewNativeCodeStore(10, time.Minute)
		code, err := s.Issue(testRecord("login"))
		require.NoError(t, err)

		sum := sha256.Sum256([]byte(testVerifier))
		for _, bad := range []string{s256(testVerifier), hex.EncodeToString(sum[:])} {
			_, err = s.Redeem(code, bad, "login")
			assert.ErrorIs(t, err, ErrNativeCodeInvalid)
		}
	})

	t.Run("unknown code fails", func(t *testing.T) {
		t.Parallel()
		s := NewNativeCodeStore(10, time.Minute)
		_, err := s.Redeem("nope", testVerifier, "login")
		assert.ErrorIs(t, err, ErrNativeCodeInvalid)
	})

	t.Run("expired code fails and is dropped", func(t *testing.T) {
		t.Parallel()
		clock := &testClock{t: time.Unix(1_000_000, 0)}
		s := newNativeCodeStore(10, time.Minute, clock.now)
		code, err := s.Issue(testRecord("login"))
		require.NoError(t, err)

		clock.advance(time.Minute)
		_, err = s.Redeem(code, testVerifier, "login")
		require.ErrorIs(t, err, ErrNativeCodeInvalid)
		assert.Empty(t, s.entries)
	})

	t.Run("stores only the code hash", func(t *testing.T) {
		t.Parallel()
		s := NewNativeCodeStore(10, time.Minute)
		code, err := s.Issue(testRecord("login"))
		require.NoError(t, err)
		_, raw := s.entries[code]
		assert.False(t, raw, "the raw code must not be a map key")
		_, hashed := s.entries[hashNativeCode(code)]
		assert.True(t, hashed)
	})
}

func TestNativeCodeStoreCapacity(t *testing.T) {
	t.Parallel()

	t.Run("refuses new codes at the cap without evicting live ones", func(t *testing.T) {
		t.Parallel()
		clock := &testClock{t: time.Unix(1_000_000, 0)}
		s := newNativeCodeStore(2, time.Minute, clock.now)
		first, err := s.Issue(testRecord("login"))
		require.NoError(t, err)
		_, err = s.Issue(testRecord("login"))
		require.NoError(t, err)

		_, err = s.Issue(testRecord("login"))
		require.ErrorIs(t, err, ErrNativeCodeStoreFull)

		_, err = s.Redeem(first, testVerifier, "login")
		assert.NoError(t, err, "a live code survives a refused Issue")
	})

	t.Run("redeeming frees a slot", func(t *testing.T) {
		t.Parallel()
		s := NewNativeCodeStore(1, time.Minute)
		code, err := s.Issue(testRecord("login"))
		require.NoError(t, err)
		_, err = s.Redeem(code, testVerifier, "login")
		require.NoError(t, err)
		_, err = s.Issue(testRecord("login"))
		assert.NoError(t, err)
	})

	t.Run("expired codes are swept to make room", func(t *testing.T) {
		t.Parallel()
		clock := &testClock{t: time.Unix(1_000_000, 0)}
		s := newNativeCodeStore(2, time.Minute, clock.now)
		for range 2 {
			_, err := s.Issue(testRecord("login"))
			require.NoError(t, err)
		}
		clock.advance(time.Minute)
		_, err := s.Issue(testRecord("login"))
		require.NoError(t, err)
		assert.Len(t, s.entries, 1)
	})
}

func TestValidS256Challenge(t *testing.T) {
	t.Parallel()
	valid := s256(testVerifier)
	cases := []struct {
		name      string
		challenge string
		want      bool
	}{
		{"valid", valid, true},
		{"empty", "", false},
		{"padded", valid + "=", false},
		{"too short", valid[:42], false},
		{"standard alphabet", "+" + valid[1:], false},
		{"hex digest", hex.EncodeToString(make([]byte, 32)), false},
		{"non-canonical trailing bits", valid[:42] + "B", false},
		{"invalid characters", strings.Repeat("!", 43), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, ValidS256Challenge(tc.challenge))
		})
	}
}

func TestValidCodeVerifier(t *testing.T) {
	t.Parallel()
	assert.True(t, ValidCodeVerifier(strings.Repeat("a", 43)))
	assert.True(t, ValidCodeVerifier(strings.Repeat("a", 128)))
	assert.True(t, ValidCodeVerifier("abc-._~"+strings.Repeat("Z9", 20)))
	assert.False(t, ValidCodeVerifier(strings.Repeat("a", 42)))
	assert.False(t, ValidCodeVerifier(strings.Repeat("a", 129)))
	assert.False(t, ValidCodeVerifier(strings.Repeat("a", 42)+"+"))
}

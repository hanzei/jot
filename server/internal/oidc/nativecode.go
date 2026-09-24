package oidc

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	// NativeCodeTTL is how long a native hand-off code stays redeemable after
	// the callback issues it (spec §10.3: 60 seconds).
	NativeCodeTTL = 60 * time.Second
	// NativeCodeCapacity bounds how many unexpired codes the store holds at
	// once. A code lives for a minute and each one needs a completed IdP round
	// trip through the per-IP rate-limited callback, so legitimate traffic sits
	// orders of magnitude below this; the cap only stops a runaway client from
	// growing the map without limit.
	NativeCodeCapacity = 1000

	// s256ChallengeLen is the length of BASE64URL(SHA256(x)) without padding.
	s256ChallengeLen = 43
)

var (
	// ErrNativeCodeStoreFull is returned by Issue when the store already holds
	// NativeCodeCapacity unexpired codes. Live codes are never evicted to make
	// room: evicting would let a burst of new flows silently break flows that
	// are mid-hand-off, whereas refusing fails the new flow visibly and it can
	// be retried a minute later.
	ErrNativeCodeStoreFull = errors.New("too many pending SSO sign-ins; try again shortly")
	// ErrNativeCodeInvalid is returned by Redeem for an unknown, expired,
	// wrong-intent, or wrong-verifier code. The cases are deliberately not
	// distinguished to the caller.
	ErrNativeCodeInvalid = errors.New("invalid or expired code")
)

// NativeCodeRecord is what the callback stores for a native flow: the verified
// identity plus what the later exchange needs to check and act on it. It holds
// only the claims provisioning needs, never the raw ID token.
type NativeCodeRecord struct {
	Issuer        string
	Subject       string
	UsernameSeed  string
	Intent        string
	CodeChallenge string
}

type nativeCodeEntry struct {
	record    NativeCodeRecord
	expiresAt time.Time
}

// NativeCodeStore holds one-time codes for the mobile native hand-off (spec
// §10.5): an in-memory, mutex-guarded, size-bounded map keyed by the SHA-256 of
// the code, so the raw code is never stored. Expired entries are swept on every
// Issue and dropped when a Redeem finds them.
type NativeCodeStore struct {
	mu       sync.Mutex
	entries  map[string]nativeCodeEntry
	capacity int
	ttl      time.Duration
	now      func() time.Time
}

// NewNativeCodeStore returns an empty store holding at most capacity unexpired
// codes, each redeemable for ttl.
func NewNativeCodeStore(capacity int, ttl time.Duration) *NativeCodeStore {
	return newNativeCodeStore(capacity, ttl, time.Now)
}

func newNativeCodeStore(capacity int, ttl time.Duration, now func() time.Time) *NativeCodeStore {
	return &NativeCodeStore{
		entries:  map[string]nativeCodeEntry{},
		capacity: capacity,
		ttl:      ttl,
		now:      now,
	}
}

// Issue stores rec under a fresh random code and returns the raw code. It
// returns ErrNativeCodeStoreFull when the store is at capacity after sweeping
// expired codes.
func (s *NativeCodeStore) Issue(rec NativeCodeRecord) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	code := base64.RawURLEncoding.EncodeToString(b)

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for k, e := range s.entries {
		if !now.Before(e.expiresAt) {
			delete(s.entries, k)
		}
	}
	if len(s.entries) >= s.capacity {
		return "", ErrNativeCodeStoreFull
	}
	s.entries[hashNativeCode(code)] = nativeCodeEntry{record: rec, expiresAt: now.Add(s.ttl)}
	return code, nil
}

// Redeem atomically checks and consumes a code. It succeeds only when the code
// exists, has not expired, was issued for intent, and
// BASE64URL(SHA256(verifier)) equals its stored challenge; only then is the
// code removed. Any failed check leaves the code redeemable, so an attempt with
// a wrong verifier or at the wrong endpoint cannot burn it before the
// legitimate app exchanges it.
func (s *NativeCodeStore) Redeem(code, verifier, intent string) (NativeCodeRecord, error) {
	key := hashNativeCode(code)

	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[key]
	if !ok {
		return NativeCodeRecord{}, ErrNativeCodeInvalid
	}
	if !s.now().Before(e.expiresAt) {
		delete(s.entries, key)
		return NativeCodeRecord{}, ErrNativeCodeInvalid
	}
	if e.record.Intent != intent || !VerifyS256(verifier, e.record.CodeChallenge) {
		return NativeCodeRecord{}, ErrNativeCodeInvalid
	}
	delete(s.entries, key)
	return e.record, nil
}

// ValidS256Challenge reports whether challenge is a well-formed S256 code
// challenge: the canonical unpadded base64url encoding of a 32-byte digest.
func ValidS256Challenge(challenge string) bool {
	if len(challenge) != s256ChallengeLen {
		return false
	}
	// Strict rejects non-canonical encodings (non-zero trailing bits), so
	// each digest has exactly one accepted challenge string.
	b, err := base64.RawURLEncoding.Strict().DecodeString(challenge)
	return err == nil && len(b) == sha256.Size
}

// ValidCodeVerifier reports whether verifier has the RFC 7636 §4.1 shape:
// 43–128 characters from the unreserved set [A-Za-z0-9-._~].
func ValidCodeVerifier(verifier string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	for _, c := range []byte(verifier) {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
		default:
			return false
		}
	}
	return true
}

// VerifyS256 reports, in constant time, whether
// BASE64URL(SHA256(verifier)) equals challenge (RFC 7636 §4.6).
func VerifyS256(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(challenge)) == 1
}

func hashNativeCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return string(sum[:])
}

package models

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGeneratePATToken(t *testing.T) {
	t.Run("returns a token with the jot_pat_ prefix", func(t *testing.T) {
		token, err := generatePATToken()
		require.NoError(t, err)

		assert.True(t, strings.HasPrefix(token, patTokenPrefix))
		assert.Len(t, strings.TrimPrefix(token, patTokenPrefix), 64)
	})

	t.Run("returns distinct tokens across calls", func(t *testing.T) {
		first, err := generatePATToken()
		require.NoError(t, err)
		second, err := generatePATToken()
		require.NoError(t, err)

		assert.NotEqual(t, first, second)
	})
}

func TestHashPATToken(t *testing.T) {
	t.Run("hashing is deterministic for a given raw string", func(t *testing.T) {
		token, err := generatePATToken()
		require.NoError(t, err)

		want := hashPATToken(token)
		assert.Equal(t, want, hashPATToken(token))
	})

	t.Run("hashes whatever raw string it is given, prefixed or not", func(t *testing.T) {
		// Tokens issued before jot_pat_ was introduced are bare 64-char hex
		// strings with no prefix. hashPATToken must keep hashing whatever
		// raw string it is given, so those old tokens keep authenticating.
		legacyToken := "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff"
		assert.NotEqual(t, hashPATToken(legacyToken), hashPATToken(patTokenPrefix+legacyToken))
	})
}

package models

import (
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPATRecordUse(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		ctx := t.Context()
		db := dbtest.New(t, driver)
		d := &dialect.Dialect{Driver: driver}
		users := newUserStore(db, d)
		pats := newPATStore(db, d)

		user, err := users.Create(ctx, "alice", "password123", "")
		require.NoError(t, err)
		pat, rawToken, err := pats.Create(ctx, user.ID, "script")
		require.NoError(t, err)

		// load returns the token as authentication sees it.
		load := func() *PersonalAccessToken {
			t.Helper()
			got, getErr := pats.GetByTokenHash(ctx, rawToken)
			require.NoError(t, getErr)
			return got
		}

		require.Nil(t, load().LastUsedAt, "a new token has no recorded use")

		first := Now()
		require.NoError(t, pats.RecordUse(ctx, load(), first))
		require.NotNil(t, load().LastUsedAt, "the first use writes")
		assert.True(t, first.Equal(*load().LastUsedAt))

		inside := first.Add(PATLastUsedInterval - time.Minute)
		require.NoError(t, pats.RecordUse(ctx, load(), inside))
		assert.True(t, first.Equal(*load().LastUsedAt), "a use inside the interval does not write")

		// pat was loaded before the first use, like a concurrent request that
		// saw the token stale: the UPDATE's own condition stops the write.
		require.NoError(t, pats.RecordUse(ctx, pat, inside))
		assert.True(t, first.Equal(*load().LastUsedAt), "a stale copy does not write inside the interval")

		later := first.Add(PATLastUsedInterval + time.Minute)
		require.NoError(t, pats.RecordUse(ctx, load(), later))
		assert.True(t, later.Equal(*load().LastUsedAt), "a use after the interval writes again")

		listed, err := pats.GetByUserID(ctx, user.ID)
		require.NoError(t, err)
		require.Len(t, listed, 1)
		require.NotNil(t, listed[0].LastUsedAt)
		assert.True(t, later.Equal(*listed[0].LastUsedAt))
	})
}

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
